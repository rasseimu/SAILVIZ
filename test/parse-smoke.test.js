// 全 src/*.js の構文チェック（node --check 相当）。
// ブラウザ専用のエントリ(app.js)は node から import できず単体テストで拾えないため、
// マージで混入した重複 import 等の SyntaxError を parse 段階で検出する。
// 例: windaxis.js の estimateWindAxisSeries を二重 import → app.js 全体が起動不能。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dir, '..', 'src');

for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
  test(`src/${file} が構文エラーなくパースできる`, () => {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', join(srcDir, file)], { stdio: 'pipe' });
    });
  });
}
