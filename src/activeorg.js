// 表示中の組織。組織 ID を localStorage に覚え、api.js が X-Sailviz-Org ヘッダーに載せる。
// ファイル版・共有ログインでは何も覚えない(= ヘッダーを付けない)。
// localStorage は無い・投げる(プライベートモード等)ことがあるので、読み書きは必ず try/catch で囲む。
const KEY = 'sailviz.activeOrg.v1';

export function getActiveOrgId() {
  try { return globalThis.localStorage?.getItem(KEY) || null; } catch { return null; }
}

export function setActiveOrgId(id) {
  try {
    if (id) globalThis.localStorage?.setItem(KEY, id);
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* 覚えられなくても動く(ヘッダー無し=所属の先頭) */ }
}

// /api/me の orgs から表示中の組織を決める。覚えている ID が所属にあればそれ、無ければ先頭。
// 結果を保存し直す(所属から外れた ID はここで捨てる)。
export function resolveActiveOrg(orgs) {
  const list = Array.isArray(orgs) ? orgs : [];
  const remembered = getActiveOrgId();
  const id = list.some((o) => o?.id === remembered) ? remembered : (list[0]?.id ?? null);
  setActiveOrgId(id);
  return id;
}
