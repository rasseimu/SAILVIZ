# プロジェクト保存／読込（過去の練習）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 作業の途中経過を保存フォルダにファイルとして書き出し、「過去の練習」プルダウンから選んで復元できるようにする（動画は参照のみ・フォルダ再選択で再リンク）。

**Architecture:** 純ロジック（直列化・フォルダ入出力・動画ファイル収集）を DOM 非依存モジュールに分離して TDD。ブラウザ API 依存（IndexedDB でのフォルダハンドル永続化、File System Access、UI 結線）は薄い層に隔離し手動確認。保存フォルダの `FileSystemDirectoryHandle` を IndexedDB に永続化して「過去の練習」を記憶する。

**Tech Stack:** バニラ ES modules、`node --test`（純ロジック）、File System Access API（`showDirectoryPicker`）、IndexedDB。ビルドなし・依存なしの静的サイト。

**Spec:** `docs/superpowers/specs/2026-08-17-project-save-load-design.md`

## Global Constraints

- 依存追加なし（バニラ JS ES modules のみ）。既存の import スタイル・命名に合わせる。
- 保存ファイル拡張子は `.sailviz.json`、`version` は `1`。
- 直列化から必ず除外: `state.transform`（投影関数を含む）と `video.url`（一時 blob URL）。
- 純ロジックのテストは `node --test`。DOM/ブラウザ API 依存部は手動確認（README の方針「描画/操作は手動確認」に従う）。
- 動画は実体を保存せず `{ id, t, name, durationMs }` のみ。読込後は「未リンク」。
- File System Access API 前提のため Chrome/Edge 限定。非対応ブラウザは案内表示。

---

## File Structure

- Create `src/project.js` — state ⇄ 保存オブジェクトの直列化（純ロジック）
- Create `src/projectfs.js` — フォルダ直下の `.sailviz.json` 列挙・読み書き・ファイル名（注入可能ハンドル）
- Create `src/dirhandle.js` — 保存フォルダハンドルの IndexedDB 永続化・権限確認（薄い層・手動確認）
- Modify `src/folderimport.js` — `collectVideoFiles` を追加（名前一致で File 収集）
- Modify `index.html` — topbar に「💾 保存」ボタンと「過去の練習」`<select>` を追加
- Modify `src/app.js` — 保存／過去の練習／動画再リンクの結線、起動時のフォルダ復元
- Create `test/project.test.js`、`test/projectfs.test.js`
- Modify `test/folderimport.test.js` — `collectVideoFiles` のテスト追記

---

## Task 1: 直列化モジュール `src/project.js`

**Files:**
- Create: `src/project.js`
- Test: `test/project.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `PROJECT_VERSION: number`（=1）
  - `serializeProject(state, { savedAt }) -> object`
  - `deserializeProject(obj) -> { mode, accuracyFilter, crop, tracks, events, marks, pins, videos, reflections }`（`obj.version !== 1` で throw）

- [ ] **Step 1: 失敗するテストを書く**

`test/project.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, deserializeProject, PROJECT_VERSION } from '../src/project.js';

function sampleState() {
  return {
    mode: 'elapsed',
    accuracyFilter: false,
    crop: { start: 10, end: 90 },
    tracks: [{
      id: 'a.csv', name: 'a.csv', color: '#1c72b8', visible: true,
      points: [{ t: 0, lat: 35, lon: 139 }, { t: 1000, lat: 35.1, lon: 139.1 }],
      bounds: { minLat: 35, maxLat: 35.1, minLon: 139, maxLon: 139.1 },
      tRange: { start: 0, end: 1000 },
    }],
    events: [{ kind: 'point', t: 500, tEnd: null, label: 'タック', lat: null, lon: null }],
    marks: [{ id: 'mk0', lat: 35.05, lon: 139.05, shape: 'triangle', color: '#e02020' }],
    pins: [250, 750],
    videos: [{ id: 'vid0', t: 300, url: 'blob:xyz', name: 'v.mp4', durationMs: 5000 }],
    reflections: [{ id: 'r1', createdAt: 1, text: 'メモ', people: [], videos: [], wind: null, practice: null }],
    // 直列化されてはいけないもの
    transform: { scale: 1, cx: 0, cy: 0, w: 800, h: 600, proj: () => {} },
  };
}

