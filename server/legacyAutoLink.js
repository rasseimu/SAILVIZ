// server/legacyAutoLink.js
// 旧名簿の氏名への自動の結び付け。旧データを取り込んだ組織(MIGRATION_ORG_ID)のメンバーで、
// 氏名(空白を除く)が未付け替えの旧氏名とちょうど 1 つ一致したら、その旧氏名の反省・記録・ロードマップを本人に付け替える。
// 登録・ログイン・招待での参加・氏名の変更・GET /api/me で呼ぶ(冪等。結び付け済みなら何もしない)。
// ほかの組織に同姓同名がいても対象は取込み組織の記録だけ(reattachLegacy が組織で絞る)。同期関数だけ。HTTP には触れない。
import { orgMemberEntries } from './orgMembers.js';
import { legacyClaimView } from './domain/legacyClaim.js';

// 結び付けたら { legacyName, moved }、何もしなければ null。
export function autoLinkLegacy(accounts, migrationOrgId, userId) {
  if (!accounts || !migrationOrgId || !userId) return null;
  if (!accounts.isMember(migrationOrgId, userId)) return null;
  const user = accounts.getUser(userId);
  if (!user || user.deleted_at != null) return null;
  return accounts.withTx(() => {
    const view = legacyStatus(accounts, migrationOrgId, user);
    if (view.linked || !view.suggested) return null;
    const moved = accounts.reattachLegacy({ orgId: migrationOrgId, userId, legacyName: view.suggested });
    return { legacyName: view.suggested, moved };
  });
}

// 本人の結び付きの状態 { linked, suggested, candidates }(server/domain/legacyClaim.js)。
export function legacyStatus(accounts, orgId, user) {
  const entries = orgMemberEntries(accounts, orgId);
  return legacyClaimView({
    names: accounts.listLegacyNames(orgId),
    userId: user.id,
    userName: user.name,
    linked: entries.find((e) => e.userId === user.id)?.legacyName ?? null,
    takenByOthers: new Set(entries.filter((e) => e.userId !== user.id && e.legacyName).map((e) => e.legacyName)),
  });
}
