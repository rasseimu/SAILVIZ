// server/routes/videoComments.js
// 動画の瞬間コメント(②。設計書 docs/superpowers/specs/2026-10-28-video-moment-comments-design.md)。
//   GET    /api/projects/:id/video-comments  → { comments: [...位置順], canWrite }
//   POST   /api/projects/:id/video-comments  本文 { videoName, videoT, positionMs, text } → 作ったコメント(201)
//   PATCH  /api/video-comments/:cid          本文 { text } → 更新後(本人だけ。練習・勉強動画で共用)
//   DELETE /api/video-comments/:cid          → { ok: true }(本人か組織の管理者)
// コメントの形: { id, videoName, videoT, positionMs, text, authorUserId, authorName, createdAt, updatedAt, canEdit, canDelete }。
// 練習を読めるかは互換 API と同じ判定(store.getProjectAccess + canSeeProject。点列は読まない)。
// コメントを読めるのはその練習の組織のメンバーだけ。練習は読めるが組織の外の主体には空の一覧を返す。
// ③(勉強動画)の一覧・作成は routes/studyComments.js。PATCH / DELETE はここを共用し、scope 'study' の行は
// 表示中の組織のメンバーだけが読める(canReadVideoComment)。他組織・表示中でない組織の行は 404。
// ファイル版(repo か store.getProjectAccess が無い)はパスが一致した時点で 503。エラーは { error: { code, message } }。
import { send } from './http.js';
import { err, readJson } from './jsonApi.js';
import { isValidProjectId } from '../storage.js';
import { displayNameFor } from '../domain/displayName.js';
import { orgMemberEntries } from '../orgMembers.js';
import { canSeeProject } from '../domain/compatAccess.js';
import {
  practiceVideoKey, practiceVideoTOf, studyVideoSizeOf, validateNewPracticeComment, validateCommentText,
  canReadPracticeComments, canWritePracticeComment, canReadVideoComment, canEditVideoComment, canDeleteVideoComment,
} from '../domain/videoComments.js';

const PRACTICE_RE = /^\/api\/projects\/([^/]+)\/video-comments$/;
const COMMENT_RE = /^\/api\/video-comments\/([^/]+)$/;

const decode = (raw) => { try { return decodeURIComponent(raw); } catch { return null; } };

// コメントを API の形にする部品(③の routes/studyComments.js と共用)。
//   nameResolver(orgId) → (userId) → 書いた人の名前 / isAdminOf(subject, orgId) / toApi(c, subject, nameOf, isOrgAdmin)
export function createCommentPresenter(accounts) {
  // 書いた人の名前: その組織での旧氏名(名簿)、無ければ表示名。リクエストごとに1回だけ名簿を引く。
  // 組織を抜けた人・退会した人は表示名(退会者は displayNameFor の匿名表示)のまま。名前は表に保存しない。
  const nameResolver = (orgId) => {
    const legacy = new Map(orgMemberEntries(accounts, orgId).map((e) => [e.userId, e.legacyName]));
    const cache = new Map();
    return (uid) => {
      if (!cache.has(uid)) cache.set(uid, legacy.get(uid) || displayNameFor(accounts.getUser(uid) ?? { id: uid }));
      return cache.get(uid);
    };
  };
  const isAdminOf = (subject, orgId) => subject?.kind === 'user' && !!accounts.isOrgAdmin(orgId, subject.userId);
  // API で返す形。canEdit / canDelete は主体から計算する(画面はこれでボタンを出し分ける)。
  // 勉強動画(scope 'study')は videoSize も付ける(練習の形は変えない)。
  const toApi = (c, subject, nameOf, isOrgAdmin) => ({
    id: c.id,
    videoName: c.videoName,
    videoT: c.scope === 'practice' ? practiceVideoTOf(c.videoKey) : null,
    ...(c.scope === 'study' ? { videoSize: studyVideoSizeOf(c.videoKey) } : {}),
    positionMs: c.positionMs,
    text: c.text,
    authorUserId: c.authorUserId,
    authorName: nameOf(c.authorUserId),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    canEdit: canEditVideoComment(subject, c),
    canDelete: canDeleteVideoComment(subject, c, { isOrgAdmin }),
  });
  return { nameResolver, isAdminOf, toApi };
}

// 本文(JSON)を読む。読めなければ 413 / 422 を返して null。
export async function readCommentBody(req, res) {
  try { return { body: await readJson(req) }; } catch (e) {
    if (e.code === 'too_large') err(res, 413, 'too_large', '本文が大きすぎます');
    else err(res, 422, 'invalid_input', 'JSON を読めません');
    return null;
  }
}

