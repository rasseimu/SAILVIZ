// minutes.html の id 健全性ガード(重複なし + 必須 id 存在)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = () => readFileSync(join(__dir, '..', 'minutes.html'), 'utf8');

test('minutes.html に重複 id が無い', () => {
  const ids = [...html().matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set(); const dupes = new Set();
  for (const id of ids) { if (seen.has(id)) dupes.add(id); seen.add(id); }
  assert.deepEqual([...dupes], [], `重複 id: ${[...dupes].join(', ')}`);
});

test('minutes.html に画面ロジックが参照する必須 id が揃う', () => {
  const h = html();
  for (const id of ['mn-lock', 'mn-password', 'mn-unlock-btn', 'mn-app', 'mn-text',
    'mn-ai-btn', 'mn-manual-btn', 'mn-status', 'mn-preview', 'mn-date', 'mn-commit-btn', 'mn-toast']) {
    assert.ok(new RegExp(`id="${id}"`).test(h), `${id} が無い`);
  }
});

test('minutes.html は src/minutes-input.js を module で読み込む', () => {
  assert.match(html(), /<script[^>]+type="module"[^>]+src="src\/minutes-input\.js"/);
  assert.match(html(), /viewport/);
});
