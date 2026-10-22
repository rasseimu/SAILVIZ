// index.html の id 重複ガード。
// 別々の機能ブランチをマージした際、同じ id を持つ要素が両方残ると
// getElementById が先頭要素しか返さず、後から配線した addEventListener が
// 意図しない要素に付いて機能が無言で壊れる（例: vmg-toggle の重複）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

test('index.html に重複した id が存在しない', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  assert.deepEqual([...dupes], [], `重複 id: ${[...dupes].join(', ')}`);
});

test('index.html に refl-date と import-date が存在する', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  assert.ok(/id="refl-date"/.test(html), 'refl-date が無い');
  assert.ok(/id="import-date"/.test(html), 'import-date が無い');
});

test('index.html に風速帯ノートのUI要素が存在する', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  for (const id of ['progress-kb-rebuild', 'progress-kb-status', 'progress-kb-view', 'kb-modal', 'kb-modal-body', 'kb-modal-download', 'kb-modal-close']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `${id} が無い`);
  }
});

test('index.html にホームと組織管理への導線がある', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  for (const id of ['top-screen', 'top-recent', 'top-goal-text', 'top-goal-form', 'top-member-goals', 'top-guide', 'sb-home-logo', 'account-org']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `${id} が無い`);
  }
  assert.ok(/data-nav="top"/.test(html), 'サイドバーのホームが無い');
  // 組織管理はログアウトの上
  assert.ok(html.indexOf('id="account-org"') < html.indexOf('id="account-logout"'), '組織管理がログアウトより下にある');
  assert.ok(/id="account-org"[^>]*href="\/account#org"/.test(html), '組織管理のリンク先が違う');
});
