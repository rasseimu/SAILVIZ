// 進捗の解決履歴(解決済み課題・達成済み目標)に、同一部員がその後に書いた反省
// (発見・目標/課題の変化)を「解決の手がかり」として添え、未解決アイテムへ実名引用の
// 助言コメントを Gemini で生成する。参考文献ベースの aicomment.js と対の、チーム内
// ピア学習ベースのコメント源。純ロジック(プール構築・プロンプト・検証)は API 呼び出しから
// 分離してテスト可能にする。
import { summarize, windBinKey } from './progressstore.js';

const FIELD_LABEL = { goal: '目標', issue: '課題', discovery: '発見' };

const FIELDS = new Set(['goal', 'issue']);

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

// 解決アイテムごとに、同一部員が"以降"に書いた発見・課題/目標の変化を最大 maxEvidence 件添える。
// reflections=全反省, progress=sailviz.progress。
export function buildHistoryPool(reflections, progress, { maxEvidence = 5 } = {}) {
  const sum = summarize(reflections, progress);
  const speedById = new Map();
  for (const r of reflections) if (r?.id != null) speedById.set(r.id, r.wind?.speed ?? null);

  const pool = [];
  let seq = 0;
  for (const [member, b] of Object.entries(sum.byMember)) {
    // その部員の発見(全風速ビンを平坦化)と、目標/課題テキストの時系列(手がかり候補)。
    const discoveries = Object.values(b.discoveriesByBin).flat().map((d) =>
      ({ dateMs: d.dateMs, field: 'discovery', text: d.text, windBin: windBinKey(d.speed) }));
    const changes = [
      ...b.issues.map((it) => ({ dateMs: it.dateMs, field: 'issue', text: it.text })),
      ...b.goals.map((g) => ({ dateMs: g.dateMs, field: 'goal', text: g.text })),
    ];
    const resolved = [
      ...b.issues.filter((it) => it.stage === 2)
        .map((it) => ({ reflId: it.reflId, field: 'issue', text: it.text, dateMs: it.dateMs })),
      ...b.goals.filter((g) => g.done)
        .map((g) => ({ reflId: g.reflId, field: 'goal', text: g.text, dateMs: g.dateMs })),
    ];
    for (const item of resolved) {
      const wb = windBinKey(speedById.get(item.reflId));
      // 手がかり = 解決日時"以降"の発見(主)+ 後続の課題/目標の変化。
      const cand = [
        ...discoveries.filter((d) => d.dateMs >= item.dateMs),
        ...changes.filter((c) => c.dateMs > item.dateMs),
      ];
      // 風速帯が近い発見を優先し、次に新しい順。最大 maxEvidence 件。
      cand.sort((a, c) => {
        const am = a.windBin && a.windBin !== 'unknown' && a.windBin === wb ? 0 : 1;
        const cm = c.windBin && c.windBin !== 'unknown' && c.windBin === wb ? 0 : 1;
        if (am !== cm) return am - cm;
        return c.dateMs - a.dateMs;
      });
      const evidence = cand.slice(0, maxEvidence)
        .map((e) => ({ dateMs: e.dateMs, field: e.field, text: e.text }));
      pool.push({ poolId: `p${seq++}`, member, field: item.field, text: item.text, dateMs: item.dateMs, windBin: wb, evidence });
    }
  }
  return pool;
}

// --- (1) スクリーニング(プール要約のみ・evidence本文は渡さずトークン節約) ---

