# sailviz-reflect コア（オフライン完結）実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 各部員がスマホで反省を入力し、自分の履歴を時系列で見返せるオフライン完結の PWA コアを作る（クラウド同期は後続プラン2で結線）。

**Architecture:** 素の ESM・ビルド無し。純ロジック（スキーマ / identity / 同期キュー / ルーター）を `node --test` ＋ DI で TDD し、DOM ビューは薄く被せる。反省は localStorage の同期キューに `pending` で積む（プラン2で Supabase へフラッシュ）。SailViz とは共有スキーマ `schema.js` ＋ ゴールデン JSON フィクスチャの契約テストで形の一致を保証する。

**Tech Stack:** Vanilla ESM, `node --test`(node:test/node:assert), localStorage(注入可能), Service Worker(手書き), Web App Manifest。ビルドツール・npm 依存なし。

**Spec:** `docs/superpowers/specs/2026-08-24-sailviz-reflect-design.md`

## Global Constraints

- ビルドステップ・npm 依存を **増やさない**（素の ESM のみ）。テストは `node --test`。
- 純ロジックは DOM/ブラウザ API 非依存にし、`storage`/`send` 等の依存は**引数で注入**（既存 SailViz `reflections.js`/`projectfs.js` と同じ DI 流儀）。
- 反省オブジェクトの形は **#16 = SailViz `src/reflections.js` の `createReflection` 出力と厳密一致**。逸脱はゴールデンフィクスチャ契約テストで検出する。
- 反省の `id`/`createdAt` は**呼び出し側で採番**して渡す（テストの決定性のため。`Math.random`/`Date.now` を純ロジックに入れない）。
- RIG_FIELDS 順序: `boatNo, gear, prebend, rake, sideTension, foreTension, puller, peakRope, bridleHeight, jibLeader, jibPull, vangPull`。NOTE_FIELDS 順序: `goal, issue, discovery, slowFactor, fastFactor`。
- 新リポジトリ名: `sailviz-reflect`。以降パスは新リポのルート基準（例 `src/schema.js`）。**Task 1 のみ既存 SailViz リポ**で作業する。

---

## ファイル構成（このプランで作る/触るもの）

**既存 SailViz リポ（Task 1 のみ）:**
- Create: `test/schema-contract.test.js` — `createReflection` 出力がゴールデン JSON と一致することを固定。
- Create: `test/fixtures/reflection-golden.json` — 両リポ共有の期待 JSON。

**新リポ `sailviz-reflect`:**
- Create: `package.json`, `.gitignore`, `README.md`
- Create: `src/schema.js` — 共有スキーマ（SailViz からコピー）。DOM 非依存。
- Create: `src/members.js` — 名簿（SailViz からコピー）。
- Create: `src/identity.js` — 名簿選択・合言葉・localStorage 保持。純ロジック。
- Create: `src/syncQueue.js` — オフライン同期キュー。純ロジック（`storage`/`send` 注入）。
- Create: `src/router.js` — ハッシュルーター。純ロジック。
- Create: `src/store.js` — 反省の読み書きヘルパ（キュー上の反省一覧・履歴集計）。純ロジック。
- Create: `src/views/home.js`, `src/views/newReflection.js`, `src/views/history.js`, `src/views/detail.js` — DOM 描画（薄く）。
- Create: `src/app.js` — 結線（ルーター↔ビュー）。
- Create: `index.html`, `styles.css`, `sw.js`, `manifest.webmanifest`
- Create: `test/schema-contract.test.js`, `test/fixtures/reflection-golden.json`（Task 1 と同一内容をコピー）
- Create: `test/identity.test.js`, `test/syncQueue.test.js`, `test/router.test.js`, `test/store.test.js`

---

## Task 1: 共有スキーマの契約フィクスチャ（既存 SailViz リポ）

`createReflection` の出力形を固定し、以降どちらのリポでも同じ形を保証する基準を作る。

**Files:**
- Create: `test/fixtures/reflection-golden.json`
- Create: `test/schema-contract.test.js`
- Reference: `src/reflections.js`（`createReflection`, `RIG_FIELDS`, `NOTE_FIELDS`）

**Interfaces:**
- Consumes: `createReflection(input)` from `src/reflections.js`（既存）。
- Produces: `test/fixtures/reflection-golden.json`（入力→期待出力のペア）。Task 8 で新リポにコピーする。

- [ ] **Step 1: ゴールデンフィクスチャを書く**

Create `test/fixtures/reflection-golden.json`:

