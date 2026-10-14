// test/invites-domain.test.js — 招待の純関数(有効性判定・入力検証・コード生成)。DB 不要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inviteStatus, validateInviteInput, generateInviteCode, expiresAtFromDays, DAY_MS,
} from '../server/domain/invites.js';

const NOW = 1_000_000_000;
const base = { revoked_at: null, expires_at: null, max_uses: null, use_count: 0 };

test('inviteStatus: 無期限・無制限は valid', () => {
  assert.equal(inviteStatus(base, NOW), 'valid');
});
test('inviteStatus: 失効済みは revoked(他の条件より優先)', () => {
  assert.equal(inviteStatus({ ...base, revoked_at: 5, expires_at: NOW - 1, max_uses: 1, use_count: 1 }, NOW), 'revoked');
});
test('inviteStatus: 期限は expires_at <= now で expired(境界を含む)', () => {
  assert.equal(inviteStatus({ ...base, expires_at: NOW + 1 }, NOW), 'valid');
  assert.equal(inviteStatus({ ...base, expires_at: NOW }, NOW), 'expired');
  assert.equal(inviteStatus({ ...base, expires_at: NOW - 1 }, NOW), 'expired');
});
test('inviteStatus: use_count >= max_uses で exhausted', () => {
  assert.equal(inviteStatus({ ...base, max_uses: 2, use_count: 1 }, NOW), 'valid');
  assert.equal(inviteStatus({ ...base, max_uses: 2, use_count: 2 }, NOW), 'exhausted');
  assert.equal(inviteStatus({ ...base, max_uses: 2, use_count: 3 }, NOW), 'exhausted');
});
test('inviteStatus: expired は exhausted より優先', () => {
  assert.equal(inviteStatus({ ...base, expires_at: NOW - 1, max_uses: 1, use_count: 1 }, NOW), 'expired');
});
test('inviteStatus: 行が無ければ null', () => {
  assert.equal(inviteStatus(null, NOW), null);
});

test('validateInviteInput: 省略は null(無期限・無制限)', () => {
  assert.deepEqual(validateInviteInput({}), { ok: true, expiresInDays: null, maxUses: null });
  assert.deepEqual(validateInviteInput({ expiresInDays: null, maxUses: null }), { ok: true, expiresInDays: null, maxUses: null });
});
test('validateInviteInput: 範囲内の整数は通す', () => {
  assert.deepEqual(validateInviteInput({ expiresInDays: 7, maxUses: 30 }), { ok: true, expiresInDays: 7, maxUses: 30 });
  assert.equal(validateInviteInput({ expiresInDays: 365, maxUses: 1000 }).ok, true);
  assert.equal(validateInviteInput({ expiresInDays: 1, maxUses: 1 }).ok, true);
});
test('validateInviteInput: 範囲外・非整数・型違いは拒否', () => {
  for (const bad of [0, -1, 366, 1.5, '7', NaN, true]) {
    assert.equal(validateInviteInput({ expiresInDays: bad }).ok, false, `days ${bad}`);
  }
  for (const bad of [0, -1, 1001, 2.5, '3', Infinity, false]) {
    assert.equal(validateInviteInput({ maxUses: bad }).ok, false, `uses ${bad}`);
  }
});

test('expiresAtFromDays', () => {
  assert.equal(expiresAtFromDays(null, NOW), null);
  assert.equal(expiresAtFromDays(2, NOW), NOW + 2 * DAY_MS);
});

test('generateInviteCode: URL-safe・十分な長さ・毎回違う', () => {
  const a = generateInviteCode(); const b = generateInviteCode();
  assert.match(a, /^[A-Za-z0-9_-]{22,}$/);
  assert.notEqual(a, b);
});
