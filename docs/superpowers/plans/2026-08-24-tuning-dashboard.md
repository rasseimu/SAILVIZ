# 全艇チューニングダッシュボード Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保存フォルダの全練習ファイルから艇セッティングを集計し、470船図を囲むように各パラメータの推移グラフを配置した「全艇チューニングダッシュボード」を追加する。

**Architecture:** 純ロジックを3モジュール(`tuning` 集計 / `linechart` SVG折れ線 / `boatlayout` アンカー表)＋期間ブラシの純ヘルパ(`timebrush`)に分離しTDD。`dashboard.js` がそれらを束ねてDOM描画・ファイル読込・ブラシ配線を担い、`app.js` は最小の画面切替配線のみ追加する。

**Tech Stack:** 素ESM(no-build)、`node --test`(node:test / node:assert/strict)、ブラウザ標準API(SVG/DOM/File System Access)。外部ライブラリなし。

**Spec:** `docs/superpowers/specs/2026-08-24-tuning-dashboard-design.md`

## Global Constraints

- 素ESM・ビルド無し。外部ライブラリ/CDN依存を追加しない。
- 純ロジック(集計・座標変換・アンカー表・ブラシ算術)は DOM/ブラウザAPI非依存でユニットテスト必須。
- 対象6艇: `4899, 4859, 4807, 4677, 4519, 4304`。これ以外の `boatNo` は集計から除外。
- rigのキー順は `src/reflections.js` の `RIG_FIELDS`(先頭 `boatNo` はグラフ対象外)。
- x軸時刻フォールバック: `reflection.practice?.startMs` → 練習ファイルの最古実データ時刻 → `reflection.createdAt`。
- テスト実行: `node --test test/<file>.test.js`。コミットは各タスク末尾で行う。
- 中央画像は `sample-data/470.jpg`(416×554)。

---

### Task 1: 集計モジュール `tuning.js`

**Files:**
- Create: `src/tuning.js`
- Test: `test/tuning.test.js`

**Interfaces:**
- Consumes: `RIG_FIELDS` from `src/reflections.js`.
- Produces:
  - `FOCUS_BOATS: number[]` = `[4899,4859,4807,4677,4519,4304]`
  - `BOAT_COLORS: Record<number,string>`
  - `TUNING_PARAMS: string[]` (= `RIG_FIELDS` minus `boatNo`)
  - `reflectionTimeMs(reflection, project) -> number|null`
  - `collectTuning(entries) -> { boats: number[], series: Record<param, Record<boatNo, {tMs:number,value:number}[]>>, domain: {min:number,max:number}|null }` where `entries: {name?:string, project:object}[]`.

- [ ] **Step 1: 失敗するテストを書く**

```js
// test/tuning.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTuning, reflectionTimeMs, FOCUS_BOATS, TUNING_PARAMS } from '../src/tuning.js';

test('TUNING_PARAMS は RIG_FIELDS から boatNo を除いた11項目', () => {
  assert.ok(!TUNING_PARAMS.includes('boatNo'));
  assert.equal(TUNING_PARAMS.length, 11);
  assert.ok(TUNING_PARAMS.includes('rake'));
});

test('reflectionTimeMs: practice.startMs を最優先', () => {
  const r = { practice: { startMs: 1000 }, createdAt: 9999 };
  assert.equal(reflectionTimeMs(r, {}), 1000);
});

test('reflectionTimeMs: practice が無ければ project 最古実データ→createdAt', () => {
  const proj = { tracks: [{ tRange: { start: 500 } }], videos: [{ t: 800 }] };
  assert.equal(reflectionTimeMs({ createdAt: 9999 }, proj), 500);
  assert.equal(reflectionTimeMs({ createdAt: 9999 }, {}), 9999);
});

test('collectTuning: 艇別・パラメータ別に時系列化し6艇のみ・昇順・null除外', () => {
  const entries = [
    { project: { reflections: [
      { practice: { startMs: 200 }, rig: { boatNo: 4899, rake: 10, gear: null } },
      { practice: { startMs: 100 }, rig: { boatNo: 4899, rake: 8 } },
      { practice: { startMs: 150 }, rig: { boatNo: 9999, rake: 5 } }, // 対象外
    ] } },
    { project: { reflections: [
      { practice: { startMs: 300 }, rig: { boatNo: 4304, rake: 12 } },
    ] } },
  ];
  const out = collectTuning(entries);
  assert.deepEqual(out.boats, [4899, 4304]); // 出現順(FOCUS_BOATS内)
  assert.deepEqual(out.series.rake[4899], [{ tMs: 100, value: 8 }, { tMs: 200, value: 10 }]);
  assert.deepEqual(out.series.rake[4304], [{ tMs: 300, value: 12 }]);
  assert.equal(out.series.gear[4899], undefined); // null しか無い欄は空
  assert.deepEqual(out.domain, { min: 100, max: 300 });
});

test('collectTuning: 空入力は domain=null', () => {
  const out = collectTuning([]);
  assert.equal(out.domain, null);
  assert.deepEqual(out.boats, []);
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `node --test test/tuning.test.js`
Expected: FAIL(モジュール未作成)。

- [ ] **Step 3: 最小実装**

```js
// src/tuning.js
// 全練習の反省 rig を「艇番号×パラメータ」の時系列に集計する純モジュール。
import { RIG_FIELDS } from './reflections.js';

