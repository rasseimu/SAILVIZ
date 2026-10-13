// server/routes/orgs.js
// 組織の名簿・メンバー API(設計書 v2 §10.3): /api/orgs/:orgId/roster(GET/PUT)・/api/orgs/:orgId/members(GET)。
// 組織の作成(POST /api/orgs)は routes/auth.js。処理したら true、対象外なら false。
// GET の応答は設計書 §10.3 どおり素の配列。PUT の本文は { roster:[...] }、応答は { linked, unlinked }。
import { send } from './http.js';
import { resolveIdentity } from '../accountAuth.js';
import { validateRosterRows } from '../domain/rosterInput.js';
import { applyRoster } from '../rosterLink.js';

const MAX_BODY = 512 * 1024; // 1000 行の名簿が収まる大きさ
const err = (res, status, code, message) => send(res, status, { error: { code, message } });

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { const e = new Error('too large'); e.code = 'too_large'; throw e; }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createOrgsRoute({ accounts, writeToken, now = () => Date.now() }) {
  // 認証→組織の存在→権限。失敗したら応答を送って null。
  const gate = (req, res, orgId, need) => {
    const id = resolveIdentity(req, { writeToken, repo: accounts, now: now() });
    if (id?.kind !== 'user') { err(res, 401, 'unauthorized', 'ログインが必要です'); return null; }
    if (!accounts.getOrg(orgId)) { err(res, 404, 'not_found', '組織が見つかりません'); return null; }
    const ok = need === 'admin' ? accounts.isOrgAdmin(orgId, id.user.id) : accounts.isMember(orgId, id.user.id);
    if (!ok) {
      err(res, 403, 'forbidden', need === 'admin' ? '組織管理者のみ操作できます' : '組織メンバーのみ見られます');
      return null;
    }
    return id;
  };

  const handlers = {
    'GET roster': async (req, res, orgId) => {
      if (!gate(req, res, orgId, 'admin')) return;
      const linked = new Map(accounts.listMembers(orgId).filter((m) => m.roster_id).map((m) => [m.roster_id, m.user_id]));
      send(res, 200, accounts.listRoster(orgId).map((r) => ({
        name: r.name, email: r.email, legacyName: r.legacy_name, linkedUserId: linked.get(r.id) ?? null,
      })));
    },
    'PUT roster': async (req, res, orgId) => {
      if (!gate(req, res, orgId, 'admin')) return;
      let body;
      try { body = await readJson(req); } catch (e) {
        return err(res, 422, 'invalid_input', e && e.code === 'too_large' ? '本文が大きすぎます' : 'JSON を読めません');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return err(res, 422, 'invalid_input', '本文は JSON オブジェクトにしてください');
      }
      const v = validateRosterRows(body.roster);
      if (!v.ok) return err(res, 422, 'invalid_input', v.message);
      let out;
      try { out = applyRoster(accounts, orgId, v.rows, now()); } catch (e) {
        if (e && e.code === 'ROSTER_DUPLICATE_EMAIL') return err(res, 422, 'invalid_input', 'メールアドレスが重複しています');
        throw e;
      }
      send(res, 200, { linked: out.linked, unlinked: out.unlinked });
    },
    'GET members': async (req, res, orgId) => {
      if (!gate(req, res, orgId, 'member')) return;
      send(res, 200, accounts.listMembers(orgId).map((m) => ({ userId: m.user_id, name: accounts.getUser(m.user_id)?.name ?? null })));
    },
  };

  return async function orgsRoute(req, res, ctx) {
    const m = /^\/api\/orgs\/([^/]+)\/(roster|members)$/.exec(ctx.path);
    if (!m) return false;
    const h = handlers[`${ctx.method} ${m[2]}`];
    if (!h) return false;
    let orgId;
    try { orgId = decodeURIComponent(m[1]); } catch { err(res, 404, 'not_found', '組織が見つかりません'); return true; }
    await h(req, res, orgId);
    return true;
  };
}
