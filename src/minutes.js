// 練習振り返り議事録(構造化テキスト)を部員ブロックへ分解し、名簿へ照合する純ロジック。
// 形式: `## 見出し（フルネーム）` ＋ `- **ラベル**：本文`。AI不要・決定的。
import { memberList, toHiragana } from './members.js';

// ラベル(別名込み)→ 反省フィールドキー。今後/取り組みは発見(discovery)に集約する。
const LABEL_MAP = {
  '目標': 'goal', '今日の目標': 'goal',
  '課題': 'issue',
  '発見': 'discovery',
  '今後': 'discovery', '今後の取り組み': 'discovery', '取り組み': 'discovery', '取組': 'discovery',
};

// 見出しから括弧(全角/半角)を剥がし、{ headerName, fullNameHint } を返す。
function splitHeader(line) {
  const m = line.match(/^(.*?)[（(]\s*(.+?)\s*[)）]\s*$/);
  if (m) return { headerName: m[1].trim(), fullNameHint: m[2].trim() };
  return { headerName: line.trim(), fullNameHint: null };
}

// `- **ラベル**：本文` 行を { key, text } に。ラベル別名を解決。非該当は null。
function parseLabelLine(line) {
  const m = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*[：:]\s*(.*)$/);
  if (!m) return null;
  const key = LABEL_MAP[m[1].trim()];
  if (!key) return null;
  return { key, text: m[2].trim() };
}

// 議事録全文 → 部員ブロック配列。
export function parseMinutes(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let cur = null;      // 現在のブロック
  let lastKey = null;  // 継続行(ラベルの折返し)の追記先
  const push = () => { if (cur) blocks.push(cur); };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      push();
      const { headerName, fullNameHint } = splitHeader(h[1]);
      cur = { headerName, fullNameHint, goal: '', issue: '', discovery: '', raw: '' };
      lastKey = null;
      continue;
    }
    if (!cur) continue; // 最初の ## より前(# タイトル等)は無視
    cur.raw += (cur.raw ? '\n' : '') + line;
    const lbl = parseLabelLine(line);
    if (lbl) {
      cur[lbl.key] = cur[lbl.key] ? `${cur[lbl.key]} ${lbl.text}` : lbl.text; // 同キー複数は連結
      lastKey = lbl.key;
    } else if (lastKey && line.trim() && !/^\s*[-*]/.test(line)) {
      cur[lastKey] += (cur[lastKey] ? ' ' : '') + line.trim(); // 折返し継続行を直近ラベルへ
    } else if (/^\s*[-*]/.test(line)) {
      lastKey = null; // 別の(未知)箇条書きに入ったら継続を止める
    }
  }
  push();
  return blocks;
}

// 見出し名/フルネームヒントを名簿へ照合。優先: fullname → family → kana → given。
export function matchMember(headerName, fullNameHint, roster = memberList()) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const hint = norm(fullNameHint);
  const head = String(headerName || '').trim();
  if (hint) {
    const byFull = roster.find((m) => norm(m.fullName) === hint);
    if (byFull) return { member: byFull, how: 'fullname' };
    const byFamHint = roster.find((m) => hint.startsWith(m.family) || m.family === hint);
    if (byFamHint) return { member: byFamHint, how: 'family' };
  }
  const byFam = roster.find((m) => head === m.family || head.startsWith(m.family));
  if (byFam) return { member: byFam, how: 'family' };
  const kana = toHiragana(head);
  const byKana = roster.find((m) => m.kana === kana);
  if (byKana) return { member: byKana, how: 'kana' };
  const byGiven = roster.find((m) => m.given === head);
  if (byGiven) return { member: byGiven, how: 'given' };
  return { member: null, how: 'none' };
}
