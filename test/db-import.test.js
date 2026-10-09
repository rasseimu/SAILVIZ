// test/db-import.test.js
// ファイル→DB 取込: dry-run は書かず件数と orphan 警告を出す。実行は冪等。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite ガード: Node <22.5 では skip する
const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');

let openDb, migrate, loadMigrations, importFromFiles;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ importFromFiles } = await import('../server/db/importFromFiles.js'));
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-import-'));
  await mkdir(join(dataDir, 'projects'), { recursive: true });
  const proj = (refls, tracks = []) => JSON.stringify({ version: 3, mode: 'absolute', accuracyFilter: true,
    crop: { start: 0, end: 0 }, tracks, events: [], marks: [], pins: [], videos: [], reflections: refls });
  await writeFile(join(dataDir, 'projects', 'sailviz-20260901-0900.sailviz.json'),
    proj([{ id: 'reflA', createdAt: 1, text: 'a', people: ['村瀬 礼'], notes: {} }],
      [{ id: 't1', name: '1', color: '#e6194B', visible: true, points: [{ t: 1, lat: 35, lon: 139, speed: 1 }], bounds: { minLat: 35, maxLat: 35, minLon: 139, maxLon: 139 } }]));
  await writeFile(join(dataDir, 'projects', 'sailviz-20260902-0900.sailviz.json'),
    proj([{ id: 'reflB', createdAt: 2, text: 'b', people: [], notes: {} }]));
  // progress: reflA は実在、ghost は orphan
  await writeFile(join(dataDir, 'progress.json'), JSON.stringify({
    reflA: { issueStage: 1, goalDone: false, text: { goal: 'g' }, comments: { goal: [{ text: 'c', ts: 5 }] } },
    ghost: { issueStage: 0, goalDone: false },
  }));
  await writeFile(join(dataDir, 'roadmap.json'), JSON.stringify({ '村瀬 礼': { goal: 'x', milestones: [] } }));
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  return { dataDir, db };
}

const count = (db, t) => db.prepare(`SELECT count(*) c FROM ${t}`).get().c;

test('dry-run は件数と orphan 警告を返し、DB に書かない', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  const report = importFromFiles({ db, dataDir, dryRun: true, now: 1 });
  assert.equal(report.projects, 2);
  assert.equal(report.tracks, 1);
  assert.equal(report.reflections, 2);
  assert.equal(report.progress, 2);
  assert.ok(report.warnings.some((w) => w.includes('ghost')), 'orphan progress 警告');
  assert.equal(count(db, 'practice_days'), 0, 'dry-run は書かない');
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('実行で行が入り、2回流しても件数が変わらない(冪等)', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  importFromFiles({ db, dataDir, now: 1 });
  const snap = () => ['practice_days', 'rec_sessions', 'tracks', 'reflections', 'reflection_progress', 'reflection_comments', 'roadmaps'].map((t) => count(db, t));
  const first = snap();
  assert.deepEqual(first, [2, 1, 1, 2, 2, 1, 1]);
  importFromFiles({ db, dataDir, now: 2 });
  assert.deepEqual(snap(), first, '2回目も同じ件数');
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('取込後の往復: readProject が元ファイルと一致(_rev 除く)', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  importFromFiles({ db, dataDir, now: 1 });
  const { createDbRepo } = await import('../server/repos/dbRepo.js');
  const repo = createDbRepo({ db, dataDir });
  const got = await repo.readProject('sailviz-20260901-0900.sailviz.json');
  const { _rev, ...pure } = got;
  const { readFileSync } = await import('node:fs');
  const original = JSON.parse(readFileSync(join(dataDir, 'projects', 'sailviz-20260901-0900.sailviz.json'), 'utf8'));
  assert.deepStrictEqual(pure, original);
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});