```json
{
  "input": {
    "id": "r1",
    "createdAt": "2026-08-24T09:00:00.000Z",
    "text": "テスト本文",
    "people": [{ "id": "m0", "name": "村瀬 礼" }],
    "videos": [{ "name": "PXL_1.mp4", "tMs": 65000 }],
    "wind": { "dir": "南南西", "speed": 3.2, "source": "manual" },
    "practice": { "date": "2026-08-24" },
    "rig": { "boatNo": "12", "prebend": 30 },
    "waveHeight": "0.5",
    "notes": { "goal": "目標X", "issue": "課題Y" }
  },
  "expected": {
    "id": "r1",
    "createdAt": "2026-08-24T09:00:00.000Z",
    "text": "テスト本文",
    "people": [{ "id": "m0", "name": "村瀬 礼" }],
    "videos": [{ "name": "PXL_1.mp4", "tMs": 65000 }],
    "wind": { "dir": "南南西", "speed": 3.2, "source": "manual" },
    "practice": { "date": "2026-08-24" },
    "rig": {
      "boatNo": 12, "gear": null, "prebend": 30, "rake": null,
      "sideTension": null, "foreTension": null, "puller": null,
      "peakRope": null, "bridleHeight": null, "jibLeader": null,
      "jibPull": null, "vangPull": null
    },
    "waveHeight": 0.5,
    "notes": {
      "goal": "目標X", "issue": "課題Y",
      "discovery": "", "slowFactor": "", "fastFactor": ""
    }
  }
}
```

- [ ] **Step 2: 契約テストを書く（失敗するはず）**

Create `test/schema-contract.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReflection } from '../src/reflections.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/reflection-golden.json', import.meta.url))
);

test('createReflection がゴールデン期待形と一致する', () => {
  const out = createReflection(golden.input);
  assert.deepEqual(out, golden.expected);
});
```

- [ ] **Step 3: テスト実行で PASS を確認（既存実装が正しければ通る）**

Run: `node --test test/schema-contract.test.js`
Expected: PASS。もし FAIL したら、フィクスチャの `expected` を現行 `createReflection` の実挙動に合わせて修正する（現行実装が #16 の正）。

- [ ] **Step 4: コミット**

```bash
git add test/schema-contract.test.js test/fixtures/reflection-golden.json
git commit -m "test: 反省スキーマのゴールデン契約フィクスチャを追加(#20 共有基準)"
```

---

## Task 2: 新リポ `sailviz-reflect` の初期化

以降のタスクの土台。テストランナーとディレクトリ構造だけ用意する。

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: `npm test` → `node --test` が走る空プロジェクト。

- [ ] **Step 1: リポジトリを作る**

```bash
mkdir -p ~/Documents/sailviz-reflect && cd ~/Documents/sailviz-reflect
git init
mkdir -p src src/views test test/fixtures
```

- [ ] **Step 2: `package.json` を書く**

Create `package.json`:

```json
{
  "name": "sailviz-reflect",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "部員がスマホで反省を入力・時系列閲覧する PWA (SailViz #20)",
  "scripts": {
    "test": "node --test",
    "serve": "python3 -m http.server 8100"
  }
}
```

- [ ] **Step 3: `.gitignore` と README を書く**

Create `.gitignore`:

```
.DS_Store
node_modules/
src/config.js
```

Create `README.md`:

```md
# sailviz-reflect

部員がスマホで反省を入力し、自分の履歴を時系列で見返す PWA。SailViz(#20)。
素の ESM・ビルド無し。`npm test` で `node --test`、`npm run serve` で静的配信。
反省スキーマは SailViz `src/reflections.js` と共有(契約テストで一致を保証)。
```

- [ ] **Step 4: テストランナーの疎通確認**

```bash
node --test
```
Expected: "no tests found" 等で正常終了（テスト未作成のためエラーなく終わる）。

- [ ] **Step 5: コミット**

```bash
git add -A && git commit -m "chore: sailviz-reflect リポ初期化(素ESM/node --test)"
```

---

## Task 3: 共有スキーマ `schema.js` をコピーし契約テストで固定

SailViz の反省スキーマ純ロジックを新リポへ持ち込み、Task 1 と同じフィクスチャで一致を保証する。

**Files:**
- Create: `src/schema.js`
- Create: `test/fixtures/reflection-golden.json`（Task 1 と同一内容）
- Create: `test/schema-contract.test.js`

**Interfaces:**
- Produces: `RIG_FIELDS`, `NOTE_FIELDS`, `toNum(v)`, `previousRig(list)`, `createReflection(input)`, `formatVideoPos(ms)`, `windLabel(wind, opts)` — SailViz `reflections.js` と同一シグネチャ。

