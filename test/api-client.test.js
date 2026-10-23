// test/api-client.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiGetProject, apiPutProject, apiUnlock, apiCommitMinutes, apiCreateProject, apiListProjects, apiMe,
} from '../src/api.js';
import { getActiveOrgId, setActiveOrgId, resolveActiveOrg } from '../src/activeorg.js';

const realFetch = globalThis.fetch;
const lsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
// 表示中の組織は localStorage に覚える。テストごとに空の偽物を差す。
beforeEach(() => {
  const m = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) },
    configurable: true, writable: true,
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (lsDesc) Object.defineProperty(globalThis, 'localStorage', lsDesc);
  else delete globalThis.localStorage;
});

// fetch の呼び出しを記録する偽物。reply(url, init) が応答を返す。
function recordFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return reply(url, init); };
  return calls;
}
const okJson = (body, status = 200) => ({ ok: true, status, json: async () => body });
const orgHeader = (init) => (init.headers || {})['X-Sailviz-Org'];

test('apiGetProject returns parsed json', async () => {
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => ({ version: 1, u }) });
  const p = await apiGetProject('x.sailviz.json');
  assert.equal(p.version, 1);
});

test('apiPutProject throws on non-2xx', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'x' }) });
  await assert.rejects(() => apiPutProject('x.sailviz.json', {}));
});

test('apiUnlock returns false on 401', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  assert.equal(await apiUnlock('bad'), false);
});

test('apiCommitMinutes returns parsed json on 200', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ name: 'x.sailviz.json', added: 2, created: true }) });
  const r = await apiCommitMinutes({ practiceDate: 1, rows: [] });
  assert.equal(r.added, 2);
  assert.equal(r.name, 'x.sailviz.json');
});

test('apiCommitMinutes throws on non-2xx', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: '名簿外' }) });
  await assert.rejects(() => apiCommitMinutes({ practiceDate: 1, rows: [] }), /名簿外/);
});

test('api: 表示中の組織があれば X-Sailviz-Org を付ける', async () => {
  const calls = recordFetch(() => okJson([]));
  await apiListProjects();
  assert.equal(orgHeader(calls[0].init), undefined); // 無ければ付けない(ファイル版・共有ログイン)
  setActiveOrgId('org_a');
  await apiListProjects();
  await apiPutProject('pd_0123456789', { version: 1 });
  assert.equal(orgHeader(calls[1].init), 'org_a');
  assert.equal(orgHeader(calls[2].init), 'org_a');
  assert.equal(calls[2].init.headers['content-type'], 'application/json'); // 既存のヘッダーは残す
  assert.equal(calls[2].init.credentials, 'same-origin');
});

test('api: 練習の読み書きは ID を URL に入れる', async () => {
  const calls = recordFetch(() => okJson({}));
  await apiGetProject('pd_0123456789');
  await apiPutProject('pd_0123456789', {});
  assert.equal(calls[0].url, '/api/projects/pd_0123456789');
  assert.equal(calls[1].url, '/api/projects/pd_0123456789');
  assert.equal(calls[1].init.method, 'PUT');
});

test('api: apiCreateProject は POST /api/projects に { name, project } を送り { id, name } を返す', async () => {
  const calls = recordFetch(() => okJson({ id: 'pd_0123456789', name: '2026-01-02_0900.sailviz.json' }, 201));
  const r = await apiCreateProject('2026-01-02_0900.sailviz.json', { version: 1 });
  assert.deepEqual(r, { id: 'pd_0123456789', name: '2026-01-02_0900.sailviz.json' });
  assert.equal(calls[0].url, '/api/projects');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: '2026-01-02_0900.sailviz.json', project: { version: 1 } });
});

test('api: apiCreateProject は失敗で投げる', async () => {
  recordFetch(() => ({ ok: false, status: 409, json: async () => ({ error: 'exists' }) }));
  await assert.rejects(() => apiCreateProject('x.sailviz.json', {}), /409/);
});

test('403 org_forbidden で表示中の組織を消して me を読み直す', async () => {
  setActiveOrgId('org_gone');
  recordFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'org_forbidden' }) }));
  await assert.rejects(() => apiListProjects());
  assert.equal(getActiveOrgId(), null); // api.js が消す
  // 起動時と同じく me を読み、所属の先頭を表示中にする。以後の要求はその組織で送る。
  const calls = recordFetch((url) => (url === '/api/me'
    ? okJson({ user: { id: 'u_1' }, orgs: [{ id: 'org_a', name: 'A', isAdmin: false }] })
    : okJson([])));
  const me = await apiMe();
  assert.equal(resolveActiveOrg(me.orgs), 'org_a');
  await apiListProjects();
  assert.equal(orgHeader(calls[1].init), 'org_a');
});

test('api: 403 でも org_forbidden 以外は表示中の組織を残す', async () => {
  setActiveOrgId('org_a');
  recordFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }));
  await assert.rejects(() => apiPutProject('pd_0123456789', {}));
  assert.equal(getActiveOrgId(), 'org_a');
});

test('api: apiMe は 401・503 で null を返す(共有ログイン・ファイル版)', async () => {
  recordFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal(await apiMe(), null);
  recordFetch(() => ({ ok: false, status: 503, json: async () => ({ error: 'accounts_unavailable' }) }));
  assert.equal(await apiMe(), null);
});
