// test/account-delete-web.test.js
// 退会画面(S2.12)の純関数: 後任の選択対象の算出と DELETE /api/me の本文づくり。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soleAdminOrgs, buildDeleteBody, displayName, unloadedAdminOrgs, unloadedNotice } from '../src/account/logic.js';

const orgs = [
  { id: 'o1', name: '部A', isAdmin: true },
  { id: 'o2', name: '部B', isAdmin: true },
  { id: 'o3', name: '部C', isAdmin: false },
];
const membersByOrg = {
  o1: [{ userId: 'me', name: '自分', isAdmin: true }, { userId: 'u2', name: '甲', isAdmin: false }, { userId: 'u3', name: '乙', isAdmin: false }],
  o2: [{ userId: 'me', name: '自分', isAdmin: true }, { userId: 'u4', name: '丙', isAdmin: true }],
  o3: [{ userId: 'me', name: '自分', isAdmin: false }, { userId: 'u5', name: '丁', isAdmin: true }],
};

test('soleAdminOrgs: 自分が管理者で他に管理者がいない組織だけ、自分以外のメンバーを候補にして返す', () => {
  const r = soleAdminOrgs('me', orgs, membersByOrg);
  assert.equal(r.length, 1);
  assert.equal(r[0].orgId, 'o1');
  assert.equal(r[0].orgName, '部A');
  assert.deepEqual(r[0].candidates, [{ userId: 'u2', name: '甲' }, { userId: 'u3', name: '乙' }]);
});

test('soleAdminOrgs: メンバーが自分だけの組織は候補なし(後任なしで残る)・メンバー一覧が無い組織は除く', () => {
  const r = soleAdminOrgs('me', [{ id: 'o1', name: '部A', isAdmin: true }, { id: 'o9', name: '部Z', isAdmin: true }],
    { o1: [{ userId: 'me', name: '自分', isAdmin: true }] });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].candidates, []);
  assert.deepEqual(soleAdminOrgs('me', null, null), []);
});

test('soleAdminOrgs: orgs[] で isAdmin でも、members で自分が非管理者なら対象外', () => {
  const r = soleAdminOrgs('me', [{ id: 'o1', name: '部A', isAdmin: true }],
    { o1: [{ userId: 'me', name: '自分', isAdmin: false }, { userId: 'u2', name: '甲', isAdmin: false }] });
  assert.deepEqual(r, []);
});

test('soleAdminOrgs: members に自分がいなければ(他に管理者もいなければ)対象のまま', () => {
  const r = soleAdminOrgs('me', [{ id: 'o1', name: '部A', isAdmin: true }],
    { o1: [{ userId: 'u2', name: '甲', isAdmin: false }] });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].candidates, [{ userId: 'u2', name: '甲' }]);
});

test('unloadedNotice: 言い切らず「唯一の管理者の場合」と条件付きで書く。組織名と「読み込めなかった」を含む', () => {
  const s = unloadedNotice('部A');
  assert.match(s, /部A/);
  assert.match(s, /読み込めなかった/);
  assert.match(s, /唯一の管理者の場合/);
  assert.match(s, /管理者不在/);
});

test('buildDeleteBody: choices の null・数値は successors に入らない', () => {
  assert.deepEqual(buildDeleteBody('pw', { o1: null, o2: 5, o3: 'u3' }), { ok: true, body: { password: 'pw', successors: { o3: 'u3' } } });
  assert.deepEqual(buildDeleteBody('pw', { o1: null, o2: 5 }), { ok: true, body: { password: 'pw' } });
});

test('buildDeleteBody: 空白だけのパスワードも加工せずそのまま送る', () => {
  assert.deepEqual(buildDeleteBody('   ', {}), { ok: true, body: { password: '   ' } });
});

test('displayName: 名前が空・空白なら「(名前なし)」', () => {
  assert.equal(displayName('甲'), '甲');
  assert.equal(displayName(''), '(名前なし)');
  assert.equal(displayName('  '), '(名前なし)');
  assert.equal(displayName(undefined), '(名前なし)');
});

test('unloadedAdminOrgs: 管理者の組織のうち members を取得できなかったものを返す', () => {
  const r = unloadedAdminOrgs(orgs, { o1: [] });
  assert.deepEqual(r.map((o) => o.id), ['o2']);
  assert.deepEqual(unloadedAdminOrgs(null, null), []);
});

test('buildDeleteBody: パスワード必須。選んだ組織だけ successors に入れ、未選択なら successors を付けない', () => {
  assert.equal(buildDeleteBody('', {}).ok, false);
  assert.deepEqual(buildDeleteBody('pw', {}), { ok: true, body: { password: 'pw' } });
  assert.deepEqual(buildDeleteBody('pw', { o1: '', o2: undefined }), { ok: true, body: { password: 'pw' } });
  assert.deepEqual(buildDeleteBody('pw', { o1: 'u2', o2: '' }), { ok: true, body: { password: 'pw', successors: { o1: 'u2' } } });
});
