// server/routes/practiceDays.js
// アプリ向け API のうち練習日の器(Phase 4。設計書 §7)。
//   GET   /api/practice-days?scope=mine|org|public   [{id, date, name, orgId, sessionCount, reflectionCount}](date の新しい順)
//   GET   /api/practice-days/:id                     {practiceDay: {id, date, name, orgId, webState}, sessions, reflections}
//   PATCH /api/practice-days/:id                     {webState} → {practiceDay}(注釈・表示設定の置き換え)
// 器の中身(セッション・反省)は policy の visibleDayItems で絞る。見える中身が無い器は「無い」扱い(一覧に出さない・404)。
// ただし器の組織のメンバーと、組織なしの器の持ち主本人には、中身が空でも器を見せる。
// mine・org は要ログイン(401)、public と 1 件は未ログインでも読める。エラーは { error: { code, message } }。
import { send } from './http.js';
import { err, readJson } from './jsonApi.js';
import { sessionJson, sessionTarget } from './sessions.js';
import { visibleDayItems, isMemberOfOrg } from '../domain/policy.js';

const SCOPES = ['mine', 'org', 'public'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const parseWs = (day) => {
  try { const v = JSON.parse(day.web_state); return isObj(v) ? v : {}; } catch { return {}; }
};
const dayJson = (day) => ({ id: day.id, date: day.date, name: day.legacy_name ?? null, orgId: day.org_id ?? null, webState: parseWs(day) });

export function createPracticeDaysRoute({ app, sessions, now = () => Date.now() }) {
  return async function practiceDaysRoute(req, res, ctx) {
    const { path, method } = ctx;
    if (path !== '/api/practice-days' && !path.startsWith('/api/practice-days/')) return false;
    if (!app || !sessions) { err(res, 503, 'unavailable', 'このサーバでは使えません'); return true; }
    const subject = ctx.getSubject();
    if (subject?.orgForbidden) { err(res, 403, 'org_forbidden', '所属していない組織です'); return true; }
    const me = subject?.kind === 'user' ? subject : null;

    // 器の中身のうち主体に見えるものと、器そのものを見せてよいか。見せられなければ null。
    const visibleDay = (parts) => {
      if (!parts) return null;
      const { day } = parts;
      const sTargets = parts.sessions.map((s) => sessionTarget(sessions, s));
      const rTargets = parts.reflections.map((r) => app.reflectionTarget(r));
      const seen = new Set(visibleDayItems(subject, [...sTargets, ...rTargets]));
      const ownDay = !!me && day.org_id == null && day.owner_user_id === me.userId;
      if (!seen.size && !isMemberOfOrg(subject, day.org_id) && !ownDay) return null;
      return {
        day,
        sessions: parts.sessions.filter((_, i) => seen.has(sTargets[i])),
        reflections: parts.reflections.filter((_, i) => seen.has(rTargets[i])),
      };
    };

    if (path === '/api/practice-days') {
      if (method !== 'GET') return false;
      const scope = new URL(req.url, 'http://localhost').searchParams.get('scope') || 'mine';
      if (!SCOPES.includes(scope)) { err(res, 422, 'invalid_input', 'scope は mine・org・public のどれかです'); return true; }
      if (scope !== 'public' && !me) { err(res, 401, 'unauthorized', 'ログインが必要です'); return true; }
      const orgId = me?.activeOrgId ?? null;
      if (scope === 'org' && !orgId) { send(res, 200, []); return true; }
      const out = [];
      for (const day of app.listDays({ scope, userId: me?.userId ?? null, orgId })) {
        const v = visibleDay(app.dayParts(day.id));
        if (!v) continue;
        out.push({
          id: day.id, date: day.date, name: day.legacy_name ?? null, orgId: day.org_id ?? null,
          sessionCount: v.sessions.length, reflectionCount: v.reflections.length,
        });
      }
      send(res, 200, out);
      return true;
    }

    const m = /^\/api\/practice-days\/([^/]+)$/.exec(path);
    if (!m || (method !== 'GET' && method !== 'PATCH')) return false;
    const notFound = () => err(res, 404, 'not_found', '練習日が見つかりません');
    let pdId;
    try { pdId = decodeURIComponent(m[1]); } catch { notFound(); return true; }

    if (method === 'GET') {
      const v = visibleDay(app.dayParts(pdId));
      if (!v) { notFound(); return true; }
      send(res, 200, {
        practiceDay: dayJson(v.day),
        sessions: v.sessions.map((s) => sessionJson(sessions, s)),
        reflections: v.reflections.map((r) => app.reflectionJson(r)),
      });
      return true;
    }

    // PATCH: 器の組織のメンバー、または組織なしの器の持ち主本人だけ(読めれば 403、読めなければ 404)。
    if (!me) { err(res, 401, 'unauthorized', 'ログインが必要です'); return true; }
    const v = visibleDay(app.dayParts(pdId));
    if (!v) { notFound(); return true; }
    const { day } = v;
    const can = isMemberOfOrg(subject, day.org_id) || (day.org_id == null && day.owner_user_id === me.userId);
    if (!can) { err(res, 403, 'forbidden', 'この練習日を変える権限がありません'); return true; }
    let b;
    try { b = await readJson(req); } catch (e) {
      if (e.code === 'too_large') { err(res, 413, 'too_large', '本文が大きすぎます'); return true; }
      err(res, 422, 'invalid_input', 'JSON を読めません'); return true;
    }
    if (!isObj(b) || !isObj(b.webState)) { err(res, 422, 'invalid_input', 'webState はオブジェクトです'); return true; }
    send(res, 200, { practiceDay: dayJson(app.patchDayWebState(day.id, b.webState, now())) });
    return true;
  };
}
