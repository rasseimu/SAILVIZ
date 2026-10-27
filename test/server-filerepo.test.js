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

test('appendVideos は name + t が未登録の動画だけ足し、他の項目はそのまま。足さなければ書かない', async () => {
  const name = 'repo-videos.sailviz.json';
  const obj = { version: 1, reflections: [{ id: 'r1' }], videos: [{ id: 'vid0', t: 100, name: 'a.mp4', durationMs: null }] };
  await repo.createProject(obj, { name });
  const res = await repo.appendVideos(name, [{ t: 100, name: 'a.mp4' }, { t: 200, name: 'b.mp4', durationMs: 5 }]);
  assert.equal(res.added, 1);
  const saved = await repo.readProject(name);
  assert.deepEqual(saved.reflections, obj.reflections);
  assert.deepEqual(saved.videos, res.videos);
  assert.deepEqual(await repo.readVideos(name), res.videos);
  assert.equal((await repo.appendVideos(name, [{ t: 200, name: 'b.mp4' }])).added, 0);
});

test('appendVideos は同じ練習への同時の追記を直列にし、重複も取りこぼしもない', async () => {
  const name = 'repo-videos-concurrent.sailviz.json';
  await repo.createProject({ version: 1 }, { name });
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => repo.appendVideos(name, [{ t: i, name: `v${i}.mp4` }, { t: 0, name: 'v0.mp4' }])));
  assert.equal(results.reduce((n, r) => n + r.added, 0), 5);
  const saved = await repo.readVideos(name);
  assert.deepEqual(saved.map((v) => v.name).sort(), ['v0.mp4', 'v1.mp4', 'v2.mp4', 'v3.mp4', 'v4.mp4']);
});

test('appendVideos / readVideos は無いファイル・不正な名前で not_found を投げる。失敗しても次の追記は進む', async () => {
  await assert.rejects(repo.appendVideos('missing.sailviz.json', []), (e) => e.code === 'not_found');
  await assert.rejects(repo.appendVideos('pd_0000000000', []), (e) => e.code === 'not_found');
  await assert.rejects(repo.readVideos('missing.sailviz.json'), (e) => e.code === 'not_found');
  assert.equal((await repo.appendVideos('repo-videos.sailviz.json', [{ t: 300, name: 'c.mp4' }])).added, 1);
});

test('全体の書き込み(writeProject)と動画の追記を同時に送っても、反省も動画も残る(直列にする)', async () => {
  const name = 'repo-videos-put.sailviz.json';
  await repo.createProject({ version: 1, reflections: [], videos: [] }, { name });
  // 追記が先に読み、全体の書き込みが後に書く順でも、追記の書き込みが全体の書き込みを古い内容で上書きしない
  await Promise.all([
    repo.appendVideos(name, [{ t: 1, name: 'a.mp4' }]),
    repo.writeProject(name, { version: 2, reflections: [{ id: 'r1' }], videos: [{ id: 'vid0', t: 1, name: 'a.mp4', durationMs: null }] }),
    repo.appendVideos(name, [{ t: 2, name: 'b.mp4' }]),
  ]);
  const saved = await repo.readProject(name);
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.reflections, [{ id: 'r1' }]);
  assert.deepEqual(saved.videos.map((v) => v.name), ['a.mp4', 'b.mp4']);
});

test('writeProject / createProject の失敗(not_found・exists)は投げ、後続の書き込みは進む', async () => {
  await assert.rejects(repo.writeProject('missing2.sailviz.json', {}), (e) => e.code === 'not_found');
  await assert.rejects(repo.createProject({}, { name: 'repo-videos-put.sailviz.json' }), (e) => e.code === 'exists');
  await repo.writeProject('repo-videos-put.sailviz.json', { version: 3 });
  assert.equal((await repo.readProject('repo-videos-put.sailviz.json')).version, 3);
});
