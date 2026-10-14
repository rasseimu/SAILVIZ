// test/auth-routes.test.js
// アカウント API(設計書 v2 §10.2)の結合テスト。DB(:memory:)・スタブのメール・合成データ。Node 24 が要る。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';
import { createStubMailer } from '../server/mail.js';
import { hashPassword } from '../server/domain/password.js';
import { hashToken } from '../server/domain/tokens.js';
import { LIMITS } from '../server/routes/auth.js';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite が要る(Node >=24)';
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');
const FAST = { N: 1024, r: 8, p: 1, keyLen: 32, saltLen: 16 };
const BASE_URL = 'https://app.example.test';
const DAY = 24 * 60 * 60 * 1000;

let server, base, db, accounts, mailer, clock;
let openDb, migrate, loadMigrations, createAccountsRepo;
if (!skip) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createAccountsRepo } = await import('../server/repos/accountsRepo.js'));
}

// テストごとに DB・メール・時計・回数制限を作り直す(サーバは1つのハンドラを差し替えて使う)。
let handler;
before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => { if (await handler(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  if (skip) return;
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  accounts = createAccountsRepo({ db });
  mailer = createStubMailer();
  clock = { t: 1_700_000_000_000 };
  handler = createApi({
    dataDir: '/nonexistent', repo: { }, token: 'shared-write', accounts, mailer, baseUrl: BASE_URL,
    authOptions: { now: () => clock.t, hashParams: FAST, logger: () => {} },
  });
});

async function call(method, path, body, { token, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 本文なし */ }
  return { status: r.status, json, headers: r.headers, text };
}
const REG = { email: 'taro@example.test', password: 'pass-word-1', name: 'テスト太郎', affiliationText: 'テスト部', agreedAt: 1_699_999_000_000 };
const register = (over = {}) => call('POST', '/api/auth/register', { ...REG, ...over });
const tokenFrom = (url) => new URL(url).searchParams.get('token');

test('register: 200 で token・user を返し、Cookie(HttpOnly・Lax)を出し、確認メールは Web の URL', { skip }, async () => {
  const r = await register();
  assert.equal(r.status, 200);
  assert.ok(r.json.token.length >= 43);
  assert.equal(r.json.user.email, 'taro@example.test');
  assert.equal(r.json.user.emailVerified, false);
  assert.ok(!('password_hash' in r.json.user) && !JSON.stringify(r.json).includes('scrypt$'));
  const ck = r.headers.get('set-cookie');
  assert.match(ck, /^sailviz_session=/);
  assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Lax/); assert.match(ck, /Path=\//);
  assert.ok(ck.includes(r.json.token));
  const mail = mailer.last('verify');
  assert.equal(mail.to, 'taro@example.test');
  assert.ok(mail.url.startsWith(`${BASE_URL}/verify-email?token=`));
  // DB にはパスワードもトークンも平文で入らない
  const row = accounts.getUserByEmail('taro@example.test');
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.equal(row.agreed_at, REG.agreedAt);
  assert.ok(accounts.getEmailTokenByHash(hashToken(tokenFrom(mail.url))));
});

test('register: 重複メール(大文字小文字違い含む)は 409、不正入力は 422', { skip }, async () => {
  assert.equal((await register()).status, 200);
  const dup = await register({ email: 'TARO@example.test' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'email_taken');
  for (const bad of [{ email: 'x' }, { password: 'short' }, { name: '' }, { affiliationText: '' }, { agreedAt: null }]) {
    const r = await register({ email: 'new@example.test', ...bad });
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal(r.json.error.code, 'invalid_input');
  }
  const broken = await fetch(`${base}/api/auth/register`, { method: 'POST', body: '{bad' });
  assert.equal(broken.status, 422);
});

test('register: メール送信が失敗しても登録は成功する(再送できる)', { skip }, async () => {
  mailer.send = async () => { throw new Error('smtp down'); };
  const r = await register();
  assert.equal(r.status, 200);
});

test('verify-email: 確認 → /api/me の emailVerified が true。二重使用・期限切れ・未知は 422', { skip }, async () => {
  const reg = await register();
  const t = tokenFrom(mailer.last('verify').url);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).json.emailVerified, false);
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: t })).status, 200); // 認証不要
  const me = await call('GET', '/api/me', undefined, { token: reg.json.token });
  assert.equal(me.json.emailVerified, true);
  assert.equal(me.json.user.emailVerified, true);
  const again = await call('POST', '/api/auth/verify-email', { verifyToken: t });
  assert.equal(again.status, 422); assert.equal(again.json.error.code, 'invalid_token');
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: 'nope' })).status, 422);
  assert.equal((await call('POST', '/api/auth/verify-email', {})).status, 422);
  // 期限切れ(3 日)
  await call('POST', '/api/auth/verify-email/resend', {}, { token: reg.json.token }); // 確認済みなので送られない
  const u2 = await register({ email: 'b@example.test' });
  const t2 = tokenFrom(mailer.last('verify').url);
  clock.t += 3 * DAY + 1;
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: t2 })).status, 422);
  assert.equal(accounts.getUser(u2.json.user.id).email_verified_at, null);
});

