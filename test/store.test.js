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
    apiListReflections: async () => Object.entries(db.projects).map(([id, p]) => ({ id, name: id, reflections: p.reflections || [] })),
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

test('logout calls both shared logout and account logout', async () => {
  const calls = [];
  const store = createStore({
    ...fakeApi(),
    apiLogout: async () => { calls.push('shared'); },
    apiAccountLogout: async () => { calls.push('account'); },
  });
  await store.logout();
  assert.deepEqual(calls.sort(), ['account', 'shared']);
});

test('logout still calls the other when one rejects (shared failure is propagated as before)', async () => {
  let accountCalled = false;
  const s1 = createStore({
    ...fakeApi(),
    apiLogout: async () => { throw new Error('shared down'); },
    apiAccountLogout: async () => { accountCalled = true; },
  });
  await assert.rejects(s1.logout(), /shared down/);
  assert.equal(accountCalled, true);

  let sharedCalled = false;
  const s2 = createStore({
    ...fakeApi(),
    apiLogout: async () => { sharedCalled = true; },
    apiAccountLogout: async () => { throw new Error('account down'); },
  });
  await s2.logout();
  assert.equal(sharedCalled, true);
});

test('loginAny: 共有ログインが通ればそれ。だめでメールアドレスの形ならアカウントで試す。それ以外は共有ログインの理由', async () => {
  const calls = [];
  const mk = (sharedOk, accountOk) => createStore({
    apiLogin: async (u) => { calls.push(['shared', u]); return sharedOk ? { ok: true } : { ok: false, error: '共有だめ' }; },
    apiAccountLogin: async (e) => { calls.push(['account', e]); return accountOk ? { ok: true } : { ok: false, error: 'アカウントだめ' }; },
  });
  assert.deepEqual(await mk(true, false).loginAny('a@example.test', 'pw'), { ok: true, kind: 'shared' });
  assert.deepEqual(calls.splice(0), [['shared', 'a@example.test']]);
  assert.deepEqual(await mk(false, true).loginAny('a@example.test', 'pw'), { ok: true, kind: 'account' });
  assert.deepEqual(calls.splice(0), [['shared', 'a@example.test'], ['account', 'a@example.test']]);
  assert.deepEqual(await mk(false, false).loginAny('a@example.test', 'pw'), { ok: false, error: 'アカウントだめ' });
  calls.splice(0);
  assert.deepEqual(await mk(false, true).loginAny('club-user', 'pw'), { ok: false, error: '共有だめ' });
  assert.deepEqual(calls, [['shared', 'club-user']]); // メールアドレスの形でなければアカウントでは試さない
});

test('listReflections は練習ごとの反省だけを返す', async () => {
  const store = createStore(fakeApi());
  const { id } = await store.createProject('a.sailviz.json', { version: 1, tracks: [{ id: 't' }], reflections: [{ id: 'r1' }] });
  assert.deepEqual(await store.listReflections(), [{ id, name: id, reflections: [{ id: 'r1' }] }]);
});

test('readProjectVideos / appendProjectVideos は api の動画だけの読み・追記に渡す', async () => {
  const calls = [];
  const store = createStore({
    apiGetProjectVideos: async (id) => { calls.push(['get', id]); return []; },
    apiAppendProjectVideos: async (id, v) => { calls.push(['post', id, v]); return { videos: v, added: v.length }; },
  });
  assert.deepEqual(await store.readProjectVideos('pd_1'), []);
  assert.deepEqual(await store.appendProjectVideos('pd_1', [{ t: 1, name: 'a.mp4' }]), { videos: [{ t: 1, name: 'a.mp4' }], added: 1 });
  assert.deepEqual(calls.map((c) => c[0]), ['get', 'post']);
});
