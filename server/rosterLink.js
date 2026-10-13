// server/rosterLink.js
// 名簿照合(設計書 v2 §4.4)。確認済みメールが名簿のメールと一致したユーザーを組織に紐付け、
// 名簿の「旧名簿の氏名」と一致する legacy_* のデータを本人に付け替える。
// 照合はメール確認時(linkVerifiedUser)と名簿更新時(applyRoster)の両方で行う。どちらも冪等。
// 同期関数だけ(accountsRepo.withTx の制約)。HTTP には触れない。

const emptyCounts = () => ({ reflections: 0, sessions: 0, roadmaps: 0 });
const addCounts = (a, b) => ({
  reflections: a.reflections + b.reflections, sessions: a.sessions + b.sessions, roadmaps: a.roadmaps + b.roadmaps,
});
const eligible = (u) => !!u && u.email_verified_at != null && u.deleted_at == null;

// 1人を 1 つの名簿行に照合する。新しく紐付けたら true。
// 既にメンバーで roster_id が NULL(組織の作成者)なら roster_id は付けない:
// 名簿から外れても解除されない扱いを保つ(§4.4 利用者決定)。legacy の付け替えは行う。
function linkOne(accounts, user, row, now, counts) {
  const existing = accounts.listMembershipsOfUser(user.id).find((m) => m.org_id === row.org_id);
  let newly = false;
  if (!existing) {
    accounts.linkMember({ orgId: row.org_id, userId: user.id, rosterId: row.id, now });
    newly = true;
  }
  const moved = accounts.reattachLegacy({ orgId: row.org_id, userId: user.id, legacyName: row.legacy_name });
  Object.assign(counts, addCounts(counts, moved));
  return newly;
}

// メール確認時。確認済みでなければ何もしない。{ linkedOrgIds, reattached }
export function linkVerifiedUser(accounts, user, now = Date.now()) {
  const out = { linkedOrgIds: [], reattached: emptyCounts() };
  if (!eligible(user)) return out;
  accounts.withTx(() => {
    for (const row of accounts.findRosterRowsByEmail(user.email)) {
      if (linkOne(accounts, user, row, now, out.reattached)) out.linkedOrgIds.push(row.org_id);
    }
  });
  return out;
}

// 名簿全体の置き換え→照合し直し。{ linked:[{userId,name}], unlinked:[{userId,name}], reattached }
// 重複メールは accountsRepo.replaceRoster が code='ROSTER_DUPLICATE_EMAIL' で投げる(何も変えない)。
export function applyRoster(accounts, orgId, rows, now = Date.now()) {
  const brief = (id) => ({ userId: id, name: accounts.getUser(id)?.name ?? null });
  return accounts.withTx(() => {
    const { rows: saved, detached } = accounts.replaceRoster(orgId, rows, now);
    const unlinked = [];
    for (const d of detached) {
      accounts.unlinkMember(orgId, d.userId);
      unlinked.push(brief(d.userId));
    }
    const linked = [];
    const reattached = emptyCounts();
    for (const row of saved) {
      if (!row.email) continue;
      const user = accounts.getUserByEmail(row.email);
      if (!eligible(user)) continue;
      if (linkOne(accounts, user, row, now, reattached)) linked.push(brief(user.id));
    }
    return { linked, unlinked, reattached };
  });
}
