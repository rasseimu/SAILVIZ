# 同じ風のプロ動画との並列比較 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現在の練習動画を、同期フォルダ `プロ動画/` 内の同じ風条件のプロ動画と、GPS・練習動画・プロ動画の左右3分割で並べて見比べられるようにする。

**Architecture:** プロ動画のファイル名(`…_風速3.2ms_風向NE47度_…`)から風を度ベースで抽出する純粋モジュール `windspec.js` と、フォルダを走査する `proscan.js` を新設。比較元の風は現在の練習動画の時刻で既存 `fetchWind`(AMeDAS→CSVフォールバック)から取得し、度に変換して近い順にランキング。UI は `app.js`/`index.html`/`styles.css` に比較ボタン・候補リスト・プロ動画パネル(独立 native controls)を足す。

**Tech Stack:** バニラ JS ES modules、`node --test`(`node:test` + `node:assert/strict`)、File System Access API、IndexedDB(`dirhandle.js`)。フレームワーク・ビルド無し。

**Spec:** `docs/superpowers/specs/2026-08-17-pro-video-wind-compare-design.md`

## Global Constraints

- ES modules(`"type": "module"`)。`src/` からの相対 import、`.js` 拡張子必須。
- テストは `node --test` で走る。テストファイルは `test/<name>.test.js`、`import ... from '../src/<name>.js'`。
- 純粋モジュール(`windspec.js`/`proscan.js`)は DOM・ブラウザ API に依存しない。
- 動画拡張子は既存踏襲: `/\.(mp4|mov|m4v|webm)$/i`。
- 方位度は 0=北、時計回り。AMeDAS `dirIdx`(1..16, 16=北)は `(dirIdx % 16) * 22.5` で度に変換。
- コミットメッセージは既存に倣い日本語 `feat:` / `test:` プレフィクス。

---

### Task 1: windspec.js — ファイル名から風を抽出(parseWindSpec)

**Files:**
- Create: `src/windspec.js`
- Test: `test/windspec.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `COMPASS_DEG: Record<string, number>`(英字16方位→度)
  - `dirIdxToDeg(dirIdx: number) => number`
  - `parseWindSpec(name: string) => { deg: number, speed: number, dateStr: string|null } | null`

- [ ] **Step 1: 失敗するテストを書く**

`test/windspec.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindSpec, dirIdxToDeg, COMPASS_DEG } from '../src/windspec.js';

test('実フォーマットから風速と風向(度)を抽出', () => {
  const name = '2026-08-16_風速3.2ms_風向NE47度_Day 5 2026 470 World Championship, Enoshima JPN.mp4';
  assert.deepEqual(parseWindSpec(name), { deg: 47, speed: 3.2, dateStr: '2026-08-16' });
});

test('度が無く英字方位のみ → COMPASS_DEG で度に変換', () => {
  assert.deepEqual(parseWindSpec('風速5ms_風向NE.mp4'), { deg: 45, speed: 5, dateStr: null });
});

test('度と英字が両方 → 度を優先', () => {
  assert.equal(parseWindSpec('風速4ms_風向S200度.mp4').deg, 200);
});

test('風速が無ければ null', () => {
  assert.equal(parseWindSpec('風向NE47度.mp4'), null);
});

test('風向が無ければ null', () => {
  assert.equal(parseWindSpec('風速3.2ms のみ.mp4'), null);
});

test('dirIdxToDeg: 北東(idx2)=45°, 北(idx16)=0°', () => {
  assert.equal(dirIdxToDeg(2), 45);
  assert.equal(dirIdxToDeg(16), 0);
});

