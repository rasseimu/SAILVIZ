# SailViz 公開ホスティング化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 部員が URL からアクセスできる公開サイトにする。共有 JSON を Node バックエンドに集約し、書き込みを共有パスワードで限定する。動画は現状のローカル方式を維持。

**Architecture:** 依存ゼロの Node 標準 `http`/`fs` サーバーを1つ用意し、静的フロント配信と `/api` の JSON CRUD を兼ねる。フロントは既存 `projectfs.js`（フォルダCRUD）と同形の API アダプタ `src/store.js` を新設し、`app.js` の保存/読込呼び出しだけを差し替える。データ形式（`.sailviz.json`）と純ロジックは不変。

**Tech Stack:** Node.js（標準ライブラリのみ、外部依存なし）、ES Modules、`node --test`、バニラ JS フロント（ビルドなし）。

**Spec:** `docs/superpowers/specs/2026-09-07-public-hosting-design.md`

## Global Constraints

- 外部依存を追加しない（`package.json` に dependencies を増やさない）。サーバーは Node 標準 `http` / `fs` / `path` / `url` のみ。
- ES Modules（`package.json` は `"type": "module"`）。`import`/`export` を使う。
- テストは `node --test`。純ロジックは baseDir / storage / fetch を引数注入してテスト可能にする（既存 `projectfs.js` と同方針）。
- データ形式は不変: 練習は `.sailviz.json`、直列化は `src/project.js` の `serializeProject`/`deserializeProject`。
- テキスト系レスポンスは `charset=utf-8` を明示（既存 `serve.py` と同じ理由で文字化け防止）。
- 環境変数: `PORT`（既定 8000）/ `DATA_DIR`（既定 `./data`）/ `SAILVIZ_WRITE_TOKEN`（書き込みパスワード。未設定時は全書き込みを 503 で拒否）。
- 認証は共有トークン1つ。Cookie は `HttpOnly; SameSite=Lax; Path=/`（本番は `Secure` 付与）。
- 動画関連（`folderimport.js` / `videometa.js` / 動画用の `dirhandle.js`）は変更しない。

### 仕様からの意図的な差分（実装で確定した点）
- 仕様の「サマリを共有オーバーレイとして保存」は不採用。サマリは練習から算出できる派生データのため、サーバーが `src/summary.js` の `practiceSummary` を使って `GET /api/summaries` で軽量サマリ一覧を返す（ホームで全練習の巨大な points をダウンロードさせない）。localStorage のサマリキャッシュはブラウザ内キャッシュとして無害なので残置。
- 共有オーバーレイは `progress` と `roadmap` の2種のみ。

---

## Task 1: サーバー ストレージ層 `server/storage.js`

`data/` 配下のファイル CRUD。baseDir を引数注入し一時ディレクトリでテストする。パストラバーサルを名前検証で防ぐ。

**Files:**
- Create: `server/storage.js`
- Test: `test/server-storage.test.js`

**Interfaces:**
- Produces:
  - `isValidProjectName(name): boolean` — `/^[A-Za-z0-9._-]+\.sailviz\.json$/` かつ `..` を含まない。
  - `async listProjects(dataDir): Promise<Array<{name, label}>>` — `label` は `src/projectfs.js` の `projectLabel(name)`。名前降順。
  - `async readProject(dataDir, name): Promise<object>` — JSON。無ければ throw（呼び出し側で 404）。
  - `async writeProject(dataDir, name, obj): Promise<void>`
  - `async deleteProject(dataDir, name): Promise<void>`
  - `OVERLAY_NAMES = ['progress', 'roadmap']`
  - `async readOverlay(dataDir, name): Promise<object>` — 無い/壊れは `{}`。
  - `async writeOverlay(dataDir, name, obj): Promise<void>`
- Consumes: `src/projectfs.js` の `projectLabel`。

- [ ] **Step 1: Write the failing test**

```javascript
// test/server-storage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isValidProjectName, listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay,
} from '../server/storage.js';

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sailviz-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('isValidProjectName accepts .sailviz.json, rejects traversal', () => {
  assert.equal(isValidProjectName('sailviz-20260101-0900.sailviz.json'), true);
  assert.equal(isValidProjectName('../etc/passwd'), false);
  assert.equal(isValidProjectName('foo.json'), false);
  assert.equal(isValidProjectName('a/b.sailviz.json'), false);
});

test('writeProject then readProject round-trips', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260101-0900.sailviz.json';
    await writeProject(dir, name, { version: 1, hello: 'world' });
    assert.deepEqual(await readProject(dir, name), { version: 1, hello: 'world' });
  });
});

test('listProjects returns names desc with labels', async () => {
  await withTmp(async (dir) => {
    await writeProject(dir, 'sailviz-20260101-0900.sailviz.json', {});
    await writeProject(dir, 'sailviz-20260102-0900.sailviz.json', {});
    const list = await listProjects(dir);
    assert.equal(list[0].name, 'sailviz-20260102-0900.sailviz.json');
    assert.equal(typeof list[0].label, 'string');
  });
});

test('deleteProject removes file', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260101-0900.sailviz.json';
    await writeProject(dir, name, {});
    await deleteProject(dir, name);
    await assert.rejects(() => readProject(dir, name));
  });
});

test('overlay read is forgiving, write round-trips', async () => {
  await withTmp(async (dir) => {
    assert.deepEqual(await readOverlay(dir, 'progress'), {});
    await writeOverlay(dir, 'progress', { a: 1 });
    assert.deepEqual(await readOverlay(dir, 'progress'), { a: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-storage.test.js`