test('verify-email: 削除済みユーザーのリンクは無効', { skip }, async () => {
  const reg = await register();
  const t = tokenFrom(mailer.last('verify').url);
  const del = await call('DELETE', '/api/me', { password: REG.password }, { token: reg.json.token });
  assert.equal(del.status, 200);
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: t })).status, 422);
});

test('resend: 要ログイン。未確認なら新しいリンクを送り、確認済みなら送らない。回数制限あり', { skip }, async () => {
  assert.equal((await call('POST', '/api/auth/verify-email/resend', {})).status, 401);
  const reg = await register();
  const before = mailer.sent.length;
  const r = await call('POST', '/api/auth/verify-email/resend', {}, { token: reg.json.token });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(mailer.sent.length, before + 1);
  assert.notEqual(mailer.sent.at(-1).url, mailer.sent.at(-2).url);
  await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mailer.last('verify').url) });
  const n = mailer.sent.length;
  await call('POST', '/api/auth/verify-email/resend', {}, { token: reg.json.token });
  assert.equal(mailer.sent.length, n); // 確認済みは送らない
  // 回数制限(本人ごと)
  const u = await register({ email: 'c@example.test' });
  let last;
  for (let i = 0; i < LIMITS.resend.max + 1; i++) last = await call('POST', '/api/auth/verify-email/resend', {}, { token: u.json.token });
  assert.equal(last.status, 429);
});

test('login: 成功で token・user・Cookie。誤パスワード・未登録・削除済みは同じ 401', { skip }, async () => {
  await register();
  const ok = await call('POST', '/api/auth/login', { email: 'TARO@example.test', password: REG.password });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token); assert.equal(ok.json.user.name, 'テスト太郎');
  assert.match(ok.headers.get('set-cookie'), /^sailviz_session=/);
  const bad = await call('POST', '/api/auth/login', { email: REG.email, password: 'wrong-pass-1' });
  const none = await call('POST', '/api/auth/login', { email: 'nobody@example.test', password: 'wrong-pass-1' });
  assert.equal(bad.status, 401); assert.equal(none.status, 401);
  assert.deepEqual(bad.json, none.json); // 登録の有無を漏らさない
  assert.equal((await call('POST', '/api/auth/login', {})).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: { $ne: 1 } })).status, 401);
  // 削除済み
  await call('DELETE', '/api/me', { password: REG.password }, { token: ok.json.token });
  assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: REG.password })).status, 401);
});

test('login: 未確認でも使える(§4.2)。古いパラメータのハッシュはログインで保存し直す', { skip }, async () => {
  const old = { N: 512, r: 8, p: 1, keyLen: 32, saltLen: 16 };
  const u = accounts.createUser({ email: 'old@example.test', name: 'x', passwordHash: await hashPassword('pass-word-1', old) });
  const r = await call('POST', '/api/auth/login', { email: 'old@example.test', password: 'pass-word-1' });
  assert.equal(r.status, 200);
  assert.match(accounts.getUser(u.id).password_hash, /^scrypt\$1024\$/);
  assert.equal((await call('POST', '/api/auth/login', { email: 'old@example.test', password: 'pass-word-1' })).status, 200);
});

