// server/routes/reflectionExtras.js
// アプリ向け API のうち反省の進捗とコメント(Phase 4。設計書 §6)。:id は反省 ID(body.id)。
//   GET  /api/reflections/:id/progress   {issueStage, goalDone, text}(行が無ければ null・false・null)
//   PUT  /api/reflections/:id/progress   渡したキーだけ更新(extra は保つ)
//   GET  /api/reflections/:id/comments   [{id, field, text, ts, authorUserId, authorName}](ts の古い順)
//   POST /api/reflections/:id/comments   {field, text} → 作ったコメント(201)
// 読めない反省は存在しない ID と同じ 404。public の反省は未ログインでも読める。書き込みはログインが要る(401)。
// エラーは { error: { code, message } }。
import { send } from './http.js';
import { err, readJson } from './jsonApi.js';
import { displayNameFor } from '../domain/displayName.js';
import { orgMemberEntries } from '../orgMembers.js';
import { canReadReflectionExtras, canComment, canUpdateProgress } from '../domain/policy.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isLoggedIn = (s) => !!s && (s.kind === 'user' || s.kind === 'legacy');
const strLen = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
// 進捗の部分更新の検証(issueStage は整数か null、goalDone は真偽、text は任意の JSON)。
const validProgress = (b) => isObj(b)
  && (!('issueStage' in b) || b.issueStage === null || Number.isInteger(b.issueStage))
  && (!('goalDone' in b) || typeof b.goalDone === 'boolean');

export function createReflectionExtrasRoute({ app, accounts, now = () => Date.now() }) {
  return async function reflectionExtrasRoute(req, res, ctx) {
    const { path, method } = ctx;
    if (!path.startsWith('/api/reflections/')) return false;
    if (!app) { err(res, 503, 'unavailable', 'このサーバでは使えません'); return true; }
    const m = /^\/api\/reflections\/([^/]+)\/(progress|comments)$/.exec(path);
    if (!m) return false;
    const [, rawId, kind] = m;
    const allowed = kind === 'progress' ? ['GET', 'PUT'] : ['GET', 'POST'];
    if (!allowed.includes(method)) return false;
    let reflId;
    try { reflId = decodeURIComponent(rawId); } catch { err(res, 404, 'not_found', '反省が見つかりません'); return true; }

    const subject = ctx.getSubject();
    if (subject?.orgForbidden) { err(res, 403, 'org_forbidden', '所属していない組織です'); return true; }
    const writing = method !== 'GET';
    if (writing && !isLoggedIn(subject)) { err(res, 401, 'unauthorized', 'ログインが必要です'); return true; }
    const found = app.readableReflection(subject, reflId);
    if (!found || !canReadReflectionExtras(subject, found.target)) { err(res, 404, 'not_found', '反省が見つかりません'); return true; }

    if (!writing) {
      if (kind === 'progress') { send(res, 200, app.getProgress(reflId)); return true; }
      const list = app.listComments(reflId).map((c) => ({
        ...c, authorName: c.authorUserId ? displayNameFor(accounts.getUser(c.authorUserId)) : null,
      }));
      send(res, 200, list);
      return true;
    }

    const can = kind === 'progress' ? canUpdateProgress(subject, found.target) : canComment(subject, found.target);
    if (!can) { err(res, 403, 'forbidden', '書く権限がありません'); return true; }
    let b;
    try { b = await readJson(req); } catch (e) {
      if (e.code === 'too_large') { err(res, 413, 'too_large', '本文が大きすぎます'); return true; }
      err(res, 422, 'invalid_input', 'JSON を読めません'); return true;
    }
    if (kind === 'progress') {
      if (!validProgress(b)) { err(res, 422, 'invalid_input', 'issueStage / goalDone の形が正しくありません'); return true; }
      const patch = {};
      for (const k of ['issueStage', 'goalDone', 'text']) if (k in b) patch[k] = b[k];
      send(res, 200, app.putProgress(reflId, patch, now()));
      return true;
    }
    if (!isObj(b) || !strLen(b.field, 1, 50) || !strLen(b.text, 1, 2000)) {
      err(res, 422, 'invalid_input', 'field は 1〜50 字、text は 1〜2000 字です'); return true;
    }
    const authorUserId = subject.kind === 'user' ? subject.userId : null;
    // Web と同じ名前(反省の組織での旧氏名、無ければ表示名)を付ける。Web の名前付きコメント・議事録の fullName と揃える。
    const orgId = found.target.orgId;
    const author = authorUserId
      ? ((orgId && orgMemberEntries(accounts, orgId).find((e) => e.userId === authorUserId)?.legacyName)
        || displayNameFor(accounts.getUser(authorUserId)))
      : null;
    const c = app.addComment({ reflId, field: b.field, text: b.text, authorUserId, author, ts: now() });
    send(res, 201, { ...c, authorName: authorUserId ? displayNameFor(accounts.getUser(authorUserId)) : null });
    return true;
  };
}
