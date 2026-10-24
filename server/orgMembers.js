// server/orgMembers.js
// 反省・議事録・進捗のメンバー候補(互換 API の GET /api/members と議事録の取込の検証で共通)。同期関数だけ。HTTP には触れない。
// legacyName は、そのメンバーに結び付いた名簿行(roster_id。組織の作成者など無い人は、誰にも結び付いていない名簿行のうち
// メールが一致するもの)の「旧名簿の氏名」。既存の記録(旧名簿の氏名で保存された反省・進捗・ロードマップ)を引き継ぐキーに使う。
import { displayNameFor } from './domain/displayName.js';
import { normalizeEmail } from './domain/accountInput.js';
import { orgRoster, legacyMemberList } from '../src/members.js';

// [{ userId, name, legacyName }](accounts.listMembers の順)。
export function orgMemberEntries(accounts, orgId) {
  const roster = accounts.listRoster(orgId);
  const members = accounts.listMembers(orgId);
  const byId = new Map(roster.map((r) => [r.id, r]));
  const linked = new Set(members.map((m) => m.roster_id).filter(Boolean));
  const byEmail = new Map(roster.filter((r) => r.email && !linked.has(r.id)).map((r) => [r.email, r]));
  return members.map((m) => {
    const user = accounts.getUser(m.user_id) ?? { id: m.user_id };
    const row = (m.roster_id && byId.get(m.roster_id)) || (user.email ? byEmail.get(normalizeEmail(user.email)) : null);
    return { userId: m.user_id, name: displayNameFor(user), legacyName: row?.legacy_name ?? null };
  });
}

// 主体(compatPrincipal.js の resolveSubject。読み書きされるデータの組織を決めるのと同じ判定)の名簿(src/members.js の形)。
// 個人アカウントの主体で表示中の組織があればその組織のメンバー、それ以外(共有ログイン・閲覧ゲートの Cookie がある Web・
// ファイル版)は従来の名簿。画面の候補と取込の検証をこの1つの判定にそろえる。
// 個人アカウントで組織に所属していない(表示中の組織が無い)主体は空(従来の名簿=実在の部員名を見せない)。
export function rosterForSubject(accounts, subject, activeOrgId) {
  if (!accounts || subject?.kind !== 'user') return legacyMemberList();
  if (!activeOrgId) return [];
  return orgRoster(orgMemberEntries(accounts, activeOrgId));
}
