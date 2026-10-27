// server/routes/studyComments.js
// 勉強動画(プロ動画)の瞬間コメント(③。設計書 docs/superpowers/specs/2026-10-28-pro-video-study-page-design.md)。
//   GET  /api/study-comments  → { comments: [...動画キー → 位置順。最大 5000 件], canWrite }
//   POST /api/study-comments  本文 { videoName, videoSize, positionMs, text } → 作ったコメント(201)
// 編集・削除は②の PATCH / DELETE /api/video-comments/:cid を共用する(scope 'study' の行は表示中の組織のメンバーだけ)。
// コメントは表示中の組織(activeOrgOf)のもの。表は②の video_comments(scope 'study'、practice_day_id NULL)。
// 動画は 名前 + ファイルサイズ で指す(フォルダの場所は見ない)。コメントの形は②と同じで videoSize が付く。
// 判定順: 503(ファイル版)→ 401(未ログイン)→ 403 org_forbidden(所属外ヘッダー)→ 403 no_org(組織が無い)
//   → POST は 403 forbidden(共有ログイン)→ 422(本文)。エラーは { error: { code, message } }。
import { send } from './http.js';
import { err } from './jsonApi.js';
import { activeOrgOf } from '../domain/policy.js';
import {
  studyVideoKey, normalizeStudyVideoName, validateNewStudyComment, canReadStudyComments, canWriteStudyComment,
} from '../domain/videoComments.js';
import { createCommentPresenter, readCommentBody } from './videoComments.js';

export const STUDY_COMMENTS_LIMIT = 5000;
const PATH = '/api/study-comments';

export function createStudyCommentsRoute({ repo, accounts, now = () => Date.now(), limit = STUDY_COMMENTS_LIMIT }) {
  const available = !!repo && !!accounts;
  const { nameResolver, isAdminOf, toApi } = createCommentPresenter(accounts);

  return async function studyCommentsRoute(req, res, ctx) {
    const { path, method } = ctx;
    if (path !== PATH || (method !== 'GET' && method !== 'POST')) return false;
    if (!available) { err(res, 503, 'unavailable', 'このサーバでは使えません'); return true; }
    const subject = ctx.getSubject();
    if (!subject) { err(res, 401, 'unauthorized', 'ログインが必要です'); return true; }
    if (subject.orgForbidden) { err(res, 403, 'org_forbidden', '所属していない組織です'); return true; }
    const orgId = activeOrgOf(subject);
    if (!canReadStudyComments(subject, orgId)) { err(res, 403, 'no_org', '組織のメンバーだけが使えます'); return true; }

    if (method === 'GET') {
      const nameOf = nameResolver(orgId);
      const isOrgAdmin = isAdminOf(subject, orgId);
      const comments = repo.listStudy(orgId, limit).map((c) => toApi(c, subject, nameOf, isOrgAdmin));
      send(res, 200, { comments, canWrite: canWriteStudyComment(subject, orgId) });
      return true;
    }

    if (!canWriteStudyComment(subject, orgId)) { err(res, 403, 'forbidden', 'コメントを書く権限がありません'); return true; }
    const got = await readCommentBody(req, res); if (!got) return true;
    const bad = validateNewStudyComment(got.body);
    if (bad) { err(res, 422, 'invalid_input', bad); return true; }
    const b = got.body;
    const videoName = normalizeStudyVideoName(b.videoName); // キーも表示名も NFC で保存する
    const c = repo.insert({
      orgId, scope: 'study', practiceDayId: null,
      videoKey: studyVideoKey(videoName, b.videoSize), videoName,
      positionMs: b.positionMs, text: b.text, authorUserId: subject.userId, now: now(),
    });
    send(res, 201, toApi(c, subject, nameResolver(orgId), isAdminOf(subject, orgId)));
    return true;
  };
}
