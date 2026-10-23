// test/db-export.test.js
// 書き戻し(DB→ファイル)の往復: 実データ data/ を DB に取込→別ディレクトリへ書き戻し、
// 旧ファイルと内容一致(file→DB→file)。移行の戻し道の安全性を保証する。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite ガード: Node <22.5 では skip する
const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(ROOT, 'server', 'db', 'migrations');
const SRC = join(ROOT, 'data');

let openDb, migrate, loadMigrations, importFromFiles, exportToFiles;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ importFromFiles } = await import('../server/db/importFromFiles.js'));
  ({ exportToFiles } = await import('../server/db/exportToFiles.js'));
}

test('実データ file→DB→file が全件内容一致', { skip: skipMsg }, async () => {
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

test('exportToFiles: 同名の器は上書きせず別名で書き出す', { skip: skipMsg }, async () => {
  const { createDbRepo } = await import('../server/repos/dbRepo.js');
  const out = await mkdtemp(join(tmpdir(), 'sailviz-export-dup-'));
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  const repo = createDbRepo({ db, dataDir: out });
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  const proj = (m) => ({ version: 3, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
    tracks: [], events: [], marks: [{ id: m }], pins: [], videos: [], reflections: [] });
  const a = repo.createProject(proj('mA'), { name: NAME });
  const b = repo.createProject(proj('mB'), { name: NAME });
  const report = exportToFiles({ db, outDir: out });
  assert.equal(report.projects, 2);
  // 並びは id 順なので、id の小さい方がそのままの名前、もう一方が <名前>-<id>.sailviz.json
  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  const secondName = `sailviz-20260901-0900-${second.id}.sailviz.json`;
  assert.deepEqual(readdirSync(join(out, 'projects')).sort(), [NAME, secondName].sort());
  const marksOf = (f) => JSON.parse(readFileSync(join(out, 'projects', f), 'utf8')).marks[0].id;
  assert.equal(marksOf(NAME), first === a ? 'mA' : 'mB');
  assert.equal(marksOf(secondName), second === a ? 'mA' : 'mB');
  db.close();
  await rm(out, { recursive: true, force: true });
});

// 組織が 2 つあるとき: 練習・全体目標(__team__)・進捗を組織ごとに分けて書き出す(混ぜない)。合成データだけ。
async function twoOrgDb(out) {
  const { createDbRepo } = await import('../server/repos/dbRepo.js');
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  const repo = createDbRepo({ db, dataDir: out });
  const proj = (reflections) => ({ version: 3, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
    tracks: [], events: [], marks: [], pins: [], videos: [], reflections });
  const refl = (id) => ({ id, people: ['テスト部員A'], createdAt: 1, notes: { goal: id } });
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  repo.createProject(proj([refl('rA'), refl('rDup')]), { name: NAME, orgId: 'org_a' });
  repo.createProject(proj([refl('rB'), refl('rDup')]), { name: 'sailviz-20260902-0900.sailviz.json', orgId: 'org_b' });
  repo.writeOverlay('roadmap', { __team__: { goal: 'Aの全体目標', milestones: [] } }, { orgId: 'org_a', scopeOrgId: 'org_a' });
  repo.writeOverlay('roadmap', { __team__: { goal: 'Bの全体目標', milestones: [] } }, { orgId: 'org_b', scopeOrgId: 'org_b' });
  repo.writeOverlay('progress', { rA: { issueStage: 1 }, rB: { issueStage: 2 }, rDup: { issueStage: 3 } });
  return { db, NAME };
}

test('exportToFiles: orgId を渡すとその組織の練習・全体目標・進捗だけを書き出す', { skip: skipMsg }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'sailviz-export-org-'));
  const { db, NAME } = await twoOrgDb(out);
  const report = exportToFiles({ db, outDir: out, orgId: 'org_a' });
  assert.deepEqual(readdirSync(join(out, 'projects')), [NAME]);
  assert.equal(report.projects, 1);
  const read = (f) => JSON.parse(readFileSync(join(out, f), 'utf8'));
  assert.equal(read('roadmap.json').__team__.goal, 'Aの全体目標');
  // rDup は A と B の両方にある反省 ID なので、A だけの書き出しには入れない
  assert.deepEqual(read('progress.json'), { rA: { issueStage: 1 } });
  db.close();
  await rm(out, { recursive: true, force: true });
});

test('exportToFiles: 組織が 2 つ以上あるのに orgId が無ければ混ぜずに投げる', { skip: skipMsg }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'sailviz-export-org-'));
  const { db } = await twoOrgDb(out);
  assert.throws(() => exportToFiles({ db, outDir: out }), /orgId|MIGRATION_ORG_ID/);
  assert.equal(existsSync(join(out, 'projects')), false, '何も書かない');
  db.close();
  await rm(out, { recursive: true, force: true });
});
