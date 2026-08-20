// 練習の反省ノート。1件 = 本文 + メンション(部員/動画) + 風 + 練習日時。
// localStorage に配列で永続化する(クライアント完結)。純ロジックはテスト可能に分離。
export const STORAGE_KEY = 'sailviz.reflections';

// 艇セッティング(全て数値)。UI/正規化/引き継ぎで共通に使う順序付きキー。
export const RIG_FIELDS = [
  'boatNo', 'gear', 'prebend', 'rake', 'sideTension', 'foreTension',
  'puller', 'peakRope', 'bridleHeight', 'jibLeader', 'jibPull', 'vangPull',
];
// 反省内容(ラベル付きテキスト5欄)。
export const NOTE_FIELDS = ['goal', 'issue', 'discovery', 'slowFactor', 'fastFactor'];

// 数値入力の正規化: 空欄/非数値→null、それ以外→number(0 は保持)。
export function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 入力 rig を RIG_FIELDS 全キー揃いの数値オブジェクトに整える(未指定→null)。
function normalizeRig(rig = {}) {
  const out = {};
  for (const f of RIG_FIELDS) out[f] = toNum(rig?.[f]);
  return out;
}

// 入力 notes を NOTE_FIELDS 全キー揃いの文字列オブジェクトに整える(未指定→'')。
function normalizeNotes(notes = {}) {
  const out = {};
  for (const f of NOTE_FIELDS) out[f] = String(notes?.[f] ?? '');
  return out;
}

// 新規反省の初期セッティング用に、最新(末尾)の反省の rig を返す。無ければ空 rig。
export function previousRig(list = []) {
  const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
  return normalizeRig(last?.rig);
}

// mm:ss 形式(動画メンションの位置表示用)。
export function formatVideoPos(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 反省1件を組み立てる。people/videos は挿入時に構造化して渡す。
// id/createdAt は呼び出し側(=ブラウザ)で採番して渡す(テストの決定性のため)。
export function createReflection({
  id, createdAt, text = '', people = [], videos = [], wind = null, practice = null,
  rig = null, waveHeight = null, notes = null,
}) {
  return {
    id,
    createdAt,
    text: String(text),
    people: [...people],
    videos: videos.map((v) => ({ name: v.name, tMs: v.tMs ?? 0 })),
    wind: wind ? { ...wind } : null,
    practice: practice ? { ...practice } : null,
    rig: normalizeRig(rig),
    waveHeight: toNum(waveHeight),
    notes: normalizeNotes(notes),
  };
}

// 風を人間可読の1行に(例: 「南南西 3.2m/s(辻堂 12:40)」)。手入力/取得失敗も吸収。
export function windLabel(wind, { formatObs } = {}) {
  if (!wind) return '風: 未設定';
  const dir = wind.dir || '不明';
  const speed = (wind.speed ?? wind.speed === 0) ? `${wind.speed}m/s` : '—';
  let suffix = '';
  if (wind.source === 'amedas' && wind.station) {
    const t = formatObs && wind.obsMs != null ? ` ${formatObs(wind.obsMs)}` : '';
    suffix = `(${wind.station}${t})`;
  } else if (wind.source === 'manual') {
    suffix = '(手入力)';
  }
  return `風: ${dir} ${speed}${suffix}`;
}

// 保存/復元。storage は localStorage 互換({getItem,setItem})を注入可能。
export function loadReflections(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveReflections(list, storage = globalThis.localStorage) {
  storage?.setItem(STORAGE_KEY, JSON.stringify(list));
  return list;
}