export const FOCUS_BOATS = [4899, 4859, 4807, 4677, 4519, 4304];
export const BOAT_COLORS = {
  4899: '#e6194b', 4859: '#3cb44b', 4807: '#4363d8',
  4677: '#f58231', 4519: '#911eb4', 4304: '#f032e6',
};
export const TUNING_PARAMS = RIG_FIELDS.filter((f) => f !== 'boatNo');

// project の最古実データ時刻(トラックGPS開始/動画配置時刻の最小)。無ければ null。
function earliestContentMs(project) {
  let min = null;
  const consider = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && (min == null || v < min)) min = v;
  };
  if (Array.isArray(project?.tracks)) for (const t of project.tracks) consider(t?.tRange?.start);
  if (Array.isArray(project?.videos)) for (const v of project.videos) consider(v?.t);
  return min;
}

// 反省1件のx軸時刻: practice.startMs → 練習最古実データ → createdAt。
export function reflectionTimeMs(reflection, project) {
  const p = reflection?.practice?.startMs;
  if (typeof p === 'number' && Number.isFinite(p)) return p;
  const e = earliestContentMs(project);
  if (e != null) return e;
  const c = reflection?.createdAt;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

export function collectTuning(entries) {
  const series = {};
  for (const param of TUNING_PARAMS) series[param] = {};
  const boatsSeen = [];
  let min = null; let max = null;

  for (const { project } of entries || []) {
    const reflections = Array.isArray(project?.reflections) ? project.reflections : [];
    for (const r of reflections) {
      const boat = Number(r?.rig?.boatNo);
      if (!FOCUS_BOATS.includes(boat)) continue;
      const tMs = reflectionTimeMs(r, project);
      if (tMs == null) continue;
      if (!boatsSeen.includes(boat)) boatsSeen.push(boat);
      for (const param of TUNING_PARAMS) {
        const value = r.rig?.[param];
        if (value == null || !Number.isFinite(Number(value))) continue;
        (series[param][boat] ||= []).push({ tMs, value: Number(value) });
        if (min == null || tMs < min) min = tMs;
        if (max == null || tMs > max) max = tMs;
      }
    }
  }

  for (const param of TUNING_PARAMS) {
    for (const boat of Object.keys(series[param])) {
      series[param][boat].sort((a, b) => a.tMs - b.tMs);
    }
  }
  const boats = FOCUS_BOATS.filter((b) => boatsSeen.includes(b));
  return { boats, series, domain: min == null ? null : { min, max } };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/tuning.test.js`
Expected: PASS(全5テスト)。

- [ ] **Step 5: コミット**

```bash
git add src/tuning.js test/tuning.test.js
git commit -m "feat: 全艇チューニング集計モジュール tuning.js (#22)"
```

---

### Task 2: SVG折れ線モジュール `linechart.js`

**Files:**
- Create: `src/linechart.js`
- Test: `test/linechart.test.js`

**Interfaces:**
- Consumes: なし(純)。
- Produces:
  - `projectPoints(points, {from,to,minY,maxY,width,height,pad}) -> {x:number,y:number}[]` — `[from,to]` 外を除外し、値→画面座標(yは上下反転)に変換。
  - `buildLineChart({series, boats, colors, from, to, width, height, pad}) -> string` — 艇ごとに `<polyline>`、y範囲は全系列の値から自動。空/単一点でも破綻しないSVG文字列を返す。

- [ ] **Step 1: 失敗するテストを書く**

```js
// test/linechart.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPoints, buildLineChart } from '../src/linechart.js';

test('projectPoints: 値→座標(y反転)・範囲外除外', () => {
  const pts = [{ tMs: 0, value: 0 }, { tMs: 10, value: 10 }, { tMs: 20, value: 5 }];
  const out = projectPoints(pts, { from: 0, to: 20, minY: 0, maxY: 10, width: 100, height: 50, pad: 0 });
  assert.deepEqual(out[0], { x: 0, y: 50 });   // value 0 → 下端
  assert.deepEqual(out[1], { x: 50, y: 0 });   // value 10 → 上端
  assert.equal(out.length, 3);
});

test('projectPoints: from/to 外は除外', () => {
  const pts = [{ tMs: 0, value: 1 }, { tMs: 100, value: 2 }];
  const out = projectPoints(pts, { from: 50, to: 100, minY: 0, maxY: 2, width: 10, height: 10, pad: 0 });
  assert.equal(out.length, 1);
});

test('buildLineChart: 艇ごとに polyline を含むSVG文字列', () => {
  const svg = buildLineChart({
    series: { 4899: [{ tMs: 0, value: 1 }, { tMs: 10, value: 3 }], 4304: [{ tMs: 0, value: 2 }] },
    boats: [4899, 4304], colors: { 4899: '#f00', 4304: '#00f' },
    from: 0, to: 10, width: 100, height: 40, pad: 2,
  });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('polyline'));
  assert.ok(svg.includes('#f00'));
  assert.ok(svg.includes('#00f'));
});

test('buildLineChart: 空系列でも <svg> を返す(polylineなし)', () => {
  const svg = buildLineChart({ series: {}, boats: [], colors: {}, from: 0, to: 1, width: 10, height: 10, pad: 1 });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('polyline'));
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `node --test test/linechart.test.js`
Expected: FAIL(モジュール未作成)。

- [ ] **Step 3: 最小実装**

```js
// src/linechart.js
// 多系列折れ線を SVG 文字列で描く純モジュール(外部依存なし)。

// [from,to] 内の点を画面座標へ。y は上が大きい値になるよう反転。
export function projectPoints(points, { from, to, minY, maxY, width, height, pad = 0 }) {
  const spanX = to - from || 1;
  const spanY = maxY - minY || 1;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const out = [];
  for (const p of points || []) {
    if (p.tMs < from || p.tMs > to) continue;
    const x = pad + ((p.tMs - from) / spanX) * w;
    const y = pad + (1 - (p.value - minY) / spanY) * h;
    out.push({ x, y });
  }
  return out;
}

// series: { boatNo: [{tMs,value}] }。y範囲は全系列の値から自動算出。
export function buildLineChart({ series, boats, colors, from, to, width, height, pad = 2 }) {
  let minY = Infinity; let maxY = -Infinity;
  for (const boat of boats) {
    for (const p of series[boat] || []) {
      if (p.value < minY) minY = p.value;
      if (p.value > maxY) maxY = p.value;
    }
  }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 1; }
  if (minY === maxY) { minY -= 1; maxY += 1; } // 平坦系列でも線を出す

  let body = '';
  for (const boat of boats) {
    const pts = projectPoints(series[boat] || [], { from, to, minY, maxY, width, height, pad });
    if (pts.length === 0) continue;
    const coords = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const color = colors[boat] || '#888';
    if (pts.length === 1) {
      body += `<circle cx="${pts[0].x.toFixed(1)}" cy="${pts[0].y.toFixed(1)}" r="2" fill="${color}" />`;
    } else {
      body += `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${coords}" />`;
    }
  }
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" `
    + `xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/linechart.test.js`