- [ ] **Step 1: `schema.js` を SailViz からコピー**

`src/schema.js` を作成し、SailViz `src/reflections.js` の**形を規定する純ロジックのみ**を移植する（`STORAGE_KEY`/`loadReflections`/`saveReflections` は持ち込まない — 保存は syncQueue が担う）。移植する export:
`RIG_FIELDS`, `NOTE_FIELDS`, `toNum`, `previousRig`, `formatVideoPos`, `createReflection`, `windLabel`、および内部 `normalizeRig`/`normalizeNotes`。SailViz の該当行（`src/reflections.js:6-81`）をそのまま貼り、`export const STORAGE_KEY` 以下の localStorage 関数は除外する。

- [ ] **Step 2: フィクスチャをコピー**

Task 1 の `test/fixtures/reflection-golden.json` を新リポの同パスへ**バイト一致でコピー**する。

- [ ] **Step 3: 契約テストを書く（失敗するはず）**

Create `test/schema-contract.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReflection, previousRig, RIG_FIELDS } from '../src/schema.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/reflection-golden.json', import.meta.url))
);

test('schema.js の createReflection が SailViz と同一の形を返す', () => {
  assert.deepEqual(createReflection(golden.input), golden.expected);
});

test('previousRig は最新反省のリグを全キー揃いで返す', () => {
  const rig = { boatNo: 7, gear: null, prebend: 25, rake: null, sideTension: null,
    foreTension: null, puller: null, peakRope: null, bridleHeight: null,
    jibLeader: null, jibPull: null, vangPull: null };
  assert.deepEqual(previousRig([{ rig }]), rig);
});

test('previousRig は空履歴で空リグ(全null)を返す', () => {
  const empty = previousRig([]);
  assert.deepEqual(Object.keys(empty), RIG_FIELDS);
  assert.ok(RIG_FIELDS.every((f) => empty[f] === null));
});
```

- [ ] **Step 4: テスト実行で PASS を確認**

Run: `node --test test/schema-contract.test.js`
Expected: 全 PASS。FAIL する場合はコピー漏れ（関数欠落）を疑い `src/schema.js` を補う。

- [ ] **Step 5: コミット**

```bash
git add src/schema.js test/schema-contract.test.js test/fixtures/reflection-golden.json
git commit -m "feat: 共有反省スキーマ schema.js を移植し契約テストで固定(#20)"
```

---

## Task 4: 名簿 `members.js` と identity（名簿選択・合言葉）

「誰の反省か」を名簿選択で決め、localStorage に保持する軽量 identity。

**Files:**
- Create: `src/members.js`（SailViz からコピー）
- Create: `src/identity.js`
- Create: `test/identity.test.js`

**Interfaces:**
- Consumes: `memberList()` from `src/members.js`（`{ id, name, kana }` の配列を返す）。
- Produces:
  - `loadIdentity(storage)` → `{ memberId } | null`
  - `saveIdentity(memberId, storage)` → `{ memberId }`（保存し返す）
  - `clearIdentity(storage)` → `void`
  - `isAuthorized(input, expected)` → `boolean`（前後空白を無視した一致。`expected` が空/未設定なら常に true）

- [ ] **Step 1: `members.js` をコピー**

SailViz `src/members.js` を新リポ `src/members.js` へバイト一致でコピー（`MEMBERS` と `memberList()` を含む全体）。

- [ ] **Step 2: identity のテストを書く（失敗するはず）**

Create `test/identity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIdentity, saveIdentity, clearIdentity, isAuthorized } from '../src/identity.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('save→load で memberId が往復する', () => {
  const s = fakeStorage();
  saveIdentity('m3', s);
  assert.deepEqual(loadIdentity(s), { memberId: 'm3' });
});

test('未保存なら load は null', () => {
  assert.equal(loadIdentity(fakeStorage()), null);
});

test('clear で消える', () => {
  const s = fakeStorage();
  saveIdentity('m3', s);
  clearIdentity(s);
  assert.equal(loadIdentity(s), null);
});

test('合言葉は前後空白無視で一致判定', () => {
  assert.equal(isAuthorized('  sail2026 ', 'sail2026'), true);
  assert.equal(isAuthorized('nope', 'sail2026'), false);
});

test('合言葉未設定(空)なら常に許可', () => {
  assert.equal(isAuthorized('', ''), true);
  assert.equal(isAuthorized('anything', ''), true);
});
```

- [ ] **Step 3: テスト実行で FAIL を確認**

Run: `node --test test/identity.test.js`
Expected: FAIL（`identity.js` 未作成 → import error）。