test('COMPASS_DEG は16方位を持つ', () => {
  assert.equal(COMPASS_DEG.N, 0);
  assert.equal(COMPASS_DEG.SW, 225);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/windspec.test.js`
Expected: FAIL(`Cannot find module '../src/windspec.js'`)

- [ ] **Step 3: 最小実装を書く**

`src/windspec.js`:

```js
// プロ動画ファイル名から風(風速 m/s・風向 度)を抽出し、比較元の風との近さで並べる。
// 命名例: 2026-08-16_風速3.2ms_風向NE47度_Day 5 ... .mp4
//   風速<数値>ms / 風向<英字方位?><数値>度。度が無い時は英字方位を度に変換。

// 英字16方位 → 度(0=北, 時計回り)。度が読めない時のフォールバック。
export const COMPASS_DEG = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

// AMeDAS の windDirection インデックス(1..16, 16=北=0°, 22.5°刻み)を度(0..360)に。
export function dirIdxToDeg(dirIdx) {
  return (dirIdx % 16) * 22.5;
}

// ファイル名から { deg, speed, dateStr } を抽出。風速・風向どちらか欠ければ null。
export function parseWindSpec(name) {
  const s = String(name);
  const speedM = s.match(/風速\s*([\d.]+)\s*m/);
  const speed = speedM ? Number(speedM[1]) : null;

  let deg = null;
  const dirM = s.match(/風向\s*([A-Z]{1,3})?\s*([\d.]+)\s*度/);
  if (dirM) {
    deg = Number(dirM[2]); // 度を優先
  } else {
    const alt = s.match(/風向\s*([A-Z]{1,3})/); // 度が無く英字方位のみ
    if (alt && alt[1] in COMPASS_DEG) deg = COMPASS_DEG[alt[1]];
  }

  if (speed == null || !Number.isFinite(speed) || deg == null || !Number.isFinite(deg)) {
    return null;
  }
  const dateM = s.match(/(\d{4}-\d{2}-\d{2})/);
  return { deg: ((deg % 360) + 360) % 360, speed, dateStr: dateM ? dateM[1] : null };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/windspec.test.js`
Expected: PASS(7 tests)

- [ ] **Step 5: コミット**

```bash
git add src/windspec.js test/windspec.test.js
git commit -m "feat: プロ動画ファイル名から風を抽出(parseWindSpec)"
```

---

### Task 2: windspec.js — 近さのスコアとランキング

**Files:**
- Modify: `src/windspec.js`
- Test: `test/windspec.test.js`(追記)

**Interfaces:**
- Consumes: Task 1 の `src/windspec.js`
- Produces:
  - `angleDiff(a: number, b: number) => number`(円周角度差 0..180)
  - `windScore(target: {deg,speed}, cand: {deg,speed}, opts?) => number`
  - `rankProVideos(list: Array<{wind: {deg,speed}|null}>, target: {deg,speed}, opts?) => Array<item & {score:number}>`
  - opts 既定: `{ maxDegDiff: 45, maxSpeedDiff: 2 }`

- [ ] **Step 1: 失敗するテストを書く**

`test/windspec.test.js` に追記:

```js
import { angleDiff, windScore, rankProVideos } from '../src/windspec.js';

test('angleDiff: 350°と10°の差は20°', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(0, 180), 180);
});

test('windScore: 完全一致は0、方位45°差=1、風速2差=1', () => {
  const t = { deg: 100, speed: 5 };
  assert.equal(windScore(t, { deg: 100, speed: 5 }), 0);
  assert.equal(windScore(t, { deg: 145, speed: 5 }), 1);
  assert.equal(windScore(t, { deg: 100, speed: 7 }), 1);
});

test('rankProVideos: 閾値内を近い順に並べ、閾値外と wind=null を除外', () => {
  const target = { deg: 50, speed: 4 };
  const list = [
    { name: 'far-dir', wind: { deg: 120, speed: 4 } },   // 方位70°差 → 除外
    { name: 'close',   wind: { deg: 55, speed: 4 } },    // 近い
    { name: 'mid',     wind: { deg: 50, speed: 5.5 } },  // 風速1.5差
    { name: 'far-spd', wind: { deg: 50, speed: 7 } },    // 風速3差 → 除外
    { name: 'untagged', wind: null },                    // 除外
  ];
  const ranked = rankProVideos(list, target);
  assert.deepEqual(ranked.map((r) => r.name), ['close', 'mid']);
  assert.ok(ranked[0].score < ranked[1].score);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/windspec.test.js`
Expected: FAIL(`angleDiff` などが未定義)

- [ ] **Step 3: 最小実装を書く**

`src/windspec.js` に追記:

```js
// 円周上の角度差(0..180)。350°と10°は20°。
export function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

// 比較元 target={deg,speed} と候補 cand={deg,speed} の近さ。小さいほど近い。
export function windScore(target, cand, { maxDegDiff = 45, maxSpeedDiff = 2 } = {}) {
  const dd = angleDiff(target.deg, cand.deg) / maxDegDiff;
  const sd = Math.abs(target.speed - cand.speed) / maxSpeedDiff;
  return dd + sd;
}

// list=[{...,wind:{deg,speed}|null}] を target に近い順に。閾値外/wind=null は除外。
export function rankProVideos(list, target, opts = {}) {
  const { maxDegDiff = 45, maxSpeedDiff = 2 } = opts;
  return list
    .filter((it) => it.wind
      && angleDiff(target.deg, it.wind.deg) <= maxDegDiff
      && Math.abs(target.speed - it.wind.speed) <= maxSpeedDiff)
    .map((it) => ({ ...it, score: windScore(target, it.wind, { maxDegDiff, maxSpeedDiff }) }))
    .sort((a, b) => a.score - b.score);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/windspec.test.js`
Expected: PASS(全 10 tests)

- [ ] **Step 5: コミット**

```bash
git add src/windspec.js test/windspec.test.js
git commit -m "feat: 風の近さスコアとプロ動画ランキング(windScore/rankProVideos)"
```

---

### Task 3: proscan.js — プロ動画フォルダの走査

**Files:**
- Create: `src/proscan.js`
- Test: `test/proscan.test.js`

**Interfaces:**
- Consumes: Task 1 の `parseWindSpec`
- Produces:
  - `scanProVideos(dirHandle, parse = parseWindSpec, prefix = '') => Promise<Array<{ file, name, path, wind }>>`
  - `wind` は `parseWindSpec(name)` の結果(読めなければ `null`)。除外は呼び出し側。

- [ ] **Step 1: 失敗するテストを書く**

`test/proscan.test.js`(`folderimport.test.js` の fake handle 流儀を踏襲):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProVideos } from '../src/proscan.js';

function fileHandle(name) {
  return { kind: 'file', name, getFile: async () => ({ name }) };
}
function fakeDir(entries) {
  return { kind: 'directory', values: async function* () { for (const e of entries) yield e; } };
}

test('動画のみ収集し、ファイル名から wind を付ける(非動画は無視)', async () => {
  const dir = fakeDir([
    fileHandle('風速3ms_風向NE45度_a.mp4'),
    fileHandle('メモ.txt'),          // 非動画 → 無視
    fileHandle('タグ無し.mov'),       // 動画だが風読めず → wind=null で含める
  ]);
  const res = await scanProVideos(dir);
  assert.deepEqual(res.map((r) => r.name), ['風速3ms_風向NE45度_a.mp4', 'タグ無し.mov']);
  assert.deepEqual(res[0].wind, { deg: 45, speed: 3, dateStr: null });
  assert.equal(res[1].wind, null);
});

test('サブフォルダも再帰し、path に相対パスを入れる', async () => {
  const sub = fakeDir([fileHandle('風速4ms_風向S180度_b.mp4')]);
  sub.name = 'day1';
  const dir = fakeDir([fileHandle('風速2ms_風向N0度_top.mp4'), sub]);
  const res = await scanProVideos(dir);
  assert.deepEqual(res.map((r) => r.path).sort(), ['day1/風速4ms_風向S180度_b.mp4', '風速2ms_風向N0度_top.mp4']);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/proscan.test.js`
Expected: FAIL(`Cannot find module '../src/proscan.js'`)

- [ ] **Step 3: 最小実装を書く**

`src/proscan.js`:

```js
import { parseWindSpec } from './windspec.js';

const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;

// dirHandle 直下+サブフォルダを再帰走査し、動画ごとに wind=parse(name) を付けて返す。
// 返り値: [{ file, name, path, wind }]（wind=null も含む。除外は呼び出し側）。
// parse は差し替え可(テスト用)。
export async function scanProVideos(dirHandle, parse = parseWindSpec, prefix = '') {
  const out = [];
  for await (const entry of dirHandle.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      out.push(...await scanProVideos(entry, parse, path));
    } else if (entry.kind === 'file' && VIDEO_RE.test(entry.name)) {
      out.push({ file: await entry.getFile(), name: entry.name, path, wind: parse(entry.name) });
    }
  }
  return out;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/proscan.test.js`
Expected: PASS(2 tests)

- [ ] **Step 5: コミット**

```bash
git add src/proscan.js test/proscan.test.js
git commit -m "feat: プロ動画フォルダを再帰走査し風を付与(scanProVideos)"
```

---

### Task 4: dirhandle.js — key 引数でプロフォルダも永続化

**Files:**
- Modify: `src/dirhandle.js:16-37`

**Interfaces:**
- Consumes: なし
- Produces:
  - `saveDirHandle(handle, key = 'projectDir') => Promise<void>`
  - `loadDirHandle(key = 'projectDir') => Promise<handle|null>`
  - 既存呼び出し(引数なし)は 'projectDir' のまま(後方互換)。

Node には IndexedDB が無く単体テスト不可(既存 `dirhandle.js` もテスト無し)。後方互換=既存呼び出しを壊さないことで担保する。

- [ ] **Step 1: `saveDirHandle` に key 引数を追加**

`src/dirhandle.js`、現状:

```js
export async function saveDirHandle(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, KEY);
```

を次に変更:

```js
export async function saveDirHandle(handle, key = KEY) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
```

- [ ] **Step 2: `loadDirHandle` に key 引数を追加**

現状:

```js
export async function loadDirHandle() {
  const db = await openDb();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
```

を次に変更:

```js
export async function loadDirHandle(key = KEY) {
  const db = await openDb();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
```

(`const KEY = 'projectDir';` はそのまま既定値として残す。)

- [ ] **Step 3: 既存テスト・スモークが壊れないことを確認**

Run: `node --test`
Expected: PASS(全既存テスト。dirhandle 呼び出しは引数なしで 'projectDir' 継続)

- [ ] **Step 4: コミット**

```bash
git add src/dirhandle.js
git commit -m "feat: dirhandle に key 引数を追加(プロフォルダ永続化の下準備)"
```

---

### Task 5: 比較フローと3分割UIの結線(app.js / index.html / styles.css)

**Files:**
- Modify: `index.html`(`#video-bar` にボタン追加 / `#video-panel` の後に `#pro-panel` 追加)
- Modify: `styles.css`(`#pro-panel`・`body.comparing` の3分割)
- Modify: `src/app.js`(import 追加 / `proDir` 復元 / `openCompare` / 候補描画 / プロ動画開閉)

**Interfaces:**
- Consumes:
  - `parseWindSpec`, `dirIdxToDeg`, `rankProVideos`(`./windspec.js`)
  - `scanProVideos`(`./proscan.js`)
  - `saveDirHandle`, `loadDirHandle`, `ensurePermission`(`./dirhandle.js`、key 対応済み)
  - 既存: `fetchWind`(`./wind.js`)、`fetchWindFromCsv`(`./windCsv.js`)、`currentVideo`、`statusEl`、`$`、`resizeCanvas`、`refitTransform`、`draw`、`closeVideoPanel`
- Produces: UI 機能(単体テスト対象外、手動確認)

DOM/フォルダ選択/fetch 結線のため単体テスト対象外。仕様どおり手動確認する。

- [ ] **Step 1: index.html に比較ボタンとプロパネルを追加**

`#video-bar` の `<span id="video-name"></span>` の直後に:

```html
      <button id="video-compare" title="同じ風のプロ動画と比較">🆚</button>
```

`<aside id="video-panel" ...> … </aside>`(`</main>` の手前)の直後に:

```html
    <aside id="pro-panel" class="hidden">
      <div id="pro-bar">
        <span id="pro-name"></span>
        <button id="pro-close" title="閉じる">×</button>
      </div>
      <ul id="pro-candidates" class="hidden"></ul>
      <video id="pro-video-el" class="hidden" controls></video>
    </aside>
```

- [ ] **Step 2: styles.css に3分割とプロパネルの見た目を追加**

`#video-panel` のブロック群の後に追記:

```css
/* 比較中は練習動画パネルを狭め、3分割(canvas | 練習 | プロ)にする */
body.comparing #video-panel { flex: 0 0 33%; }
#pro-panel { flex: 0 0 33%; min-width: 0; display: flex; flex-direction: column; background: #1b2735; }
#pro-panel.hidden { display: none; }
#pro-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #22303c; color: #dfeaf2; }
#pro-bar #pro-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#pro-bar button { width: 26px; height: 26px; border: none; border-radius: 4px; background: #2c3e50; color: #fff; cursor: pointer; }
#pro-bar button:hover { background: #33475a; }
#pro-video-el { flex: 1; min-height: 0; width: 100%; background: #000; object-fit: contain; }
#pro-video-el.hidden { display: none; }
#pro-candidates { list-style: none; margin: 0; padding: 8px; overflow: auto; color: #dfeaf2; }
#pro-candidates.hidden { display: none; }
#pro-candidates li { padding: 8px; border-bottom: 1px solid #33475a; cursor: pointer; font-size: 13px; }
#pro-candidates li:hover { background: #33475a; }
```

- [ ] **Step 3: app.js に import を追加**

`src/app.js` の既存 import 群(`./dirhandle.js` 等の近く)に追記:

```js
import { dirIdxToDeg, rankProVideos } from './windspec.js';
import { scanProVideos } from './proscan.js';
```

(`fetchWind`・`fetchWindFromCsv`・`saveDirHandle`・`loadDirHandle`・`ensurePermission` は既に import 済み。)

- [ ] **Step 4: プロフォルダのセッション変数・確保・起動時復元を追加**

`ensureProjectDir()` の定義(`src/app.js:167-179` 付近)の直後に追記:

```js
// プロ動画フォルダ(セッションキャッシュ)。起動時に IndexedDB から復元。
let proDir = null;
async function ensureProDir() {
  if (proDir && await ensurePermission(proDir)) return proDir;
  if (!window.showDirectoryPicker) {
    statusEl.textContent = 'このブラウザは非対応です（Chrome/Edge で開いてください）';
    return null;
  }
  let dir;
  try { dir = await window.showDirectoryPicker(); } catch { return null; } // キャンセル
  proDir = dir;
  try { await saveDirHandle(dir, 'proDir'); } catch { /* 永続化失敗は致命ではない */ }
  return proDir;
}
```

起動時に `projectDir` を復元している箇所(`src/app.js:435-436` 付近の `const h = await loadDirHandle();` ブロック)の直後に追記:

```js
    const ph = await loadDirHandle('proDir');
    if (ph) proDir = ph; // 権限は比較実行時に確認する
```

- [ ] **Step 5: 比較フロー本体(openCompare / 候補描画 / 開閉)を追加**

`closeVideoPanel()` の定義(`src/app.js:567-575` 付近)の直後に追記:

```js
// ===== 同じ風のプロ動画と比較 =====
let proObjectUrl = null; // プロ動画の blob URL(差し替え/閉じるで revoke)

async function openCompare() {
  if (!currentVideo) { statusEl.textContent = '先に練習動画を開いてください'; return; }
  const dir = await ensureProDir();
  if (!dir) return;
  statusEl.textContent = 'プロ動画を走査中…';
  const list = await scanProVideos(dir);
  const withWind = list.filter((x) => x.wind);
  const excluded = list.length - withWind.length;
  // 比較元の風 = 現在の練習動画の時刻(録画中央)。AMeDAS→CSV フォールバック。
  const tMid = currentVideo.t + (currentVideo.durationMs ?? 0) / 2;
  const w = (await fetchWind(tMid)) || (await fetchWindFromCsv(tMid));
  if (!w || w.dirIdx == null) { statusEl.textContent = '風を取得できませんでした'; return; }
  const target = { deg: dirIdxToDeg(w.dirIdx), speed: w.speed };
  renderCandidates(rankProVideos(withWind, target), target, excluded);
}

function renderCandidates(ranked, target, excluded) {
  const ul = $('pro-candidates');
  document.body.classList.add('comparing');
  $('pro-panel').classList.remove('hidden');
  $('pro-video-el').classList.add('hidden');
  ul.classList.remove('hidden');
  $('pro-name').textContent = `候補（比較元 ${Math.round(target.deg)}° / ${target.speed}m）`;
  ul.innerHTML = '';
  if (!ranked.length) {
    const li = document.createElement('li');
    li.textContent = '同じ風のプロ動画が見つかりません';
    ul.appendChild(li);
  } else {
    ranked.forEach((it) => {
      const li = document.createElement('li');
      li.textContent = `${Math.round(it.wind.deg)}° / ${it.wind.speed}m — ${it.name}`;
      li.addEventListener('click', () => openProVideo(it));
      ul.appendChild(li);
    });
  }
  statusEl.textContent = excluded ? `風不明で ${excluded} 件を候補から除外` : '';
  resizeCanvas(); refitTransform(); draw();
}

function openProVideo(item) {
  if (proObjectUrl) { URL.revokeObjectURL(proObjectUrl); proObjectUrl = null; }
  proObjectUrl = URL.createObjectURL(item.file);
  const v = $('pro-video-el');
  v.src = proObjectUrl;
  $('pro-name').textContent = item.name;
  $('pro-candidates').classList.add('hidden');
  v.classList.remove('hidden');
  v.play().catch(() => { /* autoplay ブロックは手動再生に委ねる */ });
}

function closeProPanel() {
  const panel = $('pro-panel');
  if (panel.classList.contains('hidden')) return;
  const v = $('pro-video-el');
  v.pause(); v.removeAttribute('src'); v.load();
  if (proObjectUrl) { URL.revokeObjectURL(proObjectUrl); proObjectUrl = null; }
  panel.classList.add('hidden');
  document.body.classList.remove('comparing');
  resizeCanvas(); refitTransform(); draw();
}
```

- [ ] **Step 6: イベント結線と練習動画を閉じたときの連動を追加**

`$('video-close').addEventListener('click', closeVideoPanel);`(`src/app.js:600` 付近)の直後に追記:

```js
$('video-compare').addEventListener('click', openCompare);
$('pro-close').addEventListener('click', closeProPanel);
```

`closeVideoPanel()` の本体先頭(`const panel = $('video-panel');` の直前)に、練習動画を閉じたら比較も終了する連動を追記:

```js
  closeProPanel();
```

- [ ] **Step 7: 全テストが緑であることを確認**

Run: `node --test`
Expected: PASS(既存 + Task1-3 の新規テスト。app.js は構文エラーが無いことを `dom-smoke.test.js`/`smoke.test.js` で担保)

- [ ] **Step 8: 手動確認(Chrome/Edge)**

Run: `npm run serve` → ブラウザで `http://localhost:8000`

確認項目:
1. CSV と練習動画を読み込み、動画リストから動画を開く(練習動画パネル表示)。
2. `🆚` を押す → 初回は `プロ動画/` フォルダ選択ダイアログ。
3. 候補リストが「度/風速 — ファイル名」で近い順に出る。風不明の除外数がステータスに出る。
4. 候補をクリック → 右に3分割(GPS | 練習 | プロ)。プロ動画が独立 controls で再生でき、練習動画側の操作と干渉しない(個別操作)。
5. プロパネルの `×` でプロだけ閉じ、2分割に戻る。練習動画パネルの `×` で比較も一緒に閉じる。
6. 再度 `🆚` を押すと、フォルダ選択なしで(権限が生きていれば)候補が出る。

- [ ] **Step 9: コミット**

```bash
git add index.html styles.css src/app.js
git commit -m "feat: 同じ風のプロ動画と3分割で並列比較するUIを結線"
```

---

## Self-Review

**Spec coverage:**
- 命名規約(度ベース・英字フォールバック・除外) → Task 1 ✓
- 度変換(dirIdx→deg) → Task 1 ✓ / Task 5 で利用 ✓
- スコア・ランキング・閾値 → Task 2 ✓
- フォルダ走査(再帰・wind 付与) → Task 3 ✓
- proDir 永続化(key 引数) → Task 4 + Task 5 Step 4 ✓
- 比較元の風(fetchWind→CSV、dirIdx null 時中断) → Task 5 Step 5 ✓
- UI フロー(ボタン→候補→選択) → Task 5 Step 1,5,6 ✓
- 3分割レイアウト → Task 5 Step 2 ✓
- 個別操作の2動画 → Task 5(pro は独立 `<video controls>`、GPS 同期は練習のみ)✓
- 開閉・blob URL revoke・state 非汚染 → Task 5 Step 5,6(`proObjectUrl` revoke、`state` 不変)✓
- エッジ(権限失効=ensureProDir 再選択 / 風無し除外 / 風取得不可 / 候補0件) → Task 4,5 ✓
- 保存形式不変 → 変更タスク無し(project.js に触れない)✓

**Placeholder scan:** プレースホルダなし。全コード実体あり。

**Type consistency:** `parseWindSpec → {deg,speed,dateStr}`、`rankProVideos` は `it.wind.{deg,speed}` を参照、`target={deg,speed}`、`scanProVideos → {file,name,path,wind}` で一貫。`dirIdxToDeg`・`fetchWind().dirIdx`・`w.speed` の流れも一致。
