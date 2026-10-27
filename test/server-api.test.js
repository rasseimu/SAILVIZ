// test/server-api.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile as readFileP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../server/api.js';

let server, base, dataDir;
const TOKEN = 's3cret';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sailviz-api-'));
  const api = createApi({ dataDir, token: TOKEN });
  server = createServer(async (req, res) => {
    if (await api(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

test('health ok', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.deepEqual(await r.json(), { ok: true });
});

test('write requires auth', async () => {
  const name = 'sailviz-20260101-0900.sailviz.json';
  const unauth = await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(unauth.status, 401);
});

test('unlock then write then read', async () => {
  const name = 'sailviz-20260101-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  // 新規は POST /api/projects。ファイル版の id はファイル名そのもの。
  const post = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ name, project: { version: 1, tracks: [] } }),
  });
  assert.equal(post.status, 201);
  assert.deepEqual(await post.json(), { id: name, name });
  const put = await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: bearer, body: JSON.stringify({ version: 2, tracks: [] }),
  });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/projects/${name}`)).json();
  assert.equal(got.version, 2);
  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(list.some((p) => p.id === name && p.name === name), true);
});

test('file: PUT は既存のファイルだけ(無ければ 404)、POST の同名は 409', async () => {
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const missing = await fetch(`${base}/api/projects/sailviz-20260109-0900.sailviz.json`, {
    method: 'PUT', headers: bearer, body: JSON.stringify({ version: 1 }),
  });
  assert.equal(missing.status, 404);
  const dup = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ name: 'sailviz-20260101-0900.sailviz.json', project: { version: 1 } }),
  });
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: 'exists' });
  const bad = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ name: '../x', project: {} }),
  });
  assert.equal(bad.status, 400);
});

test('unlock endpoint validates password', async () => {
  const bad = await fetch(`${base}/api/unlock`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/unlock`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: TOKEN }),
  });
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie') || '', /sailviz_token=/);
});

test('GET /api/reflections returns only reflections per project (file version)', async () => {
  const name = 'sailviz-20260104-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const post = await fetch(`${base}/api/projects`, { method: 'POST', headers: bearer,
    body: JSON.stringify({ name, project: { version: 1, tracks: [{ id: 't', points: [{ t: 1, lat: 35, lon: 139 }] }], reflections: [{ id: 'rf1', people: ['部員 A'] }] } }) });
  assert.equal(post.status, 201);
  const rows = await (await fetch(`${base}/api/reflections`)).json();
  assert.deepStrictEqual(rows.find((r) => r.name === name), { id: name, name, reflections: [{ id: 'rf1', people: ['部員 A'] }] });
});

test('summaries returns lightweight rows', async () => {
  const rows = await (await fetch(`${base}/api/summaries`)).json();
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows[0]?.reflectionCount !== undefined, true);
});

test('summaries rows include daySummary saved with the project', async () => {
  const name = 'sailviz-20260102-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const ds = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));
  const post = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ name, project: { version: 1, tracks: [], daySummary: ds } }),
  });
  assert.equal(post.status, 201);
  const rows = await (await fetch(`${base}/api/summaries`)).json();
  const row = rows.find((r) => r.name === name);
  assert.equal(row?.id, name);
  assert.deepEqual(row?.daySummary, ds);
});

test('overlay put/get', async () => {
  const put = await fetch(`${base}/api/overlays/progress`, {
    method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ r1: { issueStage: 2 } }),
  });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/overlays/progress`)).json();
  assert.deepEqual(got, { r1: { issueStage: 2 } });
});

test('ai-comment requires auth (401)', async () => {
  const r = await fetch(`${base}/api/ai-comment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ text: 'x' }] }),
  });
  assert.equal(r.status, 401);
});

test('ai-comment returns 503 when GEMINI_API_KEY is unset', async () => {
  // メインサーバは geminiKey 未設定なので、認証済みでも 503。
  const r = await fetch(`${base}/api/ai-comment`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ text: 'x' }] }),
  });
  assert.equal(r.status, 503);
});

test('ai-comment proxies to Gemini and returns text (auth + key)', async () => {
  // geminiKey 付きの別サーバ。Gemini ホストへの fetch だけスタブし、テスト自身のリクエストは実通信。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'AIコメント' }] } }] }), text: async () => '' };
    }
    return realFetch(url, opts);
  };
  const api2 = createApi({ dataDir, token: TOKEN, geminiKey: 'gkey' });
  const srv = createServer(async (req, res) => { if (await api2(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await realFetch(`${b2}/api/ai-comment`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ text: 'hello' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).text, 'AIコメント');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((r) => srv.close(r));
  }
});