- [ ] **Step 4: `identity.js` を実装**

Create `src/identity.js`:

```js
// 部員の本人確認(軽量)。名簿選択の memberId を localStorage に保持し、
// 任意の共有合言葉でゲートする。DOM 非依存・storage は注入可能。
const KEY = 'sailviz-reflect.identity';

export function loadIdentity(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj.memberId === 'string' ? { memberId: obj.memberId } : null;
  } catch {
    return null;
  }
}

export function saveIdentity(memberId, storage = globalThis.localStorage) {
  const id = { memberId: String(memberId) };
  storage?.setItem(KEY, JSON.stringify(id));
  return id;
}

export function clearIdentity(storage = globalThis.localStorage) {
  storage?.removeItem(KEY);
}

// 前後空白を無視した一致。expected が空(未設定)なら常に許可。
export function isAuthorized(input, expected) {
  if (!expected) return true;
  return String(input).trim() === String(expected).trim();
}
```

- [ ] **Step 5: テスト実行で PASS を確認**

Run: `node --test test/identity.test.js`
Expected: 全 PASS。

- [ ] **Step 6: コミット**

```bash
git add src/members.js src/identity.js test/identity.test.js
git commit -m "feat: 名簿コピーと軽量 identity(名簿選択+合言葉)(#20)"
```

---

## Task 5: オフライン同期キュー `syncQueue.js`

反省を localStorage に `pending` で即保存し、`send` 注入でフラッシュ（成功→`synced`、失敗→`pending` 保持）。プラン2で `send` に本物の Supabase を差す。

**Files:**
- Create: `src/syncQueue.js`
- Create: `test/syncQueue.test.js`

**Interfaces:**
- Consumes: 注入する `storage`（localStorage 互換）、注入する `send(reflection) => Promise<void>`（失敗時 throw）。
- Produces:
  - `loadQueue(storage)` → `Array<{ reflection, status }>`
  - `enqueue(reflection, storage)` → 追加後の配列（同一 `reflection.id` は置換＝べき等）
  - `flush(storage, send)` → `Promise<{ synced, pending }>`（件数）。成功件を `synced` に更新して保存。

- [ ] **Step 1: テストを書く（失敗するはず）**

Create `test/syncQueue.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQueue, enqueue, flush } from '../src/syncQueue.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
const R = (id) => ({ id, text: `t${id}` });

test('enqueue は pending で積み、load で読める', () => {
  const s = fakeStorage();
  enqueue(R('a'), s);
  const q = loadQueue(s);
  assert.equal(q.length, 1);
  assert.equal(q[0].status, 'pending');
  assert.equal(q[0].reflection.id, 'a');
});

test('同一 id の enqueue は置換(べき等・重複しない)', () => {
  const s = fakeStorage();
  enqueue(R('a'), s);
  enqueue({ id: 'a', text: 'updated' }, s);
  const q = loadQueue(s);
  assert.equal(q.length, 1);
  assert.equal(q[0].reflection.text, 'updated');
  assert.equal(q[0].status, 'pending');
});

test('flush 成功で全件 synced になる', async () => {
  const s = fakeStorage();
  enqueue(R('a'), s); enqueue(R('b'), s);
  const sent = [];
  const res = await flush(s, async (r) => { sent.push(r.id); });
  assert.deepEqual(sent.sort(), ['a', 'b']);
  assert.deepEqual(res, { synced: 2, pending: 0 });
  assert.ok(loadQueue(s).every((e) => e.status === 'synced'));
});

test('flush 失敗は pending のまま残り再試行できる', async () => {
  const s = fakeStorage();
  enqueue(R('a'), s); enqueue(R('b'), s);
  let calls = 0;
  const send = async (r) => { calls++; if (r.id === 'b') throw new Error('offline'); };
  const res1 = await flush(s, send);
  assert.deepEqual(res1, { synced: 1, pending: 1 });
  assert.equal(loadQueue(s).find((e) => e.reflection.id === 'b').status, 'pending');
  // 再試行では synced 済みは送らず、pending の b だけ送る
  const res2 = await flush(s, async (r) => { calls++; });
  assert.deepEqual(res2, { synced: 2, pending: 0 });
});

test('synced 済みは flush で再送しない', async () => {
  const s = fakeStorage();
  enqueue(R('a'), s);
  await flush(s, async () => {});
  let calls = 0;
  await flush(s, async () => { calls++; });
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: テスト実行で FAIL を確認**

Run: `node --test test/syncQueue.test.js`
Expected: FAIL（`syncQueue.js` 未作成）。

- [ ] **Step 3: `syncQueue.js` を実装**

Create `src/syncQueue.js`:

```js
// オフライン同期キュー。反省を localStorage に pending で即保存し、
// send(reflection) 注入でフラッシュする。成功→synced、失敗→pending 保持。
// storage/send は注入可能(DOM/ネットワーク非依存)。
const KEY = 'sailviz-reflect.queue';

