// 反省ノート × 参考文献(ローカルPDF)を Gemini で照合し、出典リンク付きコメント案を返す。
// 2段構え: (1)章要約で関連ソースをスクリーニング(複数可) → (2)関連PDFをまとめて inline 直送し
// 数値やコツを引用した詳しいコメントを生成。純ロジック(プロンプト生成・レスポンス検証)は
// API 呼び出しから分離してテスト可能にする。
import { geminiGenerate, pdfPart } from './gemini.js';

const FIELDS = new Set(['goal', 'issue', 'discovery']);

// JSON配列をコードフェンス等を無視して取り出す。非配列/非JSONは例外。
function extractJsonArray(rawText) {
  const text = String(rawText).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('AI応答にJSON配列がありません');
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('AI応答が配列ではありません');
  return arr;
}

// --- スクリーニング(章要約のみ・PDF不要) ---

export function buildScreenPrompt(items, sources) {
  const srcLines = sources.map((s) => `- id=${s.id} | ${s.title} | ${s.summary}`).join('\n');
  const reflLines = items
    .map((it) => `- reflId=${it.reflId} field=${it.field} text=${JSON.stringify(it.text)}`).join('\n');
  const system = [
    'あなたは経験豊富なセーリングコーチです。参考文献ソースの一覧から、各反省内容に',
    '関連するソースがあれば選びます。関連が薄ければその反省は選びません。憶測で紐付けないこと。',
  ].join('');
  const user = [
    '# 参考文献ソース(id | タイトル | 要約)',
    srcLines,
    '',
    '# 反省内容',
    reflLines,
    '',
    '# 出力形式',
    '関連するものだけを次のJSON配列で返す(前後に説明文を付けない):',
    '[{"reflId":"...","field":"goal|issue|discovery","sourceId":"...(上のidから選ぶ)"}]',
    '関連が無ければ [] を返す。1つの反省に複数のソースが関連するなら、関連度の高い順に',
    '最大3つまで別々の行として挙げてよい(reflId/fieldを同じにしてsourceIdだけ変える)。',
  ].join('\n');
  return { system, user };
}

// スクリーニング応答を検証。存在する sourceId・正しい field のみ採用。
export function parseScreen(rawText, sources) {
  const validIds = new Set(sources.map((s) => s.id));
  return extractJsonArray(rawText).filter((s) =>
    s && typeof s.reflId === 'string' && FIELDS.has(s.field) && validIds.has(s.sourceId))
    .map((s) => ({ reflId: s.reflId, field: s.field, sourceId: s.sourceId }));
}

// --- 根拠付け(該当PDFを inline 直送。1反省=複数PDFをまとめて渡し詳しいコメント) ---

// item: {field, text}、sources: [{id, title}](添付PDFの順に対応)。
export function buildGroundPrompt(item, sources) {
  const srcLines = sources.map((s) => `- id=${s.id} | ${s.title}`).join('\n');
  const system = [
    'あなたは経験豊富なセーリングコーチです。添付した参考文献PDFの内容だけを根拠に、',
    '対象の反省へ具体的で実践的な助言コメントを日本語で書きます。PDF内の要点・数値・コツを',
    '引用しながら3〜5文で詳しく述べ、複数のPDFにまたがって引用してもかまいません。',
    'PDFに根拠が無い内容は憶測で書かないこと。',
  ].join('');
  const user = [
    '# 対象の反省',
    `field=${item.field} text=${JSON.stringify(item.text)}`,
    '',
    '# 添付PDFのソース(id | タイトル) — 添付した順に対応',
    srcLines,
    '',
    '# 出力形式(JSONオブジェクト、前後に説明文を付けない)',
    '{"comment":"...(3〜5文の詳しい助言)","usedSourceIds":["実際に根拠にしたid",...]}',
    '根拠にできるPDFが無ければ {"comment":"","usedSourceIds":[]} を返す。',
  ].join('\n');
  return { system, user };
}