export function buildPeerScreenPrompt(items, pool) {
  const poolLines = pool.map((p) =>
    `- poolId=${p.poolId} | ${p.member} | ${FIELD_LABEL[p.field]} | ${JSON.stringify(p.text)}`).join('\n');
  const reflLines = items.map((it) =>
    `- reflId=${it.reflId} field=${it.field} text=${JSON.stringify(it.text)}`).join('\n');
  const system = [
    'あなたは経験豊富なセーリングコーチです。未解決の目標・課題それぞれに対し、過去に似た',
    '目標・課題を解決した事例(解決事例プール)から関連するものを選びます。同一人物の過去事例が',
    'あれば優先し、無ければ他部員の事例を選びます。関連が薄ければ選びません。憶測で紐付けないこと。',
  ].join('');
  const user = [
    '# 解決事例プール(poolId | 部員 | 種別 | テキスト)',
    poolLines,
    '',
    '# 未解決の目標・課題',
    reflLines,
    '',
    '# 出力形式',
    '関連するものだけを次のJSON配列で返す(前後に説明文を付けない):',
    '[{"reflId":"...","field":"goal|issue","poolId":"...(上のpoolIdから選ぶ)"}]',
    '関連が無ければ [] を返す。1つのアイテムに複数事例が関連するなら、関連度の高い順に',
    '最大3つまで別々の行として挙げてよい(reflId/fieldを同じにしてpoolIdだけ変える)。',
  ].join('\n');
  return { system, user };
}

// スクリーニング応答を検証。存在する poolId・正しい field のみ採用。
export function parsePeerScreen(rawText, pool) {
  const validIds = new Set(pool.map((p) => p.poolId));
  return extractJsonArray(rawText).filter((s) =>
    s && typeof s.reflId === 'string' && FIELDS.has(s.field) && validIds.has(s.poolId))
    .map((s) => ({ reflId: s.reflId, field: s.field, poolId: s.poolId }));
}

// --- (2) 根拠付け(選ばれた解決事例を本文で渡し、実名引用のコメントを生成) ---

export function buildPeerGroundPrompt(item, matches) {
  const blocks = matches.map((m) => {
    const ev = (m.evidence || []).length
      ? (m.evidence || []).map((e) => `    - ${FIELD_LABEL[e.field] || e.field}: ${JSON.stringify(e.text)}`).join('\n')
      : '    - (その後の記録なし)';
    return `- poolId=${m.poolId} | ${m.member} | ${FIELD_LABEL[m.field]} | ${JSON.stringify(m.text)}\n`
      + `  その後の記録(解決の手がかり):\n${ev}`;
  }).join('\n');
  const system = [
    'あなたは経験豊富なセーリングコーチです。以下のチーム内の解決事例だけを根拠に、対象の',
    '未解決の目標/課題へ具体的で実践的な助言を日本語3〜5文で書きます。誰(実名)が似た目標/課題を',
    'どう解決したかを引用します(例「村瀬さんも同様の課題を『カニンガムを緩める』という発見で',
    '解決しています」)。対象本人自身の過去事例なら「自分の△△の時の発見が使えます」と促します。',
    '事例に無い内容は憶測で書かないこと。',
  ].join('');
  const user = [
    '# 対象の未解決アイテム',
    `field=${item.field} text=${JSON.stringify(item.text)}`,
    '',
    '# チーム内の解決事例(poolId | 部員 | 種別 | テキスト と その後の記録)',
    blocks,
    '',
    '# 出力形式(JSONオブジェクト、前後に説明文を付けない)',
    '{"comment":"...(3〜5文の助言。実名を引用)","usedPoolIds":["実際に根拠にしたpoolId",...]}',
    '根拠にできる事例が無ければ {"comment":"","usedPoolIds":[]} を返す。',
  ].join('\n');
  return { system, user };
}

// 根拠付け応答(単一オブジェクト)を検証。comment 非空でなければ null。
export function parsePeerGroundObject(rawText) {
  const text = String(rawText).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('AI応答にJSONオブジェクトがありません');
  const obj = JSON.parse(text.slice(start, end + 1));
  const comment = typeof obj.comment === 'string' ? obj.comment.trim() : '';
  if (!comment) return null;
  const usedPoolIds = Array.isArray(obj.usedPoolIds)
    ? obj.usedPoolIds.filter((x) => typeof x === 'string') : [];
  return { comment, usedPoolIds };
}
