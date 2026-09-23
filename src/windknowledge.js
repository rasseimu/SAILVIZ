// 風速帯×課題×有効技術の相関ダイジェストを1回のGemini分析で構築する。
// 入力A: チームの解決履歴+気づき(実名を除去)。入力B: 参考文献の要約(帯タグ付け)。
// 純ロジック(入力組み立て・プロンプト・応答検証・レンダリング)をAPI呼び出しから分離。
import { buildHistoryPool } from './peerlearning.js';
import { WIND_BANDS, detectBandWord, classifyWindBand, bandLabel } from './windband.js';

const NOTE_FIELDS = ['goal', 'issue', 'discovery', 'slowFactor', 'fastFactor'];
const BAND_KEYS = WIND_BANDS.map((b) => b.key); // ['bihuu','chuu','kyou','baku']

function emptyTeam() {
  const t = {};
  for (const k of BAND_KEYS) t[k] = { resolved: [], notes: [] };
  return t;
}

export function buildKnowledgeInput(reflections, progress, sources) {
  const teamByBand = emptyTeam();

  // 入力A-1: 解決履歴(既存プールを再利用。実名 member は捨てる)。
  const pool = buildHistoryPool(reflections, progress);
  for (const p of pool) {
    if (!BAND_KEYS.includes(p.windBin)) continue; // unknown は除外
    teamByBand[p.windBin].resolved.push({
      field: p.field, text: p.text,
      evidence: (p.evidence || []).map((e) => ({ field: e.field, text: e.text })),
    });
  }

  // 入力A-2: 単独の気づき(5フィールド)。フィールド文で帯付け。
  for (const r of reflections) {
    const notes = r.notes || {};
    const speed = r.wind?.speed ?? null;
    for (const f of NOTE_FIELDS) {
      const text = notes[f];
      if (!text) continue;
      const band = classifyWindBand(text, speed);
      if (!BAND_KEYS.includes(band)) continue;
      teamByBand[band].notes.push({ field: f, text });
    }
  }

  // 入力B: 参考文献要約の帯タグ付け(語なしは general)。
  const refsByBand = { general: [] };
  for (const k of BAND_KEYS) refsByBand[k] = [];
  for (const s of sources || []) {
    const band = detectBandWord(`${s.title || ''} ${s.summary || ''}`) || 'general';
    refsByBand[band].push({ title: s.title, summary: s.summary });
  }

  return { teamByBand, refsByBand };
}

const FIELD_LABEL = { goal: '目標', issue: '課題', discovery: '発見', slowFactor: '遅い要因', fastFactor: '速い要因' };
const MAX_BULLETS = 8;

function renderTeamBand(b) {
  const lines = [];
  for (const r of b.resolved) {
    const ev = r.evidence.map((e) => `${FIELD_LABEL[e.field] || e.field}:${e.text}`).join(' / ') || '(手がかりなし)';
    lines.push(`  - 解決した${FIELD_LABEL[r.field] || r.field}「${r.text}」← ${ev}`);
  }
  for (const n of b.notes) lines.push(`  - ${FIELD_LABEL[n.field] || n.field}:「${n.text}」`);
  return lines.length ? lines.join('\n') : '  - (部内データなし)';
}

function renderRefs(list) {
  return list.length ? list.map((r) => `  - ${r.title}: ${r.summary}`).join('\n') : '  - (なし)';
}

export function buildKnowledgePrompt(input) {
  const { teamByBand, refsByBand } = input;
  const system = [
    'あなたは経験豊富なセーリングコーチです。以下はチームの解決済み課題・それを解決した',
    '発見・単独の気づきを風速帯別にまとめたものと、参考文献の要約です。各帯について、繰り返し',
    '現れる「課題→有効な技術」の相関を簡潔な箇条書きで書きます。同義の言い回しは1点に',
    'クラスタします。部内実績を優先し、データが少ない帯は参考文献で補完・裏付けします。',
    `各帯 最大${MAX_BULLETS}点。データ・資料にない内容は憶測で書かないこと。`,
  ].join('');
  const bandBlocks = WIND_BANDS.map((band) => {
    const k = band.key;
    return [
      `## ${bandLabel(k)}  [key=${k}]`,
      '### 部内データ',
      renderTeamBand(teamByBand[k]),
      '### 参考文献(この帯 + 汎用)',
      renderRefs([...(refsByBand[k] || []), ...(refsByBand.general || [])]),
    ].join('\n');
  }).join('\n\n');
  const user = [
    '# 風速帯別の素材',
    bandBlocks,
    '',
    '# 出力形式(JSONオブジェクトのみ。前後に説明文を付けない)',
    '各帯キーに箇条書き文字列の配列を返す。各要素の末尾に出典タグを付ける',
    '(部内実績由来は 〔部内実績〕、参考文献由来は 〔参考: タイトル〕)。',
    '{"bihuu":["..."],"chuu":["..."],"kyou":["..."],"baku":["..."]}',
    `各帯 最大${MAX_BULLETS}点。素材が無い帯は [] を返す。`,
  ].join('\n');
  return { system, user };
}

export function parseKnowledgeResponse(rawText) {
  const text = String(rawText).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('AI応答にJSONオブジェクトがありません');
  const obj = JSON.parse(text.slice(start, end + 1));
  const out = {};
  for (const k of BAND_KEYS) {
    const arr = Array.isArray(obj[k]) ? obj[k] : [];
    out[k] = arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, MAX_BULLETS);
  }
  return out;
}

function fmtDay(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

export function renderKnowledgeMd(bandBullets, builtAtMs) {
  const head = `# 風速帯別 課題×有効技術 相関ノート  (更新: ${fmtDay(builtAtMs)})`;
  const sections = WIND_BANDS.map((band) => {
    const bullets = bandBullets[band.key] || [];
    const body = bullets.length ? bullets.map((b) => `- ${b}`).join('\n') : '（データ不足）';
    return `## ${band.label}\n${body}`;
  });
  return [head, '', ...sections.flatMap((s) => [s, ''])].join('\n').trim() + '\n';
}

export async function generateWindKnowledge({
  reflections, progress, sources, geminiGenerate, nowMs, model = 'gemini-3.6-flash',
}) {
  const input = buildKnowledgeInput(reflections, progress, sources);
  const { system, user } = buildKnowledgePrompt(input);
  const raw = await geminiGenerate({
    model, system, parts: [{ text: user }], responseMimeType: 'application/json',
  });
  const bandBullets = parseKnowledgeResponse(raw);
  const md = renderKnowledgeMd(bandBullets, nowMs);
  const perBand = {};
  for (const k of BAND_KEYS) perBand[k] = bandBullets[k].length;
  const resolved = input && Object.values(input.teamByBand).reduce((n, b) => n + b.resolved.length, 0);
  const stats = { reflections: reflections.length, resolved, perBand };
  return { md, builtAt: nowMs, bandBullets, stats };
}
