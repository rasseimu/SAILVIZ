// test/account-invite-web.test.js
// 招待の管理画面・参加ページ(S2.10)の純関数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageModeForPath, inviteCodeFromPath, parseInviteForm, inviteLimitLabel, joinFailureView, resendFailureView } from '../src/account/logic.js';

test('pageModeForPath: /join/:code は join', () => {
  assert.equal(pageModeForPath('/join/abc'), 'join');
  assert.equal(pageModeForPath('/join/abc/'), 'join');
  assert.equal(pageModeForPath('/join'), 'account');
  assert.equal(pageModeForPath('/account'), 'account');
});

test('inviteCodeFromPath: コードを取り出す(復号・不正は null)', () => {
  assert.equal(inviteCodeFromPath('/join/Ab-_09'), 'Ab-_09');
  assert.equal(inviteCodeFromPath('/join/Ab-_09/'), 'Ab-_09');
  assert.equal(inviteCodeFromPath('/join/a%20b'), 'a b');
  assert.equal(inviteCodeFromPath('/join/%E0%A4%A'), null);
  assert.equal(inviteCodeFromPath('/join/'), null);
  assert.equal(inviteCodeFromPath('/join/a/b'), null);
  assert.equal(inviteCodeFromPath('/account'), null);
});

test('parseInviteForm: 空は無期限/無制限、数値は整数の範囲を検査', () => {
  assert.deepEqual(parseInviteForm('', ''), { ok: true, body: {} });
  assert.deepEqual(parseInviteForm('7', '10'), { ok: true, body: { expiresInDays: 7, maxUses: 10 } });
  assert.deepEqual(parseInviteForm(' 30 ', ''), { ok: true, body: { expiresInDays: 30 } });
  for (const [d, m] of [['0', ''], ['366', ''], ['1.5', ''], ['abc', ''], ['', '0'], ['', '1001'], ['', '-1']]) {
    assert.equal(parseInviteForm(d, m).ok, false, `${d}/${m}`);
  }
});

test('inviteLimitLabel: 期限と利用回数の表示', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.match(inviteLimitLabel({ expiresAt: null, maxUses: null, useCount: 0 }, now), /無期限/);
  assert.match(inviteLimitLabel({ expiresAt: null, maxUses: null, useCount: 0 }, now), /無制限/);
  assert.match(inviteLimitLabel({ expiresAt: now + 3 * 86400000, maxUses: 5, useCount: 2 }, now), /あと3日/);
  assert.match(inviteLimitLabel({ expiresAt: now + 3 * 86400000, maxUses: 5, useCount: 2 }, now), /2 \/ 5/);
});

test('joinFailureView: 参加できなかったときの表示(404/403/410/401/その他)', () => {
  assert.equal(joinFailureView(404, null).kind, 'notfound');
  assert.equal(joinFailureView(403, { error: { code: 'email_not_verified' } }).kind, 'unverified');
  assert.equal(joinFailureView(410, { error: { code: 'invite_revoked' } }).kind, 'gone');
  assert.match(joinFailureView(410, { error: { code: 'invite_revoked' } }).message, /失効/);
  assert.match(joinFailureView(410, { error: { code: 'invite_expired' } }).message, /期限/);
  assert.match(joinFailureView(410, { error: { code: 'invite_exhausted' } }).message, /上限/);
  assert.equal(joinFailureView(401, null).kind, 'login');
  assert.equal(joinFailureView(401, null).needsLogin, true); // 参加ページはこれを見て未ログイン表示(ログインの案内)に落とす
  for (const st of [403, 404, 410, 500]) assert.notEqual(joinFailureView(st, null).needsLogin, true);
  assert.equal(joinFailureView(500, null).kind, 'error');
  assert.equal(joinFailureView(0, null).kind, 'error');
});

test('resendFailureView: 再送が 401 ならログインの案内に落とし、それ以外はそのままエラー表示', () => {
  assert.equal(resendFailureView(401, null).needsLogin, true);
  for (const st of [429, 500, 0]) {
    const v = resendFailureView(st, null);
    assert.equal(v.needsLogin, false);
    assert.ok(v.message);
  }
});
