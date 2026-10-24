// server/routes/orgs.js
// 組織の名簿・メンバー API(設計書 v2 §10.3): /api/orgs/:orgId/roster(GET/PUT)・/api/orgs/:orgId/members(GET)。
// 組織の作成(POST /api/orgs)は routes/auth.js。処理したら true、対象外なら false。
// GET の応答は設計書 §10.3 どおり素の配列。PUT の本文は { roster:[...] }、応答は { linked, unlinked }。
import { send } from './http.js';
import { resolveIdentity } from '../accountAuth.js';
import { validateRosterRows } from '../domain/rosterInput.js';
import { applyRoster } from '../rosterLink.js';
import { displayNameFor } from '../domain/displayName.js';
import { inviteStatus, validateInviteInput, expiresAtFromDays } from '../domain/invites.js';

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

export function createOrgsRoute({
  accounts, writeToken, now = () => Date.now(), baseUrl = 'http://localhost:8000',
}) {
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
      const admins = new Set(accounts.listOrgAdmins(orgId));
      send(res, 200, accounts.listMembers(orgId).map((m) => ({
        userId: m.user_id,
        name: displayNameFor(accounts.getUser(m.user_id) ?? { id: m.user_id }),
        isAdmin: admins.has(m.user_id),
      })));
    },
  };

  // ---- 招待コード(S2.9 / H13)----
  const inviteUrl = (code) => `${String(baseUrl).replace(/\/+$/, '')}/?invite=${encodeURIComponent(code)}`;
  const dto = (i) => ({ id: i.id, code: i.code, url: inviteUrl(i.code), expiresAt: i.expires_at, maxUses: i.max_uses });
  const REASON_MESSAGE = {
    revoked: '招待は失効しています', expired: '招待の有効期限が切れています', exhausted: '招待の利用上限に達しています',
  };
  // 要ログイン。失敗したら応答を送って null。
  // メール確認は求めない(招待リンクからの登録で確認前に参加するのと同じ扱い。招待リンク自体が参加の許可)。
  const loggedInUser = (req, res) => {
    const id = resolveIdentity(req, { writeToken, repo: accounts, now: now() });
    if (id?.kind !== 'user') { err(res, 401, 'unauthorized', 'ログインが必要です'); return null; }
    return id;
  };

  const inviteHandlers = {
    'POST invites': async (req, res, orgId) => {
      const id = gate(req, res, orgId, 'admin'); if (!id) return;
      let body;
      try { body = await readJson(req); } catch (e) {
        return err(res, 422, 'invalid_input', e && e.code === 'too_large' ? '本文が大きすぎます' : 'JSON を読めません');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return err(res, 422, 'invalid_input', '本文は JSON オブジェクトにしてください');
      }
      const v = validateInviteInput(body);
      if (!v.ok) return err(res, 422, 'invalid_input', v.message);
      const t = now();
      const inv = accounts.createInvite({
        orgId, createdByUserId: id.user.id, expiresAt: expiresAtFromDays(v.expiresInDays, t), maxUses: v.maxUses, now: t,
      });
      send(res, 201, dto(inv));
    },
    'GET invites': async (req, res, orgId) => {
      if (!gate(req, res, orgId, 'admin')) return;
      send(res, 200, accounts.listActiveInvites(orgId, now()).map((i) => ({ ...dto(i), useCount: i.use_count })));
    },
  };

  async function handleInviteRevoke(req, res, orgId, inviteId) {
    if (!gate(req, res, orgId, 'admin')) return;
    const inv = accounts.getInvite(inviteId);
    if (!inv || inv.org_id !== orgId) return err(res, 404, 'not_found', '招待が見つかりません');
    accounts.revokeInvite(orgId, inviteId, now()); // 既に失効済みでも ok(冪等)
    send(res, 200, { ok: true });
  }

  async function handleInvitePreview(req, res, code) {
    if (!loggedInUser(req, res)) return;
    const inv = accounts.getInviteByCode(code);
    const org = inv && accounts.getOrg(inv.org_id);
    if (!inv || !org) return err(res, 404, 'not_found', '招待が見つかりません');
    const status = inviteStatus(inv, now());
    send(res, 200, status === 'valid'
      ? { orgId: org.id, orgName: org.name, valid: true }
      : { orgId: org.id, orgName: org.name, valid: false, reason: status });
  }

  async function handleInviteAccept(req, res, code) {
    const id = loggedInUser(req, res); if (!id) return;
    const inv = accounts.getInviteByCode(code);
    if (!inv || !accounts.getOrg(inv.org_id)) return err(res, 404, 'not_found', '招待が見つかりません');
    const r = accounts.acceptInvite({ code, userId: id.user.id, now: now() });
    if (r.status === 'joined' || r.status === 'already') return send(res, 200, { orgId: r.orgId });
    if (r.status === 'not_found') return err(res, 404, 'not_found', '招待が見つかりません');
    return err(res, 410, `invite_${r.status}`, REASON_MESSAGE[r.status]);
  }

  const dec = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

  return async function orgsRoute(req, res, ctx) {
    let m = /^\/api\/invites\/([^/]+)(\/accept)?$/.exec(ctx.path);
    if (m) {
      const code = dec(m[1]);
      const accept = !!m[2];
      if (!((accept && ctx.method === 'POST') || (!accept && ctx.method === 'GET'))) return false;
      if (code === null) { err(res, 404, 'not_found', '招待が見つかりません'); return true; }
      await (accept ? handleInviteAccept : handleInvitePreview)(req, res, code);
      return true;
    }
    m = /^\/api\/orgs\/([^/]+)\/invites\/([^/]+)\/revoke$/.exec(ctx.path);
    if (m) {
      if (ctx.method !== 'POST') return false;
      const orgId = dec(m[1]); const inviteId = dec(m[2]);
      if (orgId === null || inviteId === null) { err(res, 404, 'not_found', '組織が見つかりません'); return true; }
      await handleInviteRevoke(req, res, orgId, inviteId);
      return true;
    }
    m = /^\/api\/orgs\/([^/]+)\/(roster|members|invites)$/.exec(ctx.path);
    if (!m) return false;
    const h = handlers[`${ctx.method} ${m[2]}`] || inviteHandlers[`${ctx.method} ${m[2]}`];
    if (!h) return false;
    const orgId = dec(m[1]);
    if (orgId === null) { err(res, 404, 'not_found', '組織が見つかりません'); return true; }
    await h(req, res, orgId);
    return true;
  };
}
