// test/db-export.test.js
// 書き戻し(DB→ファイル)の往復: 実データ data/ を DB に取込→別ディレクトリへ書き戻し、
// 旧ファイルと内容一致(file→DB→file)。移行の戻し道の安全性を保証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db/connection.js';
import { migrate, loadMigrations } from '../server/db/migrate.js';
import { importFromFiles } from '../server/db/importFromFiles.js';
import { exportToFiles } from '../server/db/exportToFiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(ROOT, 'server', 'db', 'migrations');
const SRC = join(ROOT, 'data');

test('実データ file→DB→file が全件内容一致', async () => {
  if (!existsSync(join(SRC, 'projects'))) { assert.ok(true, 'no corpus'); return; }
  const out = await mkdtemp(join(tmpdir(), 'sailviz-export-'));
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  importFromFiles({ db, dataDir: SRC, now: 1 });
  const report = exportToFiles({ db, outDir: out });

  const srcFiles = readdirSync(join(SRC, 'projects')).filter((f) => f.endsWith('.sailviz.json')).sort();
  const outFiles = readdirSync(join(out, 'projects')).filter((f) => f.endsWith('.sailviz.json')).sort();
  assert.deepEqual(outFiles, srcFiles, '器のファイル名が一致');
  assert.equal(report.projects, srcFiles.length);

  for (const f of srcFiles) {
    const a = JSON.parse(readFileSync(join(SRC, 'projects', f), 'utf8'));
    const b = JSON.parse(readFileSync(join(out, 'projects', f), 'utf8'));
    assert.deepStrictEqual(b, a, `project mismatch: ${f}`);
  }

  if (existsSync(join(SRC, 'progress.json'))) {
    assert.deepStrictEqual(
      JSON.parse(readFileSync(join(out, 'progress.json'), 'utf8')),
      JSON.parse(readFileSync(join(SRC, 'progress.json'), 'utf8')),
    );
  }
  if (existsSync(join(SRC, 'roadmap.json'))) {
    assert.deepStrictEqual(
      JSON.parse(readFileSync(join(out, 'roadmap.json'), 'utf8')),
      JSON.parse(readFileSync(join(SRC, 'roadmap.json'), 'utf8')),
    );
  }
  db.close();
  await rm(out, { recursive: true, force: true });
});