test('GET /api/me・login: name 未設定のユーザーは「ユーザー」+ID由来4文字、defaultVisibility は private(S2.3-P9)。DB は変えない', { skip }, async () => {
  const u = accounts.createUser({ email: 'noname@example.test', name: null, passwordHash: await hashPassword('pass-word-1', FAST) });
  const login = await call('POST', '/api/auth/login', { email: 'noname@example.test', password: 'pass-word-1' });
  assert.match(login.json.user.name, /^ユーザー[0-9a-f]{4}$/);
  const me = await call('GET', '/api/me', undefined, { token: login.json.token });
  assert.equal(me.json.user.name, login.json.user.name);
  assert.equal(me.json.user.defaultVisibility, 'private');
  assert.ok(!me.json.user.name.includes('noname'));
  assert.equal(accounts.getUser(u.id).name, null);
  assert.equal(accounts.getUser(u.id).default_visibility, null);
});

test('login: 不在・パスワード未設定のユーザーは、ダミーと同じ文字列でも通らず同じ 401', { skip }, async () => {
  // ダミーのハッシュで照合する実装(時間をそろえる)の副作用で通ってしまわないことの確認。
  // 時間そのものの測定は不安定なのでテストしない(実装はコメントとレビューで担保)。
  accounts.createUser({ email: 'nopw@example.test', name: 'x', passwordHash: null });
  const r = await call('POST', '/api/auth/login', { email: 'nopw@example.test', password: 'dummy-password-for-timing' });
  assert.equal(r.status, 401); // ダミーと同じ文字列でも通らない
  const r2 = await call('POST', '/api/auth/login', { email: 'ghost@example.test', password: 'dummy-password-for-timing' });
  assert.equal(r2.status, 401);
});

test('login: 回数制限(同じメールの失敗 5 回で 429・Retry-After)。窓が過ぎれば再開、成功でリセット', { skip }, async () => {
  await register();
  for (let i = 0; i < LIMITS.loginEmail.max; i++) {
    assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: 'wrong-pass-1' })).status, 401);
  }
  const blocked = await call('POST', '/api/auth/login', { email: REG.email, password: REG.password }); // 正しくても止める
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  clock.t += LIMITS.loginEmail.windowMs + 1;
  assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: REG.password })).status, 200);
  // 成功したら失敗カウントは消える
  for (let i = 0; i < LIMITS.loginEmail.max - 1; i++) await call('POST', '/api/auth/login', { email: REG.email, password: 'wrong-pass-1' });
  assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: REG.password })).status, 200);
  for (let i = 0; i < LIMITS.loginEmail.max - 1; i++) await call('POST', '/api/auth/login', { email: REG.email, password: 'wrong-pass-1' });
  assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: REG.password })).status, 200);
});

test('login: 未登録メールへの失敗も数える(ロックの有無で登録を漏らさない)', { skip }, async () => {
  for (let i = 0; i < LIMITS.loginEmail.max; i++) await call('POST', '/api/auth/login', { email: 'ghost@example.test', password: 'wrong-pass-1' });
  assert.equal((await call('POST', '/api/auth/login', { email: 'ghost@example.test', password: 'wrong-pass-1' })).status, 429);
});

test('logout: このトークンだけ失効し Cookie を消す。未ログインは 401', { skip }, async () => {
  assert.equal((await call('POST', '/api/auth/logout', {})).status, 401);
  const reg = await register();
  const second = await call('POST', '/api/auth/login', { email: REG.email, password: REG.password });
  const out = await call('POST', '/api/auth/logout', {}, { token: reg.json.token });
  assert.deepEqual(out.json, { ok: true });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, { token: second.json.token })).status, 200); // 他の端末は残る
});

test('Cookie sailviz_session でも認証でき、旧共有の書込トークンでは /api/me に入れない', { skip }, async () => {
  const reg = await register();
  assert.equal((await call('GET', '/api/me', undefined, { cookie: `sailviz_session=${reg.json.token}` })).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { cookie: `sailviz_token=${reg.json.token}` })).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, { token: 'shared-write' })).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('password-reset/request: 登録の有無で応答が同じ。確認済みユーザーにだけメールを送る', { skip }, async () => {
  await register();
  const sentBefore = mailer.sent.length;
  const unverified = await call('POST', '/api/auth/password-reset/request', { email: REG.email });
  const ghost = await call('POST', '/api/auth/password-reset/request', { email: 'ghost@example.test' });
  assert.deepEqual(unverified.json, { ok: true }); assert.deepEqual(ghost.json, { ok: true });
  assert.equal(mailer.sent.length, sentBefore); // 未確認(§4.2)・不在には送らない
  await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mailer.last('verify').url) });
  const known = await call('POST', '/api/auth/password-reset/request', { email: REG.email });
  assert.deepEqual(known.json, unverified.json);
  await new Promise((r) => setImmediate(r));
  const mail = mailer.last('reset');
  assert.ok(mail.url.startsWith(`${BASE_URL}/reset-password?token=`));
  assert.equal((await call('POST', '/api/auth/password-reset/request', {})).status, 200);
});