export function loadQueue(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(queue, storage) {
  storage?.setItem(KEY, JSON.stringify(queue));
  return queue;
}

// 同一 reflection.id は置換(べき等)。新規は末尾に pending で追加。
export function enqueue(reflection, storage = globalThis.localStorage) {
  const q = loadQueue(storage);
  const entry = { reflection, status: 'pending' };
  const i = q.findIndex((e) => e.reflection.id === reflection.id);
  if (i >= 0) q[i] = entry; else q.push(entry);
  return save(q, storage);
}

// pending だけを send。成功→synced に更新。失敗→pending 維持。件数を返す。
export async function flush(storage = globalThis.localStorage, send) {
  const q = loadQueue(storage);
  for (const e of q) {
    if (e.status === 'synced') continue;
    try {
      await send(e.reflection);
      e.status = 'synced';
    } catch {
      e.status = 'pending';
    }
  }
  save(q, storage);
  const synced = q.filter((e) => e.status === 'synced').length;
  return { synced, pending: q.length - synced };
}
```

- [ ] **Step 4: テスト実行で PASS を確認**

Run: `node --test test/syncQueue.test.js`
Expected: 全 PASS。

- [ ] **Step 5: コミット**

```bash
git add src/syncQueue.js test/syncQueue.test.js
git commit -m "feat: オフライン同期キュー syncQueue(pending/synced・べき等)(#20)"
```

---

## Task 6: 反省ストア `store.js`（一覧・履歴集計・前回課題）

キュー上の反省から「自分の反省一覧（新しい順）」「前回の課題/発見」を導く純ロジック。ビューが依存する読み取り層。

**Files:**
- Create: `src/store.js`
- Create: `test/store.test.js`

**Interfaces:**
- Consumes: `loadQueue(storage)` from `src/syncQueue.js`。反省は `{ id, createdAt, notes:{issue,discovery,...}, ... }`。
- Produces:
  - `myReflections(memberId, storage)` → 自分の反省を `createdAt` 降順の配列で返す（`reflection.people` ではなく保存時に付与する `reflection.memberId` で絞る）。
  - `lastIssueDiscovery(memberId, storage)` → `{ issue, discovery } | null`（最新反省の notes から。無ければ null）。

- [ ] **Step 1: テストを書く（失敗するはず）**

Create `test/store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue } from '../src/syncQueue.js';
import { myReflections, lastIssueDiscovery } from '../src/store.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const R = (id, memberId, createdAt, notes) =>
  ({ id, memberId, createdAt, notes: { issue: '', discovery: '', ...notes } });

test('myReflections は自分の分だけを新しい順で返す', () => {
  const s = fakeStorage();
  enqueue(R('a', 'm1', '2026-08-20T00:00:00.000Z', {}), s);
  enqueue(R('b', 'm2', '2026-08-21T00:00:00.000Z', {}), s);
  enqueue(R('c', 'm1', '2026-08-22T00:00:00.000Z', {}), s);
  const mine = myReflections('m1', s);
  assert.deepEqual(mine.map((r) => r.id), ['c', 'a']);
});

test('lastIssueDiscovery は自分の最新反省の課題/発見を返す', () => {
  const s = fakeStorage();
  enqueue(R('a', 'm1', '2026-08-20T00:00:00.000Z', { issue: '旧課題' }), s);
  enqueue(R('c', 'm1', '2026-08-22T00:00:00.000Z', { issue: '新課題', discovery: '発見Z' }), s);
  assert.deepEqual(lastIssueDiscovery('m1', s), { issue: '新課題', discovery: '発見Z' });
});

test('lastIssueDiscovery は履歴なしで null', () => {
  assert.equal(lastIssueDiscovery('m1', fakeStorage()), null);
});
```

- [ ] **Step 2: テスト実行で FAIL を確認**

Run: `node --test test/store.test.js`
Expected: FAIL（`store.js` 未作成）。

- [ ] **Step 3: `store.js` を実装**

Create `src/store.js`:

```js
// キュー上の反省から読み取り(自分の一覧・前回課題/発見)を導く純ロジック。
import { loadQueue } from './syncQueue.js';

