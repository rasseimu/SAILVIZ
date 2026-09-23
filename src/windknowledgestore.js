// 風速帯相関ダイジェストの localStorage キャッシュ。progressstore.js の作法に倣う。
export const STORAGE_KEY = 'sailviz.windknowledge';

export function loadWindKnowledge(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export function saveWindKnowledge(data, storage = globalThis.localStorage) {
  storage?.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clearWindKnowledge(storage = globalThis.localStorage) {
  storage?.removeItem(STORAGE_KEY);
}
