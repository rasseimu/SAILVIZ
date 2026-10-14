// test/db-migrate-load.test.js
// loadMigrations: ファイル名先頭の数字(version)が重複したら例外にする(S2.6-P8)。fs のみ(node:sqlite 不要)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations } from '../server/db/migrate.js';

test('version が重複するマイグレーションは例外', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sailviz-mig-'));
  await writeFile(join(dir, '001_a.sql'), 'SELECT 1;');
  await writeFile(join(dir, '003_b.sql'), 'SELECT 1;');
  await writeFile(join(dir, '003_c.sql'), 'SELECT 1;');
  assert.throws(() => loadMigrations(dir), /重複.*003_b\.sql.*003_c\.sql/);
  await rm(dir, { recursive: true, force: true });
});

test('重複が無ければ version 順に読める。実際の migrations/ も重複なし', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sailviz-mig-'));
  await writeFile(join(dir, '002_b.sql'), 'SELECT 1;');
  await writeFile(join(dir, '001_a.sql'), 'SELECT 1;');
  assert.deepEqual(loadMigrations(dir).map((m) => m.version), [1, 2]);
  await rm(dir, { recursive: true, force: true });
  const real = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');
  assert.doesNotThrow(() => loadMigrations(real));
});
