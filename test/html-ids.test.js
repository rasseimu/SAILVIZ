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
