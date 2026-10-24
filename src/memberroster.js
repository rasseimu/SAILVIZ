// src/memberroster.js
// 反省・議事録・進捗のメンバー候補を、表示中の組織に所属するアカウントにする(DOM 非依存の非同期グルー)。
// 個人アカウントでログインしていなければ(共有ログイン・ファイル版)何もせず、従来の名簿(members.js の MEMBERS)のまま。
import { apiMe, apiOrgMembers } from './api.js';
import { resolveActiveOrg } from './activeorg.js';
import { orgRoster, setMemberRoster } from './members.js';

// orgId の組織のメンバーを名簿にする。取れなければ(未ログイン・非メンバー・通信失敗)従来の名簿のまま。組織の名簿にできたら true。
export async function loadOrgMemberRoster(orgId) {
  if (!orgId) return false;
  try {
    const roster = orgRoster(await apiOrgMembers(orgId));
    if (!roster.length) return false;
    setMemberRoster(roster);
    return true;
  } catch {
    return false;
  }
}

// /api/me から表示中の組織を決めて、その組織のメンバーを名簿にする(スマホ議事録ページなど me を持たない画面用)。
export async function loadActiveOrgMemberRoster() {
  try {
    const me = await apiMe();
    return me ? loadOrgMemberRoster(resolveActiveOrg(me.orgs)) : false;
  } catch {
    return false;
  }
}