Expected: FAIL — `Cannot find module '../server/storage.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// server/storage.js
// data/ 配下のファイル CRUD。baseDir 注入でテスト可能。名前検証でパストラバーサルを防ぐ。
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectLabel } from '../src/projectfs.js';

const PROJECT_RE = /^[A-Za-z0-9._-]+\.sailviz\.json$/;
export const OVERLAY_NAMES = ['progress', 'roadmap'];

export function isValidProjectName(name) {
  return typeof name === 'string' && !name.includes('..') && PROJECT_RE.test(name);
}

function projectsDir(dataDir) { return join(dataDir, 'projects'); }

async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }

export async function listProjects(dataDir) {
  const dir = projectsDir(dataDir);
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  names = names.filter(isValidProjectName).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return names.map((name) => ({ name, label: projectLabel(name) }));
}

export async function readProject(dataDir, name) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  const text = await readFile(join(projectsDir(dataDir), name), 'utf8');
  return JSON.parse(text);
}

export async function writeProject(dataDir, name, obj) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  await ensureDir(projectsDir(dataDir));
  await writeFile(join(projectsDir(dataDir), name), JSON.stringify(obj), 'utf8');
}

export async function deleteProject(dataDir, name) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  await unlink(join(projectsDir(dataDir), name));
}

function overlayPath(dataDir, name) {
  if (!OVERLAY_NAMES.includes(name)) throw new Error('invalid overlay');
  return join(dataDir, `${name}.json`);
}

export async function readOverlay(dataDir, name) {
  try {
    const obj = JSON.parse(await readFile(overlayPath(dataDir, name), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

export async function writeOverlay(dataDir, name, obj) {
  await ensureDir(dataDir);
  await writeFile(overlayPath(dataDir, name), JSON.stringify(obj), 'utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-storage.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add server/storage.js test/server-storage.test.js
git commit -m "feat(server): データフォルダのJSON CRUDストレージ層 #deploy"
```

---

## Task 2: 認証ヘルパ `server/auth.js`

Cookie/Authorization ヘッダから共有トークンを取り出し照合する純関数。

**Files:**
- Create: `server/auth.js`
- Test: `test/server-auth.test.js`

**Interfaces:**
- Produces:
  - `parseCookies(header: string|undefined): Record<string,string>`
  - `extractToken(req: {headers}): string|null` — `Authorization: Bearer X` 優先、無ければ Cookie `sailviz_token`。
  - `isAuthorized(req, token: string|undefined): boolean` — `token` が falsy なら常に false（未設定時は書き込み不可）。

- [ ] **Step 1: Write the failing test**

```javascript
// test/server-auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, extractToken, isAuthorized } from '../server/auth.js';

test('parseCookies splits pairs', () => {
  assert.deepEqual(parseCookies('a=1; sailviz_token=xyz'), { a: '1', sailviz_token: 'xyz' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('extractToken prefers Authorization bearer', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(extractToken({ headers: { cookie: 'sailviz_token=c' } }), 'c');
  assert.equal(extractToken({ headers: {} }), null);
});

test('isAuthorized matches token, false when unset', () => {
  assert.equal(isAuthorized({ headers: { cookie: 'sailviz_token=s3cret' } }, 's3cret'), true);
  assert.equal(isAuthorized({ headers: { cookie: 'sailviz_token=wrong' } }, 's3cret'), false);
  assert.equal(isAuthorized({ headers: { cookie: 'sailviz_token=x' } }, ''), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-auth.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// server/auth.js
// 共有トークンの抽出・照合。DOM/http 非依存の純関数でテストする。
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function extractToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const cookies = parseCookies(req.headers.cookie);
  return cookies.sailviz_token || null;
}

export function isAuthorized(req, token) {
  if (!token) return false;
  return extractToken(req) === token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-auth.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add server/auth.js test/server-auth.test.js
git commit -m "feat(server): 共有トークンの認証ヘルパ #deploy"
```

---

## Task 3: API ルーター `server/api.js`