test('password-reset/confirm: 新パスワードで入れ、旧パスワードと全トークンは無効。再利用・期限切れ・弱いパスワード', { skip }, async () => {
  const reg = await register();
  await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mailer.last('verify').url) });
  await call('POST', '/api/auth/password-reset/request', { email: REG.email });
  await new Promise((r) => setImmediate(r));
  const t = tokenFrom(mailer.last('reset').url);
  // 弱いパスワードはトークンを消費しない
  assert.equal((await call('POST', '/api/auth/password-reset/confirm', { resetToken: t, newPassword: 'short' })).status, 422);
  const ok = await call('POST', '/api/auth/password-reset/confirm', { resetToken: t, newPassword: 'new-pass-word-2' });
  assert.deepEqual(ok.json, { ok: true });
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).status, 401); // §4.3 全失効
  assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: REG.password })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: REG.email, password: 'new-pass-word-2' })).status, 200);
  const reuse = await call('POST', '/api/auth/password-reset/confirm', { resetToken: t, newPassword: 'another-pass-3' });
  assert.equal(reuse.status, 422); assert.equal(reuse.json.error.code, 'invalid_token');
  // 期限切れ(1 時間)
  await call('POST', '/api/auth/password-reset/request', { email: REG.email });
  await new Promise((r) => setImmediate(r));
  const t2 = tokenFrom(mailer.last('reset').url);
  clock.t += 60 * 60 * 1000 + 1;
  assert.equal((await call('POST', '/api/auth/password-reset/confirm', { resetToken: t2, newPassword: 'another-pass-3' })).status, 422);
});

test('password-reset/confirm: 未確認ユーザー・削除済みユーザーのトークンは無効', { skip }, async () => {
  const reg = await register();
  const u = accounts.getUser(reg.json.user.id);
  const { issueEmailToken } = await import('../server/accountAuth.js');
  const t = issueEmailToken(accounts, { userId: u.id, purpose: 'reset', now: clock.t }).token;
  assert.equal((await call('POST', '/api/auth/password-reset/confirm', { resetToken: t, newPassword: 'new-pass-word-2' })).status, 422); // 未確認
  accounts.markEmailVerified(u.id, clock.t);
  const t2 = issueEmailToken(accounts, { userId: u.id, purpose: 'reset', now: clock.t }).token;
  accounts.markUserDeleted(u.id, clock.t);
  assert.equal((await call('POST', '/api/auth/password-reset/confirm', { resetToken: t2, newPassword: 'new-pass-word-2' })).status, 422); // 削除済み
  // 'verify' 目的のトークンでは再設定できない
  const v = issueEmailToken(accounts, { userId: u.id, purpose: 'verify', now: clock.t }).token;
  assert.equal((await call('POST', '/api/auth/password-reset/confirm', { resetToken: v, newPassword: 'new-pass-word-2' })).status, 422);
});

test('password-reset/request: 同じメールは 1 時間に 3 通まで(超えても応答は同じ)、IP は 429', { skip }, async () => {
  await register();
  await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mailer.last('verify').url) });
  const n0 = mailer.sent.length;
  for (let i = 0; i < LIMITS.resetRequestEmail.max + 2; i++) {
    const r = await call('POST', '/api/auth/password-reset/request', { email: REG.email });
    assert.deepEqual(r.json, { ok: true });
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(mailer.sent.length - n0, LIMITS.resetRequestEmail.max);
  let last;
  for (let i = 0; i < LIMITS.resetRequestIp.max; i++) last = await call('POST', '/api/auth/password-reset/request', { email: `x${i}@example.test` });
  assert.equal(last.status, 429);
});

