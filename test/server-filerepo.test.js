// test/server-filerepo.test.js
// ファイル実装のリポジトリ(保存の窓口)。storage.js の IO を dataDir 束縛の
// メソッドとして包み、Phase 1 の STORAGE=file|db 切替の継ぎ目にする。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRepo } from '../server/repos/fileRepo.js';

let dataDir, repo;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sailviz-filerepo-'));
  repo = createFileRepo(dataDir);
});
after(async () => { await rm(dataDir, { recursive: true, force: true }); });

test('project を write→read で往復する', async () => {
  const name = 'repo-test.sailviz.json';
  const obj = { version: 1, reflections: [], practiceDate: 123 };
  await repo.writeProject(name, obj);
  assert.deepEqual(await repo.readProject(name), obj);
});

test('listProjects が書いた project を含む', async () => {
  const names = (await repo.listProjects()).map((p) => p.name);
  assert.ok(names.includes('repo-test.sailviz.json'));
});

test('overlay を write→read で往復する', async () => {
  await repo.writeOverlay('progress', { r1: { issueStage: 2 } });
  assert.deepEqual(await repo.readOverlay('progress'), { r1: { issueStage: 2 } });
});

test('upload を save→read し rename できる', async () => {
  const importId = 'imp_20260101_abcd1234';
  await repo.saveUpload(importId, 'raw.csv', 'a,b\n1,2\n');
  assert.equal(await repo.readUpload(importId, 'raw.csv'), 'a,b\n1,2\n');
  await repo.renameUpload(importId, 'raw.csv', '15_20260101-0900.csv');
  assert.equal(await repo.readUpload(importId, '15_20260101-0900.csv'), 'a,b\n1,2\n');
});