`http` の (req, res) を受け、`/api/*` を処理して true を返す（対象外は false でフォールスルー）。ボディJSON読取、CORS不要（同一オリジン）、書き込みは `isAuthorized` で保護。

**Files:**
- Create: `server/api.js`
- Test: `test/server-api.test.js`

**Interfaces:**
- Consumes: Task 1 storage 全関数、Task 2 `isAuthorized`、`src/summary.js` の `practiceSummary`、`src/project.js` は不要（保存は生JSONをそのまま格納）。
- Produces:
  - `createApi({ dataDir, token }): (req, res) => Promise<boolean>` — 処理したら true。
  - ルート:
    - `GET  /api/health` → `{ok:true}`
    - `GET  /api/auth` → `{unlocked: boolean}`
    - `POST /api/unlock` body `{password}` → 一致で `Set-Cookie sailviz_token` & `{unlocked:true}`、不一致 401、token 未設定 503
    - `POST /api/lock` → Cookie 失効 `{unlocked:false}`
    - `GET  /api/projects` → `[{name,label}]`
    - `GET  /api/summaries` → `[{name, ...practiceSummary}]`
    - `GET  /api/projects/:name` → project JSON（無ければ 404）
    - `PUT  /api/projects/:name` (auth) body=project JSON → `{ok:true}`
    - `DELETE /api/projects/:name` (auth) → `{ok:true}`
    - `GET  /api/overlays/:name` → overlay object
    - `PUT  /api/overlays/:name` (auth) body=object → `{ok:true}`

- [ ] **Step 1: Write the failing test**

サーバーを port 0 で起動し fetch で叩く統合テスト。

```javascript
// test/server-api.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const put = await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: bearer, body: JSON.stringify({ version: 1, tracks: [] }),
  });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/projects/${name}`)).json();
  assert.equal(got.version, 1);
  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(list.some((p) => p.name === name), true);
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