test('GET /api/me: user・emailVerified・org(未所属は null、所属すれば id と name)', { skip }, async () => {
  const reg = await register();
  const me = await call('GET', '/api/me', undefined, { token: reg.json.token });
  assert.equal(me.json.user.id, reg.json.user.id);
  assert.equal(me.json.org, null);
  const org = accounts.createOrg({ name: 'テスト部', adminUserIds: [], now: clock.t });
  accounts.linkMember({ orgId: org.id, userId: reg.json.user.id, now: clock.t });
  const me2 = await call('GET', '/api/me', undefined, { token: reg.json.token });
  assert.deepEqual(me2.json.org, { id: org.id, name: 'テスト部' });
});

test('PATCH /api/me: 名前・所属・既定の公開範囲を更新。不正は 422', { skip }, async () => {
  const reg = await register();
  const r = await call('PATCH', '/api/me', { name: '新しい名前', defaultVisibility: 'org', affiliationText: '別の所属' }, { token: reg.json.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.name, '新しい名前'); assert.equal(r.json.user.defaultVisibility, 'org');
  assert.equal(accounts.getUser(reg.json.user.id).affiliation_text, '別の所属');
  assert.equal((await call('PATCH', '/api/me', { defaultVisibility: 'x' }, { token: reg.json.token })).status, 422);
  assert.equal((await call('PATCH', '/api/me', {}, { token: reg.json.token })).status, 422);
  assert.equal((await call('PATCH', '/api/me', { name: 'x' })).status, 401);
});

test('PATCH /api/me: メール変更は再確認が必要で、組織の紐付けを外し、新アドレスへ確認メール。重複は 409', { skip }, async () => {
  const reg = await register();
  await register({ email: 'other@example.test' });
  await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mailer.sent.find((m) => m.to === 'taro@example.test').url) });
  const org = accounts.createOrg({ name: 'テスト部', adminUserIds: [], now: clock.t });
  accounts.replaceRoster(org.id, [{ email: 'taro@example.test', name: 'テスト太郎' }, { email: 'taro2@example.test', name: 'テスト太郎' }], clock.t);
  const rosterId = accounts.listRoster(org.id).find((r) => r.email === 'taro@example.test').id;
  accounts.linkMember({ orgId: org.id, userId: reg.json.user.id, rosterId, now: clock.t });

  assert.equal((await call('PATCH', '/api/me', { email: 'OTHER@example.test' }, { token: reg.json.token })).status, 409);
  const r = await call('PATCH', '/api/me', { email: 'Taro2@Example.test' }, { token: reg.json.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.email, 'taro2@example.test');
  assert.equal(r.json.user.emailVerified, false);
  assert.equal(accounts.isMember(org.id, reg.json.user.id), false);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).json.org, null);
  const mail = mailer.last('verify');
  assert.equal(mail.to, 'taro2@example.test');
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mail.url) })).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).json.emailVerified, true);
  assert.equal(accounts.isMember(org.id, reg.json.user.id), true); // 新メールで名簿に再照合される
  // 同じアドレスへの変更は何もしない(再確認も要らない)
  const same = await call('PATCH', '/api/me', { email: 'taro2@example.test' }, { token: reg.json.token });
  assert.equal(same.status, 200); assert.equal(same.json.user.emailVerified, true);
});

test('PATCH /api/me: roster_id が NULL のメンバー(組織の作成者)はメールを変えても組織に残る', { skip }, async () => {
  const reg = await register();
  const org = accounts.createOrg({ name: 'テスト部', adminUserIds: [reg.json.user.id], now: clock.t });
  accounts.linkMember({ orgId: org.id, userId: reg.json.user.id, rosterId: null, now: clock.t });
  const r = await call('PATCH', '/api/me', { email: 'creator2@example.test' }, { token: reg.json.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.emailVerified, false);
  assert.equal(accounts.isMember(org.id, reg.json.user.id), true);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).json.org.id, org.id);
  assert.equal(accounts.isOrgAdmin(org.id, reg.json.user.id), true); // 管理者のまま
});

