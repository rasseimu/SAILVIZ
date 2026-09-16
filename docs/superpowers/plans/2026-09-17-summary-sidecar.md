# サマリ・サイドカー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/summaries` を、全 points を含む本体(約11MB/件)のパースから解放し、軽量サイドカー `*.summary.json` だけで応答できるようにする。

**Architecture:** プロジェクト本体 `data/projects/foo.sailviz.json` ごとに要約サイドカー `data/projects/summaries/foo.summary.json` を並置する。`writeProject` が保存のたびに `practiceSummary` を計算してサイドカーを再生成し、`deleteProject` が両方を削除する。一覧は `readSummary` を読み、欠損時のみ本体を一度読んで生成する(遅延バックフィル)。

**Tech Stack:** Node.js ESM, `node:fs/promises`, `node --test`(組込みテストランナー)。

**Spec:** `docs/superpowers/specs/2026-09-17-summary-sidecar-design.md`

## Global Constraints

- ランタイム依存の追加なし(組込み `node:*` のみ)。
- `/api/summaries` のレスポンス形状は不変: 各行 `{ name, ...practiceSummary(...) }`。
- `practiceSummary`(`src/summary.js`)は変更しない。既に points 非依存。
- サイドカー名は本体名から `\.sailviz\.json$` → `.summary.json` で導出。本体名は `isValidProjectName` 済み前提でトラバーサル不可。
- 本体の書込み・読取りは既存挙動を破壊しない(サイドカー生成失敗は本体書込みを妨げない)。
- テストは各ファイルにつき一時ディレクトリ(`mkdtemp`)で隔離し、`withTmp` パターンに倣う。

---

### Task 1: storage にサイドカー CRUD を追加

**Files:**
- Modify: `server/storage.js`
- Test: `test/server-storage.test.js`

**Interfaces:**
- Consumes: `practiceSummary(project, { name })`(`src/summary.js`、既存)。`projectsDir(dataDir)`/`ensureDir(dir)`/`isValidProjectName(name)`(`server/storage.js` 内、既存)。
- Produces:
  - `summaryName(name: string): string` — 本体名 → サイドカー名。
  - `writeSummary(dataDir: string, name: string, summaryObj: object): Promise<void>` — `projects/summaries/` を作成してサイドカー JSON を書く。
  - `readSummary(dataDir: string, name: string): Promise<object|null>` — サイドカーを読む。欠損/破損時は `null`。

- [ ] **Step 1: Write the failing tests**

`test/server-storage.test.js` の末尾(既存の import と `withTmp` を再利用)に追加。import 行に `summaryName, readSummary, writeSummary` を足す。

```js
test('summaryName は本体名をサイドカー名に変換する', () => {
  assert.equal(
    summaryName('sailviz-20260101-0900.sailviz.json'),
    'sailviz-20260101-0900.summary.json',
  );
});

test('writeSummary → readSummary が round-trip し、summaries/ に置かれる', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260101-0900.sailviz.json';
    await writeSummary(dir, name, { name, trackCount: 2 });
    assert.deepEqual(await readSummary(dir, name), { name, trackCount: 2 });
    // サイドカーは projects/summaries/ に置かれ、一覧(本体)には混入しない
    assert.deepEqual(await listProjects(dir), []);
  });
});

test('readSummary は欠損時 null を返す', async () => {
  await withTmp(async (dir) => {
    assert.equal(await readSummary(dir, 'sailviz-20260101-0900.sailviz.json'), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server-storage.test.js`
Expected: FAIL(`summaryName`/`writeSummary`/`readSummary` が export されていない)。

- [ ] **Step 3: 実装を追加**

`server/storage.js` の `PROJECT_RE`/`projectsDir`/`ensureDir` 付近に追記。

```js
function summariesDir(dataDir) { return join(projectsDir(dataDir), 'summaries'); }

export function summaryName(name) {
  return name.replace(/\.sailviz\.json$/, '.summary.json');
}

export async function writeSummary(dataDir, name, summaryObj) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  await ensureDir(summariesDir(dataDir));
  await writeFile(join(summariesDir(dataDir), summaryName(name)), JSON.stringify(summaryObj), 'utf8');
}

export async function readSummary(dataDir, name) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  try {
    const text = await readFile(join(summariesDir(dataDir), summaryName(name)), 'utf8');
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server-storage.test.js`
Expected: PASS(既存テストも含め全て緑)。

