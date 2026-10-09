// test/open-repo.test.js
// STORAGE=file|db の切替ファクトリ。db は接続+マイグレーション込みで返す。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node:sqlite ガード: Node <22.5 では skip する
const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

let openRepo;
if (hasSqlite) {
  ({ openRepo } = await import('../server/repos/openRepo.js'));
}

const baseProj = { version: 3, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
  tracks: [], events: [], marks: [], pins: [], videos: [], reflections: [] };

test('STORAGE=db は DB 版リポジトリを返し、sqlite ファイルを作る', { skip: skipMsg }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-openrepo-'));
  const { repo, db } = openRepo({ storage: 'db', dataDir });
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj);
  const got = await repo.readProject('sailviz-20260901-0900.sailviz.json');
  assert.equal(got._rev, 1);
  const files = await readdir(dataDir);
  assert.ok(files.some((f) => f === 'sailviz.db'), 'sqlite file created');
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('STORAGE 未指定は file 版リポジトリ(db は null)', { skip: skipMsg }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-openrepo-'));
  const { repo, db } = openRepo({ dataDir });
  assert.equal(db, null);
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj);
  const files = await readdir(join(dataDir, 'projects'));
  assert.ok(files.includes('sailviz-20260901-0900.sailviz.json'), 'file written');
  await rm(dataDir, { recursive: true, force: true });
});