test('PATCH /api/me: 組織 A の作成者(roster_id NULL)かつ組織 B の名簿メンバーは、メール変更で A に残り B から外れる', { skip }, async () => {
  const reg = await register();
  const orgA = accounts.createOrg({ name: 'テスト部A', adminUserIds: [reg.json.user.id], now: clock.t });
  accounts.linkMember({ orgId: orgA.id, userId: reg.json.user.id, rosterId: null, now: clock.t });
  const orgB = accounts.createOrg({ name: 'テスト部B', adminUserIds: [], now: clock.t });
  accounts.replaceRoster(orgB.id, [{ email: 'taro@example.test', name: 'テスト太郎' }], clock.t);
  const rosterId = accounts.listRoster(orgB.id)[0].id;
  accounts.linkMember({ orgId: orgB.id, userId: reg.json.user.id, rosterId, now: clock.t });
  const r = await call('PATCH', '/api/me', { email: 'creator3@example.test' }, { token: reg.json.token });
  assert.equal(r.status, 200);
  assert.equal(accounts.isMember(orgA.id, reg.json.user.id), true);
  assert.equal(accounts.isOrgAdmin(orgA.id, reg.json.user.id), true);
  assert.equal(accounts.isMember(orgB.id, reg.json.user.id), false);
});

test('POST /api/auth/verify-email: 名簿照合が失敗したら、確認済みの記録も巻き戻る', { skip }, async () => {
  const reg = await register();
  const tok = tokenFrom(mailer.last('verify').url);
  const findOrig = accounts.findRosterRowsByEmail;
  // 確認済みの記録の後、名簿照合の段で失敗させる
  accounts.findRosterRowsByEmail = () => { throw new Error('boom'); };
  let status;
  try { status = (await call('POST', '/api/auth/verify-email', { verifyToken: tok })).status; }
  finally { accounts.findRosterRowsByEmail = findOrig; }
  assert.notEqual(status, 200);
  assert.equal(accounts.getUser(reg.json.user.id).email_verified_at, null);
});

test('PATCH /api/me: メールを再変更したら古い確認リンクは無効', { skip }, async () => {
  const reg = await register();
  await call('PATCH', '/api/me', { email: 'one@example.test' }, { token: reg.json.token });
  const first = tokenFrom(mailer.last('verify').url);
  await call('PATCH', '/api/me', { email: 'two@example.test' }, { token: reg.json.token });
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: first })).status, 422);
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mailer.last('verify').url) })).status, 200);
});

test('PATCH /api/me: 登録時の verify リンクは、メール変更後は 422 で、新アドレスは未確認のまま', { skip }, async () => {
  const reg = await register();
  const old = tokenFrom(mailer.last('verify').url);
  await call('PATCH', '/api/me', { email: 'new@example.test' }, { token: reg.json.token });
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: old })).status, 422);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).json.emailVerified, false);
  // 新アドレス宛てのリンクなら確認できる
  assert.equal((await call('POST', '/api/auth/verify-email', { verifyToken: tokenFrom(mailer.last('verify').url) })).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).json.emailVerified, true);
});

test('PATCH /api/me: メール変更は本人ごとに 1 時間 3 回まで(429・Retry-After)。窓が過ぎれば再開', { skip }, async () => {
  const reg = await register();
  const patch = (e) => call('PATCH', '/api/me', { email: e }, { token: reg.json.token });
  for (let i = 0; i < LIMITS.emailChange.max; i++) assert.equal((await patch(`n${i}@example.test`)).status, 200);
  const r = await patch('over@example.test');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await call('PATCH', '/api/me', { name: '名前だけ' }, { token: reg.json.token })).status, 200); // メール以外は数えない
  clock.t += LIMITS.emailChange.windowMs + 1000;
  assert.equal((await patch('after@example.test')).status, 200);
});

test('PATCH /api/me: 登録済みアドレスへの変更(409)も回数に数える。上限を超えたら 429', { skip }, async () => {
  const reg = await register();
  await register({ email: 'other@example.test' });
  const patch = (e) => call('PATCH', '/api/me', { email: e }, { token: reg.json.token });
  for (let i = 0; i < LIMITS.emailChange.max; i++) {
    const r = await patch('other@example.test');
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'email_taken');
  }
  assert.equal((await patch('other@example.test')).status, 429); // 登録の有無を無制限に調べられない
  assert.equal((await patch('free@example.test')).status, 429);
});

