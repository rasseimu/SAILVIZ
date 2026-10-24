// server/orgMembers.js
// 組織のメンバー一覧(GET /api/orgs/:orgId/members と、議事録の取込で使う名簿)。同期関数だけ。HTTP には触れない。
// legacyName は、そのメンバーに結び付いた名簿行(roster_id。組織の作成者など無い人はメールが一致する名簿行)の
// 「旧名簿の氏名」。既存の記録(旧名簿の氏名で保存された反省・進捗・ロードマップ)を引き継ぐキーに使う。
import { displayNameFor } from './domain/displayName.js';
import { normalizeEmail } from './domain/accountInput.js';
import { orgRoster, legacyMemberList } from '../src/members.js';

// [{ userId, name, legacyName }](accounts.listMembers の順)。
export function orgMemberEntries(accounts, orgId) {
  const roster = accounts.listRoster(orgId);
  const byId = new Map(roster.map((r) => [r.id, r]));
  const byEmail = new Map(roster.filter((r) => r.email).map((r) => [r.email, r]));
  return accounts.listMembers(orgId).map((m) => {
    const user = accounts.getUser(m.user_id) ?? { id: m.user_id };
    const row = (m.roster_id && byId.get(m.roster_id)) || (user.email ? byEmail.get(normalizeEmail(user.email)) : null);
    return { userId: m.user_id, name: displayNameFor(user), legacyName: row?.legacy_name ?? null };
  });
}

// 議事録の取込で使う名簿(src/members.js の形)。個人アカウントで表示中の組織があればその組織のメンバー、
// それ以外(共有ログイン・ファイル版)は従来の名簿。
export function rosterForSubject(accounts, subject, activeOrgId) {
  if (!accounts || subject?.kind !== 'user' || !activeOrgId) return legacyMemberList();
  return orgRoster(orgMemberEntries(accounts, activeOrgId));
}
