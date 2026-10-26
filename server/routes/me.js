// server/routes/me.js
// アプリ向け API のうち「自分のもの」(Phase 4。設計書 §4)。
//   PUT    /api/me/reflections/:reflId   反省の保存(同じ reflId の再送は同じ結果)
//   GET    /api/me/reflections?limit=n   自分の反省(新しい順。既定 20・上限 100)
//   DELETE /api/me/reflections/:reflId   自分の反省を消す
// /api/me 自体や他の /api/me* は auth.js の担当なので false を返す。エラーは { error: { code, message } }。
import { send } from './http.js';
import { err, readJson } from './jsonApi.js';
import { practiceDateToMs } from '../repos/practiceDayFor.js';
import { displayNameFor } from '../domain/displayName.js';

const VIS = ['private', 'org', 'public'];
const REFL_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function createMeRoute({ app, accounts, now = () => Date.now() }) {
  return async function meRoute(req, res, ctx) {
    const { path, method } = ctx;
    const refl = path === '/api/me/reflections' || path.startsWith('/api/me/reflections/');
    const road = path === '/api/me/roadmap';
    if (!refl && !road) return false;
    if (!app) { err(res, 503, 'unavailable', 'このサーバでは使えません'); return true; }
    const subject = ctx.getSubject();
    if (subject?.orgForbidden) { err(res, 403, 'org_forbidden', '所属していない組織です'); return true; }
    const me = subject?.kind === 'user' ? subject : null;
    if (!me) { err(res, 401, 'unauthorized', 'ログインが必要です'); return true; }
    if (!refl) return false; // roadmap は Task 3 以降

    {
      if (path === '/api/me/reflections' && method === 'GET') {
        const raw = Number(new URL(req.url, 'http://localhost').searchParams.get('limit'));
        const limit = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 100) : 20;
        send(res, 200, app.listMyReflections(me.userId, limit));
        return true;
      }
      const m = /^\/api\/me\/reflections\/([^/]+)$/.exec(path);
      if (!m) return false;
      const reflId = decodeURIComponent(m[1]);
      if (!REFL_ID_RE.test(reflId)) { err(res, 422, 'invalid_input', '反省 ID が正しくありません'); return true; }

      if (method === 'PUT') {
        let b;
        try { b = await readJson(req); } catch (e) {
          if (e.code === 'too_large') { err(res, 413, 'too_large', '本文が大きすぎます'); return true; }
          err(res, 422, 'invalid_input', 'JSON を読めません'); return true;
        }
        if (!isObj(b)) { err(res, 422, 'invalid_input', '本文がオブジェクトではありません'); return true; }
        if (!VIS.includes(b.visibility)) { err(res, 422, 'invalid_input', 'visibility が正しくありません'); return true; }
        const firstPointMs = practiceDateToMs(b.practice);
        if (firstPointMs == null) { err(res, 422, 'invalid_input', 'practice の日付が正しくありません'); return true; }
        const body = { ...b, id: reflId, authorUserId: me.userId, origin: b.origin ?? 'app' };
        const first = Array.isArray(b.people) && typeof b.people[0] === 'string' && b.people[0].trim() ? b.people[0] : null;
        const legacyAuthorName = first ?? displayNameFor(accounts.getUser(me.userId));
        const r = app.upsertMyReflection({
          reflId, userId: me.userId, orgId: me.activeOrgId ?? null, body, visibility: b.visibility,
          legacyAuthorName, firstPointMs, now: now(),
        });
        if (!r.ok) { err(res, 409, 'conflict', '同じ ID の反省が既にあります'); return true; }
        send(res, 200, { practiceDayId: r.practiceDayId });
        return true;
      }
      if (method === 'DELETE') {
        if (!app.deleteMyReflection(reflId, me.userId, now())) { err(res, 404, 'not_found', '反省が見つかりません'); return true; }
        res.writeHead(204).end();
        return true;
      }
      return false;
    }
  };
}
