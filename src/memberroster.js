// src/memberroster.js
// 反省・議事録・進捗のメンバー候補を、サーバーが決めた名簿(GET /api/members)にする(DOM 非依存の非同期グルー)。
// サーバーは読み書きの主体と同じ判定で名簿を返す: 個人アカウントで表示中の組織があればそのメンバー、
// 共有ログイン・閲覧ゲートの Cookie がある Web・ファイル版は従来の名簿(members.js の MEMBERS)。
// 組織に所属していないアカウントには空の名簿が返り、そのまま空にする(従来の名簿へ戻さない)。
// 取れなければ(未ログイン・通信失敗)従来の名簿のまま。
import { apiMembers } from './api.js';
import { setMemberRoster } from './members.js';

// 名簿を読み込む。サーバーの名簿にできたら true。
export async function loadMemberRoster() {
  try {
    const list = await apiMembers();
    if (!Array.isArray(list)) return false;
    setMemberRoster(list);
    return true;
  } catch {
    return false;
  }
}
