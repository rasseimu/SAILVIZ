// test/compat-principal.test.js
// リクエストから policy の主体を組み立てる(S2.5-P2 の (1))。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubject } from '../server/compatPrincipal.js';
import { hashToken } from '../server/domain/tokens.js';

const TOKEN = 'dummy-write';
const SECRET = 'view-secret';
const req = (headers = {}) => ({ headers });
const base = { token: TOKEN, viewEnabled: true, viewSecret: SECRET, accounts: null, migrationOrgId: 'o_main' };

test('閲覧ゲートの Cookie → 共有ログイン(書込可・MIGRATION_ORG_ID の組織)', () => {
  const s = resolveSubject(req({ cookie: `sailviz_view=${SECRET}` }), base);
  assert.deepEqual(s, { kind: 'legacy', shared: true, orgId: 'o_main', canWrite: true });
});

test('書込トークン (Bearer / Cookie sailviz_token) → 共有ログイン(書込可)', () => {
  for (const headers of [{ authorization: `Bearer ${TOKEN}` }, { cookie: `sailviz_token=${TOKEN}` }]) {
    const s = resolveSubject(req(headers), base);
    assert.equal(s.kind, 'legacy'); assert.equal(s.canWrite, true); assert.equal(s.orgId, 'o_main');
  }
});

test('閲覧ゲート無効(アカウント機能なし=ファイル版): Cookie なしでも読める共有ログイン(書込不可)。トークンがあれば書込可', () => {
  const open = { ...base, viewEnabled: false, viewSecret: null };
  assert.equal(resolveSubject(req(), open).canWrite, false);
  assert.equal(resolveSubject(req({ authorization: `Bearer ${TOKEN}` }), open).canWrite, true);
});

test('閲覧ゲート無効でもアカウント機能があれば、未ログインは null(共有ログインにしない)。トークンは共有ログイン', () => {
  const accounts = { getAuthTokenByHash: () => null, listMembershipsOfUser: () => [] };
  const open = { ...base, viewEnabled: false, viewSecret: null, accounts };
  assert.equal(resolveSubject(req(), open), null);
  assert.equal(resolveSubject(req({ cookie: 'sailviz_view=anything' }), open), null);
  assert.equal(resolveSubject(req({ authorization: `Bearer ${TOKEN}` }), open).kind, 'legacy');
});

test('未ログイン・誤ったトークンは null', () => {
  assert.equal(resolveSubject(req(), base), null);
  assert.equal(resolveSubject(req({ authorization: 'Bearer wrong' }), base), null);
  assert.equal(resolveSubject(req({ cookie: 'sailviz_view=nope' }), base), null);
});

test('MIGRATION_ORG_ID 未設定(空文字含む)は orgId が null の共有ログイン', () => {
  for (const migrationOrgId of [undefined, '', null]) {
    const s = resolveSubject(req({ cookie: `sailviz_view=${SECRET}` }), { ...base, migrationOrgId });
    assert.equal(s.orgId, null);
  }
});

test('アカウントの Bearer → user(userId, 所属組織)。無効なトークンは null', () => {
  const tok = 'account-token-xyz';
  const accounts = {
    getAuthTokenByHash: (h) => (h === hashToken(tok) ? { id: 't1', user_id: 'u_1', revoked_at: null, expires_at: null } : null),
    getUser: (id) => (id === 'u_1' ? { id: 'u_1', deleted_at: null } : null),
    touchAuthToken: () => {},
    listMembershipsOfUser: (id) => (id === 'u_1' ? [{ org_id: 'o_a' }, { org_id: 'o_b' }] : []),
  };
  const s = resolveSubject(req({ authorization: `Bearer ${tok}` }), { ...base, accounts });
  assert.deepEqual(s, { kind: 'user', userId: 'u_1', orgIds: ['o_a', 'o_b'], activeOrgId: 'o_a' });
  assert.equal(resolveSubject(req({ authorization: 'Bearer other' }), { ...base, accounts }), null);
  // 共有トークンが先に判定される
  assert.equal(resolveSubject(req({ authorization: `Bearer ${TOKEN}` }), { ...base, accounts }).kind, 'legacy');
});