Expected: PASS(全4テスト)。

- [ ] **Step 5: コミット**

```bash
git add src/linechart.js test/linechart.test.js
git commit -m "feat: SVG多系列折れ線モジュール linechart.js (#22)"
```

---

### Task 3: 船体アンカー表 `boatlayout.js`

**Files:**
- Create: `src/boatlayout.js`
- Test: `test/boatlayout.test.js`

**Interfaces:**
- Consumes: `RIG_FIELDS` from `src/reflections.js`。
- Produces:
  - `BOAT_IMAGE: string` = `'sample-data/470.jpg'`
  - `ANCHORS: Record<param, {x:number,y:number,side:'left'|'right'}>` — `boatNo` 以外の全 `RIG_FIELDS` に対し、画像左上=0,0 / 右下=1,1 の正規化アンカーと配置側。
  - `anchorFor(param) -> {x,y,side}|null`

- [ ] **Step 1: 失敗するテストを書く**

```js
// test/boatlayout.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIG_FIELDS } from '../src/reflections.js';
import { ANCHORS, anchorFor, BOAT_IMAGE } from '../src/boatlayout.js';

test('boatNo 以外の全 RIG_FIELDS にアンカーがある', () => {
  for (const f of RIG_FIELDS) {
    if (f === 'boatNo') continue;
    const a = anchorFor(f);
    assert.ok(a, `missing anchor: ${f}`);
    assert.ok(a.x >= 0 && a.x <= 1, `x range: ${f}`);
    assert.ok(a.y >= 0 && a.y <= 1, `y range: ${f}`);
    assert.ok(a.side === 'left' || a.side === 'right', `side: ${f}`);
  }
});

test('boatNo にはアンカーが無い', () => {
  assert.equal(anchorFor('boatNo'), null);
  assert.equal(ANCHORS.boatNo, undefined);
});

test('BOAT_IMAGE は 470.jpg を指す', () => {
  assert.equal(BOAT_IMAGE, 'sample-data/470.jpg');
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `node --test test/boatlayout.test.js`
Expected: FAIL(モジュール未作成)。

- [ ] **Step 3: 最小実装**

```js
// src/boatlayout.js
// 各 rig パラメータを 470 側面図(sample-data/470.jpg, 横向き)の
// 「そのデータが指し示す位置」に紐付けるアンカー表。座標は画像左上=0,0/右下=1,1。
// side は吹き出しグラフを画像のどちら側に置くか。座標は目視調整可能。
export const BOAT_IMAGE = 'sample-data/470.jpg';