export function myReflections(memberId, storage = globalThis.localStorage) {
  return loadQueue(storage)
    .map((e) => e.reflection)
    .filter((r) => r.memberId === memberId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export function lastIssueDiscovery(memberId, storage = globalThis.localStorage) {
  const latest = myReflections(memberId, storage)[0];
  if (!latest) return null;
  const notes = latest.notes || {};
  return { issue: notes.issue || '', discovery: notes.discovery || '' };
}
```

- [ ] **Step 4: テスト実行で PASS を確認**

Run: `node --test test/store.test.js`
Expected: 全 PASS。

- [ ] **Step 5: コミット**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: 反省ストア(自分の一覧・前回課題/発見)(#20)"
```

---

## Task 7: ハッシュルーター `router.js`

`#/new`, `#/history`, `#/detail/<id>`, 既定 `home` を解決する純ロジック。

**Files:**
- Create: `src/router.js`
- Create: `test/router.test.js`

**Interfaces:**
- Produces:
  - `parseRoute(hash)` → `{ name, params }`。未知/空は `{ name: 'home', params: {} }`。
  - `buildHash(name, params)` → `string`（例 `buildHash('detail',{id:'r1'})` → `'#/detail/r1'`）。

- [ ] **Step 1: テストを書く（失敗するはず）**

Create `test/router.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, buildHash } from '../src/router.js';

test('空/未知は home', () => {
  assert.deepEqual(parseRoute(''), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('#/'), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('#/zzz'), { name: 'home', params: {} });
});

test('固定ルート', () => {
  assert.deepEqual(parseRoute('#/new'), { name: 'new', params: {} });
  assert.deepEqual(parseRoute('#/history'), { name: 'history', params: {} });
});

test('detail は id を取り出す', () => {
  assert.deepEqual(parseRoute('#/detail/r1'), { name: 'detail', params: { id: 'r1' } });
});

test('buildHash は往復する', () => {
  assert.equal(buildHash('new'), '#/new');
  assert.equal(buildHash('detail', { id: 'r1' }), '#/detail/r1');
  assert.deepEqual(parseRoute(buildHash('detail', { id: 'abc' })), { name: 'detail', params: { id: 'abc' } });
});
```

- [ ] **Step 2: テスト実行で FAIL を確認**

Run: `node --test test/router.test.js`
Expected: FAIL（`router.js` 未作成）。

- [ ] **Step 3: `router.js` を実装**

Create `src/router.js`:

```js
// 極小ハッシュルーター。#/new #/history #/detail/<id>、既定 home。DOM 非依存。
const FIXED = new Set(['new', 'history']);

export function parseRoute(hash = '') {
  const path = String(hash).replace(/^#\/?/, ''); // "detail/r1" 等
  const [head, ...rest] = path.split('/').filter(Boolean);
  if (!head) return { name: 'home', params: {} };
  if (head === 'detail' && rest[0]) return { name: 'detail', params: { id: rest[0] } };
  if (FIXED.has(head)) return { name: head, params: {} };
  return { name: 'home', params: {} };
}

export function buildHash(name, params = {}) {
  if (name === 'detail' && params.id) return `#/detail/${params.id}`;
  if (name === 'home') return '#/';
  return `#/${name}`;
}
```

- [ ] **Step 4: テスト実行で PASS を確認**

Run: `node --test test/router.test.js`
Expected: 全 PASS。

- [ ] **Step 5: 全テスト実行**

Run: `node --test`
Expected: schema-contract / identity / syncQueue / store / router 全 PASS。

- [ ] **Step 6: コミット**

```bash
git add src/router.js test/router.test.js
git commit -m "feat: ハッシュルーター router(#20)"
```

---

## Task 8: PWA シェル（index.html / manifest / sw.js / styles.css）

インストール可能・オフライン起動する静的シェル。アプリシェルを Service Worker でキャッシュ。

**Files:**
- Create: `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`

**Interfaces:**
- Consumes: なし（静的資産）。`index.html` が `src/app.js` を `type=module` で読む（app.js は Task 9）。
- Produces: `#app` コンテナ（ビューの描画先）と、SW 登録スニペット。

- [ ] **Step 1: `manifest.webmanifest` を書く**

Create `manifest.webmanifest`:

```json
{
  "name": "SailViz 反省",
  "short_name": "反省",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#0b1f33",
  "theme_color": "#0b1f33",
  "icons": []
}
```

- [ ] **Step 2: `index.html` を書く**

Create `index.html`:

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b1f33" />
  <link rel="manifest" href="./manifest.webmanifest" />
  <link rel="stylesheet" href="./styles.css" />
  <title>SailViz 反省</title>
</head>
<body>
  <main id="app"></main>
  <script type="module" src="./src/app.js"></script>
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
    }
  </script>