export function createVideoCommentsRoute({ repo, accounts, store, now = () => Date.now() }) {
  const available = !!repo && !!accounts && !!store && typeof store.getProjectAccess === 'function';
  const { nameResolver, isAdminOf, toApi } = createCommentPresenter(accounts);
  // コメントの scope に応じた「読めるか」の材料。
  const accessFor = (c) => (c.scope === 'practice' && c.practiceDayId ? { practiceAccess: store.getProjectAccess(c.practiceDayId) } : {});

  async function practiceRoute(req, res, ctx, rawId) {
    const { method } = ctx;
    const id = decode(rawId);
    if (id == null || !isValidProjectId(id)) { err(res, 404, 'not_found', '練習が見つかりません'); return true; }
    const subject = ctx.getSubject();
    if (subject?.orgForbidden) { err(res, 403, 'org_forbidden', '所属していない組織です'); return true; }
    if (!subject) { err(res, 401, 'unauthorized', 'ログインが必要です'); return true; }
    const access = store.getProjectAccess(id);
    if (!access || !canSeeProject(subject, access)) { err(res, 404, 'not_found', '練習が見つかりません'); return true; }

    if (method === 'GET') {
      // 練習は読めるが組織の外の主体(他組織の public 練習・組織の無い練習)には、名前を出さないよう空で返す。
      if (!canReadPracticeComments(subject, access)) { send(res, 200, { comments: [], canWrite: false }); return true; }
      const nameOf = nameResolver(access.orgId);
      const isOrgAdmin = isAdminOf(subject, access.orgId);
      const comments = repo.listByPracticeDay(id)
        .filter((c) => c.orgId === access.orgId)
        .map((c) => toApi(c, subject, nameOf, isOrgAdmin));
      send(res, 200, { comments, canWrite: canWritePracticeComment(subject, access) });
      return true;
    }

    if (!canWritePracticeComment(subject, access)) { err(res, 403, 'forbidden', 'コメントを書く権限がありません'); return true; }
    const got = await readCommentBody(req, res); if (!got) return true;
    const bad = validateNewPracticeComment(got.body);
    if (bad) { err(res, 422, 'invalid_input', bad); return true; }
    const b = got.body;
    const c = repo.insert({
      orgId: access.orgId, scope: 'practice', practiceDayId: id,
      videoKey: practiceVideoKey(b.videoName, b.videoT), videoName: b.videoName,
      positionMs: b.positionMs, text: b.text, authorUserId: subject.userId, now: now(),
    });
    send(res, 201, toApi(c, subject, nameResolver(access.orgId), isAdminOf(subject, access.orgId)));
    return true;
  }

  async function commentRoute(req, res, ctx, rawId) {
    const { method } = ctx;
    const subject = ctx.getSubject();
    if (!subject) { err(res, 401, 'unauthorized', 'ログインが必要です'); return true; }
    if (subject.orgForbidden) { err(res, 403, 'org_forbidden', '所属していない組織です'); return true; }
    const cid = decode(rawId);
    const c = cid == null ? null : repo.get(cid);
    // 無いコメントと読めないコメント(練習を読めない・組織の外・練習が消えた)は同じ 404。
    if (!c || !canReadVideoComment(subject, c, accessFor(c))) { err(res, 404, 'not_found', 'コメントが見つかりません'); return true; }
    const isOrgAdmin = isAdminOf(subject, c.orgId);

    if (method === 'DELETE') {
      if (!canDeleteVideoComment(subject, c, { isOrgAdmin })) { err(res, 403, 'forbidden', 'コメントを消す権限がありません'); return true; }
      repo.remove(c.id);
      send(res, 200, { ok: true });
      return true;
    }

    if (!canEditVideoComment(subject, c)) { err(res, 403, 'forbidden', 'コメントを書き換える権限がありません'); return true; }
    const got = await readCommentBody(req, res); if (!got) return true;
    const b = got.body;
    const bad = b && typeof b === 'object' && !Array.isArray(b) ? validateCommentText(b.text) : '本文は { text } です';
    if (bad) { err(res, 422, 'invalid_input', bad); return true; }
    const updated = repo.updateText(c.id, b.text, now());
    if (!updated) { err(res, 404, 'not_found', 'コメントが見つかりません'); return true; }
    send(res, 200, toApi(updated, subject, nameResolver(updated.orgId), isOrgAdmin));
    return true;
  }

  return async function videoCommentsRoute(req, res, ctx) {
    const { path, method } = ctx;
    const pm = PRACTICE_RE.exec(path);
    const cm = pm ? null : COMMENT_RE.exec(path);
    if (!pm && !cm) return false;
    if (!available) { err(res, 503, 'unavailable', 'このサーバでは使えません'); return true; }
    if (pm) {
      if (method !== 'GET' && method !== 'POST') return false;
      return practiceRoute(req, res, ctx, pm[1]);
    }
    if (method !== 'PATCH' && method !== 'DELETE') return false;
    return commentRoute(req, res, ctx, cm[1]);
  };
}