- [ ] **Step 5: Commit**

```bash
git add server/storage.js test/server-storage.test.js
git commit -m "feat(storage): サマリ・サイドカーの読み書き(summaryName/readSummary/writeSummary)"
```

---

### Task 2: writeProject / deleteProject でサイドカーを同期

**Files:**
- Modify: `server/storage.js`
- Test: `test/server-storage.test.js`

**Interfaces:**
- Consumes: Task 1 の `writeSummary`/`readSummary`/`summaryName`。`practiceSummary`(`src/summary.js`)。
- Produces: 既存の `writeProject`/`deleteProject` の副作用としてサイドカーを生成/削除。シグネチャは不変。

- [ ] **Step 1: Write the failing tests**

`test/server-storage.test.js` に追加。import は Task 1 で追加済みの `readSummary` を使用。`practiceSummary` を `../src/summary.js` から import 追加。

```js
import { practiceSummary } from '../src/summary.js';

test('writeProject がサイドカーを practiceSummary と一致して生成する', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260101-0900.sailviz.json';
    const obj = {
      version: 1,
      tracks: [{ id: 'a', tRange: { start: 1000 } }],
      videos: [], events: [], reflections: [], practiceDate: 1000,
    };
    await writeProject(dir, name, obj);
    assert.deepEqual(await readSummary(dir, name), practiceSummary(obj, { name }));
  });
});

test('サイドカー書込みが失敗しても本体書込みは成功する', async () => {
  await withTmp(async (dir) => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(dir, 'projects'), { recursive: true });
    // summaries があるべき場所を通常ファイルで塞ぐ → writeSummary の mkdir が失敗する
    await writeFile(join(dir, 'projects', 'summaries'), 'x', 'utf8');
    const name = 'sailviz-20260101-0900.sailviz.json';
    const obj = { version: 1, tracks: [], videos: [], events: [], reflections: [] };
    await writeProject(dir, name, obj);                   // throw しないこと
    assert.deepEqual(await readProject(dir, name), obj);  // 本体は書けている
    assert.equal(await readSummary(dir, name), null);     // サイドカーは無い
  });
});

test('deleteProject が本体とサイドカーの両方を削除する', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260101-0900.sailviz.json';
    await writeProject(dir, name, { version: 1, tracks: [], videos: [], events: [], reflections: [] });
    assert.notEqual(await readSummary(dir, name), null);
    await deleteProject(dir, name);
    await assert.rejects(() => readProject(dir, name));
    assert.equal(await readSummary(dir, name), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server-storage.test.js`
Expected: FAIL(現状 `writeProject` はサイドカーを作らず、`deleteProject` はサイドカーを消さない)。

- [ ] **Step 3: 実装を変更**

`server/storage.js` の `writeProject`/`deleteProject` を差し替え。`practiceSummary` の import を先頭に追加。

```js
import { practiceSummary } from '../src/summary.js';
```

```js
export async function writeProject(dataDir, name, obj) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  await ensureDir(projectsDir(dataDir));
  await writeFile(join(projectsDir(dataDir), name), JSON.stringify(obj), 'utf8');
  // サイドカー(派生キャッシュ)の失敗は本体書込みを妨げない。欠損は遅延生成が保険。
  try { await writeSummary(dataDir, name, practiceSummary(obj, { name })); } catch { /* noop */ }
}

export async function deleteProject(dataDir, name) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  await unlink(join(projectsDir(dataDir), name));
  try { await unlink(join(summariesDir(dataDir), summaryName(name))); } catch { /* 既に無ければ黙認 */ }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server-storage.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/storage.js test/server-storage.test.js
git commit -m "feat(storage): writeProject/deleteProject でサイドカーを同期"
```

---

### Task 3: /api/summaries を遅延バックフィルに切替え

**Files:**
- Modify: `server/api.js:223-231`(`/api/summaries` ハンドラ)、`server/api.js:4`(storage import)
- Test: `test/server-api.test.js`