</body>
</html>
```

- [ ] **Step 3: `sw.js` を書く**

Create `sw.js`:

```js
// アプリシェルをキャッシュしてオフライン起動を可能にする。
const CACHE = 'sailviz-reflect-v1';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './src/app.js', './src/schema.js', './src/members.js', './src/identity.js',
  './src/syncQueue.js', './src/store.js', './src/router.js',
  './src/views/home.js', './src/views/newReflection.js',
  './src/views/history.js', './src/views/detail.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
```

- [ ] **Step 4: `styles.css`（最小・モバイル前提）を書く**

Create `styles.css`:

```css
:root { --bg:#0b1f33; --fg:#e8eef5; --card:#12314d; --accent:#f2b134; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font-family: system-ui, sans-serif; padding: env(safe-area-inset-top) 0 0; }
#app { max-width: 640px; margin: 0 auto; padding: 16px; }
.card { background:var(--card); border-radius:12px; padding:14px; margin:10px 0; }
button, .btn { font-size:16px; padding:12px 16px; border-radius:10px; border:0;
  background:var(--accent); color:#0b1f33; font-weight:700; width:100%; }
label { display:block; margin:10px 0 4px; font-size:14px; opacity:.9; }
input, textarea, select { width:100%; font-size:16px; padding:10px; border-radius:8px;
  border:1px solid #2a4a6a; background:#0e2942; color:var(--fg); }
.rig-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.status-pending { color: var(--accent); } .status-synced { color:#7fd08a; }
```

- [ ] **Step 5: ローカル配信して起動を目視確認**

```bash
python3 -m http.server 8100
```
`http://localhost:8100/` を開き、白画面でも **コンソールにエラーが出ないこと**（app.js は Task 9 で作るため、この時点では 404 になる想定 → Task 9 完了後に再確認）。SW 登録は app.js 完成後に確認。

- [ ] **Step 6: コミット**

```bash
git add index.html styles.css manifest.webmanifest sw.js
git commit -m "feat: PWA シェル(index/manifest/sw/styles)(#20)"
```

---

## Task 9: ビューと結線（app.js + views/）

identity ゲート → ホーム（前回課題/発見）→ 新規反省（#16 レイアウト・前回リグ プリフィル）→ 履歴 → 詳細。純ロジックは Task 3–7 で担保済みなので、ここは DOM 描画と結線に集中し、動作は実機/ブラウザで目視確認する。

**Files:**
- Create: `src/views/home.js`, `src/views/newReflection.js`, `src/views/history.js`, `src/views/detail.js`
- Create: `src/app.js`

**Interfaces:**
- Consumes: `memberList()`(members.js), `loadIdentity/saveIdentity/isAuthorized`(identity.js), `createReflection/RIG_FIELDS/NOTE_FIELDS/previousRig`(schema.js), `enqueue/flush`(syncQueue.js), `myReflections/lastIssueDiscovery`(store.js), `parseRoute/buildHash`(router.js)。
- Produces: `renderHome(el, ctx)`, `renderNewReflection(el, ctx)`, `renderHistory(el, ctx)`, `renderDetail(el, ctx, id)` — 各ビューは `#app` 要素と共通 `ctx`(memberId, storage, navigate) を受け取り描画する。

- [ ] **Step 1: 各フィールドの日本語ラベルを用意**

`src/views/newReflection.js` の先頭に、SailViz `app.js:848` 付近の艇セッティング/反省内容ラベルと同じ対応表を定義する（`RIG_FIELDS`/`NOTE_FIELDS` のキー→日本語）。SailViz の該当ラベル定義をコピーして流用。

- [ ] **Step 2: `newReflection.js` を実装（#16 レイアウト）**

`renderNewReflection(el, ctx)`:
- `previousRig(myReflections(ctx.memberId, ctx.storage))` で前回リグを初期値に、`RIG_FIELDS` を `type=number` の `.rig-grid` に動的生成（SailViz #16 と同じ12項目）。
- 天候(風向/風速/波高)・反省内容 `NOTE_FIELDS` 5欄・自由記述 `text` を入力欄に。天候は前回を引き継がない。
- 「保存」で: `id = crypto.randomUUID()`, `createdAt = new Date().toISOString()`, `memberId = ctx.memberId` を付け、`createReflection({...})` に `rig`/`notes`/`wind`/`waveHeight`/`text` を渡し、返り値に `memberId` を合成 → `enqueue(reflection, ctx.storage)` → `flush(ctx.storage, ctx.send).catch(()=>{})`（オンライン時のみ成功、失敗は pending 維持）→ `ctx.navigate('home')`。
- `ctx.send` はプラン2まで「常に throw する no-op」を app.js が注入（＝常に pending。ローカルには残る）。

- [ ] **Step 3: `home.js` を実装**

`renderHome(el, ctx)`:
- `lastIssueDiscovery(ctx.memberId, ctx.storage)` を「前回の課題／発見」カードに表示（null なら「まだ反省がありません」）。
- 「＋ 新規反省」ボタン → `ctx.navigate('new')`、「履歴」ボタン → `ctx.navigate('history')`。
- 「動画を Drive にアップ」ボタン → `window.open(ctx.driveUrl, '_blank')`（`driveUrl` は `src/config.js` から。プラン2で確定。未設定なら非表示）。

- [ ] **Step 4: `history.js` と `detail.js` を実装**

- `renderHistory(el, ctx)`: `myReflections(ctx.memberId, ctx.storage)` を時系列カードで一覧（`createdAt` を読みやすく整形、`notes.issue` 抜粋、同期ステータス pending/synced をキュー状態から表示）。カードタップで `ctx.navigate('detail', { id })`。
- `renderDetail(el, ctx, id)`: 当該反省の全項目（リグ12・天候・反省5欄・本文・動画メンション）を読み取り表示。「戻る」で `history` へ。

- [ ] **Step 5: `app.js` で結線**

`src/app.js`:
- 起動時 `loadIdentity()`。未設定なら名簿選択＋合言葉ゲート画面を出し、`isAuthorized` 通過後 `saveIdentity` → 再描画。
- `ctx = { memberId, storage: localStorage, navigate, send, driveUrl }`。`navigate(name, params)` は `location.hash = buildHash(name, params)`。
- `window.onhashchange` と初回で `parseRoute(location.hash)` → 対応ビューを `#app` に描画。
- `send` はプラン2まで `async () => { throw new Error('cloud not wired'); }` を注入。
- 起動時と `online` イベントで `flush(localStorage, send).catch(()=>{})`（プラン2で有効化）。

- [ ] **Step 6: ブラウザで一連の動作を目視確認**

```bash
python3 -m http.server 8100
```
確認: 名簿選択→ホーム→新規反省入力→保存→履歴に出る→詳細で全項目→リロードしても残る（localStorage）→機内モードにしても入力・保存・閲覧できる（pending のまま保持）→コンソールにエラーなし→SW 登録済み(DevTools > Application)。

- [ ] **Step 7: コミット**

```bash
git add src/app.js src/views/
git commit -m "feat: identity/ホーム/新規反省/履歴/詳細のビューと結線(#20)"
```

---

## 後続: プラン2（別途作成）

本プランはオフライン完結まで。次プラン `2026-XX-XX-sailviz-reflect-sync.md` で:
- `src/config.js`＋`src/supabase.js`（CDN ESM `@supabase/supabase-js`）で実 `send`（`reflections` へ upsert）を実装し、`flush` に差し替え。
- Supabase プロジェクト作成・DDL 適用（spec のデータモデル）・RLS ソフトポリシー。
- 履歴の remote 取得（自端末以外/再インストール後も見えるように）。
- ホスティング（静的デプロイ）と実機スマホ検証。
- Drive アップ導線の `driveUrl` 確定。
- **SailViz 本体**へ「☁ クラウド反省取込」（現在の練習日で read-only fetch → `state.reflections` 合流）を追加。

## Self-Review（このプランの点検結果）

- **Spec coverage:** 別リポ化=Task2 / 共有スキーマ+契約=Task1,3 / 名簿identity+合言葉=Task4 / オフラインキュー=Task5 / 前回課題・履歴=Task6 / ルーティング=Task7 / PWA=Task8 / #16フォーム・プリフィル・Driveリンク導線=Task9。**Supabase実結線・RLS・デプロイ・SailViz取込はプラン2へ明示分離**（spec の「後続フェーズ」に合致）。
- **Placeholder scan:** 純ロジック(Task1–7)は実コード・実テストで記述。ビュー(Task9)は DOM 描画のため手順＋目視確認で具体化（純ロジックは Task3–7 でテスト済み）。TBD/TODO なし。
- **Type consistency:** `createReflection`(schema.js)/`enqueue`,`flush`(syncQueue.js)/`myReflections`,`lastIssueDiscovery`(store.js)/`parseRoute`,`buildHash`(router.js)/`loadIdentity`,`saveIdentity`,`isAuthorized`(identity.js) のシグネチャは各タスクの Interfaces と実装で一致。反省の絞り込みキーは全タスクで `reflection.memberId` に統一。
