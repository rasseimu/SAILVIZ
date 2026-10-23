// test/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

function fakeApi() {
  const db = { projects: {}, overlays: { progress: {}, roadmap: {} }, unlocked: false };
  let seq = 0;
  return {
    apiListProjects: async () => Object.keys(db.projects).map((id) => ({ id, name: id, label: id })),
    apiCreateProject: async (name, o) => { const id = `pd_${String(++seq).padStart(10, '0')}`; db.projects[id] = o; return { id, name }; },
    apiListSummaries: async () => [],
    apiGetProject: async (n) => db.projects[n],
    apiPutProject: async (n, o) => { db.projects[n] = o; },
    apiDeleteProject: async (n) => { delete db.projects[n]; },
    apiGetOverlay: async (n) => db.overlays[n],
    apiPutOverlay: async (n, o) => { db.overlays[n] = o; },
    apiAuthStatus: async () => db.unlocked,
    apiUnlock: async (pw) => { db.unlocked = pw === 'ok'; return db.unlocked; },
    apiLock: async () => { db.unlocked = false; },
    _db: db,
  };
}

test('writeProject/readProject via store', async () => {
  const store = createStore(fakeApi());
  await store.writeProject('a.sailviz.json', { version: 1 });
  assert.deepEqual(await store.readProject('a.sailviz.json'), { version: 1 });
});

test('createProject は { id, name } を返し、以後は id で読み書き・削除する', async () => {
  const store = createStore(fakeApi());
  const { id, name } = await store.createProject('a.sailviz.json', { version: 1 });
  assert.equal(name, 'a.sailviz.json');
  assert.equal(id, 'pd_0000000001');
  await store.writeProject(id, { version: 2 });
  assert.deepEqual(await store.readProject(id), { version: 2 });
  await store.deleteProject(id);
  assert.deepEqual(await store.listProjects(), []);
});

test('unlock updates isUnlocked', async () => {
  const store = createStore(fakeApi());
  assert.equal(store.isUnlocked(), false);
  assert.equal(await store.unlock('ok'), true);
  assert.equal(store.isUnlocked(), true);
});

test('progress overlay round-trip', async () => {
  const store = createStore(fakeApi());
  await store.writeProgress({ r1: { issueStage: 1 } });
  assert.deepEqual(await store.readProgress(), { r1: { issueStage: 1 } });
});
