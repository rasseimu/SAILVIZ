// server/routes/orgs.js
// 組織の作成(設計書 v2 §10.3 に追記する POST /api/orgs)。名簿 API(S2.6)はここでは扱わない。
// ctx.accounts(accountsRepo)が無い(STORAGE=file)ときは 503。エラー形式は §10.1 の { error:{code,message} }。
import { send, readBody } from './http.js';
import { resolveIdentity } from '../accountAuth.js';
import { validateOrgName, MAX_ORGS_PER_USER } from '../domain/orgCreate.js';

const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

export async function orgsRoute(req, res, ctx) {
  const { path, method, accounts, token, orgCreateLimiter, now } = ctx;
  if (path !== '/api/orgs') return false;
  if (method !== 'POST') { fail(res, 405, 'method_not_allowed', 'POST のみ'); return true; }

  if (!accounts) { fail(res, 503, 'accounts_unavailable', 'アカウント機能は DB 保存(STORAGE=db)でのみ使えます'); return true; }
  const t = now();
  const id = resolveIdentity(req, { writeToken: token, repo: accounts, now: t });
  if (!id) { fail(res, 401, 'unauthorized', 'ログインしてください'); return true; }
  if (id.kind !== 'user') { fail(res, 403, 'account_required', 'アカウントでのログインが必要です'); return true; }
  const user = id.user;
  if (user.email_verified_at == null) {
    fail(res, 403, 'email_not_verified', 'メールアドレスを確認してから組織を作成してください'); return true;
  }
  if (!orgCreateLimiter.check(user.id, t)) {
    fail(res, 429, 'rate_limited', '組織の作成回数が多すぎます。しばらくしてからやり直してください'); return true;
  }

  let body;
  try { body = await readBody(req); } catch { body = undefined; }
  const v = validateOrgName(body && typeof body === 'object' ? body.name : undefined);
  if (!v.ok) { fail(res, 422, 'invalid_name', v.message); return true; }

  const org = accounts.withTx(() => {
    if (accounts.countOrgsAdministeredBy(user.id) >= MAX_ORGS_PER_USER) return null;
    const created = accounts.createOrg({ name: v.name, adminUserIds: [user.id], now: t });
    accounts.linkMember({ orgId: created.id, userId: user.id, rosterId: null, now: t });
    return created;
  });
  if (!org) {
    fail(res, 409, 'org_limit_reached', `作成できる組織は 1 人あたり ${MAX_ORGS_PER_USER} 件までです`);
    return true;
  }
  send(res, 201, { org: { id: org.id, name: org.name, createdAt: org.created_at } });
  return true;
}