**Interfaces:**
- Consumes: Task 1/2 の `readSummary`/`writeSummary`。`practiceSummary`(`server/api.js` で既に import 済み、行14)。`readProject`/`listProjects`(既存)。
- Produces: `GET /api/summaries` は各プロジェクトにつきサイドカー優先で応答。欠損時のみ本体を1回読んで要約を作りサイドカーへ書き戻す。レスポンス形状 `{ name, ...summary }` は不変。

- [ ] **Step 1: Write the failing test**

`test/server-api.test.js` に追加(既存の `before`/`after` の server/base/dataDir を再利用)。`storage.js` から `readSummary` を import して検証。ファイル冒頭付近の import に追加:

```js
import { readSummary } from '../server/storage.js';
```

テスト本体:

```js
test('summaries は既存プロジェクトを遅延バックフィルする', async () => {
  const name = 'sailviz-20260410-0900.sailviz.json';
  // サイドカーを作らずに本体だけを直書き(既存プロジェクトを模す)
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const projDir = join(dataDir, 'projects');
  await mkdir(projDir, { recursive: true });
  const obj = { version: 1, tracks: [{ id: 'x', tRange: { start: 5000 } }], videos: [], events: [], reflections: [], practiceDate: 5000 };
  await writeFile(join(projDir, name), JSON.stringify(obj), 'utf8');

  // この時点でサイドカーは無い
  assert.equal(await readSummary(dataDir, name), null);

  const r = await fetch(`${base}/api/summaries`);
  const rows = await r.json();
  const row = rows.find((x) => x.name === name);
  assert.ok(row, 'summaries に対象プロジェクトが含まれる');
  assert.equal(row.trackCount, 1);

  // 遅延バックフィルでサイドカーが生成されている
  assert.notEqual(await readSummary(dataDir, name), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-api.test.js`
Expected: FAIL(現状はサイドカーを生成しないため最後の `notEqual` が落ちる)。

- [ ] **Step 3: 実装を変更**

`server/api.js:4` の storage import に `readSummary, writeSummary` を追加:

```js
import {
  listProjects, readProject, writeProject, deleteProject,
  readSummary, writeSummary,
  // ...既存の他 export はそのまま
```

`/api/summaries` ハンドラ(現 223-231 行)を差し替え:

```js
if (path === '/api/summaries' && method === 'GET') {
  const list = await listProjects(dataDir);
  const rows = [];
  for (const { name } of list) {
    try {
      let s = await readSummary(dataDir, name);            // 無ければ null
      if (!s) {                                            // 遅延バックフィル
        s = practiceSummary(await readProject(dataDir, name), { name });
        await writeSummary(dataDir, name, s);
      }
      rows.push({ name, ...s });
    } catch { /* 壊れたファイルは飛ばす */ }
  }
  send(res, 200, rows); return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-api.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/api.js test/server-api.test.js
git commit -m "feat(api): /api/summaries をサイドカー優先+遅延バックフィルに"
```

---

### Task 4: 全テスト実行で回帰確認

**Files:**
- なし(検証のみ)

- [ ] **Step 1: 全テストを実行**

Run: `npm test`
Expected: 全テスト PASS。特に既存の `server-storage`/`server-api`/`summary` が緑であること。

- [ ] **Step 2: 壊れていれば systematic-debugging で修正**

失敗があれば原因を切り分けて修正し、該当タスクの Step からやり直す。

- [ ] **Step 3(任意): 動作確認**

`data/` の実プロジェクトに対し `GET /api/summaries` を叩き、レスポンスが従来と一致すること、`data/projects/summaries/` にサイドカーが生成されることを確認。

---

## Self-Review メモ

- **Spec coverage:** サイドカー CRUD(Task 1)、write/delete 同期(Task 2)、遅延バックフィル(Task 3)、回帰(Task 4)。spec の全節をカバー。`src/summary.js` 変更なしも spec 通り。
- **Placeholder scan:** プレースホルダなし。全ステップにコード/コマンドあり。
- **Type consistency:** `summaryName`/`readSummary`/`writeSummary` の名称・引数は Task 1〜3 で一貫。`practiceSummary(obj, { name })` の呼び出し形も一貫。
