// server/domain/legacyClaim.js
// 旧名簿の氏名への自動の結び付け(server/legacyAutoLink.js)の対象を決める純関数。DB・HTTP には触れない。
// 候補 = 未付け替えの記録があり、ほかのメンバーに紐付いていない旧氏名。
// 一致(suggested) = 候補のうち、本人の氏名と空白(半角・全角)を除いて一致するもの(1つに決まるときだけ)。

// 空白を除いた比較用の名前。
export const nameKey = (s) => String(s ?? '').replace(/[\s　]+/g, '');

// names: accounts.listLegacyNames の結果 [{ name, unclaimed, userIds }]
// takenByOthers: ほかのメンバーに結び付いた旧氏名(名簿行の legacy_name など)の Set
export function legacyClaimView({ names, userId, userName, linked, takenByOthers = new Set() }) {
  if (linked) return { linked, suggested: null, candidates: [] };
  const candidates = (Array.isArray(names) ? names : [])
    .filter((n) => n && n.unclaimed > 0 && !(n.userIds || []).some((u) => u !== userId) && !takenByOthers.has(n.name))
    .map((n) => n.name);
  const key = nameKey(userName);
  const hits = key ? candidates.filter((n) => nameKey(n) === key) : [];
  return { linked: null, suggested: hits.length === 1 ? hits[0] : null, candidates };
}
