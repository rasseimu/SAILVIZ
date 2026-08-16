// 練習の反省ノート。1件 = 本文 + メンション(部員/動画) + 風 + 練習日時。
// localStorage に配列で永続化する(クライアント完結)。純ロジックはテスト可能に分離。
export const STORAGE_KEY = 'sailviz.reflections';

// mm:ss 形式(動画メンションの位置表示用)。
export function formatVideoPos(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 反省1件を組み立てる。people/videos は挿入時に構造化して渡す。
// id/createdAt は呼び出し側(=ブラウザ)で採番して渡す(テストの決定性のため)。
export function createReflection({ id, createdAt, text = '', people = [], videos = [], wind = null, practice = null }) {
  return {
    id,
    createdAt,
    text: String(text),
    people: [...people],
    videos: videos.map((v) => ({ name: v.name, tMs: v.tMs ?? 0 })),
    wind: wind ? { ...wind } : null,
    practice: practice ? { ...practice } : null,
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