export const ANCHORS = {
  rake:         { x: 0.66, y: 0.10, side: 'right' }, // マスト上部
  bridleHeight: { x: 0.66, y: 0.22, side: 'right' }, // ハウンズ付近
  gear:         { x: 0.46, y: 0.30, side: 'left'  }, // メインセイル中程
  foreTension:  { x: 0.40, y: 0.28, side: 'left'  }, // フォアステイ
  prebend:      { x: 0.64, y: 0.38, side: 'right' }, // マスト中央の曲がり
  jibPull:      { x: 0.40, y: 0.50, side: 'left'  }, // ジブ後縁
  sideTension:  { x: 0.58, y: 0.55, side: 'right' }, // シュラウド/チェーンプレート
  jibLeader:    { x: 0.44, y: 0.58, side: 'left'  }, // ジブクリュー下
  peakRope:     { x: 0.48, y: 0.70, side: 'left'  }, // ブーム端付近
  vangPull:     { x: 0.60, y: 0.72, side: 'right' }, // バング
  puller:       { x: 0.52, y: 0.80, side: 'left'  }, // デッキ/プラー
};

export function anchorFor(param) {
  return ANCHORS[param] ?? null;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/boatlayout.test.js`
Expected: PASS(全3テスト)。

- [ ] **Step 5: コミット**

```bash
git add src/boatlayout.js test/boatlayout.test.js
git commit -m "feat: rigパラメータ→船体アンカー表 boatlayout.js (#22)"
```

---

### Task 4: 期間ブラシの純ヘルパ `timebrush.js`

**Files:**
- Create: `src/timebrush.js`
- Test: `test/timebrush.test.js`

**Interfaces:**
- Consumes: なし(純)。
- Produces:
  - `msToX(ms, {min,max,width}) -> number`
  - `xToMs(x, {min,max,width}) -> number`
  - `clampRange({from,to}, {min,max}) -> {from,to}` — min/max内へクランプし、from<=to を保証。

- [ ] **Step 1: 失敗するテストを書く**

```js
// test/timebrush.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msToX, xToMs, clampRange } from '../src/timebrush.js';

test('msToX / xToMs は往復する', () => {
  const scale = { min: 1000, max: 2000, width: 100 };
  assert.equal(msToX(1500, scale), 50);
  assert.equal(xToMs(50, scale), 1500);
});

test('msToX: min==max でも例外にならない', () => {
  assert.equal(msToX(1000, { min: 1000, max: 1000, width: 100 }), 0);
});

test('clampRange: 範囲内へ収め from<=to を保証', () => {
  assert.deepEqual(clampRange({ from: -5, to: 50 }, { min: 0, max: 40 }), { from: 0, to: 40 });
  assert.deepEqual(clampRange({ from: 30, to: 10 }, { min: 0, max: 40 }), { from: 10, to: 30 });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `node --test test/timebrush.test.js`
Expected: FAIL(モジュール未作成)。

- [ ] **Step 3: 最小実装**

```js
// src/timebrush.js
// 期間ブラシの座標↔時刻変換とクランプ(DOM非依存の純ヘルパ)。
export function msToX(ms, { min, max, width }) {
  const span = max - min;
  if (span <= 0) return 0;
  return ((ms - min) / span) * width;
}

export function xToMs(x, { min, max, width }) {
  if (width <= 0) return min;
  return min + (x / width) * (max - min);
}

export function clampRange({ from, to }, { min, max }) {
  let lo = Math.max(min, Math.min(from, to));
  let hi = Math.min(max, Math.max(from, to));
  if (lo < min) lo = min;
  if (hi > max) hi = max;
  return { from: lo, to: hi };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/timebrush.test.js`
Expected: PASS(全3テスト)。

- [ ] **Step 5: コミット**

```bash
git add src/timebrush.js test/timebrush.test.js
git commit -m "feat: 期間ブラシ純ヘルパ timebrush.js (#22)"
```

---

### Task 5: ダッシュボード枠 (index.html / styles.css) とホームのリンク

**Files:**
- Modify: `index.html`(`#home-bar` にリンク追加、`#dashboard-screen` セクション新設)
- Modify: `styles.css`(`view-dashboard` 表示切替とレイアウト)

**Interfaces:**
- Produces(DOM契約): 要素id `#home-dashboard-link`, `#dashboard-screen`, `#dashboard-home-link`, `#dashboard-legend`, `#dashboard-stage`, `#dashboard-boat`(中央`<img>`), `#dashboard-charts`(グラフ＋リーダー線コンテナ), `#dashboard-timebar`(canvas)。
- Consumes: 既存の body クラス表示切替パターン(`view-home`)。

- [ ] **Step 1: `#home-bar` にダッシュボードリンクを追加**

`index.html` の `#home-bar`(現状 `<strong>SailViz</strong>` と `#home-folder`)を次にする:

```html
    <header id="home-bar">
      <strong>SailViz</strong>
      <a id="home-dashboard-link" class="home-link" title="全艇チューニングを見比べる">🔧 チューニングダッシュボード</a>
      <span id="home-folder"></span>
    </header>
```

- [ ] **Step 2: `#dashboard-screen` セクションを追加**

`index.html` の `#home-screen` セクション直後に追加:

```html
  <section id="dashboard-screen">
    <header id="dashboard-bar">
      <a id="dashboard-home-link" class="home-link" title="ホームへ戻る">← ホーム</a>
      <strong>全艇チューニングダッシュボード</strong>
      <div id="dashboard-legend"></div>
    </header>
    <div id="dashboard-stage">
      <div id="dashboard-charts"></div>
      <img id="dashboard-boat" alt="470" />
    </div>
    <canvas id="dashboard-timebar"></canvas>
  </section>
```

- [ ] **Step 3: 表示切替とレイアウトのCSSを追加**

`styles.css` 末尾に追加(既存の `body.view-home` の表示切替に倣う):

```css
/* --- チューニングダッシュボード --- */
#dashboard-screen { display: none; }
body.view-dashboard #dashboard-screen { display: flex; flex-direction: column; height: 100vh; }
body.view-dashboard #topbar,
body.view-dashboard main,
body.view-dashboard #transport { display: none; }

#dashboard-bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #ccc; }
#dashboard-legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; margin-left: auto; }
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.legend-swatch { width: 12px; height: 3px; display: inline-block; }

.home-link { cursor: pointer; color: #1558d6; text-decoration: underline; font-size: 13px; }

#dashboard-stage { position: relative; flex: 1; overflow: hidden; }
#dashboard-boat { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  max-height: 80%; max-width: 40%; object-fit: contain; }
#dashboard-charts { position: absolute; inset: 0; }
.tuning-chart { position: absolute; width: 160px; background: rgba(255,255,255,0.9);
  border: 1px solid #ddd; border-radius: 4px; padding: 2px 4px; font-size: 11px; }
.tuning-chart .tc-title { color: #333; }
#dashboard-leaders { position: absolute; inset: 0; pointer-events: none; }

#dashboard-timebar { width: 100%; height: 44px; border-top: 1px solid #ccc; display: block; }
```

- [ ] **Step 4: 手動確認(枠が出るか)**

Run: `npm run serve` → ブラウザで `http://localhost:8000` を開き、DevToolsコンソールで
`document.body.classList.add('view-dashboard')` を実行。空のダッシュボード枠(ヘッダ＋中央枠＋下バー)が表示され、`view-home`/通常画面に切り替えると隠れることを目視確認。確認後 `document.body.className='view-home'` に戻す。

- [ ] **Step 5: コミット**

```bash
git add index.html styles.css
git commit -m "feat: ダッシュボード画面枠とホームのリンク (#22)"
```

---

### Task 6: ダッシュボード描画・配線 `dashboard.js`

**Files:**
- Create: `src/dashboard.js`
- Test: 手動(DOM/画像/ドラッグ)

**Interfaces:**
- Consumes: `collectTuning, TUNING_PARAMS, FOCUS_BOATS, BOAT_COLORS` (tuning.js), `buildLineChart` (linechart.js), `anchorFor, BOAT_IMAGE` (boatlayout.js), `msToX, xToMs, clampRange` (timebrush.js), `RIG_LABELS`(app.js から渡す)。
- Produces: `export function createDashboard({ loadEntries, rigLabels }) -> { render(): Promise<void> }`
  - `loadEntries: () => Promise<{name?:string, project:object}[]>` — 全練習の deserialize 済みプロジェクトを返す関数(app.js が projectDir から供給)。
  - `render()`: 集計 → 凡例・中央画像・各パラメータのミニグラフ＋リーダー線・期間バーを描画し、ブラシのドラッグで再描画。

- [ ] **Step 1: `dashboard.js` を実装**

```js
// src/dashboard.js
// 集計(tuning)・折れ線(linechart)・アンカー(boatlayout)・ブラシ(timebrush)を束ね、
// #dashboard-screen に「470を囲む推移グラフ＋期間バー」を描画するDOMコントローラ。
import { collectTuning, TUNING_PARAMS, FOCUS_BOATS, BOAT_COLORS } from './tuning.js';
import { buildLineChart } from './linechart.js';
import { anchorFor, BOAT_IMAGE } from './boatlayout.js';
import { msToX, xToMs, clampRange } from './timebrush.js';

const $ = (id) => document.getElementById(id);
const CHART_W = 160;
const CHART_H = 60;

export function createDashboard({ loadEntries, rigLabels }) {
  let data = null;       // collectTuning の結果
  let view = null;       // { from, to } 現在の表示域
  let drag = null;       // ブラシのドラッグ状態

  function renderLegend() {
    $('dashboard-legend').innerHTML = FOCUS_BOATS.map((b) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${BOAT_COLORS[b]}"></span>${b}</span>`
    ).join('');
  }

  // 中央画像とリーダー線オーバレイを用意。
  function ensureStage() {
    const img = $('dashboard-boat');
    if (img.getAttribute('src') !== BOAT_IMAGE) img.setAttribute('src', BOAT_IMAGE);
    let leaders = $('dashboard-leaders');
    if (!leaders) {
      leaders = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      leaders.id = 'dashboard-leaders';
      $('dashboard-stage').appendChild(leaders);
    }
    return leaders;
  }

  // 画像の実表示矩形(contain)を stage 座標で得る。未ロード時は概算。
  function boatRect() {
    const stage = $('dashboard-stage').getBoundingClientRect();
    const img = $('dashboard-boat').getBoundingClientRect();
    return {
      left: img.left - stage.left, top: img.top - stage.top,
      width: img.width, height: img.height,
      stageW: stage.width, stageH: stage.height,
    };
  }

  function renderCharts() {
    const charts = $('dashboard-charts');
    charts.innerHTML = '';
    const leaders = ensureStage();
    leaders.innerHTML = '';
    const rect = boatRect();
    leaders.setAttribute('viewBox', `0 0 ${rect.stageW} ${rect.stageH}`);
    leaders.setAttribute('width', rect.stageW);
    leaders.setAttribute('height', rect.stageH);

    TUNING_PARAMS.forEach((param, i) => {
      const a = anchorFor(param);
      if (!a) return;
      // アンカー(画像正規化)→ stage 座標
      const ax = rect.left + a.x * rect.width;
      const ay = rect.top + a.y * rect.height;
      // グラフ位置: side に応じて画像の左右へ、縦は順番で散らす
      const col = a.side === 'left';
      const sideItems = TUNING_PARAMS.filter((p) => (anchorFor(p)?.side === a.side));
      const idx = sideItems.indexOf(param);
      const cx = col ? rect.left * 0.15 : rect.left + rect.width + (rect.stageW - rect.left - rect.width) * 0.15;
      const cy = 20 + idx * (rect.stageH - 60) / Math.max(1, sideItems.length - 1);

      const box = document.createElement('div');
      box.className = 'tuning-chart';
      box.style.left = `${cx}px`;
      box.style.top = `${cy}px`;
      box.innerHTML = `<div class="tc-title">${rigLabels[param] || param}</div>`
        + buildLineChart({
          series: data.series[param], boats: data.boats, colors: BOAT_COLORS,
          from: view.from, to: view.to, width: CHART_W, height: CHART_H, pad: 3,
        });
      charts.appendChild(box);

      // リーダー線: グラフ端 → アンカー
      const lx = col ? cx + CHART_W : cx;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', lx); line.setAttribute('y1', cy + CHART_H / 2);
      line.setAttribute('x2', ax); line.setAttribute('y2', ay);
      line.setAttribute('stroke', '#bbb'); line.setAttribute('stroke-width', '1');
      leaders.appendChild(line);
    });
  }

  function renderTimebar() {
    const canvas = $('dashboard-timebar');
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 44;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!data.domain) return;
    const scale = { min: data.domain.min, max: data.domain.max, width: w };
    // 全域トラック
    ctx.fillStyle = '#eee'; ctx.fillRect(0, h / 2 - 3, w, 6);
    // 選択域
    const x1 = msToX(view.from, scale); const x2 = msToX(view.to, scale);
    ctx.fillStyle = 'rgba(21,88,214,0.35)'; ctx.fillRect(x1, h / 2 - 6, x2 - x1, 12);
    // ハンドル
    ctx.fillStyle = '#1558d6';
    for (const x of [x1, x2]) ctx.fillRect(x - 2, h / 2 - 10, 4, 20);
    // 端の日付ラベル
    ctx.fillStyle = '#555'; ctx.font = '11px sans-serif';
    ctx.fillText(fmtDate(data.domain.min), 2, 12);
    ctx.textAlign = 'right'; ctx.fillText(fmtDate(data.domain.max), w - 2, 12); ctx.textAlign = 'left';
  }

  function fmtDate(ms) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit' })
      .format(new Date(ms));
  }

  function wireTimebar() {
    const canvas = $('dashboard-timebar');
    if (canvas.dataset.wired) return;
    canvas.dataset.wired = '1';
    const scaleOf = () => ({ min: data.domain.min, max: data.domain.max, width: canvas.clientWidth || 800 });
    const pick = (e) => {
      const r = canvas.getBoundingClientRect();
      const ms = xToMs(e.clientX - r.left, scaleOf());
      // from/to の近い方を掴む
      return Math.abs(ms - view.from) <= Math.abs(ms - view.to) ? 'from' : 'to';
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!data?.domain) return;
      drag = pick(e); canvas.setPointerCapture(e.pointerId); onMove(e);
    });
    const onMove = (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      const ms = xToMs(e.clientX - r.left, scaleOf());
      view = clampRange({ ...view, [drag]: ms }, data.domain);
      renderTimebar(); renderCharts();
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', () => { drag = null; });
  }

  async function render() {
    renderLegend();
    const entries = await loadEntries();
    data = collectTuning(entries);
    view = data.domain ? { from: data.domain.min, to: data.domain.max } : { from: 0, to: 1 };
    // 画像ロード後にレイアウトが確定するので load を待つ
    const img = $('dashboard-boat');
    ensureStage();
    if (img.complete && img.naturalWidth) { renderCharts(); }
    else { img.onload = () => renderCharts(); }
    renderTimebar();
    wireTimebar();
  }

  return { render };
}
```

- [ ] **Step 2: 手動確認は Task 7 の配線後にまとめて行う**

このタスクは単体では描画されない(app.js の配線が必要)。構文が通ることだけ確認:

Run: `node --check src/dashboard.js`
Expected: エラーなし。

- [ ] **Step 3: コミット**

```bash
git add src/dashboard.js
git commit -m "feat: ダッシュボード描画コントローラ dashboard.js (#22)"
```

---

### Task 7: app.js 配線と手動確認

**Files:**
- Modify: `src/app.js`(import、`showDashboard`、リンクのイベント、`loadEntries` 供給)

**Interfaces:**
- Consumes: `createDashboard` (dashboard.js), 既存 `projectDir, listProjectFiles, readProject, deserializeProject, RIG_LABELS, showHome`。
- Produces: グローバル配線のみ(新 export なし)。

- [ ] **Step 1: import と初期化を追加**

`src/app.js` の import 群(`projectfs.js` を import している行の近く)に追加:

```js
import { createDashboard } from './dashboard.js';
```

`RIG_LABELS` 定義(app.js 内、Task参照: `const RIG_LABELS = {...}`)より後で、ダッシュボードを生成:

```js
// 全練習を deserialize して渡す(projectDir 前提)。
const dashboard = createDashboard({
  rigLabels: RIG_LABELS,
  loadEntries: async () => {
    if (!projectDir) return [];
    const files = await listProjectFiles(projectDir);
    const entries = [];
    for (const f of files) {
      try { entries.push({ name: f.name, project: deserializeProject(await readProject(projectDir, f.name)) }); }
      catch { /* 壊れたファイルはスキップ */ }
    }
    return entries;
  },
});
```

- [ ] **Step 2: `showDashboard` と画面切替を追加**

`showHome`/`showTrack` 関数の近くに追加:

```js
async function showDashboard() {
  if (!projectDir && !(await ensureProjectDir())) return;
  document.body.classList.remove('view-home');
  document.body.classList.add('view-dashboard');
  await dashboard.render();
}
function backToHomeFromDashboard() {
  document.body.classList.remove('view-dashboard');
  showHome();
}
```

- [ ] **Step 3: リンクのイベントを配線**

`$('app-title').addEventListener('click', showHome);` の近くに追加:

```js
$('home-dashboard-link').addEventListener('click', showDashboard);
$('dashboard-home-link').addEventListener('click', backToHomeFromDashboard);
```

- [ ] **Step 4: 全テスト実行(回帰なし確認)**

Run: `npm test`
Expected: 既存＋新規(tuning/linechart/boatlayout/timebrush)が全て PASS。

- [ ] **Step 5: 手動確認(実描画)**

Run: `npm run serve` → `http://localhost:8000`。
1. 保存フォルダを選択(rig入り反省を含む練習が複数あること。無ければ新規練習で `boatNo` に対象6艇のいずれかを入れた反省を数件保存してから)。
2. ホームの「🔧 チューニングダッシュボード」をクリック → ダッシュボードへ遷移。
3. 中央に470画像、周囲に各パラメータのミニグラフ、艇色のリーダー線、凡例、下部に期間バーが出る。
4. 期間バーのハンドルをドラッグ → グラフのx域が絞られ再描画される。
5. 「← ホーム」でホームへ戻る。

- [ ] **Step 6: コミット**

```bash
git add src/app.js
git commit -m "feat: ダッシュボードをapp.jsに配線しホームから遷移 (#22)"
```

---

### Task 8: roadmap 更新

**Files:**
- Modify: `docs/roadmap.md`(#22 のステータスを更新)

- [ ] **Step 1: #22 のステータスを更新**

`docs/roadmap.md` の `### 22. 全艇チューニングダッシュボード` の `- **ステータス**: 💡` を、実装済み範囲(推移グラフ＋470船図配置＋期間バー、適合点数/真後ろ画像は据え置き)を1行でまとめた `✅` 表記に書き換える。

- [ ] **Step 2: コミット**

```bash
git add docs/roadmap.md
git commit -m "docs: roadmap #22 のステータス更新"
```

---

## 実装後の統合

全タスク完了後、`superpowers:finishing-a-development-branch` で `feature/tuning-dashboard` の統合方針(mainへのマージ等)を判断する。
