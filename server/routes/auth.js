// server/routes/auth.js
// アカウント API(設計書 v2 §10.2): /api/auth/* と /api/me。処理したら true、対象外なら false。
// アカウントは SQLite に置くので、ctx.accounts(accountsRepo)が無い(STORAGE=file)ときは 503。
// 平文トークンは応答に一度だけ載せ、DB にはハッシュだけ(accountAuth.js)。
import { send } from './http.js';
import { SESSION_COOKIE } from '../auth.js';
import {
  issueAuthToken, issueEmailToken, consumeEmailToken, peekEmailToken, revokeToken, resolveIdentity,
} from '../accountAuth.js';
import { hashPassword, verifyPassword, needsRehash, validatePassword, SCRYPT_PARAMS } from '../domain/password.js';
import { AUTH_TOKEN_TTL_MS } from '../domain/tokens.js';
import { validateRegister, validateProfilePatch, isValidEmail, normalizeEmail } from '../domain/accountInput.js';
import { createRateLimiter } from '../domain/rateLimit.js';
import { validateOrgName, MAX_ORGS_PER_USER } from '../domain/orgCreate.js';
import { buildLink } from '../mail.js';
import { linkVerifiedUser } from '../rosterLink.js';
import { displayNameFor, visibilityFor } from '../domain/displayName.js';

const MIN = 60 * 1000;
const MAX_BODY = 64 * 1024;

// 回数制限の値(設計書に数値は無い。選定理由は S2.3 の報告に記載)。
export const LIMITS = {
  loginEmail: { max: 5, windowMs: 15 * MIN }, // 同じメールへの失敗
  loginIp: { max: 20, windowMs: 15 * MIN }, // 同じ IP からの失敗
  register: { max: 10, windowMs: 60 * MIN }, // 同じ IP からの登録試行
  resetRequestIp: { max: 10, windowMs: 60 * MIN },
  resetRequestEmail: { max: 3, windowMs: 60 * MIN }, // 超えたら黙って送らない(登録の有無を漏らさない)
  resetConfirmIp: { max: 10, windowMs: 15 * MIN }, // トークン推測の失敗
  resend: { max: 3, windowMs: 60 * MIN }, // 本人ごと
  emailChange: { max: 3, windowMs: 60 * MIN }, // PATCH /api/me のメール変更(確認メールの乱発防止)、本人ごと
  deletePassword: { max: 5, windowMs: 15 * MIN }, // 本人ごとの削除時パスワード失敗
  orgCreate: { max: 10, windowMs: 60 * MIN }, // POST /api/orgs の試行(失敗も数える)、本人ごと
};

const err = (res, status, code, message, headers) => send(res, status, { error: { code, message } }, headers);

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

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: displayNameFor(u),
  affiliationText: u.affiliation_text ?? null,
  defaultVisibility: visibilityFor(u),
  emailVerified: u.email_verified_at != null,
});