test('DELETE はファイルを消す前に deleted_data_folder へ保存 JSON を書き出す(ファイル版)', async () => {
  const name = 'sailviz-20260106-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const project = { version: 1, tracks: [], reflections: [{ id: 'rdel', people: ['部員 A'] }] };
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST', headers: bearer, body: JSON.stringify({ name, project }) })).status, 201);
  assert.equal((await fetch(`${base}/api/projects/${name}`, { method: 'DELETE', headers: bearer })).status, 200);
  assert.equal((await fetch(`${base}/api/projects/${name}`)).status, 404);
  const dir = join(dataDir, 'deleted_data_folder');
  const files = (await readdir(dir)).filter((f) => f.endsWith(`_${name}.json`));
  assert.equal(files.length, 1);
  const saved = JSON.parse(await readFileP(join(dir, files[0]), 'utf8'));
  assert.equal(saved.id, name);
  assert.deepEqual(saved.data.project.reflections, project.reflections);
});

// ===== 動画だけの読み・追記(POST/GET /api/projects/:id/videos)=====
test('file: 動画の追記は書込認証が要り(401)、name + t が未登録のものだけ足し、他の項目は変えない', async () => {
  const name = 'sailviz-20260301-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const proj = {
    version: 1, tracks: [], reflections: [{ id: 'r1', text: 'メモ' }],
    videos: [{ id: 'vid0', t: 1000, name: 'IMG_0001.MOV', durationMs: 5000 }],
  };
  assert.equal((await fetch(`${base}/api/projects`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ name, project: proj }),
  })).status, 201);
  const url = `${base}/api/projects/${name}/videos`;
  const unauth = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videos: [{ t: 2000, name: 'b.mp4', durationMs: null }] }),
  });
  assert.equal(unauth.status, 401);

  const r = await fetch(url, {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ videos: [
      { id: 'vid0', t: 1000, name: 'IMG_0001.MOV', durationMs: 5000 }, // 登録済み
      { id: 'vid0', t: 9000, name: 'IMG_0001.MOV', durationMs: null }, // 同名・別時刻(別人の動画)
    ] }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.added, 1);
  assert.deepEqual(body.videos.map((v) => [v.name, v.t]), [['IMG_0001.MOV', 1000], ['IMG_0001.MOV', 9000]]);
  assert.notEqual(body.videos[1].id, 'vid0'); // 重なった id は振り直す
  const saved = JSON.parse(await readFileP(join(dataDir, 'projects', name), 'utf8'));
  assert.deepEqual(saved.reflections, proj.reflections);
  assert.deepEqual(saved.videos, body.videos);

  // もう一度送っても増えない
  const again = await (await fetch(url, {
    method: 'POST', headers: bearer, body: JSON.stringify({ videos: [{ t: 9000, name: 'IMG_0001.MOV' }] }),
  })).json();
  assert.equal(again.added, 0);
  assert.equal(again.videos.length, 2);

  const got = await fetch(url);
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).videos, body.videos);
});

test('file: 動画の追記は本文が不正なら 400、器が無ければ 404', async () => {
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const name = 'sailviz-20260301-0900.sailviz.json';
  const post = (id, body) => fetch(`${base}/api/projects/${id}/videos`, { method: 'POST', headers: bearer, body: JSON.stringify(body) });
  assert.equal((await post(name, {})).status, 400);
  assert.equal((await post(name, { videos: [{ name: '', t: 1 }] })).status, 400);
  assert.equal((await post(name, { videos: [{ name: 'a.mp4', t: 'x' }] })).status, 400);
  assert.equal((await post(name, { videos: [{ name: 'a.mp4', t: 1, durationMs: -1 }] })).status, 400);
  assert.equal((await post(name, { videos: Array.from({ length: 101 }, (_, i) => ({ name: 'a.mp4', t: i })) })).status, 400);
  assert.equal((await post('sailviz-20260302-0900.sailviz.json', { videos: [] })).status, 404);
  assert.equal((await post('pd_0123456789', { videos: [] })).status, 404);
  assert.equal((await fetch(`${base}/api/projects/sailviz-20260302-0900.sailviz.json/videos`)).status, 404);
});

test('file: 同時に動画を追記しても重複せず、どちらの動画も残る', async () => {
  const name = 'sailviz-20260303-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  await fetch(`${base}/api/projects`, { method: 'POST', headers: bearer, body: JSON.stringify({ name, project: { version: 1, videos: [] } }) });
  const post = (videos) => fetch(`${base}/api/projects/${name}/videos`, { method: 'POST', headers: bearer, body: JSON.stringify({ videos }) });
  const rs = await Promise.all([
    post([{ t: 1000, name: 'a.mp4' }, { t: 2000, name: 'b.mp4' }]),
    post([{ t: 2000, name: 'b.mp4' }, { t: 3000, name: 'c.mp4' }]),
    post([{ t: 1000, name: 'a.mp4' }]),
  ]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  const saved = JSON.parse(await readFileP(join(dataDir, 'projects', name), 'utf8'));
  assert.deepEqual(saved.videos.map((v) => v.name).sort(), ['a.mp4', 'b.mp4', 'c.mp4']);
  assert.equal(new Set(saved.videos.map((v) => v.id)).size, 3);
});
