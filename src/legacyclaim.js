// src/legacyclaim.js
// 旧名簿の氏名の本人確認(「この人ですか？」)の表示を決める(DOM 非依存)。
// サーバーの GET /api/orgs/:orgId/legacy-claim の応答から、聞くかどうか・何を聞くかを返す。
// 「いいえ」で閉じた組織は覚えておき、次からは聞かない(組織管理の画面からはいつでも選べる)。
const SKIP_KEY = 'sailviz.legacyClaimSkip.v1';

// null(聞かない) | { mode: 'suggest', name, candidates } | { mode: 'choose', candidates }
export function legacyClaimPrompt(view) {
  if (!view || view.available !== true || view.linked) return null;
  const candidates = Array.isArray(view.candidates) ? view.candidates.filter((n) => typeof n === 'string' && n) : [];
  if (!candidates.length) return null;
  if (view.suggested && candidates.includes(view.suggested)) return { mode: 'suggest', name: view.suggested, candidates };
  return { mode: 'choose', candidates };
}

// 「いいえ」で閉じた組織(ユーザーごと)。localStorage は無い・投げることがあるので try/catch。
const skipId = (userId, orgId) => `${userId}:${orgId}`;
function readSkips(storage) {
  try { return JSON.parse(storage?.getItem(SKIP_KEY) || '[]'); } catch { return []; }
}
export function isLegacyClaimSkipped(userId, orgId, storage = globalThis.localStorage) {
  const s = readSkips(storage);
  return Array.isArray(s) && s.includes(skipId(userId, orgId));
}
export function skipLegacyClaim(userId, orgId, storage = globalThis.localStorage) {
  const s = readSkips(storage);
  const list = Array.isArray(s) ? s : [];
  if (!list.includes(skipId(userId, orgId))) list.push(skipId(userId, orgId));
  try { storage?.setItem(SKIP_KEY, JSON.stringify(list)); } catch { /* 覚えられなくても動く(次回また聞く) */ }
}