test('summaries returns lightweight rows', async () => {
  const rows = await (await fetch(`${base}/api/summaries`)).json();
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows[0]?.reflectionCount !== undefined, true);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-api.test.js`
Expected: FAIL — `Cannot find module '../server/api.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// server/api.js
// http (req,res) を受け /api/* を処理。処理したら true を返す。
import {
  listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay, OVERLAY_NAMES, isValidProjectName,
} from './storage.js';
import { isAuthorized } from './auth.js';
import { practiceSummary } from '../src/summary.js';

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApi({ dataDir, token }) {
  return async function api(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;
    const method = req.method;
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';

    try {
      if (path === '/api/health') { send(res, 200, { ok: true }); return true; }

      if (path === '/api/auth') { send(res, 200, { unlocked: isAuthorized(req, token) }); return true; }

      if (path === '/api/unlock' && method === 'POST') {
        if (!token) { send(res, 503, { error: 'write disabled' }); return true; }
        const body = await readBody(req);
        if (body?.password === token) {
          send(res, 200, { unlocked: true }, {
            'set-cookie': `sailviz_token=${token}; HttpOnly; SameSite=Lax; Path=/${secureCookie}`,
          });
        } else send(res, 401, { error: 'invalid password' });
        return true;
      }

      if (path === '/api/lock' && method === 'POST') {
        send(res, 200, { unlocked: false }, {
          'set-cookie': `sailviz_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`,
        });
        return true;
      }

      if (path === '/api/projects' && method === 'GET') {
        send(res, 200, await listProjects(dataDir)); return true;
      }

      if (path === '/api/summaries' && method === 'GET') {
        const list = await listProjects(dataDir);
        const rows = [];
        for (const { name } of list) {
          try { rows.push({ name, ...practiceSummary(await readProject(dataDir, name), { name }) }); }
          catch { /* 壊れたファイルは飛ばす */ }
        }
        send(res, 200, rows); return true;
      }

      const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch) {
        const name = decodeURIComponent(projMatch[1]);
        if (!isValidProjectName(name)) { send(res, 400, { error: 'bad name' }); return true; }
        if (method === 'GET') {
          try { send(res, 200, await readProject(dataDir, name)); }
          catch { send(res, 404, { error: 'not found' }); }
          return true;
        }
        if (method === 'PUT') {
          if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
          await writeProject(dataDir, name, await readBody(req));
          send(res, 200, { ok: true }); return true;
        }
        if (method === 'DELETE') {
          if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
          try { await deleteProject(dataDir, name); } catch { /* 既に無ければ黙認 */ }
          send(res, 200, { ok: true }); return true;
        }
      }

      const ovMatch = path.match(/^\/api\/overlays\/([^/]+)$/);
      if (ovMatch) {
        const name = ovMatch[1];
        if (!OVERLAY_NAMES.includes(name)) { send(res, 400, { error: 'bad overlay' }); return true; }
        if (method === 'GET') { send(res, 200, await readOverlay(dataDir, name)); return true; }
        if (method === 'PUT') {
          if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
          await writeOverlay(dataDir, name, await readBody(req));
          send(res, 200, { ok: true }); return true;
        }
      }

      send(res, 404, { error: 'no route' });
      return true;
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e) });
      return true;
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-api.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add server/api.js test/server-api.test.js
git commit -m "feat(server): /api ルーター(練習/サマリ/オーバーレイ/認証) #deploy"
```

---

## Task 4: 静的配信＋起動 `server/index.js`

`/api/*` は Task 3、それ以外は静的ファイルを charset 付きで配信。ルートは `index.html`。

**Files:**
- Create: `server/index.js`
- Create: `server/static.js`（静的配信のみ、単体テスト可能に分離）
- Test: `test/server-static.test.js`

**Interfaces:**
- Produces:
  - `server/static.js`: `contentType(pathname): string`（拡張子→charset付き Content-Type、`serve.py` の表と一致）、`async serveStatic(req, res, rootDir): Promise<void>`（パストラバーサル防止、404 は簡素な本文）。
  - `server/index.js`: 起動スクリプト（テスト対象外、`node server/index.js` で listen）。

- [ ] **Step 1: Write the failing test**

```javascript
// test/server-static.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentType } from '../server/static.js';

test('contentType maps text types with utf-8', () => {
  assert.equal(contentType('/src/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/styles.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('/x.json'), 'application/json; charset=utf-8');
  assert.equal(contentType('/x.png'), 'image/png');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-static.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// server/static.js
// 静的ファイル配信。text 系は charset=utf-8 を明示(serve.py と同じ理由)。
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

export function contentType(pathname) {
  return TYPES[extname(pathname).toLowerCase()] || 'application/octet-stream';
}

export async function serveStatic(req, res, rootDir) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(rootDir, rel));
  if (!full.startsWith(normalize(rootDir))) { res.writeHead(403).end('forbidden'); return; }
  try {
    const s = await stat(full);
    if (s.isDirectory()) { res.writeHead(403).end('forbidden'); return; }
    const buf = await readFile(full);
    res.writeHead(200, { 'content-type': contentType(full), 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}
```

```javascript
// server/index.js
// 静的フロント配信 + /api ルーターを兼ねる依存ゼロ HTTP サーバー。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from './api.js';
import { serveStatic } from './static.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const TOKEN = process.env.SAILVIZ_WRITE_TOKEN || '';

const api = createApi({ dataDir: DATA_DIR, token: TOKEN });

const server = createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    await serveStatic(req, res, ROOT);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`SailViz on http://localhost:${PORT}  data=${DATA_DIR}  write=${TOKEN ? 'on' : 'OFF'}`);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-static.test.js`
Expected: PASS。加えて手動確認: `node server/index.js` → ブラウザで `http://localhost:8000/` が表示され、`GET /api/health` が `{"ok":true}`。

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/static.js test/server-static.test.js
git commit -m "feat(server): 静的配信+API 起動スクリプト #deploy"
```

---

## Task 5: フロント HTTP クライアント `src/api.js`

fetch を薄く包む。全書き込みは `credentials:'same-origin'`（HttpOnly Cookie 送出）。

**Files:**
- Create: `src/api.js`
- Test: `test/api-client.test.js`

**Interfaces:**
- Produces（全て async。`fetchImpl` を第2引数群で注入可能にしテストする）:
  - `apiListProjects(): Promise<Array<{name,label}>>`
  - `apiListSummaries(): Promise<Array<object>>`
  - `apiGetProject(name): Promise<object>`
  - `apiPutProject(name, obj): Promise<void>`（非200で throw）
  - `apiDeleteProject(name): Promise<void>`
  - `apiGetOverlay(name): Promise<object>`
  - `apiPutOverlay(name, obj): Promise<void>`
  - `apiAuthStatus(): Promise<boolean>`
  - `apiUnlock(password): Promise<boolean>`（成功 true、401 は false、その他 throw）
  - `apiLock(): Promise<void>`
  - 実装は `globalThis.fetch` を使用。テストは `globalThis.fetch` を差し替えて検証。

- [ ] **Step 1: Write the failing test**

```javascript
// test/api-client.test.js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiGetProject, apiPutProject, apiUnlock } from '../src/api.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/api.js
// バックエンド /api への薄い fetch ラッパ。書き込みは same-origin Cookie を送る。
const OPTS = { credentials: 'same-origin' };

async function getJson(path) {
  const res = await fetch(path, OPTS);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function send(path, method, obj) {
  const res = await fetch(path, {
    ...OPTS, method,
    headers: { 'content-type': 'application/json' },
    body: obj === undefined ? undefined : JSON.stringify(obj),
  });
  return res;
}

export async function apiListProjects() { return getJson('/api/projects'); }
export async function apiListSummaries() { return getJson('/api/summaries'); }
export async function apiGetProject(name) { return getJson(`/api/projects/${encodeURIComponent(name)}`); }

export async function apiPutProject(name, obj) {
  const res = await send(`/api/projects/${encodeURIComponent(name)}`, 'PUT', obj);
  if (!res.ok) throw new Error(`保存に失敗 (${res.status})`);
}
export async function apiDeleteProject(name) {
  const res = await send(`/api/projects/${encodeURIComponent(name)}`, 'DELETE');
  if (!res.ok) throw new Error(`削除に失敗 (${res.status})`);
}
export async function apiGetOverlay(name) { return getJson(`/api/overlays/${name}`); }
export async function apiPutOverlay(name, obj) {
  const res = await send(`/api/overlays/${name}`, 'PUT', obj);
  if (!res.ok) throw new Error(`同期に失敗 (${res.status})`);
}

export async function apiAuthStatus() { return (await getJson('/api/auth')).unlocked === true; }
export async function apiUnlock(password) {
  const res = await send('/api/unlock', 'POST', { password });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`ログインに失敗 (${res.status})`);
  return (await res.json()).unlocked === true;
}
export async function apiLock() { await send('/api/lock', 'POST'); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api-client.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/api-client.test.js
git commit -m "feat(web): /api fetch クライアント #deploy"
```

---

## Task 6: ストレージアダプタ `src/store.js`

`app.js` が使う保存操作を、`projectfs.js` と同形のオブジェクトで提供する（第一引数の dirHandle が不要になる）。認証状態も保持。

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: Task 5 `src/api.js` の全関数。
- Produces: 既定エクスポート or 名前付き `store` オブジェクト:
  - `store.listProjects(): Promise<Array<{name,label}>>`
  - `store.listSummaries(): Promise<Array<object>>`
  - `store.readProject(name): Promise<object>`
  - `store.writeProject(name, obj): Promise<void>`
  - `store.deleteProject(name): Promise<void>`
  - `store.readProgress(): Promise<object>` / `store.writeProgress(obj): Promise<void>`
  - `store.readRoadmap(): Promise<object>` / `store.writeRoadmap(obj): Promise<void>`
  - `store.refreshAuth(): Promise<boolean>` / `store.isUnlocked(): boolean` / `store.unlock(pw): Promise<boolean>` / `store.lock(): Promise<void>`
  - 依存を差し替え可能にするため `createStore(api)` を公開し、既定 `store = createStore(realApiModule)`。テストはフェイク api を注入。

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/store.js
// app.js 向けの保存アダプタ。projectfs.js と同形だが dirHandle 不要(サーバー API 背後)。
import * as realApi from './api.js';

export function createStore(api) {
  let unlocked = false;
  return {
    listProjects: () => api.apiListProjects(),
    listSummaries: () => api.apiListSummaries(),
    readProject: (name) => api.apiGetProject(name),
    writeProject: (name, obj) => api.apiPutProject(name, obj),
    deleteProject: (name) => api.apiDeleteProject(name),
    readProgress: () => api.apiGetOverlay('progress'),
    writeProgress: (obj) => api.apiPutOverlay('progress', obj),
    readRoadmap: () => api.apiGetOverlay('roadmap'),
    writeRoadmap: (obj) => api.apiPutOverlay('roadmap', obj),
    async refreshAuth() { unlocked = await api.apiAuthStatus(); return unlocked; },
    isUnlocked: () => unlocked,
    async unlock(pw) { unlocked = await api.apiUnlock(pw); return unlocked; },
    async lock() { await api.apiLock(); unlocked = false; },
  };
}

export const store = createStore(realApi);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat(web): APIストレージアダプタ store.js #deploy"
```

---

## Task 7: `app.js` の保存経路を store に差し替え

JSON/オーバーレイの永続化を `projectDir`(FileSystemDirectoryHandle)経由から `store` 経由へ。動画走査用のフォルダ選択は残す（役割を「動画フォルダ選択」に限定）。

**Files:**
- Modify: `src/app.js`（インポート、保存/読込関数、進捗/ロードマップ配線、ホーム一覧）

**Interfaces:**
- Consumes: Task 6 `store`、既存 `deserializeProject`/`serializeProject`、`practiceSummary`。
- Produces: 画面の挙動は不変（ホーム一覧・練習読込・保存・進捗/ロードマップ同期）。ただしデータ源はサーバー。

**注意:** 行番号は編集で前後します。関数名・呼び出し名で対象を特定してください（現状の参照箇所: import は `src/app.js:30,37,39`、保存 `writeProject` は約 `:324`、読込 `readProject` は約 `:339`・`:494`・`:1075`、進捗/ロードマップ配線は約 `:1098-1136`）。

- [ ] **Step 1: import を差し替え**

`projectfs.js` から取り込む保存系（`listProjectFiles, readProject, writeProject, readProgress, writeProgress`）と `roadmapstore.js` の `readRoadmapFile, writeRoadmapFile` の使用を止め、`store` を導入する。`projectFileName`/`uniqueProjectName`/`projectLabel`/`listProjectFiles` の純関数のうち採番に使う `uniqueProjectName` は残す。

```javascript
import { store } from './store.js';
// 既存: import { projectFileName, listProjectFiles, readProject, writeProject, readProgress, writeProgress, ... } from './projectfs.js';
// → 採番/ラベル系のみ残す:
import { uniqueProjectName, projectLabel, projectFileName } from './projectfs.js';
```

（`saveDirHandle/loadDirHandle/ensurePermission` は動画フォルダ選択で使い続けるため残す。）

- [ ] **Step 2: 保存関数を store.writeProject に**

保存関数内の採番は「既存名一覧」をサーバーから取る。`writeProject(dir, name, obj)` を `store.writeProject(name, obj)` に。

```javascript
// 変更前:
//   const existing = (await listProjectFiles(dir)).map((f) => f.name);
//   ...
//   await writeProject(dir, name, obj);
// 変更後:
const existing = (await store.listProjects()).map((f) => f.name);
// name 採番は既存どおり uniqueProjectName(baseMs, existing)
await store.writeProject(name, obj);
```

- [ ] **Step 3: 読込を store.readProject に**

`readProject(projectDir, name)` の3箇所（loadPractice / ホームカード / loadProjectEntries）を `store.readProject(name)` に置換。ホーム一覧の初期表示は重い全読込を避け `store.listSummaries()` を使う。

```javascript
// loadPractice:
data = deserializeProject(await store.readProject(name));

// ホーム一覧生成: listProjectFiles+各readProject をやめ、
const items = await store.listSummaries();      // [{name,label,...summary}]
// renderCard は summary をそのまま使えるので per-file の readProject ループを削除
```

- [ ] **Step 4: 進捗/ロードマップ配線を store に**

`createProgress`/`createRoadmap` に渡す data コールバックを差し替え。localStorage ミラーと projectDir 分岐を撤去。

```javascript
loadProgressData: async () => store.readProgress(),
saveProgressData: async (obj) => { await store.writeProgress(obj); },
loadRoadmapData: async () => store.readRoadmap(),
saveRoadmapData: async (obj) => { await store.writeRoadmap(obj); },
```

- [ ] **Step 5: 起動時に認証状態を取得**

アプリ初期化（DOMContentLoaded 相当の起動処理）で `await store.refreshAuth();` を呼び、以後 `store.isUnlocked()` で書き込みUIを出し分ける準備をする（UI 自体は Task 8）。

- [ ] **Step 6: フォルダ選択を動画用に限定**

「保存フォルダを選択」ボタンのラベル/文言を「動画フォルダを選択（任意）」に変更。`projectDir` は動画走査(`folderimport`)専用の変数として残す（JSON 保存には使わない）。JSON はフォルダ未選択でも保存/読込できることを確認。

- [ ] **Step 7: 手動確認**

```bash
SAILVIZ_WRITE_TOKEN=test node server/index.js
```
ブラウザで:
- ホームに `data/projects` の練習が並ぶ（無ければ空）。
- 未ログインで保存操作 → 401 のトースト（Task 8 でUI整備）。ここでは Console にエラーが出ず、読込・一覧が動くことを確認。

- [ ] **Step 8: 既存テストが壊れていないか**

Run: `node --test`
Expected: 既存の純ロジックテストが全て PASS（app.js は DOM 依存で単体テスト対象外）。

- [ ] **Step 9: Commit**

```bash
git add src/app.js
git commit -m "refactor(web): JSON/オーバーレイ永続化を store(API)へ移行 #deploy"
```

---

## Task 8: 編集モード（ログイン）UI と書き込みゲート

未認証は閲覧専用。パスワードで解錠すると書き込みUIが有効化。

**Files:**
- Modify: `index.html`（ヘッダに「編集モード」ボタン＋パスワード入力の小さなダイアログ）
- Modify: `src/app.js`（解錠/施錠のハンドラ、`applyEditableState()` で書き込みボタンの表示/無効を切替）
- Modify: `styles.css`（ダイアログ/ロック時のスタイル）

**Interfaces:**
- Consumes: `store.unlock/lock/isUnlocked/refreshAuth`。
- Produces: `applyEditableState()` — `store.isUnlocked()` に応じて保存・削除・進捗トグル・反省編集などの要素へ `disabled`/`hidden` を反映する単一関数。解錠/施錠後に必ず呼ぶ。

- [ ] **Step 1: index.html にログインUIを追加**

ヘッダに以下を追加（既存のヘッダ要素のクラス命名に合わせる）:

```html
<button id="editModeBtn" type="button">編集モード</button>
<dialog id="loginDialog">
  <form method="dialog" id="loginForm">
    <p>編集用パスワード</p>
    <input id="loginPassword" type="password" autocomplete="current-password" />
    <menu>
      <button value="cancel">キャンセル</button>
      <button id="loginSubmit" value="ok">ログイン</button>
    </menu>
    <p id="loginError" class="error" hidden>パスワードが違います</p>
  </form>
</dialog>
```

- [ ] **Step 2: app.js に解錠/施錠ハンドラ**

```javascript
const editModeBtn = document.getElementById('editModeBtn');
const loginDialog = document.getElementById('loginDialog');
const loginForm = document.getElementById('loginForm');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');

function applyEditableState() {
  const on = store.isUnlocked();
  editModeBtn.textContent = on ? 'ログアウト' : '編集モード';
  document.body.classList.toggle('readonly', !on);
  // 書き込み系要素を .writes-json クラスで束ね、disabled を反映
  document.querySelectorAll('.writes-json').forEach((el) => { el.disabled = !on; });
}

editModeBtn.addEventListener('click', async () => {
  if (store.isUnlocked()) { await store.lock(); applyEditableState(); return; }
  loginError.hidden = true; loginPassword.value = ''; loginDialog.showModal();
});

loginForm.addEventListener('submit', async (e) => {
  // value==='ok' のときだけ検証。cancel はそのまま閉じる。
  if (e.submitter && e.submitter.value !== 'ok') return;
  e.preventDefault();
  const ok = await store.unlock(loginPassword.value);
  if (ok) { loginDialog.close(); applyEditableState(); }
  else { loginError.hidden = false; }
});
```

- [ ] **Step 3: 書き込みボタンに `.writes-json` を付与**

保存・削除・進捗トグル・反省の編集/コメント投稿・ロードマップ編集など、サーバー書き込みを伴うボタンに `class="writes-json"` を追加（既存クラスに追記）。読み取り専用時に押せないようにする。CSS で `body.readonly` 時に該当UIをグレーアウト。

- [ ] **Step 4: 起動時反映**

Task 7 Step 5 の `store.refreshAuth()` の直後に `applyEditableState()` を呼ぶ。

- [ ] **Step 5: styles.css**

```css
body.readonly .writes-json { opacity: .4; cursor: not-allowed; }
#loginDialog { border: none; border-radius: 8px; padding: 16px; }
#loginError.error { color: #c00; }
```

- [ ] **Step 6: 手動確認（GIF 不要）**

```bash
SAILVIZ_WRITE_TOKEN=test node server/index.js
```
- 初期表示: 閲覧専用（保存ボタン等がグレーアウト）。
- 「編集モード」→ `test` でログイン → 保存が有効化。
- 保存 → `data/projects/*.sailviz.json` が作られる。
- 「ログアウト」→ 再び閲覧専用。誤パスワードで `#loginError` 表示。

- [ ] **Step 7: Commit**

```bash
git add index.html src/app.js styles.css
git commit -m "feat(web): 編集モード(共有パスワード)と書き込みゲート #deploy"
```

---

## Task 9: 既存データ取込 CLI `server/import.js`

ローカルの既存 `.sailviz.json`（と任意で progress/roadmap JSON）を `data/` に取り込む一度きりのスクリプト。

**Files:**
- Create: `server/import.js`
- Test: `test/server-import.test.js`

**Interfaces:**
- Consumes: Task 1 `writeProject`/`writeOverlay`/`isValidProjectName`。
- Produces: `async importFolder(srcDir, dataDir): Promise<{projects:number, overlays:string[]}>` — src 直下の `*.sailviz.json` を projects へ、`sailviz-progress.json`→overlay progress、`sailviz-roadmap.json`→overlay roadmap。CLI: `node server/import.js <srcDir> [dataDir]`。

- [ ] **Step 1: Write the failing test**

```javascript
// test/server-import.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFolder } from '../server/import.js';
import { listProjects, readOverlay } from '../server/storage.js';

test('importFolder copies projects and overlays', async () => {
  const src = await mkdtemp(join(tmpdir(), 'src-'));
  const data = await mkdtemp(join(tmpdir(), 'data-'));
  try {
    await writeFile(join(src, 'sailviz-20260101-0900.sailviz.json'), JSON.stringify({ version: 1 }));
    await writeFile(join(src, 'sailviz-progress.json'), JSON.stringify({ r1: {} }));
    const r = await importFolder(src, data);
    assert.equal(r.projects, 1);
    assert.equal((await listProjects(data)).length, 1);
    assert.deepEqual(await readOverlay(data, 'progress'), { r1: {} });
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-import.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// server/import.js
// ローカルの既存データを data/ に取り込む一度きりの CLI。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeProject, writeOverlay, isValidProjectName } from './storage.js';

export async function importFolder(srcDir, dataDir) {
  const names = await readdir(srcDir);
  let projects = 0;
  const overlays = [];
  for (const name of names) {
    if (isValidProjectName(name)) {
      await writeProject(dataDir, name, JSON.parse(await readFile(join(srcDir, name), 'utf8')));
      projects++;
    }
  }
  const maybe = [['sailviz-progress.json', 'progress'], ['sailviz-roadmap.json', 'roadmap']];
  for (const [file, overlay] of maybe) {
    try {
      const obj = JSON.parse(await readFile(join(srcDir, file), 'utf8'));
      await writeOverlay(dataDir, overlay, obj);
      overlays.push(overlay);
    } catch { /* 無ければスキップ */ }
  }
  return { projects, overlays };
}