test('serialize→deserialize でトラック/タグ/マーク/ピン/動画メタ/反省/モード/クロップが保たれる', () => {
  const out = deserializeProject(serializeProject(sampleState(), { savedAt: '2026-08-17T00:00:00.000Z' }));
  assert.equal(out.mode, 'elapsed');
  assert.equal(out.accuracyFilter, false);
  assert.deepEqual(out.crop, { start: 10, end: 90 });
  assert.equal(out.tracks[0].points.length, 2);
  assert.equal(out.marks[0].shape, 'triangle');
  assert.equal(out.marks[0].lat, 35.05);
  assert.deepEqual(out.pins, [250, 750]);
  assert.equal(out.videos[0].name, 'v.mp4');
  assert.equal(out.reflections[0].text, 'メモ');
});

test('transform と video.url は保存オブジェクトに含まれない', () => {
  const saved = serializeProject(sampleState(), { savedAt: 's' });
  assert.equal('transform' in saved, false);
  assert.equal('url' in saved.videos[0], false);
  assert.equal(saved.version, PROJECT_VERSION);
  assert.equal(saved.savedAt, 's');
});

test('version 不一致は throw', () => {
  assert.throws(() => deserializeProject({ version: 999 }));
  assert.throws(() => deserializeProject(null));
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/project.test.js`
Expected: FAIL（`Cannot find module '../src/project.js'`）

- [ ] **Step 3: 最小実装を書く**

`src/project.js`:

```js
// state ⇄ 保存オブジェクトの直列化。DOM/ブラウザ API 非依存。
// 除外: state.transform(投影関数を含む) と video.url(一時 blob URL)。
export const PROJECT_VERSION = 1;

export function serializeProject(state, { savedAt } = {}) {
  return {
    version: PROJECT_VERSION,
    savedAt: savedAt ?? null,
    mode: state.mode,
    accuracyFilter: state.accuracyFilter,
    crop: { start: state.crop.start, end: state.crop.end },
    tracks: state.tracks.map((t) => ({
      id: t.id, name: t.name, color: t.color, visible: t.visible,
      points: t.points, bounds: t.bounds, tRange: t.tRange,
    })),
    events: state.events.map((e) => ({ ...e })),
    marks: state.marks.map((m) => ({ ...m })),
    pins: [...state.pins],
    videos: state.videos.map((v) => ({
      id: v.id, t: v.t, name: v.name, durationMs: v.durationMs ?? null,
    })),
    reflections: state.reflections.map((r) => ({ ...r })),
  };
}

export function deserializeProject(obj) {
  if (!obj || obj.version !== PROJECT_VERSION) {
    throw new Error(`未対応の保存形式です (version=${obj?.version})`);
  }
  const arr = (x) => (Array.isArray(x) ? x : []);
  const crop = obj.crop && typeof obj.crop.start === 'number'
    ? { start: obj.crop.start, end: obj.crop.end }
    : { start: 0, end: 0 };
  return {
    mode: obj.mode === 'elapsed' ? 'elapsed' : 'absolute',
    accuracyFilter: obj.accuracyFilter !== false,
    crop,
    tracks: arr(obj.tracks),
    events: arr(obj.events),
    marks: arr(obj.marks),
    pins: arr(obj.pins),
    videos: arr(obj.videos).map((v) => ({
      id: v.id, t: v.t, name: v.name, durationMs: v.durationMs ?? null,
    })),
    reflections: arr(obj.reflections),
  };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test test/project.test.js`
Expected: PASS（3 テスト）

- [ ] **Step 5: コミット**

```bash
git add src/project.js test/project.test.js
git commit -m "feat: プロジェクト直列化(project.js)"
```

---

## Task 2: フォルダ入出力 `src/projectfs.js`

**Files:**
- Create: `src/projectfs.js`
- Test: `test/projectfs.test.js`

**Interfaces:**
- Consumes: なし（`FileSystemDirectoryHandle` 互換を引数で受け取る）
- Produces:
  - `projectFileName(date: Date) -> string`（`sailviz-YYYYMMDD-HHMM.sailviz.json`）
  - `projectLabel(name: string) -> string`（`2026-08-17 09:30`／不正なら name）
  - `listProjectFiles(dirHandle) -> Promise<[{ name, label }]>`（`.sailviz.json` のみ・名前降順）
  - `readProject(dirHandle, name) -> Promise<object>`
  - `writeProject(dirHandle, name, obj) -> Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`test/projectfs.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectFileName, projectLabel, listProjectFiles, readProject, writeProject,
} from '../src/projectfs.js';

// 列挙用フェイクディレクトリ(values() のみ)
function fakeListDir(names) {
  return { values: async function* () { for (const n of names) yield { kind: 'file', name: n }; } };
}
// 読み書き用フェイクディレクトリ(getFileHandle が Map を裏で操作)
function fakeRWDir() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!opts || !opts.create) throw new Error('not found');
        files.set(name, '');
      }
      return {
        getFile: async () => ({ text: async () => files.get(name) }),
        createWritable: async () => ({
          write: async (data) => { files.set(name, data); },
          close: async () => {},
        }),
      };
    },
  };
}

test('projectFileName はタイムスタンプ付きファイル名を作る', () => {
  assert.equal(projectFileName(new Date(2026, 7, 17, 9, 30)), 'sailviz-20260817-0930.sailviz.json');
});

test('projectLabel は読みやすい日時に、不正なら名前をそのまま', () => {
  assert.equal(projectLabel('sailviz-20260817-0930.sailviz.json'), '2026-08-17 09:30');
  assert.equal(projectLabel('memo.sailviz.json'), 'memo.sailviz.json');
});

test('listProjectFiles は .sailviz.json のみを新しい順(名前降順)で返す', async () => {
  const dir = fakeListDir([
    'sailviz-20260817-0930.sailviz.json',
    'notes.txt',
    'sailviz-20260818-0800.sailviz.json',
    'video.mp4',
  ]);
  const list = await listProjectFiles(dir);
  assert.deepEqual(list.map((x) => x.name), [
    'sailviz-20260818-0800.sailviz.json',
    'sailviz-20260817-0930.sailviz.json',
  ]);
  assert.equal(list[0].label, '2026-08-18 08:00');
});

test('writeProject→readProject のラウンドトリップ', async () => {
  const dir = fakeRWDir();
  await writeProject(dir, 'p.sailviz.json', { version: 1, mode: 'absolute' });
  const got = await readProject(dir, 'p.sailviz.json');
  assert.deepEqual(got, { version: 1, mode: 'absolute' });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/projectfs.test.js`
Expected: FAIL（`Cannot find module '../src/projectfs.js'`）

- [ ] **Step 3: 最小実装を書く**

`src/projectfs.js`:

```js
// 保存フォルダ直下の .sailviz.json の列挙・読み書き。
// FileSystemDirectoryHandle 互換を引数で受け取り、テストではフェイクを注入する。
const PROJECT_RE = /\.sailviz\.json$/i;

const pad = (n) => String(n).padStart(2, '0');

// Date → "sailviz-YYYYMMDD-HHMM.sailviz.json"
export function projectFileName(date) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `sailviz-${stamp}.sailviz.json`;
}

// ファイル名 → 読みやすい日時。合致しなければ名前をそのまま返す。
export function projectLabel(name) {
  const m = name.match(/sailviz-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!m) return name;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

// dirHandle 直下の .sailviz.json を新しい順(名前降順=タイムスタンプ降順)で列挙。
export async function listProjectFiles(dirHandle) {
  const names = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && PROJECT_RE.test(entry.name)) names.push(entry.name);
  }
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return names.map((name) => ({ name, label: projectLabel(name) }));
}

export async function readProject(dirHandle, name) {
  const fh = await dirHandle.getFileHandle(name);
  const file = await fh.getFile();
  return JSON.parse(await file.text());
}

export async function writeProject(dirHandle, name, obj) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(obj));
  await writable.close();
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test test/projectfs.test.js`
Expected: PASS（4 テスト）

- [ ] **Step 5: コミット**

```bash
git add src/projectfs.js test/projectfs.test.js
git commit -m "feat: 保存フォルダ入出力(projectfs.js)"
```

---

## Task 3: 動画ファイル収集 `collectVideoFiles`

**Files:**
- Modify: `src/folderimport.js`
- Test: `test/folderimport.test.js`（追記）

**Interfaces:**
- Consumes: なし
- Produces: `collectVideoFiles(dirHandle, nameSet: Set<string>) -> Promise<Map<string, File>>`

- [ ] **Step 1: 失敗するテストを追記する**

`test/folderimport.test.js` の import 行を更新し、末尾にテストを追記:

```js
// 既存の import 行を差し替え
import { videoOverlapsRange, scanFolderVideos, collectVideoFiles } from '../src/folderimport.js';
```

```js
// --- collectVideoFiles: 名前一致の動画 File のみ収集 ---
test('collectVideoFiles は nameSet に含まれる名前の File だけ返す', async () => {
  const dir = fakeDir([
    fileHandle('a.mp4', null),
    fileHandle('b.mov', null),
    fileHandle('c.mp4', null),
    { kind: 'directory', name: 'sub' },
  ]);
  const map = await collectVideoFiles(dir, new Set(['a.mp4', 'c.mp4', 'missing.mp4']));
  assert.deepEqual([...map.keys()].sort(), ['a.mp4', 'c.mp4']);
  assert.equal(map.get('a.mp4').name, 'a.mp4');
});
```

（`fileHandle` / `fakeDir` は同ファイル内の既存ヘルパを流用する）

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/folderimport.test.js`
Expected: FAIL（`collectVideoFiles is not a function`）

- [ ] **Step 3: 最小実装を追加する**

`src/folderimport.js` の末尾に追記:

```js
// dirHandle 直下のファイルのうち、名前が nameSet に含まれるものを収集して
// Map<name, File> で返す。blob URL 生成はしない(呼び出し側で createObjectURL)。
export async function collectVideoFiles(dirHandle, nameSet) {
  const map = new Map();
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && nameSet.has(entry.name)) {
      map.set(entry.name, await entry.getFile());
    }
  }
  return map;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test test/folderimport.test.js`
Expected: PASS（既存 + 追記テスト）

- [ ] **Step 5: コミット**

```bash
git add src/folderimport.js test/folderimport.test.js
git commit -m "feat: 名前一致で動画Fileを収集(collectVideoFiles)"
```

---

## Task 4: フォルダハンドル永続化 `src/dirhandle.js`

ブラウザ API（IndexedDB・権限）依存のため自動テストなし。実装後 `node --test` 全体がグリーンのまま（無関係）であることだけ確認する。

**Files:**
- Create: `src/dirhandle.js`

**Interfaces:**
- Produces:
  - `saveDirHandle(handle) -> Promise<void>`
  - `loadDirHandle() -> Promise<handle|null>`
  - `ensurePermission(handle, mode='readwrite') -> Promise<boolean>`

- [ ] **Step 1: 実装を書く**

`src/dirhandle.js`:

```js
// 保存フォルダの FileSystemDirectoryHandle を IndexedDB に永続化する。
// ハンドルは structured-clone 可能なので IndexedDB に直接保存できる。
const DB_NAME = 'sailviz';
const STORE = 'handles';
const KEY = 'projectDir';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirHandle(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadDirHandle() {
  const db = await openDb();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return handle;
}

// 権限を確認し、未許可なら要求する。granted になれば true。
export async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
```

- [ ] **Step 2: 全テストが引き続きグリーンか確認**

Run: `node --test`
Expected: PASS（既存 + Task 1〜3 の新規テスト。dirhandle.js は import されないので影響なし）

- [ ] **Step 3: コミット**

```bash
git add src/dirhandle.js
git commit -m "feat: 保存フォルダハンドルのIndexedDB永続化(dirhandle.js)"
```

---

## Task 5: UI 結線（index.html + app.js）

DOM/ブラウザ API 依存のため自動テストなし。実装後に手動確認（Step 6）を行う。

**Files:**
- Modify: `index.html`（topbar にボタンと `<select>` を追加）
- Modify: `src/app.js`（import 追加・保存/過去の練習/再リンク結線・起動時復元）

**Interfaces:**
- Consumes:
  - `serializeProject`, `deserializeProject`（Task 1）
  - `projectFileName`, `listProjectFiles`, `readProject`, `writeProject`（Task 2）
  - `collectVideoFiles`（Task 3）
  - `saveDirHandle`, `loadDirHandle`, `ensurePermission`（Task 4）
  - 既存: `state`, `recomputeView`, `renderSidebar`, `draw`, `saveReflections`,
    `loadVideoDuration`, `statusEl`, `playback`, `$`, `firstVisibleTrack`, `globalRange`, `scanFolderVideos`, `placeVideo`
- Produces: なし（アプリ結線）

- [ ] **Step 1: index.html に UI を追加**

`#folder-import` ボタンの直後（同じ `<header id="topbar">` 内）に追加:

```html
      <button id="project-save" class="btn" title="現在の状態を保存フォルダに書き出す">💾 保存</button>
      <label>過去の練習:
        <select id="practice-select">
          <option value="">（練習を選択…）</option>
        </select>
      </label>
```

- [ ] **Step 2: app.js に import を追加**

`src/app.js` 冒頭の import 群に追加:

```js
import { serializeProject, deserializeProject } from './project.js';
import { projectFileName, listProjectFiles, readProject, writeProject } from './projectfs.js';
import { collectVideoFiles } from './folderimport.js';
import { saveDirHandle, loadDirHandle, ensurePermission } from './dirhandle.js';
```

（`collectVideoFiles` は既存の `scanFolderVideos` import と同じ行にまとめてもよい）

- [ ] **Step 3: 保存フォルダの取得・保存・列挙を実装**

`src/app.js` の関数定義が並ぶ領域（例: `importFromVideoFolder` の近く）に追加:

```js
// 保存フォルダハンドル(セッション内キャッシュ)。起動時に IndexedDB から復元。
let projectDir = null;
const PICK_SENTINEL = '__pick__';

// 保存フォルダを確保する。未設定/権限切れなら選択させ、永続化する。
async function ensureProjectDir() {
  if (projectDir && await ensurePermission(projectDir)) return projectDir;
  if (!window.showDirectoryPicker) {
    statusEl.textContent = 'このブラウザは非対応です（Chrome/Edge で開いてください）';
    return null;
  }
  let dir;
  try { dir = await window.showDirectoryPicker(); } catch { return null; } // キャンセル
  projectDir = dir;
  try { await saveDirHandle(dir); } catch { /* 永続化失敗は致命ではない */ }
  return projectDir;
}

// 「過去の練習」プルダウンを再構築する。
async function refreshPracticeList() {
  const sel = $('practice-select');
  const items = projectDir ? await listProjectFiles(projectDir) : [];
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = projectDir ? '（練習を選択…）' : '（保存フォルダ未選択）';
  sel.appendChild(ph);
  const pick = document.createElement('option');
  pick.value = PICK_SENTINEL; pick.textContent = '▶ 保存フォルダを選択…';
  sel.appendChild(pick);
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.name; o.textContent = it.label;
    sel.appendChild(o);
  }
}

// 現在の状態を保存フォルダに書き出す。
async function saveProject() {
  const dir = await ensureProjectDir();
  if (!dir) return;
  const name = projectFileName(new Date());
  try {
    await writeProject(dir, name, serializeProject(state, { savedAt: new Date().toISOString() }));
  } catch (e) {
    statusEl.textContent = `保存に失敗: ${e.message}`; return;
  }
  await refreshPracticeList();
  statusEl.textContent = `保存しました: ${name}`;
}

// 選択した練習ファイルを読み込み、state を置換する。
async function loadPractice(name) {
  if (state.tracks.length && !window.confirm('現在の内容を破棄して読み込みますか？')) {
    $('practice-select').value = ''; return;
  }
  let data;
  try {
    data = deserializeProject(await readProject(projectDir, name));
  } catch (e) {
    statusEl.textContent = `読込に失敗: ${e.message}`;
    $('practice-select').value = ''; return;
  }
  state.mode = data.mode;
  state.accuracyFilter = data.accuracyFilter;
  state.tracks = data.tracks;
  state.events = data.events;
  state.marks = data.marks;
  state.pins = data.pins;
  state.videos = data.videos; // url なし=未リンク
  state.reflections = data.reflections;
  saveReflections(state.reflections); // localStorage にも反映
  $('align-mode').value = state.mode;
  $('accuracy-filter').checked = state.accuracyFilter;
  recomputeView(); // tracks から transform と既定 crop を再計算
  // 保存されたクロップ範囲が妥当なら復元(recomputeView の全域クロップを上書き)
  if (data.crop && data.crop.end > data.crop.start) {
    state.crop = { start: data.crop.start, end: data.crop.end };
    playback.setRange(state.crop);
  }
  renderSidebar();
  draw();
  const n = state.videos.length;
  statusEl.textContent = n
    ? `読込: ${name}。動画${n}本は未リンク（📁 動画フォルダ取込で再リンク）`
    : `読込: ${name}`;
}
```

- [ ] **Step 4: プルダウンと保存ボタンのイベントを結線**

既存のイベント登録が並ぶ箇所（例: `$('folder-import').addEventListener(...)` の近く）に追加:

```js
$('project-save').addEventListener('click', saveProject);
$('practice-select').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (v === PICK_SENTINEL) {
    e.target.value = '';
    if (await ensureProjectDir()) await refreshPracticeList();
  } else if (v) {
    await loadPractice(v);
  }
});

// 起動時: 保存フォルダを IndexedDB から復元し、権限があれば一覧化。
(async () => {
  try {
    const h = await loadDirHandle();
    if (h && await ensurePermission(h)) { projectDir = h; }
  } catch { /* 復元失敗は無視 */ }
  await refreshPracticeList();
})();
```

- [ ] **Step 5: 動画フォルダ取込に「再リンク」を統合**

`importFromVideoFolder` 内、`showDirectoryPicker` で `dir` を得た後・`scanFolderVideos` の前に、未リンク動画の再リンクを追加する。既存の取込ロジックはそのまま残し、重複追加だけ防ぐ。

`res.matched` を配置しているループを、名前重複を除外する形へ変更:

```js
  // 読込済みで未リンクの動画を、フォルダ内の同名ファイルで再リンク
  const unlinked = new Set(state.videos.filter((v) => !v.url).map((v) => v.name));
  let relinked = 0;
  if (unlinked.size) {
    const files = await collectVideoFiles(dir, unlinked);
    for (const v of state.videos) {
      if (!v.url && files.has(v.name)) {
        v.url = URL.createObjectURL(files.get(v.name));
        if (v.durationMs == null) loadVideoDuration(v);
        relinked++;
      }
    }
  }
  const present = new Set(state.videos.map((v) => v.name));
  for (const m of res.matched) {
    if (!present.has(m.file.name)) placeVideo(m.file, m.t, m.durationMs, null);
  }
```

（元の `for (const m of res.matched) placeVideo(...)` をこの重複チェック版に置き換える。`relinked` の本数は既存 success メッセージに `（再リンク${relinked}本）` を追記する）

- [ ] **Step 6: 手動確認**

```bash
python3 serve.py 8000
```

Chrome で `http://localhost:8000/` を開き、以下を確認:

1. `sample-data/` の CSV をドラッグ&ドロップ → 軌跡表示。マーク・タグ・ピンをいくつか追加。
2. 「💾 保存」→ 保存フォルダを選択 → status に `保存しました: sailviz-...json`。
3. 「過去の練習」プルダウンに保存した練習が表示される。
4. ブラウザをリロード → プルダウンにフォルダの練習が復元される（権限確認に許可）。
5. 練習を選択 → 軌跡・**マーク位置**・タグ・ピン・クロップ・整列モード・反省が復元される。
6. （動画がある練習で）「📁 動画フォルダ取込」→ 動画フォルダ選択 → 未リンク動画が再生可能になる。

- [ ] **Step 7: コミット**

```bash
git add index.html src/app.js
git commit -m "feat: 保存/過去の練習プルダウン/動画再リンクをUIに結線"
```

---

## Self-Review メモ

- **Spec coverage:** 保存形式(Task1) / フォルダ入出力・列挙(Task2) / 動画収集(Task3) / ハンドル永続化(Task4) / UI・保存・過去の練習・再リンク・起動時復元(Task5) を網羅。エラー処理は Task5 の各 catch と非対応ブラウザ案内でカバー。
- **マーク位置の引き継ぎ:** マークは `lat/lon` で保存(Task1)、読込後 `recomputeView()` で変換再計算(Task5 Step3) → 地図上の同位置に復元。手動確認 Step6-5 で明示検証。
- **型整合:** `serializeProject/deserializeProject`、`projectFileName/listProjectFiles/readProject/writeProject`、`collectVideoFiles`、`saveDirHandle/loadDirHandle/ensurePermission` は各タスクの Produces と app.js の Consumes で一致。
