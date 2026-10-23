// test/icons.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { icon, ICON_NAMES, SPRITE_URL } from '../src/icons.js';
import { GUIDE_STEPS } from '../src/homeview.js';

const sprite = readFileSync(new URL('../src/vendor/feather/sprite.svg', import.meta.url), 'utf8');
const spriteIds = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));

test('icon: スプライトの symbol を <use> で参照し、読み上げ対象から外す', () => {
  const html = icon('play');
  assert.match(html, /^<svg class="ic" aria-hidden="true" focusable="false">/);
  assert.ok(html.includes(`<use href="${SPRITE_URL}#play"></use>`));
});

test('icon: 未収録の名前は投げる(空の四角を出さない)', () => {
  assert.throws(() => icon('no-such-icon'), /unknown icon/);
  assert.throws(() => icon('play"><script>'), /unknown icon/);
});

test('ICON_NAMES とスプライトの symbol が一致する', () => {
  assert.deepEqual([...ICON_NAMES].sort(), [...spriteIds].sort());
});

test('使い方ガイドの各手順は収録済みのアイコン名を使う', () => {
  for (const s of GUIDE_STEPS) assert.ok(ICON_NAMES.has(s.icon), s.icon);
});

test('index.html が参照するアイコンはすべてスプライトにある', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const used = [...html.matchAll(/sprite\.svg#([a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const n of used) assert.ok(spriteIds.has(n), n);
});