test('閲覧 Cookie とアカウントの sailviz_session Cookie が両方ある → 旧共有ログイン(書込可)を優先。Bearer は user のまま', () => {
  const tok = 'account-token-xyz';
  const accounts = {
    getAuthTokenByHash: (h) => (h === hashToken(tok) ? { id: 't1', user_id: 'u_1', revoked_at: null, expires_at: null } : null),
    getUser: (id) => (id === 'u_1' ? { id: 'u_1', deleted_at: null } : null),
    touchAuthToken: () => {},
    listMembershipsOfUser: () => [{ org_id: 'o_a' }],
  };
  const both = req({ cookie: `sailviz_view=${SECRET}; sailviz_session=${tok}` });
  assert.deepEqual(resolveSubject(both, { ...base, accounts }), { kind: 'legacy', shared: true, orgId: 'o_main', canWrite: true });
  assert.equal(resolveSubject(req({ cookie: `sailviz_session=${tok}` }), { ...base, accounts }).kind, 'user');
  assert.equal(resolveSubject(req({ cookie: `sailviz_view=bad; sailviz_session=${tok}` }), { ...base, accounts }).kind, 'user');
  const bearer = req({ authorization: `Bearer ${tok}`, cookie: `sailviz_view=${SECRET}` });
  assert.equal(resolveSubject(bearer, { ...base, accounts }).kind, 'user');
  assert.equal(resolveSubject(req({ cookie: `sailviz_session=${tok}` }), { ...base, accounts, viewEnabled: false, viewSecret: null }).kind, 'user');
});

// --- 表示中の組織(X-Sailviz-Org ヘッダー) ---
const TOK = 'account-token-xyz';
const accountsWith = (orgs) => ({
  getAuthTokenByHash: (h) => (h === hashToken(TOK) ? { id: 't1', user_id: 'u_1', revoked_at: null, expires_at: null } : null),
  getUser: (id) => (id === 'u_1' ? { id: 'u_1', deleted_at: null } : null),
  touchAuthToken: () => {},
  listMembershipsOfUser: () => orgs.map((org_id) => ({ org_id })),
});
const userReq = (extra = {}) => req({ authorization: `Bearer ${TOK}`, ...extra });

test('ヘッダーなしの user は所属の先頭が activeOrgId', () => {
  const s = resolveSubject(userReq(), { ...base, accounts: accountsWith(['o_a', 'o_b']) });
  assert.equal(s.activeOrgId, 'o_a');
  assert.equal(s.orgForbidden, undefined);
  // 空文字・空白だけのヘッダーはヘッダーなし扱い
  for (const v of ['', '   ']) {
    const t = resolveSubject(userReq({ 'x-sailviz-org': v }), { ...base, accounts: accountsWith(['o_a', 'o_b']) });
    assert.equal(t.activeOrgId, 'o_a');
    assert.equal(t.orgForbidden, undefined);
  }
});

test('所属組織のヘッダーで activeOrgId がその組織になる(前後の空白は無視)', () => {
  const s = resolveSubject(userReq({ 'x-sailviz-org': ' o_b ' }), { ...base, accounts: accountsWith(['o_a', 'o_b']) });
  assert.deepEqual(s, { kind: 'user', userId: 'u_1', orgIds: ['o_a', 'o_b'], activeOrgId: 'o_b' });
});

test('所属外のヘッダーは orgForbidden: true', () => {
  const s = resolveSubject(userReq({ 'x-sailviz-org': 'o_zzz' }), { ...base, accounts: accountsWith(['o_a', 'o_b']) });
  assert.deepEqual(s, { kind: 'user', userId: 'u_1', orgIds: ['o_a', 'o_b'], activeOrgId: null, orgForbidden: true });
});

test('所属ゼロの user はヘッダーなしで activeOrgId null', () => {
  const s = resolveSubject(userReq(), { ...base, accounts: accountsWith([]) });
  assert.deepEqual(s, { kind: 'user', userId: 'u_1', orgIds: [], activeOrgId: null });
});

test('書込トークン・閲覧 Cookie 優先の主体はヘッダーを無視する', () => {
  const accounts = accountsWith(['o_a']);
  const w = resolveSubject(req({ authorization: `Bearer ${TOKEN}`, 'x-sailviz-org': 'o_zzz' }), { ...base, accounts });
  assert.deepEqual(w, { kind: 'legacy', shared: true, orgId: 'o_main', canWrite: true });
  const v = resolveSubject(req({ cookie: `sailviz_view=${SECRET}; sailviz_session=${TOK}`, 'x-sailviz-org': 'o_zzz' }), { ...base, accounts });
  assert.deepEqual(v, { kind: 'legacy', shared: true, orgId: 'o_main', canWrite: true });
  const g = resolveSubject(req({ cookie: `sailviz_view=${SECRET}`, 'x-sailviz-org': 'o_zzz' }), base);
  assert.deepEqual(g, { kind: 'legacy', shared: true, orgId: 'o_main', canWrite: true });
});
