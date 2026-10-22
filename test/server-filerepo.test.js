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
  await repo.createProject(obj, { name });
  assert.deepEqual(await repo.readProject(name), obj);
});

test('listProjects の id は name と同じ', async () => {
  const p = (await repo.listProjects()).find((x) => x.name === 'repo-test.sailviz.json');
  assert.equal(p.id, p.name);
  assert.ok('label' in p);
});

test('createProject は { id: name, name } を返し、既存名で exists', async () => {
  const name = 'repo-create.sailviz.json';
  assert.deepEqual(await repo.createProject({ version: 1 }, { name }), { id: name, name });
  await assert.rejects(() => repo.createProject({ version: 1 }, { name }), (e) => e.code === 'exists');
});

test('writeProject は既存を更新し、無い名前で not_found', async () => {
  const name = 'repo-create.sailviz.json';
  await repo.writeProject(name, { version: 2 });
  assert.deepEqual(await repo.readProject(name), { version: 2 });
  await assert.rejects(() => repo.writeProject('nothing.sailviz.json', {}), (e) => e.code === 'not_found');
});

test('finder は { id, name, label } を返す', async () => {
  await repo.createProject({ version: 1, practiceDate: Date.UTC(2026, 0, 5, 0, 0) }, { name: 'repo-find.sailviz.json' });
  const f = await repo.findProjectByPracticeDate(Date.UTC(2026, 0, 5, 0, 0));
  assert.equal(f.id, 'repo-find.sailviz.json');
  assert.equal(f.name, f.id);
  assert.equal(await repo.findProjectByPracticeDate(Date.UTC(2000, 0, 1)), null);
});

test('overlay は { orgId, scopeOrgId } を受けても無視する', async () => {
  await repo.writeOverlay('roadmap', { a: 1 }, { orgId: 'o', scopeOrgId: 'o' });
  assert.deepEqual(await repo.readOverlay('roadmap', { orgId: 'x' }), { a: 1 });
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
