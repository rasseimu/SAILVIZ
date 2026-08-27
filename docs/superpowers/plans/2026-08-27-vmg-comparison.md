# 複数艇VMG比較・ハイライト Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同時に読み込んだ複数艇のGPS軌跡を風軸基準でレグごとにVMG比較し、各時刻でVMG最良の艇を地図とダッシュボードでハイライトする。

**Architecture:** 純関数モジュール `src/vmg.js` が中核（風軸補間→レグVMG→勝ち艇タイムライン→ランキング）。抽象的な風軸時系列 `WindEstimate[]` を入力に取り、風軸の生成元（`unifyWindAxis`）とは疎結合。地図描画（`renderer.js`）とダッシュボードパネル（`vmgview.js`）は薄い連携層。

**Tech Stack:** バニラJS（ESM, `"type":"module"`）、`node:test`、Chart.js（`vendor/chart.esm.js`、`chartview.js` 経由）、Canvas 2D。

**Spec:** `docs/superpowers/specs/2026-08-27-vmg-comparison-design.md`

## Global Constraints

- すべての公開関数は純粋関数（DOM/副作用なし）。DOM 依存は `vmgview.js` / `renderer.js` / `app.js` のみ。
- 角度は度・360法（0=北）。円周演算は `src/windaxis.js` の `normalizeDeg` / `circDiffDeg` / `circMedianDeg` を再利用（重複実装禁止）。
- 距離は `src/gps.js` の `haversineMeters` を再利用。
- 時刻は絶対epoch ms。艇間比較は絶対時刻でのみ行う（elapsed モードは対象外）。
- 走種は `'upwind' | 'downwind'` の2値。リーチはデッドバンドで除外し `LegVmg` を生成しない。
- テストは `node:test`。実行は `node --test test/vmg.test.js`。テストヘルパ `near`/`nearCirc` は `test/windaxis.test.js` と同形で各テストファイル先頭に定義。
- 既定パラメータ: `deadband=12`, `settleSec=12`, `settleM=30`, `minLegSec=8`, `minLegM=20`, `minBoats=2`, `gridMs=5000`。
- コミットは `feat(vmg): ...` / `docs: ...`。末尾に `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## File Structure

- Create `src/vmg.js` — 中核純関数: `windFromAt`, `vmgComponents`, `classifyPointOfSail`, `boatLegVmg`, `winnerTimeline`, `rankVmg`, `analyzeFleetVmg`, `unifyWindAxis`。
- Create `src/vmgview.js` — ダッシュボードVMGパネル。純データ整形（`buildVmgChartSeries`, `buildVmgRankTable`）＋DOMコントローラ（`createVmgPanel`）。
- Modify `src/renderer.js` — `state.vmgHighlights` の勝ちレグ帯を重ね描き。
- Modify `src/app.js` — 「VMG強調」トグルと再計算・パネル配線。
- Create `test/vmg.test.js` — `src/vmg.js` の単体テスト。
- Create `test/vmgview.test.js` — `vmgview.js` の純データ整形テスト。

---

## Task 1: 風軸の時刻補間 `windFromAt`

**Files:**
- Create: `src/vmg.js`
- Test: `test/vmg.test.js`

**Interfaces:**
- Consumes: `normalizeDeg`, `circDiffDeg`（`src/windaxis.js`）
- Produces: `windFromAt(windSeries: {tMs, windFromDeg}[], t: number) → number|null` — 時刻 t の風向を円周補間。空なら null、範囲外は端点にクランプ。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` を新規作成:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circDiffDeg } from '../src/windaxis.js';
import { windFromAt } from '../src/vmg.js';

const nearCirc = (a, b, eps = 0.5) =>
  assert.ok(Math.abs(circDiffDeg(a, b)) < eps, `circ ${a} != ${b}`);

test('windFromAt: 北跨ぎを円周補間し端点でクランプ', () => {
  const ws = [{ tMs: 0, windFromDeg: 350 }, { tMs: 1000, windFromDeg: 10 }];
  nearCirc(windFromAt(ws, 0), 350);
  nearCirc(windFromAt(ws, 1000), 10);
  nearCirc(windFromAt(ws, 500), 0);    // 350→10 の中点は 0(=360)
  nearCirc(windFromAt(ws, -100), 350); // 範囲外は端点クランプ
  nearCirc(windFromAt(ws, 9999), 10);
  assert.equal(windFromAt([], 0), null);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`windFromAt is not a function` / モジュール未作成）

- [ ] **Step 3: 最小実装**

`src/vmg.js` を新規作成:

```js
// src/vmg.js
// 複数艇のGPS軌跡を風軸基準でVMG比較する純関数群。DOM/副作用なし。
// 風軸時系列 WindEstimate[] を抽象入力に取り、その生成元とは疎結合。
import { normalizeDeg, circDiffDeg, circMedianDeg } from './windaxis.js';
import { haversineMeters } from './gps.js';

const DEG = Math.PI / 180;

// windSeries[hi].tMs >= t となる最小 hi（t は範囲内前提）。
function upperIndex(windSeries, t) {
  let lo = 0, hi = windSeries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (windSeries[mid].tMs < t) lo = mid + 1;
    else hi = mid;
  }
  return hi;
}

// 時刻 t の風向を円周補間。空配列は null、範囲外は端点にクランプ。
export function windFromAt(windSeries, t) {
  const n = windSeries.length;
  if (n === 0) return null;
  if (t <= windSeries[0].tMs) return normalizeDeg(windSeries[0].windFromDeg);
  if (t >= windSeries[n - 1].tMs) return normalizeDeg(windSeries[n - 1].windFromDeg);
  const hi = upperIndex(windSeries, t);
  const a = windSeries[hi - 1], b = windSeries[hi];
  const span = b.tMs - a.tMs;
  const f = span === 0 ? 0 : (t - a.tMs) / span;
  return normalizeDeg(a.windFromDeg + circDiffDeg(b.windFromDeg, a.windFromDeg) * f);
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/vmg.js test/vmg.test.js
git commit -m "feat(vmg): 風軸時系列の円周補間 windFromAt を追加"
```

---

## Task 2: VMG成分と走種判定 `vmgComponents` / `classifyPointOfSail`

**Files:**
- Modify: `src/vmg.js`
- Test: `test/vmg.test.js`

**Interfaces:**
- Consumes: `circDiffDeg`（`src/windaxis.js`）
- Produces:
  - `vmgComponents(cog, speed, windDeg) → { delta, upwind, downwind }` — `delta=circDiffDeg(cog,windDeg)`, `upwind=speed·cos(delta)`, `downwind=−upwind`。
  - `classifyPointOfSail(headingDeg, windDeg, deadband=12) → 'upwind'|'downwind'|'reach'`。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` に追記:

```js
import { vmgComponents, classifyPointOfSail } from '../src/vmg.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('vmgComponents: 風上/風下成分の符号', () => {
  const dead = vmgComponents(0, 3, 0);   // 風に直進
  near(dead.upwind, 3); near(dead.downwind, -3);
  const run = vmgComponents(180, 3, 0);  // 真後ろ＝ランニング
  near(run.upwind, -3); near(run.downwind, 3);
  const close = vmgComponents(45, 3, 0); // クローズ
  near(close.upwind, 3 * Math.cos(45 * Math.PI / 180));
});

