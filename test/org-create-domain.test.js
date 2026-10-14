// test/org-create-domain.test.js — 組織作成の純粋な規則(DB 不要)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrgName, ORG_NAME_MAX } from '../server/domain/orgCreate.js';

test('validateOrgName: C1 制御文字・向きを変える文字・行区切りも拒否', () => {
  for (const cp of [0x85, 0x9f, 0x61c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
    assert.equal(validateOrgName(`a${String.fromCodePoint(cp)}b`).ok, false, cp.toString(16));
  }
  assert.equal(validateOrgName('芝浦 部 (2026)').ok, true);
});

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