test('verify-email: new_email が NULL の verify トークンは 422', { skip }, async () => {
  const reg = await register();
  const raw = 'legacy-null-new-email-token';
  accounts.createEmailToken({ userId: reg.json.user.id, purpose: 'verify', tokenHash: hashToken(raw), newEmail: null, expiresAt: clock.t + DAY });
  const r = await call('POST', '/api/auth/verify-email', { verifyToken: raw });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'invalid_token');
  assert.equal(accounts.getUser(reg.json.user.id).email_verified_at, null);
});

test('DELETE /api/me: パスワード必須(誤りは 422)。成功で全トークン失効・個人情報の匿名化・同じメールで再登録できる', { skip }, async () => {
  const reg = await register();
  const org = accounts.createOrg({ name: 'テスト部', adminUserIds: [], now: clock.t });
  accounts.linkMember({ orgId: org.id, userId: reg.json.user.id, now: clock.t });
  assert.equal((await call('DELETE', '/api/me', { password: REG.password })).status, 401);
  const wrong = await call('DELETE', '/api/me', { password: 'wrong-pass-1' }, { token: reg.json.token });
  assert.equal(wrong.status, 422); assert.equal(wrong.json.error.code, 'invalid_password');
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).status, 200); // 消えていない
  const ok = await call('DELETE', '/api/me', { password: REG.password }, { token: reg.json.token });
  assert.deepEqual(ok.json, { ok: true });
  assert.match(ok.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('GET', '/api/me', undefined, { token: reg.json.token })).status, 401);
  const row = accounts.getUser(reg.json.user.id);
  assert.ok(row.deleted_at != null);
  assert.equal(row.name, null); assert.equal(row.affiliation_text, null); assert.equal(row.password_hash, null);
  assert.ok(!row.email.includes('taro'));
  assert.equal(accounts.isMember(org.id, reg.json.user.id), false);
  assert.equal((await register()).status, 200); // 同じメールで再登録できる
});

test('DELETE /api/me: org_admins の行が消える。他の管理者の行は残り、唯一の管理者でも組織は残る(管理者不在)', { skip }, async () => {
  const reg = await register();
  const uid = reg.json.user.id;
  const other = accounts.createUser({ email: 'other@example.test' });
  const shared = accounts.createOrg({ name: '共同部', adminUserIds: [uid, other.id], now: clock.t });
  const solo = accounts.createOrg({ name: '単独部', adminUserIds: [uid], now: clock.t });
  assert.equal((await call('DELETE', '/api/me', { password: REG.password }, { token: reg.json.token })).status, 200);
  assert.equal(accounts.isOrgAdmin(shared.id, uid), false);
  assert.equal(accounts.isOrgAdmin(solo.id, uid), false);
  assert.deepEqual(accounts.listOrgAdmins(shared.id), [other.id]);
  assert.deepEqual(accounts.listOrgAdmins(solo.id), []); // 正本に定めなし: 拒否も移譲もしない
  assert.ok(accounts.getOrg(solo.id));
});

test('DELETE /api/me: 誤パスワードの連続は 429(本人ごと)',{ skip }, async () => {
  const reg = await register();
  let last;
  for (let i = 0; i < LIMITS.deletePassword.max + 1; i++) last = await call('DELETE', '/api/me', { password: 'wrong-pass-1' }, { token: reg.json.token });
  assert.equal(last.status, 429);
});

test('register: 同じ IP からの試行は 1 時間に 10 回まで(429)', { skip }, async () => {
  let last;
  for (let i = 0; i < LIMITS.register.max + 1; i++) last = await register({ email: `u${i}@example.test` });
  assert.equal(last.status, 429);
});

test('accounts が無い(STORAGE=file)ときは 503、他の API は従来どおり', { skip }, async () => {
  const plain = createApi({ dataDir: '/nonexistent', repo: {}, token: 'shared-write' });
  const prev = handler; handler = plain;
  try {
    const r = await call('POST', '/api/auth/login', { email: 'a@example.test', password: 'x' });
    assert.equal(r.status, 503); assert.equal(r.json.error.code, 'accounts_unavailable');
    assert.equal((await call('GET', '/api/me')).status, 503);
    assert.equal((await call('GET', '/api/health')).status, 200);
  } finally { handler = prev; }
});
