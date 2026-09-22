// test/api-client.test.js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiGetProject, apiPutProject, apiUnlock, apiCommitMinutes } from '../src/api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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