// 設定を束ねた状態を作る。テストでは now・hashParams・mailer を差し替える。
export function createAuthRoute({
  accounts, mailer, baseUrl, writeToken, now = () => Date.now(), hashParams = SCRYPT_PARAMS, secureCookie = '',
  logger = console.error, hash = hashPassword, // hash: テストでハッシュ計算中の競合を再現するための差し替え口
}) {
  const limiters = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, createRateLimiter(v)]));
  // ユーザー不在・パスワード未設定のログインでも同じ時間をかけるためのダミー(メールの登録有無を漏らさない)。
  let dummyHash = null;
  const getDummy = () => (dummyHash ||= hashPassword('dummy-password-for-timing', hashParams));

  const cookieHeader = (token) => ({
    'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH_TOKEN_TTL_MS / 1000)}${secureCookie}`,
  });
  const clearCookie = () => ({
    'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie}`,
  });
  const ipOf = (req) => String(req.headers['fly-client-ip'] || req.socket?.remoteAddress || 'unknown');

  const limited = (res, ...checks) => {
    for (const [lim, key] of checks) {
      const r = lim.check(key, now());
      if (r.limited) {
        err(res, 429, 'rate_limited', '試行回数が多すぎます。しばらくしてからやり直してください',
          { 'retry-after': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) });
        return true;
      }
    }
    return false;
  };

  const sendMail = async (to, kind, token) => {
    try { await mailer.send({ to, kind, url: buildLink(baseUrl, kind, token) }); return true; }
    catch (e) { logger(`[mail] ${kind} の送信に失敗: ${e && e.message || e}`); return false; }
  };

  const requireUser = (req, res) => {
    const id = resolveIdentity(req, { writeToken, repo: accounts, now: now() });
    if (id?.kind === 'user') return id;
    err(res, 401, 'unauthorized', 'ログインが必要です');
    return null;
  };

  const issueVerify = (user) => (user.email_verified_at == null
    // 発行時のアドレスを保存し、確認時に「今のアドレスと同じ」を必須にする(変更前アドレス宛てのリンクで新アドレスを確認済みにさせない)
    ? issueEmailToken(accounts, { userId: user.id, purpose: 'verify', newEmail: user.email, now: now() }) : null);

  const handlers = {
    // ---- POST /api/auth/register ----
    async register(req, res, body) {
      if (limited(res, [limiters.register, ipOf(req)])) return;
      limiters.register.record(ipOf(req), now());
      const v = validateRegister(body);
      if (!v.ok) return err(res, 422, 'invalid_input', v.message);
      if (accounts.getUserByEmail(v.value.email)) return err(res, 409, 'email_taken', 'このメールアドレスは既に登録されています');
      const passwordHash = await hashPassword(v.value.password, hashParams);
      let user;
      try {
        user = accounts.createUser({
          email: v.value.email, name: v.value.name, affiliationText: v.value.affiliationText,
          passwordHash, agreedAt: v.value.agreedAt, now: now(),
        });
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) return err(res, 409, 'email_taken', 'このメールアドレスは既に登録されています');
        throw e;
      }
      const verify = issueVerify(user);
      await sendMail(user.email, 'verify', verify.token); // 失敗しても登録は成功(再送できる)
      const t = issueAuthToken(accounts, user.id, now());
      send(res, 200, { token: t.token, user: publicUser(user) }, cookieHeader(t.token));
    },

    // ---- POST /api/auth/verify-email ----(Web のページ /verify-email?token=… が呼ぶ)
    async verifyEmail(req, res, body) {
      const token = body.verifyToken;
      // トークンの使用・確認済みの記録・名簿照合(§4.4: 一致すれば組織へ紐付け、legacy_* を本人に付け替える。冪等)を
      // 1 つのトランザクションにまとめる。照合が例外で失敗したらトークンも未使用に戻る(利用者が再送せずに再試行できる)。
      const valid = accounts.withTx(() => {
        const hit = consumeEmailToken(accounts, token, 'verify', now())
          || consumeEmailToken(accounts, token, 'change', now());
        const user = hit && accounts.getUser(hit.userId);
        // 削除済み・メール変更後に古くなったトークン(verify・change とも発行時のアドレスが今と違う)は無効
        if (!user || user.deleted_at != null || !hit.newEmail || hit.newEmail !== user.email) return false;
        if (user.email_verified_at == null) accounts.markEmailVerified(user.id, now());
        linkVerifiedUser(accounts, accounts.getUser(user.id), now());
        return true;
      });
      if (!valid) return err(res, 422, 'invalid_token', 'リンクが無効か、期限切れまたは使用済みです');
      send(res, 200, { ok: true });
    },

    // ---- POST /api/auth/verify-email/resend ----
    async resend(req, res) {
      const id = requireUser(req, res); if (!id) return;
      if (limited(res, [limiters.resend, id.user.id])) return;
      limiters.resend.record(id.user.id, now());
      const verify = issueVerify(id.user); // 確認済みなら何もしない
      if (verify) await sendMail(id.user.email, 'verify', verify.token);
      send(res, 200, { ok: true });
    },

    // ---- POST /api/auth/login ----
    async login(req, res, body) {
      const email = normalizeEmail(body.email);
      const eKey = `e:${email}`; const ipKey = ipOf(req);
      if (limited(res, [limiters.loginEmail, eKey], [limiters.loginIp, ipKey])) return;
      const user = email && typeof body.password === 'string' ? accounts.getUserByEmail(email) : null;
      const usable = user && user.deleted_at == null && user.password_hash;
      // 不在・未設定でもダミーのハッシュで照合して時間をそろえる
      const ok = await verifyPassword(typeof body.password === 'string' ? body.password : '', usable ? user.password_hash : await getDummy());
      if (!usable || !ok) {
        limiters.loginEmail.record(eKey, now()); limiters.loginIp.record(ipKey, now());
        return err(res, 401, 'invalid_credentials', 'メールアドレスまたはパスワードが違います');
      }
      limiters.loginEmail.clear(eKey);
      if (needsRehash(user.password_hash, hashParams)) {
        accounts.updateUser(user.id, { passwordHash: await hashPassword(body.password, hashParams) });
      }
      const t = issueAuthToken(accounts, user.id, now());
      send(res, 200, { token: t.token, user: publicUser(accounts.getUser(user.id)) }, cookieHeader(t.token));
    },

    // ---- POST /api/auth/logout ----
    async logout(req, res) {
      const id = requireUser(req, res); if (!id) return;
      accounts.revokeAuthToken(id.tokenId, now()); // このトークンだけ失効
      send(res, 200, { ok: true }, clearCookie());
    },

    // ---- POST /api/auth/password-reset/request ----
    async resetRequest(req, res, body) {
      const ipKey = ipOf(req);
      if (limited(res, [limiters.resetRequestIp, ipKey])) return;
      limiters.resetRequestIp.record(ipKey, now());
      const email = normalizeEmail(body.email);
      if (isValidEmail(email) && !limiters.resetRequestEmail.check(email, now()).limited) {
        limiters.resetRequestEmail.record(email, now());
        const user = accounts.getUserByEmail(email);
        // 確認済みのユーザーだけ(§4.2)。それ以外も同じ応答を返し、登録の有無を漏らさない。
        if (user && user.deleted_at == null && user.email_verified_at != null) {
          const t = issueEmailToken(accounts, { userId: user.id, purpose: 'reset', now: now() });
          void sendMail(user.email, 'reset', t.token); // 応答時間を揃えるため待たない
        }
      }
      send(res, 200, { ok: true });
    },

    // ---- POST /api/auth/password-reset/confirm ----
    async resetConfirm(req, res, body) {
      const ipKey = ipOf(req);
      if (limited(res, [limiters.resetConfirmIp, ipKey])) return;
      const pw = validatePassword(body.newPassword);
      if (!pw.ok) return err(res, 422, 'invalid_input', 'パスワードは8文字以上にしてください'); // トークンを消費しない
      const invalid = () => {
        limiters.resetConfirmIp.record(ipKey, now());
        return err(res, 422, 'invalid_token', 'リンクが無効か、期限切れまたは使用済みです');
      };
      // まず消費せずに検証する(ハッシュ計算や更新が失敗してもトークンが使用済みにならないように)
      const peek = peekEmailToken(accounts, body.resetToken, 'reset', now());
      const peeked = peek && accounts.getUser(peek.userId);
      // 削除済み、またはメール未確認(§4.2: 再設定は確認後のみ)は無効
      if (!peeked || peeked.deleted_at != null || peeked.email_verified_at == null) return invalid();
      const passwordHash = await hash(body.newPassword, hashParams);
      // 消費・パスワード更新・全トークン失効を 1 つのトランザクションに。並行して先に使われていたら無効と同じ。
      // ハッシュ計算中に退会・メール未確認に変わりうるので、トランザクション内でユーザーの状態を確かめ直す。
      const done = accounts.withTx(() => {
        const p = peekEmailToken(accounts, body.resetToken, 'reset', now());
        const u = p && accounts.getUser(p.userId);
        if (!u || u.deleted_at != null || u.email_verified_at == null) return false; // トークンは消費しない
        const hit = consumeEmailToken(accounts, body.resetToken, 'reset', now());
        if (!hit) return false;
        accounts.updateUser(hit.userId, { passwordHash });
        accounts.revokeAllAuthTokens(hit.userId, now()); // §4.3: パスワード変更で全トークン失効
        return true;
      });
      if (!done) return invalid();
      send(res, 200, { ok: true });
    },

    // ---- GET /api/me ----
    async me(req, res) {
      const id = requireUser(req, res); if (!id) return;
      // orgs: linked_at 昇順・同時刻は組織 ID 順。org は互換のため orgs[0] の {id,name}。
      const orgs = [];
      for (const m of accounts.listMembershipsOfUser(id.user.id)) {
        const o = accounts.getOrg(m.org_id);
        if (o) orgs.push({ id: o.id, name: o.name, isAdmin: accounts.isOrgAdmin(o.id, id.user.id) });
      }
      send(res, 200, {
        user: publicUser(id.user),
        emailVerified: id.user.email_verified_at != null,
        org: orgs[0] ? { id: orgs[0].id, name: orgs[0].name } : null,
        orgs,
      });
    },

    // ---- PATCH /api/me ----
    async patchMe(req, res, body) {
      const id = requireUser(req, res); if (!id) return;
      const v = validateProfilePatch(body);
      if (!v.ok) return err(res, 422, 'invalid_input', v.message);
      const patch = { ...v.value };
      const emailChanged = patch.email !== undefined && patch.email !== id.user.email;
      if (!emailChanged) delete patch.email;
      if (emailChanged && limited(res, [limiters.emailChange, id.user.id])) return;
      // 409 で終わる試行も数える(登録済みアドレスかどうかを無制限に調べられないように)。getUserByEmail より前に record する。
      if (emailChanged) limiters.emailChange.record(id.user.id, now());
      if (emailChanged && accounts.getUserByEmail(patch.email)) return err(res, 409, 'email_taken', 'このメールアドレスは既に使われています');
      let verify = null;
      try {
        accounts.withTx(() => {
          if (Object.keys(patch).length) accounts.updateUser(id.user.id, patch);
          if (emailChanged) {
            // §4.2 / 例外は §4.4 利用者決定: 変更後は再確認が済むまで、名簿照合で入った紐付けを外す(updateUser は確認済みを外す)。
            // roster_id が NULL の紐付け(組織の作成者・招待(S2.9)で入ったメンバー)は名簿照合で入ったのではないので外さない。
            for (const m of accounts.listMembershipsOfUser(id.user.id)) {
              if (m.roster_id != null) accounts.unlinkMember(m.org_id, id.user.id);
            }
            verify = issueEmailToken(accounts, { userId: id.user.id, purpose: 'change', newEmail: patch.email, now: now() });
          }
        });
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) return err(res, 409, 'email_taken', 'このメールアドレスは既に使われています');
        throw e;
      }
      if (verify) await sendMail(patch.email, 'verify', verify.token);
      send(res, 200, { user: publicUser(accounts.getUser(id.user.id)) });
    },

    // ---- DELETE /api/me ----
    async deleteMe(req, res, body) {
      const id = requireUser(req, res); if (!id) return;
      if (limited(res, [limiters.deletePassword, id.user.id])) return;
      const stored = id.user.password_hash || await getDummy();
      const ok = await verifyPassword(typeof body.password === 'string' ? body.password : '', stored);
      if (!ok || !id.user.password_hash) {
        limiters.deletePassword.record(id.user.id, now());
        return err(res, 422, 'invalid_password', 'パスワードが違います');
      }
      const uid = id.user.id;
      // H25: 唯一の管理者の組織は後任へ引き継ぐ(指定があれば検証して使い、無ければ linked_at 最古→user_id 昇順)。
      const adminOrgIds = accounts.listOrgIdsAdministeredBy(uid);
      const succ = body.successors;
      if (succ !== undefined && (succ === null || typeof succ !== 'object' || Array.isArray(succ)
        || Object.values(succ).some((v) => typeof v !== 'string' || !v))) {
        return err(res, 422, 'invalid_input', 'successors は {組織ID: ユーザーID} の形にしてください');
      }
      const picked = succ || {};
      for (const [orgId, userId] of Object.entries(picked)) {
        if (!adminOrgIds.includes(orgId)) return err(res, 422, 'invalid_input', '自分が管理していない組織が successors にあります');
        const sole = accounts.listOrgAdmins(orgId).every((a) => a === uid);
        if (!sole) continue; // 他にも管理者がいれば無視
        if (userId === uid || !accounts.isMember(orgId, userId)) {
          return err(res, 422, 'invalid_input', '後任はその組織の本人以外のメンバーから選んでください');
        }
      }
      accounts.withTx(() => {
        for (const orgId of adminOrgIds) {
          if (!accounts.listOrgAdmins(orgId).every((a) => a === uid)) continue;
          const next = picked[orgId]
            ?? accounts.listMembers(orgId).find((m) => m.user_id !== uid)?.user_id;
          if (next) accounts.addOrgAdmin(orgId, next);
        }
        accounts.revokeAllAuthTokens(uid, now());
        accounts.removeOrgAdminsOfUser(uid);
        for (const m of accounts.listMembershipsOfUser(uid)) accounts.unlinkMember(m.org_id, uid);
        // メール(UNIQUE)を空けるため匿名化し、個人情報を消す。同じメールで再登録できる。
        accounts.updateUser(uid, {
          email: `deleted-${uid}@deleted.invalid`, name: null, affiliationText: null, passwordHash: null,
        });
        accounts.markUserDeleted(uid, now());
      });
      // TODO(S2.7 以降): §4.3 の「本人のセッション・反省・ロードマップ・声の反省の削除」「他人の乗員欄を（退会済み）に置換」
      //   「議事録の本人の一言の削除」。それらを書き込む API(Phase 3〜5)ができた時点で、ここから呼ぶ(S3.1・S4.1・S4.2・S5.1・S5.5 で扱う)。
      //   org_admins の行は上で削除済み(唯一の管理者の組織は H25 に従い後任へ引き継ぎ済み)。
      send(res, 200, { ok: true }, clearCookie());
    },

    // ---- POST /api/orgs ----(組織の作成。メール確認済みなら誰でも。作成者が組織管理者かつメンバー)
    async createOrg(req, res, body) {
      const id = requireUser(req, res); if (!id) return;
      const user = id.user;
      if (user.email_verified_at == null) {
        return err(res, 403, 'email_not_verified', 'メールアドレスを確認してから組織を作成してください');
      }
      if (limited(res, [limiters.orgCreate, user.id])) return;
      limiters.orgCreate.record(user.id, now());
      const v = validateOrgName(body.name);
      if (!v.ok) return err(res, 422, 'invalid_name', v.message);
      const org = accounts.withTx(() => {
        if (accounts.countOrgsAdministeredBy(user.id) >= MAX_ORGS_PER_USER) return null;
        const created = accounts.createOrg({ name: v.name, adminUserIds: [user.id], now: now() });
        accounts.linkMember({ orgId: created.id, userId: user.id, rosterId: null, now: now() });
        return created;
      });
      if (!org) return err(res, 409, 'org_limit_reached', `作成できる組織は 1 人あたり ${MAX_ORGS_PER_USER} 件までです`);
      send(res, 201, { org: { id: org.id, name: org.name, createdAt: org.created_at } });
    },
  };

  const routes = {
    'POST /api/orgs': handlers.createOrg,
    'POST /api/auth/register': handlers.register,
    'POST /api/auth/verify-email': handlers.verifyEmail,
    'POST /api/auth/verify-email/resend': handlers.resend,
    'POST /api/auth/login': handlers.login,
    'POST /api/auth/logout': handlers.logout,
    'POST /api/auth/password-reset/request': handlers.resetRequest,
    'POST /api/auth/password-reset/confirm': handlers.resetConfirm,
    'GET /api/me': handlers.me,
    'PATCH /api/me': handlers.patchMe,
    'DELETE /api/me': handlers.deleteMe,
  };

  return async function authRoute(req, res, ctx) {
    const handler = routes[`${ctx.method} ${ctx.path}`];
    if (!handler) return false;
    let body = {};
    if (ctx.method !== 'GET') {
      try { body = await readJson(req); } catch (e) {
        if (e && e.code === 'too_large') err(res, 422, 'invalid_input', '本文が大きすぎます');
        else err(res, 422, 'invalid_input', 'JSON を読めません');
        return true;
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        err(res, 422, 'invalid_input', '本文は JSON オブジェクトにしてください'); return true;
      }
    }
    await handler(req, res, body);
    return true;
  };
}

// ctx 用の薄い入口。accounts が無ければ(STORAGE=file)この系統のパスだけ 503 を返す。
export function unavailableRoute(req, res, ctx) {
  if (!(ctx.path.startsWith('/api/auth/') || ctx.path === '/api/me'
    || ctx.path === '/api/orgs' || ctx.path.startsWith('/api/orgs/') || ctx.path.startsWith('/api/invites/'))) return false;
  err(res, 503, 'accounts_unavailable', 'アカウント機能は STORAGE=db のときだけ使えます');
  return true;
}