test('classifyPointOfSail: デッドバンドでリーチ除外', () => {
  assert.equal(classifyPointOfSail(45, 0), 'upwind');
  assert.equal(classifyPointOfSail(170, 0), 'downwind');
  assert.equal(classifyPointOfSail(90, 0), 'reach');
  assert.equal(classifyPointOfSail(300, 0), 'upwind');  // -60°相当
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`vmgComponents is not a function`）

- [ ] **Step 3: 最小実装**

`src/vmg.js` に追記:

```js
// 1サンプルのVMG成分。upwind=風上前進成分、downwind=風下前進成分（符号反転）。
export function vmgComponents(cog, speed, windDeg) {
  const delta = circDiffDeg(cog, windDeg);
  const upwind = speed * Math.cos(delta * DEG);
  return { delta, upwind, downwind: -upwind };
}

// レグ代表方位と風向から走種を判定。90°±deadband をリーチとして除外。
export function classifyPointOfSail(headingDeg, windDeg, deadband = 12) {
  const absD = Math.abs(circDiffDeg(headingDeg, windDeg));
  if (absD < 90 - deadband) return 'upwind';
  if (absD > 90 + deadband) return 'downwind';
  return 'reach';
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/vmg.js test/vmg.test.js
git commit -m "feat(vmg): VMG成分算出と走種判定を追加"
```

---

## Task 3: レグ平均VMG `boatLegVmg`

**Files:**
- Modify: `src/vmg.js`
- Test: `test/vmg.test.js`

**Interfaces:**
- Consumes: `computeCog`, `segmentLegs`（`src/windaxis.js`）, `haversineMeters`（`src/gps.js`）, `windFromAt`, `vmgComponents`, `classifyPointOfSail`（Task 1,2）
- Produces:
  - `boatLegVmg(track, windSeries, opts?) → LegVmg[]`
  - `LegVmg = { boatId, startT, endT, pointOfSail:'upwind'|'downwind', meanVmg, meanSpeed, meanTwa, lenM, durSec, nSamples, confidence }`
  - opts: `{ deadband=12, settleSec=12, settleM=30, minLegSec=8, minLegM=20, cogOpts={}, segOpts={} }`。リーチレグは出力しない。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` に追記:

```js
import { boatLegVmg } from '../src/vmg.js';

// 指定方位・速度で直進する track.points（lat/lon/t/speed）を生成。cog は computeCog が再計算。
function straightTrack(id, t0, headingDeg, seconds, speed = 3, dtMs = 500) {
  const points = [];
  let lat = 35.30, lon = 139.48;
  const rad = headingDeg * Math.PI / 180;
  const mLat = 111_320, mLon = 111_320 * Math.cos(lat * Math.PI / 180);
  const n = Math.floor((seconds * 1000) / dtMs);
  for (let i = 0; i < n; i++) {
    points.push({ t: t0 + i * dtMs, lat, lon, speed, bearing: null, accuracy: null });
    lat += (Math.cos(rad) * speed * (dtMs / 1000)) / mLat;
    lon += (Math.sin(rad) * speed * (dtMs / 1000)) / mLon;
  }
  return { id, name: id, color: '#f00', points };
}

test('boatLegVmg: 風上クローズレグの平均VMGを復元', () => {
  const t0 = 1_787_000_000_000;
  const track = straightTrack('A', t0, 45, 40, 3);      // 45°クローズ, 3m/s, 40s
  const ws = [{ tMs: t0, windFromDeg: 0 }, { tMs: t0 + 40000, windFromDeg: 0 }];
  const legs = boatLegVmg(track, ws, { settleSec: 4, settleM: 10, minLegSec: 5 });
  assert.equal(legs.length, 1);
  assert.equal(legs[0].pointOfSail, 'upwind');
  assert.equal(legs[0].boatId, 'A');
  near(legs[0].meanVmg, 3 * Math.cos(45 * Math.PI / 180), 0.1); // ≈2.12
});

test('boatLegVmg: リーチレグは出力しない', () => {
  const t0 = 1_787_000_000_000;
  const track = straightTrack('R', t0, 90, 40, 3);       // 風0°に対し真横=リーチ
  const ws = [{ tMs: t0, windFromDeg: 0 }, { tMs: t0 + 40000, windFromDeg: 0 }];
  const legs = boatLegVmg(track, ws, { settleSec: 4, settleM: 10, minLegSec: 5 });
  assert.equal(legs.length, 0);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`boatLegVmg is not a function`）

- [ ] **Step 3: 最小実装**

`src/vmg.js` に追記:

```js
import { computeCog, segmentLegs } from './windaxis.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// レグの落ち着き区間（セトリング除外＋末尾10%トリム）のサンプル列。除外後が空なら全体。
function steadyWindow(seg, settleSec, settleM) {
  if (seg.length === 0) return [];
  const start = seg[0];
  const steady = [];
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (i > 0) acc += haversineMeters(seg[i - 1], seg[i]);
    const dtSec = (seg[i].t - start.t) / 1000;
    if (dtSec >= settleSec && acc >= settleM) steady.push(seg[i]);
  }
  const trimmed = steady.slice(0, Math.max(1, Math.floor(steady.length * 0.9)));
  return trimmed.length ? trimmed : seg;
}

// 1艇の beat/run レグごとの平均VMG。リーチ・風向欠損レグは除外。
export function boatLegVmg(track, windSeries, opts = {}) {
  const deadband = opts.deadband ?? 12;
  const settleSec = opts.settleSec ?? 12;
  const settleM = opts.settleM ?? 30;
  const minLegSec = opts.minLegSec ?? 8;
  const minLegM = opts.minLegM ?? 20;

  const samples = computeCog(track.points, opts.cogOpts ?? {});
  const { legs } = segmentLegs(samples, opts.segOpts ?? {});
  const out = [];
  for (const leg of legs) {
    const wMid = windFromAt(windSeries, (leg.startT + leg.endT) / 2);
    if (wMid == null) continue;
    const pos = classifyPointOfSail(leg.headingDeg, wMid, deadband);
    if (pos === 'reach') continue;

    const steady = steadyWindow(leg.samples, settleSec, settleM);
    let sumVmg = 0, sumSpeed = 0, sumTwa = 0;
    for (const s of steady) {
      const w = windFromAt(windSeries, s.t);
      const c = vmgComponents(s.cog, s.speed, w);
      sumVmg += pos === 'upwind' ? c.upwind : c.downwind;
      sumSpeed += s.speed;
      sumTwa += Math.abs(c.delta);
    }
    const nSamples = steady.length;
    const durSec = (leg.endT - leg.startT) / 1000;
    const confidence = clamp01(
      0.5 * Math.min(1, durSec / (minLegSec * 2)) +
      0.3 * Math.min(1, leg.lenM / (minLegM * 2)) +
      0.2 * Math.min(1, nSamples / 20)
    );
    out.push({
      boatId: track.id,
      startT: leg.startT, endT: leg.endT,
      pointOfSail: pos,
      meanVmg: sumVmg / nSamples,
      meanSpeed: sumSpeed / nSamples,
      meanTwa: sumTwa / nSamples,
      lenM: leg.lenM, durSec, nSamples, confidence,
    });
  }
  return out;
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/vmg.js test/vmg.test.js
git commit -m "feat(vmg): レグ平均VMG boatLegVmg（セトリング除外）を追加"
```

---

## Task 4: 勝ち艇タイムライン `winnerTimeline`

**Files:**
- Modify: `src/vmg.js`
- Test: `test/vmg.test.js`

**Interfaces:**
- Consumes: `LegVmg[]`（Task 3）
- Produces:
  - `winnerTimeline(perBoatLegVmg: LegVmg[], opts?) → Highlight[]`
  - `Highlight = { boatId, color, lo, hi, pointOfSail, vmg }`
  - opts: `{ minBoats=2, colors={} }`。同一走種で `minBoats` 以上のときのみ勝者を判定。隣接同一勝者帯は結合。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` に追記:

```js
import { winnerTimeline } from '../src/vmg.js';

const leg = (boatId, startT, endT, pointOfSail, meanVmg) =>
  ({ boatId, startT, endT, pointOfSail, meanVmg });

test('winnerTimeline: 同走種で高VMG艇が勝ち、異走種・単独は除外', () => {
  const legs = [
    leg('A', 0, 100, 'upwind', 2.5),
    leg('B', 0, 100, 'upwind', 2.0),
    leg('C', 0, 100, 'downwind', 3.0), // 風下単独→比較対象なし
  ];
  const hl = winnerTimeline(legs, { colors: { A: '#a', B: '#b', C: '#c' } });
  assert.equal(hl.length, 1);
  assert.equal(hl[0].boatId, 'A');
  assert.equal(hl[0].color, '#a');
  assert.equal(hl[0].lo, 0);
  assert.equal(hl[0].hi, 100);
});

test('winnerTimeline: 部分重複区間だけを勝ち帯にする', () => {
  const legs = [
    leg('A', 0, 100, 'upwind', 2.5),
    leg('B', 50, 150, 'upwind', 3.0),
  ];
  const hl = winnerTimeline(legs, { minBoats: 2 });
  assert.equal(hl.length, 1);        // 重複する[50,100)のみ
  assert.equal(hl[0].boatId, 'B');
  assert.equal(hl[0].lo, 50);
  assert.equal(hl[0].hi, 100);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`winnerTimeline is not a function`）

- [ ] **Step 3: 最小実装**

`src/vmg.js` に追記:

```js
// レグ群を「全境界の和集合」で区間分割し、各区間・各走種で最大VMG艇を勝者とする。
// 同一走種の参加艇が minBoats 未満の区間は勝者なし。隣接同一勝者帯は結合。
export function winnerTimeline(perBoatLegVmg, opts = {}) {
  const minBoats = opts.minBoats ?? 2;
  const colors = opts.colors ?? {};
  const bounds = new Set();
  for (const l of perBoatLegVmg) { bounds.add(l.startT); bounds.add(l.endT); }
  const times = [...bounds].sort((a, b) => a - b);

  const raw = []; // {boatId, pointOfSail, vmg, lo, hi}
  for (let i = 0; i + 1 < times.length; i++) {
    const lo = times[i], hi = times[i + 1];
    const mid = (lo + hi) / 2;
    const active = perBoatLegVmg.filter((l) => l.startT <= mid && mid < l.endT);
    for (const pos of ['upwind', 'downwind']) {
      const group = active.filter((l) => l.pointOfSail === pos);
      if (group.length < minBoats) continue;
      const win = group.reduce((a, b) => (b.meanVmg > a.meanVmg ? b : a));
      raw.push({ boatId: win.boatId, pointOfSail: pos, vmg: win.meanVmg, lo, hi });
    }
  }

  // 隣接（hi===次のlo）で同一 boatId・同一走種を結合
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.boatId === seg.boatId && last.pointOfSail === seg.pointOfSail && last.hi === seg.lo) {
      last.hi = seg.hi;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged.map((m) => ({
    boatId: m.boatId, color: colors[m.boatId] || '#888',
    lo: m.lo, hi: m.hi, pointOfSail: m.pointOfSail, vmg: m.vmg,
  }));
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/vmg.js test/vmg.test.js
git commit -m "feat(vmg): 勝ち艇タイムライン winnerTimeline を追加"
```

---

## Task 5: ランキング集約 `rankVmg`

**Files:**
- Modify: `src/vmg.js`
- Test: `test/vmg.test.js`

**Interfaces:**
- Consumes: `LegVmg[]`（Task 3）, `Highlight[]`（Task 4）
- Produces:
  - `rankVmg(perBoatLegVmg, { from, to, highlights=[] }) → RankRow[]`
  - `RankRow = { boatId, pointOfSail, meanVmg, winRatio, legCount, bestLegVmg }`
  - `[from,to]` に交差するレグを艇×走種で集約。`meanVmg` は交差時間重み平均。走種内でVMG降順。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` に追記:

```js
import { rankVmg } from '../src/vmg.js';

test('rankVmg: 艇×走種で集約し勝ち率とVMG降順を出す', () => {
  const legs = [
    { boatId: 'A', startT: 0, endT: 100, pointOfSail: 'upwind', meanVmg: 2.5 },
    { boatId: 'B', startT: 0, endT: 100, pointOfSail: 'upwind', meanVmg: 2.0 },
  ];
  const highlights = [{ boatId: 'A', pointOfSail: 'upwind', lo: 0, hi: 100 }];
  const rows = rankVmg(legs, { from: 0, to: 100, highlights });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].boatId, 'A');            // VMG降順で先頭
  near(rows[0].meanVmg, 2.5); near(rows[0].winRatio, 1);
  assert.equal(rows[0].legCount, 1);
  assert.equal(rows[1].boatId, 'B');
  near(rows[1].winRatio, 0);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`rankVmg is not a function`）

- [ ] **Step 3: 最小実装**

`src/vmg.js` に追記:

```js
// [from,to] と [a,b] の交差長（ms）。
function overlapMs(from, to, a, b) {
  return Math.max(0, Math.min(to, b) - Math.max(from, a));
}

// 艇×走種でVMGを集約。winRatio は highlights の勝ち時間 / 該当レグ在時間。
export function rankVmg(perBoatLegVmg, { from, to, highlights = [] }) {
  const groups = new Map(); // key=`${boatId}|${pos}`
  for (const l of perBoatLegVmg) {
    const ov = overlapMs(from, to, l.startT, l.endT);
    if (ov <= 0) continue;
    const key = `${l.boatId}|${l.pointOfSail}`;
    const g = groups.get(key) || { boatId: l.boatId, pointOfSail: l.pointOfSail, wSum: 0, wVmg: 0, legCount: 0, bestLegVmg: -Infinity, activeMs: 0 };
    g.wSum += ov; g.wVmg += l.meanVmg * ov; g.legCount += 1;
    g.bestLegVmg = Math.max(g.bestLegVmg, l.meanVmg);
    g.activeMs += ov;
    groups.set(key, g);
  }
  for (const h of highlights) {
    const key = `${h.boatId}|${h.pointOfSail}`;
    const g = groups.get(key);
    if (g) g.winMs = (g.winMs || 0) + overlapMs(from, to, h.lo, h.hi);
  }
  const rows = [...groups.values()].map((g) => ({
    boatId: g.boatId, pointOfSail: g.pointOfSail,
    meanVmg: g.wSum ? g.wVmg / g.wSum : 0,
    winRatio: g.activeMs ? (g.winMs || 0) / g.activeMs : 0,
    legCount: g.legCount, bestLegVmg: g.bestLegVmg,
  }));
  rows.sort((a, b) => (a.pointOfSail < b.pointOfSail ? -1 : a.pointOfSail > b.pointOfSail ? 1 : b.meanVmg - a.meanVmg));
  return rows;
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/vmg.js test/vmg.test.js
git commit -m "feat(vmg): ランキング集約 rankVmg を追加"
```

---

## Task 6: 統合エントリ `analyzeFleetVmg`

**Files:**
- Modify: `src/vmg.js`
- Test: `test/vmg.test.js`

**Interfaces:**
- Consumes: `boatLegVmg`, `winnerTimeline`, `rankVmg`（Task 3,4,5）
- Produces:
  - `analyzeFleetVmg(tracks, windSeries, opts?) → { perBoatLegVmg, highlights, ranks }`
  - 各 `track.color` から色マップを組み `winnerTimeline` に渡す。`ranks` は `{ from, to }`（既定＝全レグの範囲）で `rankVmg`。
  - opts: `boatLegVmg`/`winnerTimeline` の opts に加え `{ from, to }`。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` に追記:

```js
import { analyzeFleetVmg } from '../src/vmg.js';

test('analyzeFleetVmg: 2艇の風上比較でハイライトとランキングを返す', () => {
  const t0 = 1_787_000_000_000;
  const fast = straightTrack('F', t0, 45, 40, 3.4); fast.color = '#f00';
  const slow = straightTrack('S', t0, 45, 40, 2.6); slow.color = '#00f';
  const ws = [{ tMs: t0, windFromDeg: 0 }, { tMs: t0 + 40000, windFromDeg: 0 }];
  const r = analyzeFleetVmg([fast, slow], ws, { settleSec: 4, settleM: 10, minLegSec: 5 });
  assert.ok(r.perBoatLegVmg.length >= 2);
  assert.ok(r.highlights.length >= 1);
  assert.equal(r.highlights[0].boatId, 'F');   // 速い艇が勝つ
  assert.equal(r.highlights[0].color, '#f00');
  assert.equal(r.ranks[0].boatId, 'F');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`analyzeFleetVmg is not a function`）

- [ ] **Step 3: 最小実装**

`src/vmg.js` に追記:

```js
// 複数艇＋風軸から、レグVMG・勝ちハイライト・ランキングを一括算出する統合エントリ。
export function analyzeFleetVmg(tracks, windSeries, opts = {}) {
  const colors = {};
  const perBoatLegVmg = [];
  for (const track of tracks) {
    colors[track.id] = track.color || '#888';
    perBoatLegVmg.push(...boatLegVmg(track, windSeries, opts));
  }
  const highlights = winnerTimeline(perBoatLegVmg, { minBoats: opts.minBoats ?? 2, colors });
  let from = opts.from, to = opts.to;
  if (from == null || to == null) {
    from = Math.min(...perBoatLegVmg.map((l) => l.startT), Infinity);
    to = Math.max(...perBoatLegVmg.map((l) => l.endT), -Infinity);
  }
  const ranks = perBoatLegVmg.length ? rankVmg(perBoatLegVmg, { from, to, highlights }) : [];
  return { perBoatLegVmg, highlights, ranks };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/vmg.js test/vmg.test.js
git commit -m "feat(vmg): 統合エントリ analyzeFleetVmg を追加"
```

---

## Task 7: 統合風軸 `unifyWindAxis`

**Files:**
- Modify: `src/vmg.js`
- Test: `test/vmg.test.js`

**Interfaces:**
- Consumes: `circMedianDeg`（`src/windaxis.js`）, `windFromAt`（Task 1）
- Produces:
  - `unifyWindAxis(tracks, { estimator, marks, gridMs=5000 }) → WindEstimate[]`
  - `estimator(track, { marks }) → {tMs,windFromDeg}[]`（**必須注入**。windaxis の `estimateWindAxisSeries` 完成後に app 側で渡す。未指定はエラー）。
  - 共通グリッド上で各艇推定を `windFromAt` 補間し、寄与艇の `circMedianDeg` で統合。
- Note: windaxis の `estimateWindAxisSeries`（Task 10）は未完のため **estimator は注入式**。本タスクはモック estimator で完結し、実配線は Task 10（app.js）で行う。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` に追記:

```js
import { unifyWindAxis } from '../src/vmg.js';

test('unifyWindAxis: 3艇推定を円周中央値で統合', () => {
  const t0 = 1_787_000_000_000;
  const mk = (deg) => ({ id: `b${deg}`, points: [], _deg: deg });
  const estimator = (track) => [
    { tMs: t0, windFromDeg: track._deg }, { tMs: t0 + 10000, windFromDeg: track._deg },
  ];
  const tracks = [mk(10), mk(12), mk(14)];
  const unified = unifyWindAxis(tracks, { estimator, gridMs: 5000 });
  assert.ok(unified.length > 0);
  nearCirc(windFromAt(unified, t0 + 5000), 12); // 中央値
});

test('unifyWindAxis: estimator 未指定はエラー', () => {
  assert.throws(() => unifyWindAxis([{ id: 'x', points: [] }], {}));
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`unifyWindAxis is not a function`）

- [ ] **Step 3: 最小実装**

`src/vmg.js` に追記:

```js
// 全艇の風軸推定を共通グリッド上で円周中央値統合し、単一 WindEstimate[] を返す。
// estimator は windaxis の estimateWindAxisSeries を想定（疎結合のため注入式・必須）。
export function unifyWindAxis(tracks, { estimator, marks, gridMs = 5000 } = {}) {
  if (typeof estimator !== 'function') {
    throw new Error('unifyWindAxis: estimator（風軸推定関数）が必要です');
  }
  const perBoat = tracks.map((t) => estimator(t, { marks })).filter((s) => s && s.length);
  if (perBoat.length === 0) return [];
  let lo = Infinity, hi = -Infinity;
  for (const s of perBoat) { lo = Math.min(lo, s[0].tMs); hi = Math.max(hi, s[s.length - 1].tMs); }

  const out = [];
  for (let t = lo; t <= hi; t += gridMs) {
    const degs = [];
    for (const s of perBoat) {
      if (t < s[0].tMs || t > s[s.length - 1].tMs) continue; // 範囲外の艇は寄与させない
      const w = windFromAt(s, t);
      if (w != null) degs.push(w);
    }
    if (degs.length === 0) continue;
    out.push({ tMs: t, windFromDeg: circMedianDeg(degs), source: 'unified', confidence: degs.length / perBoat.length });
  }
  return out;
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/vmg.js test/vmg.test.js
git commit -m "feat(vmg): 全艇統合風軸 unifyWindAxis（注入式estimator）を追加"
```

---

## Task 8: 地図ハイライト描画（`renderer.js`）

**Files:**
- Modify: `src/renderer.js`
- Test: 手動（Canvas描画のため）＋ `test/vmg.test.js` に純ヘルパのテスト

**Interfaces:**
- Consumes: `state.vmgHighlights: {boatId,color,lo,hi}[]`（Task 6 の `highlights`）, `state.tracks`
- Produces: `trackForHighlight(tracks, boatId) → track|null`（純ヘルパ、`renderer.js` から export）と、`drawScene` 内の勝ちレグ帯の重ね描き。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmg.test.js` に追記（純ヘルパのみ検証。描画は手動）:

```js
import { trackForHighlight } from '../src/renderer.js';

test('trackForHighlight: boatId でトラックを引く', () => {
  const tracks = [{ id: 'A' }, { id: 'B' }];
  assert.equal(trackForHighlight(tracks, 'B').id, 'B');
  assert.equal(trackForHighlight(tracks, 'Z'), null);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmg.test.js`
Expected: FAIL（`trackForHighlight is not a function`）

- [ ] **Step 3: 最小実装**

`src/renderer.js` の先頭付近（`toScreen` の後）に純ヘルパを追加:

```js
// vmgHighlights の boatId から対象トラックを引く（純関数）。
export function trackForHighlight(tracks, boatId) {
  return tracks.find((t) => t.id === boatId) || null;
}
```

`drawScene` 内、ポリライン描画ループ（`for (const tr of tracks) { ... }`）の**直後・コースマーク描画の前**に勝ちレグ帯を重ね描き:

```js
  // VMG勝ちレグのハイライト（既存線の上に太い低透明グローを艇色で重ねる）
  const vmgHighlights = state.vmgHighlights || [];
  for (const h of vmgHighlights) {
    const tr = trackForHighlight(tracks, h.boatId);
    if (!tr || !tr.visible) continue;
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 7;
    ctx.globalAlpha = 0.35;
    ctx.lineCap = 'round';
    strokePolyline(ctx, tr.points, T, (p) => p.t >= h.lo && p.t <= h.hi);
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmg.test.js`
Expected: PASS

- [ ] **Step 5: 手動確認**

`state.vmgHighlights` にダミー帯（既存トラックの `id` と時刻範囲）を一時投入し `npm run serve` で描画。太い半透明のグローが該当区間に艇色で乗ることを目視。`state.vmgHighlights` 未設定でも従来通り描画され例外が出ないことを確認。

- [ ] **Step 6: コミット**

```bash
git add src/renderer.js test/vmg.test.js
git commit -m "feat(vmg): 地図に勝ちレグのハイライト描画を追加"
```

---

## Task 9: ダッシュボードVMGパネル（`vmgview.js`）

**Files:**
- Create: `src/vmgview.js`
- Test: `test/vmgview.test.js`（純データ整形）＋DOMコントローラは手動

**Interfaces:**
- Consumes: `LegVmg[]`, `RankRow[]`（Task 3,5）, `buildChartDatasets`/`renderChart`（`src/chartview.js`）
- Produces:
  - `buildVmgChartSeries(perBoatLegVmg, pointOfSail) → { series: {boatId:[{tMs,value}]}, boats: string[] }` — レグ中点時刻に `meanVmg` を1点。
  - `buildVmgRankTable(rankRows, { colors, pointOfSail }) → string`（HTML）。首位艇を強調。
  - `createVmgPanel({ mount }) → { render(perBoatLegVmg, ranks, opts) }`（DOMコントローラ）。

- [ ] **Step 1: 失敗するテストを書く**

`test/vmgview.test.js` を新規作成:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVmgChartSeries, buildVmgRankTable } from '../src/vmgview.js';

test('buildVmgChartSeries: 走種で絞りレグ中点に点を置く', () => {
  const legs = [
    { boatId: 'A', startT: 0, endT: 100, pointOfSail: 'upwind', meanVmg: 2.5 },
    { boatId: 'A', startT: 200, endT: 300, pointOfSail: 'downwind', meanVmg: 3.1 },
  ];
  const up = buildVmgChartSeries(legs, 'upwind');
  assert.deepEqual(up.boats, ['A']);
  assert.equal(up.series.A.length, 1);
  assert.equal(up.series.A[0].tMs, 50);
  assert.equal(up.series.A[0].value, 2.5);
});

test('buildVmgRankTable: 首位艇に is-top を付与', () => {
  const rows = [
    { boatId: 'A', pointOfSail: 'upwind', meanVmg: 2.5, winRatio: 1, legCount: 1, bestLegVmg: 2.5 },
    { boatId: 'B', pointOfSail: 'upwind', meanVmg: 2.0, winRatio: 0, legCount: 1, bestLegVmg: 2.0 },
  ];
  const html = buildVmgRankTable(rows, { colors: { A: '#a', B: '#b' }, pointOfSail: 'upwind' });
  assert.ok(html.includes('is-top'));
  assert.ok(html.indexOf('A') < html.indexOf('B')); // 先頭がA
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/vmgview.test.js`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: 最小実装**

`src/vmgview.js` を新規作成:

```js
// src/vmgview.js
// ダッシュボードのVMG比較パネル。純データ整形＋Chart.js/表のDOMコントローラ。
import { buildChartDatasets, renderChart } from './chartview.js';

// 走種で絞り、各レグ中点時刻に meanVmg を1点置いた boat 別系列。
export function buildVmgChartSeries(perBoatLegVmg, pointOfSail) {
  const series = {};
  const boats = [];
  for (const l of perBoatLegVmg) {
    if (l.pointOfSail !== pointOfSail) continue;
    if (!series[l.boatId]) { series[l.boatId] = []; boats.push(l.boatId); }
    series[l.boatId].push({ tMs: (l.startT + l.endT) / 2, value: l.meanVmg });
  }
  for (const b of boats) series[b].sort((a, c) => a.tMs - c.tMs);
  return { series, boats };
}

// ランキング行のHTML表。首位（走種内先頭行）に is-top クラス。
export function buildVmgRankTable(rankRows, { colors = {}, pointOfSail }) {
  const rows = rankRows.filter((r) => r.pointOfSail === pointOfSail);
  const body = rows.map((r, i) =>
    `<tr class="${i === 0 ? 'is-top' : ''}">` +
    `<td><span class="legend-swatch" style="background:${colors[r.boatId] || '#888'}"></span>${r.boatId}</td>` +
    `<td>${r.meanVmg.toFixed(2)}</td>` +
    `<td>${(r.winRatio * 100).toFixed(0)}%</td>` +
    `<td>${r.legCount}</td>` +
    `<td>${r.bestLegVmg.toFixed(2)}</td></tr>`
  ).join('');
  return `<table class="vmg-rank"><thead><tr><th>艇</th><th>平均VMG</th><th>勝率</th><th>レグ数</th><th>最良</th></tr></thead><tbody>${body}</tbody></table>`;
}

// DOMコントローラ。mount 要素にトグル・グラフ・表を描く。
export function createVmgPanel({ mount }) {
  let pos = 'upwind';
  let chart = null;
  let last = { perBoatLegVmg: [], ranks: [], colors: {} };

  mount.innerHTML =
    '<div class="vmg-toggle">' +
    '<button type="button" data-pos="upwind" class="active">風上</button>' +
    '<button type="button" data-pos="downwind">風下</button></div>' +
    '<div class="vmg-chart-wrap"><canvas></canvas></div>' +
    '<div class="vmg-table"></div>';

  function draw() {
    const { perBoatLegVmg, ranks, colors } = last;
    const { series, boats } = buildVmgChartSeries(perBoatLegVmg, pos);
    if (chart) { try { chart.destroy(); } catch { /* noop */ } chart = null; }
    const canvas = mount.querySelector('canvas');
    const tMs = perBoatLegVmg.map((l) => (l.startT + l.endT) / 2);
    const from = tMs.length ? Math.min(...tMs) : 0;
    const to = tMs.length ? Math.max(...tMs) : 1;
    chart = renderChart(canvas, {
      datasets: buildChartDatasets({ series, boats, colors }),
      from, to, mini: false,
    });
    mount.querySelector('.vmg-table').innerHTML = buildVmgRankTable(ranks, { colors, pointOfSail: pos });
  }

  mount.querySelectorAll('.vmg-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      pos = btn.dataset.pos;
      mount.querySelectorAll('.vmg-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      draw();
    });
  });

  return {
    render(perBoatLegVmg, ranks, opts = {}) {
      last = { perBoatLegVmg, ranks, colors: opts.colors || {} };
      draw();
    },
  };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/vmgview.test.js`
Expected: PASS

- [ ] **Step 5: 手動確認**

`createVmgPanel({ mount })` を空 div に生成し、Task 6 の `analyzeFleetVmg` 出力（`perBoatLegVmg`, `ranks`）を `render` に渡して `npm run serve` で目視。風上/風下トグルでグラフと表が切替わり、首位艇の行が強調されることを確認。

- [ ] **Step 6: コミット**

```bash
git add src/vmgview.js test/vmgview.test.js
git commit -m "feat(vmg): ダッシュボードVMGパネル vmgview を追加"
```

---

## Task 10: アプリ配線とVMG強調トグル（`app.js`）

**Files:**
- Modify: `src/app.js`
- Modify: `styles.css`（VMGパネル/トグル/`is-top` の最小スタイル）
- Test: 手動（`test/smoke.test.js` / `test/dom-smoke.test.js` の既存スモークが壊れないこと）

**Interfaces:**
- Consumes: `analyzeFleetVmg`, `unifyWindAxis`（Task 6,7）, `createVmgPanel`（Task 9）, windaxis の `estimateWindAxisSeries`（Task 10 完成後）
- Produces: `state.vmgHighlights` の設定と再描画、VMGパネルの `render` 呼び出し。

- [ ] **Step 1: 配線ポイントを特定**

`src/app.js` で以下を把握（`grep -n` 推奨）:
- `state` 生成箇所（`state.tracks`, `state.crop`, `state.mode` を持つオブジェクト）
- `drawScene(ctx, state)` 呼び出し箇所（再描画関数）
- クロップ変更ハンドラ（再描画をトリガする箇所）

- [ ] **Step 2: 風軸ソースの用意（疎結合）**

windaxis の `estimateWindAxisSeries`（Task 10）が `src/windaxis.js` から export 済みか確認:

```bash
grep -n "export function estimateWindAxisSeries" src/windaxis.js
```

- 有: `import { estimateWindAxisSeries } from './windaxis.js';` を追加し、
  `const windSeries = unifyWindAxis(state.tracks, { estimator: estimateWindAxisSeries, marks: state.marks });`
- 無（未完）: `const windSeries = [];`（空）とし、VMGパネルに「風軸未推定」を表示（後日 estimator を差し替え）。

- [ ] **Step 3: VMG強調トグルと再計算関数を追加**

`app.js` に、可視・絶対時刻前提でVMGを再計算する関数を追加:

```js
import { analyzeFleetVmg } from './vmg.js';

// VMG強調の再計算。elapsed モードや風軸なしでは無効化。
function recomputeVmg(state, windSeries, vmgPanel) {
  if (!state.vmgEnabled || state.mode !== 'absolute' || windSeries.length === 0) {
    state.vmgHighlights = [];
    if (vmgPanel) vmgPanel.render([], [], { colors: {} });
    return;
  }
  const tracks = state.tracks.filter((t) => t.visible);
  const colors = Object.fromEntries(tracks.map((t) => [t.id, t.color]));
  const { perBoatLegVmg, highlights, ranks } = analyzeFleetVmg(tracks, windSeries, {
    from: state.crop.start, to: state.crop.end,
  });
  state.vmgHighlights = highlights;
  if (vmgPanel) vmgPanel.render(perBoatLegVmg, ranks, { colors });
}
```

トグルUI（既存のツールバー/サイドに合わせて1ボタン）:

```js
state.vmgEnabled = false;
vmgToggleBtn.addEventListener('click', () => {
  state.vmgEnabled = !state.vmgEnabled;
  vmgToggleBtn.classList.toggle('active', state.vmgEnabled);
  recomputeVmg(state, windSeries, vmgPanel);
  redraw(); // 既存の再描画関数
});
```

クロップ変更ハンドラ末尾で `if (state.vmgEnabled) { recomputeVmg(state, windSeries, vmgPanel); }` を呼ぶ。

- [ ] **Step 4: 最小スタイル**

`styles.css` に追記:

```css
.vmg-toggle { display: flex; gap: 4px; margin-bottom: 6px; }
.vmg-toggle button { padding: 2px 10px; }
.vmg-toggle button.active { background: #1558d6; color: #fff; }
.vmg-chart-wrap { position: relative; height: 220px; }
.vmg-rank { width: 100%; border-collapse: collapse; font-size: 12px; }
.vmg-rank th, .vmg-rank td { padding: 3px 6px; border-bottom: 1px solid #eee; text-align: left; }
.vmg-rank tr.is-top { background: rgba(21, 88, 214, 0.12); font-weight: 600; }
```

- [ ] **Step 5: スモークが壊れないことを確認**

Run: `node --test`
Expected: 既存の全テスト＋新規 `test/vmg.test.js`, `test/vmgview.test.js` が PASS。

- [ ] **Step 6: 手動確認**

`npm run serve` で複数艇（`demo-data` の複数トラック、または2トラックを読込）を開き、絶対時刻モードでVMG強調トグルON:
- 地図で各区間の勝ち艇レグがグローする。
- ダッシュボードのVMGパネルに風上/風下ランキングとグラフが出る。
- elapsed モードや1艇のみではハイライトが出ず例外も出ない。
- windaxis 未完時はパネルに「風軸未推定」表示（estimator 差し替えで解消）。

- [ ] **Step 7: コミット**

```bash
git add src/app.js styles.css
git commit -m "feat(vmg): VMG強調トグルとダッシュボード配線を追加"
```

---

## Self-Review

**Spec coverage:**
- §3① 風軸補間 → Task 1 ✓
- §3② 1サンプルVMG → Task 2 ✓
- §3③ レグ分割・走種判定・レグ平均VMG → Task 2（走種）+ Task 3（平均）✓
- §3④ 勝ち艇タイムライン → Task 4 ✓
- §3⑤ ランキング → Task 5 ✓
- §3⑥ 統合風軸 → Task 7 ✓
- §4 地図ハイライト → Task 8 ✓／ダッシュボードパネル → Task 9 ✓／アプリ配線 → Task 10 ✓
- §5 エッジ（時間重複・elapsed・単一艇・リーチ短レグ）→ Task 3（リーチ）, Task 4（minBoats/重複）, Task 10（elapsed/単一艇/風軸なし）✓
- §6 テスト → 各タスクのテスト＋Task 6 の pincher/footer 相当（fast/slow）✓
- 統合エントリ `analyzeFleetVmg` → Task 6 ✓

**Placeholder scan:** プレースホルダ無し。DOM系（Task 8-10）は純ヘルパを分離してテストし、描画は手動確認手順を明記。

**Type consistency:**
- `LegVmg` フィールド（`boatId,startT,endT,pointOfSail,meanVmg,meanSpeed,meanTwa,lenM,durSec,nSamples,confidence`）は Task 3 で定義、Task 4/5/6/9 で同名参照 ✓
- `Highlight`（`boatId,color,lo,hi,pointOfSail,vmg`）は Task 4 で定義、Task 5（highlights）/6/8 で同名参照 ✓
- `RankRow`（`boatId,pointOfSail,meanVmg,winRatio,legCount,bestLegVmg`）は Task 5 で定義、Task 9 で同名参照 ✓
- `windSeries` 要素は `{tMs,windFromDeg}`（Task 1）。windaxis `WindEstimate` は上位互換（`tMs,windFromDeg` を含む）✓
- `analyzeFleetVmg` 戻り値 `{perBoatLegVmg,highlights,ranks}` は Task 6 定義、Task 10 で分割参照 ✓
