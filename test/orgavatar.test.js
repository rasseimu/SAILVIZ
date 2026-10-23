// test/orgavatar.test.js
// サイドバーのアカウント欄: 組織ごとのアバター(色・模様は組織 ID から決まる)。合成 ID だけを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgAvatar } from '../src/orgavatar.js';

test('同じ組織 ID なら毎回同じ見た目', () => {
  assert.deepEqual(orgAvatar({ id: 'org-a', name: 'A部' }), orgAvatar({ id: 'org-a', name: 'A部' }));
});

test('組織 ID が違えば見た目が変わる(多数の ID で色が散らばる)', () => {
  const bgs = new Set();
  for (let i = 0; i < 50; i++) bgs.add(orgAvatar({ id: `org-${i}`, name: 'X' }).background);
  assert.ok(bgs.size >= 40, `distinct=${bgs.size}`);
});

test('見た目は名前でなく ID で決まる(改名しても変わらない)', () => {
  assert.equal(orgAvatar({ id: 'org-a', name: '旧名' }).background, orgAvatar({ id: 'org-a', name: '新名' }).background);
});

test('頭文字は名前の先頭1文字(前後の空白は無視・英字は大文字)', () => {
  assert.equal(orgAvatar({ id: 'x', name: '芝浦工業大学体育会ヨット部' }).initial, '芝');
  assert.equal(orgAvatar({ id: 'x', name: '  sailing club' }).initial, 'S');
  assert.equal(orgAvatar({ id: 'x', name: '🌊海' }).initial, '🌊');
});

test('名前が無ければ ?', () => {
  assert.equal(orgAvatar({ id: 'x', name: '' }).initial, '?');
  assert.equal(orgAvatar({ id: 'x' }).initial, '?');
});

test('background は CSS の background 値(グラデーションを含む)', () => {
  const { background } = orgAvatar({ id: 'org-a', name: 'A' });
  assert.match(background, /linear-gradient\(/);
  assert.match(background, /hsl\(/);
});