// CLI 実行
if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, data = './data'] = process.argv.slice(2);
  if (!src) { console.error('usage: node server/import.js <srcDir> [dataDir]'); process.exit(1); }
  importFolder(src, data).then((r) =>
    console.log(`imported ${r.projects} projects, overlays: ${r.overlays.join(',') || 'none'}`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-import.test.js`
Expected: PASS（1 test）

- [ ] **Step 5: Commit**

```bash
git add server/import.js test/server-import.test.js
git commit -m "feat(server): 既存データ取込CLI #deploy"
```

---

## Task 10: デプロイ設定とドキュメント

`package.json` スクリプト更新、`Dockerfile`、`.gitignore` に `data/`、README に運用手順。

**Files:**
- Modify: `package.json`（`serve`/`start` スクリプト）
- Create: `Dockerfile`
- Modify: `.gitignore`
- Modify: `README.md`（起動/デプロイ/移行の節を追記）
- Delete（任意）: `serve.py` は残置可（ローカルの純静的確認用）。README に「本番/開発は node サーバー」と明記。

- [ ] **Step 1: package.json スクリプト**

```json
{
  "scripts": {
    "test": "node --test",
    "start": "node server/index.js",
    "serve": "node server/index.js",
    "import": "node server/import.js"
  }
}
```

- [ ] **Step 2: .gitignore に data/**

```
.DS_Store
node_modules/
.worktrees/
data/
```

- [ ] **Step 3: Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8000 DATA_DIR=/data
VOLUME /data
EXPOSE 8000
CMD ["node", "server/index.js"]
```

- [ ] **Step 4: README に運用節を追記**

- 起動: `SAILVIZ_WRITE_TOKEN=... npm start`（`PORT`/`DATA_DIR` 任意）。
- デプロイ: 永続ボリュームを `DATA_DIR` にマウント。`SAILVIZ_WRITE_TOKEN` を秘密に設定。HTTPS 前提（本番は `NODE_ENV=production` で Cookie Secure）。
- 移行: `npm run import -- <既存フォルダ> ./data`（または `DATA_DIR`）。
- 認証: 共有パスワード1つ。閲覧は誰でも、書き込みは「編集モード」でパスワード入力。
- 動画: 従来どおり各自のローカル/Drive 同期フォルダを選択（サーバーには置かない）。

- [ ] **Step 5: 全テスト＋手動確認**

```bash
node --test
SAILVIZ_WRITE_TOKEN=test npm start
```
Expected: 全テスト PASS。ブラウザで一連（一覧→読込→ログイン→保存→再読込で反映）が通る。

- [ ] **Step 6: Commit**

```bash
git add package.json Dockerfile .gitignore README.md
git commit -m "chore(deploy): node起動スクリプト/Dockerfile/移行手順 #deploy"
```

---

## Self-Review メモ（計画作成者による確認）

- **Spec coverage:** §3 構成→Task 3/4、§4 コンポーネント→Task 1-8、§5 データフロー→Task 3/5/6/7、§6 認証→Task 2/3/8、§7 エラー処理→Task 3(401/404/400/500)/5(throw)/8(トースト)、§8 移行→Task 9、§9 デプロイ→Task 10、§10 テスト→各 Task の test。サマリの扱いは冒頭「意図的な差分」に明記。
- **Placeholder scan:** 各コード step は実コードを記載。app.js(Task 7/8)は DOM 依存のため行番号ドリフトに注意する旨を明記し、対象を関数名/呼び出し名で特定させている。
- **Type consistency:** storage の `isValidProjectName`/`OVERLAY_NAMES` を api/import が共有。store のメソッド名は app.js の呼び出し（`store.readProject` 等）と一致。api クライアント名（`apiGetProject` 等）は store が消費する名前と一致。
- **残リスク:** Task 7 は既存 `app.js` が大きく、実際の DOM/変数名に合わせた追従が必要。実装時に現物を読んで置換対象を確定すること。同時編集は last-write-wins（仕様どおり）。
