// test/org-create-domain.test.js — 組織作成の純粋な規則(DB 不要)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrgName, createRateLimiter, ORG_NAME_MAX } from '../server/domain/orgCreate.js';

test('validateOrgName: trim して受理、空・非文字列・長すぎ・制御文字は拒否', () => {
  assert.deepEqual(validateOrgName('  テスト部 '), { ok: true, name: 'テスト部' });
  assert.equal(validateOrgName('').ok, false);
  assert.equal(validateOrgName('   ').ok, false);
  assert.equal(validateOrgName(undefined).ok, false);
  assert.equal(validateOrgName(123).ok, false);
  assert.equal(validateOrgName('あ'.repeat(ORG_NAME_MAX)).ok, true);
  assert.equal(validateOrgName('あ'.repeat(ORG_NAME_MAX + 1)).ok, false);
  assert.equal(validateOrgName('a\nb').ok, false);
});

test('createRateLimiter: 窓内で limit 回まで、窓が過ぎれば再び許可、キーは独立', () => {
  const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(rl.check('a', 0), true);
  assert.equal(rl.check('a', 10), true);
  assert.equal(rl.check('a', 20), false);
  assert.equal(rl.check('b', 20), true);
  assert.equal(rl.check('a', 1001), true);
});
