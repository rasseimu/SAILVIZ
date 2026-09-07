// test/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

function fakeApi() {
  const db = { projects: {}, overlays: { progress: {}, roadmap: {} }, unlocked: false };
  return {
    apiListProjects: async () => Object.keys(db.projects).map((name) => ({ name, label: name })),
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
