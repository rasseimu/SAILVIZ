// test/display-name.test.js
// 表示名・既定公開範囲の補い(S2.3-P9)。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayNameFor, visibilityFor } from '../server/domain/displayName.js';

test('設定済みの name はそのまま返る', () => {
  assert.equal(displayNameFor({ id: 'usr_abc', name: 'テスト太郎' }), 'テスト太郎');
});

test('null・空・空白のみは「ユーザー」+4文字', () => {
  for (const name of [null, undefined, '', '   ', '　']) {
    assert.match(displayNameFor({ id: 'usr_abc123', name }), /^ユーザー[0-9a-f]{4}$/);
  }
});

test('同じ ID なら毎回同じ。違う ID なら違う', () => {
  const a = displayNameFor({ id: 'usr_aaa', name: null });
  assert.equal(a, displayNameFor({ id: 'usr_aaa', name: '' }));
  assert.notEqual(a, displayNameFor({ id: 'usr_bbb', name: null }));
});

test('メールの @ 前を含まない', () => {
  const n = displayNameFor({ id: 'usr_x1', email: 'abcd1234@example.test', name: null });
  assert.ok(!n.includes('abcd1234') && !n.includes('@'));
});

test('defaultVisibility: null・未設定は self、設定済みはそのまま', () => {
  assert.equal(visibilityFor({ default_visibility: null }), 'self');
  assert.equal(visibilityFor({}), 'self');
  assert.equal(visibilityFor({ default_visibility: 'org' }), 'org');
});