// 根拠付け応答(単一オブジェクト)を検証。comment 非空でなければ null。
export function parseGroundObject(rawText) {
  const text = String(rawText).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('AI応答にJSONオブジェクトがありません');
  const obj = JSON.parse(text.slice(start, end + 1));
  const comment = typeof obj.comment === 'string' ? obj.comment.trim() : '';
  if (!comment) return null;
  const usedSourceIds = Array.isArray(obj.usedSourceIds)
    ? obj.usedSourceIds.filter((x) => typeof x === 'string') : [];
  return { comment, usedSourceIds };
}

// items: [{reflId, field, text}]、sources: SOURCES、loadPdfBase64: (path)=>Promise<base64>。
// 戻り値: [{reflId, field, comment, url, refs:[{link,title}]}]。関連なし/失敗は含めない。
export async function generateAiComments({
  items, sources, apiKey, loadPdfBase64,
  model = 'gemini-3.6-flash', fetchImpl = globalThis.fetch, maxSourcesPerItem = 3,
}) {
  if (!apiKey || !items || items.length === 0) return [];
  const byId = new Map(sources.map((s) => [s.id, s]));

  // (1) スクリーニング: 反省ごとに関連ソース(複数可)を選ぶ
  const sc = buildScreenPrompt(items, sources);
  const screenText = await geminiGenerate({
    apiKey, model, system: sc.system, parts: [{ text: sc.user }],
    responseMimeType: 'application/json', fetchImpl,
  });
  const matches = parseScreen(screenText, sources);
  if (matches.length === 0) return [];

  // 反省(reflId×field)ごとに関連ソースをまとめる(最大 maxSourcesPerItem)
  const textOf = new Map(items.map((it) => [`${it.reflId} ${it.field}`, it.text]));
  const groups = new Map(); // key -> { reflId, field, text, ids: [] }
  for (const m of matches) {
    const key = `${m.reflId} ${m.field}`;
    const text = textOf.get(key);
    if (text == null) continue;
    if (!groups.has(key)) groups.set(key, { reflId: m.reflId, field: m.field, text, ids: [] });
    const g = groups.get(key);
    if (!g.ids.includes(m.sourceId) && g.ids.length < maxSourcesPerItem) g.ids.push(m.sourceId);
  }

  // (2) 根拠付け: 反省ごとに、関連PDF群をまとめて inline 直送
  const out = [];
  for (const g of groups.values()) {
    const loaded = []; // { source, base64 }
    for (const id of g.ids) {
      const source = byId.get(id);
      if (!source) continue;
      try { loaded.push({ source, base64: await loadPdfBase64(source.pdf) }); } catch { /* skip */ }
    }
    if (loaded.length === 0) continue;
    const gp = buildGroundPrompt(g, loaded.map((x) => ({ id: x.source.id, title: x.source.title })));
    let res;
    try {
      const text = await geminiGenerate({
        apiKey, model, system: gp.system,
        parts: [{ text: gp.user }, ...loaded.map((x) => pdfPart(x.base64))],
        responseMimeType: 'application/json', fetchImpl,
      });
      res = parseGroundObject(text);
    } catch { continue; } // 1反省の失敗で全体を止めない
    if (!res) continue;

    // 実際に使われたソース(なければ渡した全ソース)を出典にする
    const provided = new Set(loaded.map((x) => x.source.id));
    let usedIds = res.usedSourceIds.filter((id) => provided.has(id));
    if (usedIds.length === 0) usedIds = [...provided];
    const refs = usedIds.map((id) => {
      const s = byId.get(id);
      return { link: s.link || null, title: s.title };
    });
    // 重複排除キー: 反省×使用ソース集合。再生成時の二重挿入を防ぐ。
    const url = `ai:${g.reflId}:${g.field}:${[...usedIds].sort().join(',')}`;
    out.push({ reflId: g.reflId, field: g.field, comment: res.comment, url, refs });
  }
  return out;
}
