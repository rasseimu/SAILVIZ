// server/domain/videoComments.js
// 動画の瞬間コメント(②練習動画 scope 'practice'。③勉強動画 scope 'study')の純関数。DB・HTTP に触れない。
// 設計書 docs/superpowers/specs/2026-10-28-video-moment-comments-design.md。
//
// コメント(comment)は repo の形 { id, orgId, scope, practiceDayId, videoKey, videoName, positionMs, text, authorUserId, ... }。
// 主体(subject)は policy.js の形(user / legacy / null)。
// 未知の scope は読めない・書けない・消せない(deny by default)。
import { videoKey } from '../../src/videolink.js';
import { canSeeProject, inScope } from './compatAccess.js';
import { isMemberOfOrg, activeOrgOf } from './policy.js';

export const VIDEO_COMMENT_SCOPES = ['practice', 'study'];
export const MAX_COMMENT_TEXT = 1000;
export const MAX_VIDEO_NAME = 255;
export const MAX_POSITION_MS = 86_400_000; // 24 時間

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isUser = (s) => !!s && s.kind === 'user' && s.userId != null && !s.orgForbidden;

// 練習動画のキー。①の videoKey(name と整数 ms の t の JSON 配列)と同じなので、名前に何が入っても衝突しない。
export const practiceVideoKey = (name, t) => videoKey({ name, t });

// 練習動画のキーから t(整数 ms)を取り出す。形が違えば null。
export function practiceVideoTOf(key) {
  try {
    const a = JSON.parse(key);
    return Array.isArray(a) && a.length === 2 && Number.isSafeInteger(a[1]) ? a[1] : null;
  } catch { return null; }
}

// 勉強動画(③)のキー。名前 + ファイルサイズ(バイト)の JSON 配列なので、名前に何が入っても衝突しない。
// フォルダの場所は含めない(フォルダを移動・改名してもコメントが付いたまま)。src/studyfolder.js の studyKey と同じ形。
// 名前は NFC にそろえる(macOS の同期フォルダの NFD の名前と Windows の NFC の名前を同じ動画にする)。
export const normalizeStudyVideoName = (name) => String(name).normalize('NFC');
export const studyVideoKey = (name, size) => JSON.stringify([normalizeStudyVideoName(name), size]);

// 勉強動画のキーからサイズ(バイト)を取り出す。形が違えば null。
export function studyVideoSizeOf(key) {
  try {
    const a = JSON.parse(key);
    return Array.isArray(a) && a.length === 2 && typeof a[0] === 'string' && Number.isSafeInteger(a[1]) && a[1] >= 0 ? a[1] : null;
  } catch { return null; }
}

// 本文の検証。問題があれば理由の文字列、なければ null。長さは JS の .length(UTF-16)で数える。
export function validateCommentText(text) {
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_COMMENT_TEXT || !text.trim()) {
    return `text は 1〜${MAX_COMMENT_TEXT} 字(空白だけは不可)です`;
  }
  return null;
}

// 再生位置(ms)の検証。scope 共通(③でも使う)。
export const validPositionMs = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_POSITION_MS;
export const validVideoName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_VIDEO_NAME;

// 練習動画への新しいコメントの本文 { videoName, videoT, positionMs, text } の検証。問題があれば理由の文字列、なければ null。
// 動画が練習の videos にあるかは見ない(動画の一覧と独立に保存する。消した動画を足し直してもコメントが戻る)。
export function validateNewPracticeComment(body) {
  if (!isObj(body)) return '本文は { videoName, videoT, positionMs, text } です';
  if (!validVideoName(body.videoName)) return `videoName は 1〜${MAX_VIDEO_NAME} 字です`;
  if (!(Number.isSafeInteger(body.videoT) && body.videoT >= 0)) return 'videoT は 0 以上の整数(ms)です';
  if (!validPositionMs(body.positionMs)) return `positionMs は 0〜${MAX_POSITION_MS} の整数(ms)です`;
  return validateCommentText(body.text);
}

