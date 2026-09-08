import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TODAIYACHT, SOURCES } from '../src/references/todaiyacht.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('TODAIYACHT: メタ情報', () => {
  assert.equal(TODAIYACHT.id, 'todaiyacht');
  assert.equal(TODAIYACHT.baseUrl, 'https://www.todaiyacht.jp/sailing/');
  assert.ok(TODAIYACHT.label);
});

test('TODAIYACHT: 21章すべてが必須キーとURL整合を満たす', () => {
  assert.equal(TODAIYACHT.chapters.length, 21);
  const nums = new Set();
  for (const c of TODAIYACHT.chapters) {
    assert.equal(typeof c.title, 'string'); assert.ok(c.title.length);
    assert.equal(typeof c.summary, 'string'); assert.ok(c.summary.length);
    assert.equal(c.url, `${TODAIYACHT.baseUrl}${c.chapter}.html`);
    assert.ok(Number.isInteger(c.chapter) && c.chapter >= 1 && c.chapter <= 21);
    nums.add(c.chapter);
  }
  assert.equal(nums.size, 21);
});

test('SOURCES: 東大21章＋動画＋書籍6章、必須キーとid一意', () => {
  assert.ok(SOURCES.length >= 28);
  const ids = new Set();
  for (const s of SOURCES) {
    assert.equal(typeof s.id, 'string'); assert.ok(s.id.length);
    assert.equal(typeof s.title, 'string'); assert.ok(s.title.length);
    assert.equal(typeof s.summary, 'string'); assert.ok(s.summary.length);
    assert.ok(s.link === null || /^https?:\/\//.test(s.link));
    assert.match(s.file, /^src\/references\/.+\.(pdf|txt)$/);
    assert.ok(s.mime === 'application/pdf' || s.mime === 'text/plain');
    ids.add(s.id);
  }
  assert.equal(ids.size, SOURCES.length); // id重複なし
});

test('SOURCES: 書籍Winning in 470の6章がテキストソースとして揃う', () => {
  const book = SOURCES.filter((s) => s.id.startsWith('win470-ch'));
  assert.equal(book.length, 6);
  for (const s of book) {
    assert.equal(s.mime, 'text/plain');
    assert.equal(s.link, null);
    assert.match(s.file, /\.txt$/);
  }
});

test('SOURCES: 参照するファイルが実在する(ファイルパスの検証)', () => {
  for (const s of SOURCES) {
    assert.ok(existsSync(join(repoRoot, s.file)), `ファイルが見つからない: ${s.file}`);
  }
});