// 勉強動画への新しいコメントの本文 { videoName, videoSize, positionMs, text } の検証。問題があれば理由の文字列、なければ null。
// 勉強動画は長さの上限を設けない(positionMs は 0 以上の安全な整数)。
export function validateNewStudyComment(body) {
  if (!isObj(body)) return '本文は { videoName, videoSize, positionMs, text } です';
  // 長さは保存する形(NFC)で数える。
  if (typeof body.videoName !== 'string' || !validVideoName(normalizeStudyVideoName(body.videoName))) return `videoName は 1〜${MAX_VIDEO_NAME} 字です`;
  if (!(Number.isSafeInteger(body.videoSize) && body.videoSize >= 0)) return 'videoSize は 0 以上の整数(バイト)です';
  if (!(Number.isSafeInteger(body.positionMs) && body.positionMs >= 0)) return 'positionMs は 0 以上の整数(ms)です';
  return validateCommentText(body.text);
}

// 勉強動画のコメント(組織 orgId のもの)を読めるか。表示中の組織が orgId で、そのメンバー
// (ログインアカウント、または自組織の共有ログイン)だけ。所属外ヘッダー(orgForbidden)・組織の無い主体は読めない。
export function canReadStudyComments(subject, orgId) {
  if (orgId == null || !subject || subject.orgForbidden) return false;
  return activeOrgOf(subject) === orgId && isMemberOfOrg(subject, orgId);
}

// 勉強動画にコメントを書けるか。ログインアカウント(user 主体)で読める人。共有ログインは書けない。
export function canWriteStudyComment(subject, orgId) {
  return isUser(subject) && canReadStudyComments(subject, orgId);
}

// 練習のコメントを読めるか。練習を読める(canSeeProject)主体のうち、その練習の組織のメンバー
// (表示中の組織がその組織のユーザー、または自組織の共有ログイン)だけ。
// 他組織の public 練習を読める主体や、組織の無い練習(org_id NULL)では読めない(書いた人の名前を組織の外に出さない)。
export function canReadPracticeComments(subject, access) {
  if (!access || access.orgId == null) return false;
  if (!canSeeProject(subject, access)) return false;
  return inScope(subject, access.orgId) && isMemberOfOrg(subject, access.orgId);
}

// 練習にコメントを書けるか。ログインアカウント(user 主体)で、その練習の組織が表示中の組織のメンバー。
// 共有ログインは個人を特定できないので書けない。
export function canWritePracticeComment(subject, access) {
  return isUser(subject) && canReadPracticeComments(subject, access);
}

// コメントの scope ごとの「読めるか」。practice は練習の access(getProjectAccess の結果)で判定する。
// study はコメントの組織が表示中の組織で、そのメンバーか。未知の scope は false。
export function canReadVideoComment(subject, comment, { practiceAccess } = {}) {
  if (!comment) return false;
  switch (comment.scope) {
    case 'practice':
      return !!practiceAccess && practiceAccess.orgId === comment.orgId && canReadPracticeComments(subject, practiceAccess);
    case 'study':
      return canReadStudyComments(subject, comment.orgId);
    default:
      return false;
  }
}

const knownScope = (c) => !!c && VIDEO_COMMENT_SCOPES.includes(c.scope);

// 編集は書いた本人だけ(ログインアカウント)。管理者も他人のコメントは書き換えない。
export function canEditVideoComment(subject, comment) {
  return knownScope(comment) && isUser(subject) && comment.authorUserId === subject.userId;
}

// 削除は書いた本人、またはそのコメントの組織の管理者(isOrgAdmin)で、その組織に所属している人。
// 共有ログインは消せない。
export function canDeleteVideoComment(subject, comment, { isOrgAdmin = false } = {}) {
  if (!knownScope(comment) || !isUser(subject)) return false;
  if (comment.authorUserId === subject.userId) return true;
  return !!isOrgAdmin && (subject.orgIds || []).includes(comment.orgId);
}
