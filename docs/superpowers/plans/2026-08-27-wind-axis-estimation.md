# 風軸推定 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPS軌跡から、タック/ジャイブの幾何と学習した帆走角に基づき、各タイミングの風軸(風向)を時系列推定する `src/windaxis.js` を実装し、ダッシュボードに風軸グラフを追加する。

**Architecture:** 位置から算出したCOG列をレグ/マニューバに分割し、マニューバ前後レグの内側二等分線から風軸アンカーを得る(タックは風上、ジャイブは風下=+180°)。タック/ジャイブからクローズ角・ランニング角を学習し、ビート/ランのレグ内を連続推定。マーク近傍・幾何・ロバスト統計で飛び値を除去し、円周量の移動中央値で平滑化する。すべて純粋関数として `src/windaxis.js` に集約し `node:test` でTDD。可視化はダッシュボードに専用パネルとして追加。

**Tech Stack:** Vanilla JS / ES Modules（`"type":"module"`）/ ビルドなし / `node --test`（`node:test` + `node:assert/strict`）/ Chart.js（既存 `src/chartview.js` 経由）

**Spec:** `docs/superpowers/specs/2026-08-27-wind-axis-estimation-design.md`

## Global Constraints

- 外部依存を追加しない（純粋 stdlib + ブラウザAPIのみ）。テストは `node --test`。
- ESモジュール（`import`/`export`）。ファイル拡張子は `.js`、相対importに `.js` を明記。
- 角度はすべて度（deg）、方位は0=北・時計回り・[0,360) 正規化。時刻はエポックms。
- コメント・ドキュメント文字列は既存流儀に合わせ日本語で簡潔に。
- 純粋関数のみを `src/windaxis.js` に置き、DOM/副作用を持ち込まない（可視化は別ファイル）。
- 既存 `src/gps.js` の `haversineMeters(a,b)`、`src/interpolate.js` の `positionAt(points,t)` / `speedAt(points,t)` を再利用する（重複実装しない）。

---

## ファイル構成

- Create: `src/windaxis.js` — 円周演算＋風軸推定の純粋関数群（Task 1〜10）
- Create: `test/windaxis.test.js` — 上記のTDDテスト（Task 1〜10で追記）
- Create: `src/windaxisview.js` — 風軸系列→Chart.jsデータ整形（純粋、Task 11）
- Create: `test/windaxisview.test.js` — Task 11のテスト
- Modify: `index.html`、`src/dashboard.js`（または新規パネル配線）、`src/app.js` — 描画配線（Task 12、手動検証）

各Taskは独立してテスト可能な成果物で終わる。テスト実行は原則 `node --test test/windaxis.test.js`（単一ファイル）または `npm test`（全体）。

---

### Task 1: 円周演算ユーティリティ

**Files:**
- Create: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `normalizeDeg(d: number) → number`（[0,360)）
  - `circDiffDeg(a: number, b: number) → number`（a−b を (−180,180] に正規化した符号付き差）
  - `circMeanDeg(degs: number[]) → number`（円周平均, [0,360)）
  - `circMedianDeg(degs: number[]) → number`（ロバスト円周中央値, [0,360)）
  - `bisectorDeg(a: number, b: number) → number`（内側=短弧側の二等分方位, [0,360)）
  - `bearingDeg(from: {lat,lon}, to: {lat,lon}) → number`（初期方位, [0,360)）

- [ ] **Step 1: 失敗するテストを書く**

`test/windaxis.test.js` を新規作成：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeg, circDiffDeg, circMeanDeg, circMedianDeg, bisectorDeg, bearingDeg,
} from '../src/windaxis.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// 円周量の近さ（北またぎ対応）
const nearCirc = (a, b, eps = 0.5) =>
  assert.ok(Math.abs(circDiffDeg(a, b)) < eps, `circ ${a} != ${b}`);

test('normalizeDeg wraps into [0,360)', () => {
  near(normalizeDeg(370), 10);
  near(normalizeDeg(-10), 350);
  near(normalizeDeg(0), 0);
});

test('circDiffDeg signed shortest difference', () => {
  near(circDiffDeg(10, 350), 20);    // 10 - 350 = -340 -> +20
  near(circDiffDeg(350, 10), -20);
  near(circDiffDeg(90, 0), 90);
});

test('circMeanDeg averages across north', () => {
  nearCirc(circMeanDeg([350, 10]), 0);
  nearCirc(circMeanDeg([10, 20, 30]), 20);
});

test('circMedianDeg is robust to an outlier', () => {
  nearCirc(circMedianDeg([9, 10, 11, 200]), 10);
  nearCirc(circMedianDeg([358, 0, 2]), 0);
});

test('bisectorDeg picks the inner bisector', () => {
  nearCirc(bisectorDeg(45, 315), 0);    // タック: 風上
  nearCirc(bisectorDeg(135, 225), 180);  // ジャイブ: 風下
});

test('bearingDeg north/east', () => {
  nearCirc(bearingDeg({ lat: 35.30, lon: 139.48 }, { lat: 35.31, lon: 139.48 }), 0, 1);
  nearCirc(bearingDeg({ lat: 35.30, lon: 139.48 }, { lat: 35.30, lon: 139.49 }), 90, 1);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL（`Cannot find module '../src/windaxis.js'` もしくは未定義エラー）

- [ ] **Step 3: 最小実装**

`src/windaxis.js` を新規作成：

```js
// src/windaxis.js
// GPS軌跡からの風軸(風向)推定。円周演算＋レグ分割＋タック/ジャイブ幾何＋帆走角学習。
// すべて純粋関数。DOM/副作用なし。
import { haversineMeters } from './gps.js';
import { positionAt, speedAt } from './interpolate.js';

const DEG = Math.PI / 180;

export function normalizeDeg(d) {
  return ((d % 360) + 360) % 360;
}

// a - b を (-180, 180] に正規化した符号付き差
export function circDiffDeg(a, b) {
  return ((a - b + 540) % 360) - 180;
}

export function circMeanDeg(degs) {
  let x = 0, y = 0;
  for (const d of degs) { x += Math.cos(d * DEG); y += Math.sin(d * DEG); }
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

// 円周中央値: 円周平均を基準に偏差の(線形)中央値を足し戻す（分散<180°で有効）
export function circMedianDeg(degs) {
  if (degs.length === 0) return 0;
  const ref = circMeanDeg(degs);
  const devs = degs.map((d) => circDiffDeg(d, ref)).sort((p, q) => p - q);
  const m = devs.length % 2
    ? devs[(devs.length - 1) / 2]
    : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;
  return normalizeDeg(ref + m);
}

// 内側(短弧側)の二等分方位
export function bisectorDeg(a, b) {
  return normalizeDeg(a + circDiffDeg(b, a) / 2);
}

export function bearingDeg(from, to) {
  const φ1 = from.lat * DEG, φ2 = to.lat * DEG;
  const Δλ = (to.lon - from.lon) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(Math.atan2(y, x) / DEG);
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS（6テスト）

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): 円周演算ユーティリティを追加"
```

---

### Task 2: COG算出（`computeCog`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `positionAt`, `speedAt`（interpolate.js）, `normalizeDeg`, `bearingDeg`（Task 1）
- Produces:
  - `computeCog(points: Point[], opts?: {windowMs?, minSpeedMps?}) → Sample[]`
    - `Point = {t, lat, lon, speed, bearing, accuracy}`（既存 gps.js）
    - `Sample = {t, lat, lon, cog, speed}`（`speed >= minSpeedMps` の点のみ、時刻昇順）
    - 既定 `windowMs=3000`, `minSpeedMps=1.5`

- [ ] **Step 1: 失敗するテストを書く**

`test/windaxis.test.js` に追記：

```js
import { computeCog } from '../src/windaxis.js';

// 東へ一定速で進む合成トラック（0.2s刻み, 経度増加=東）を作る
function eastwardTrack(n = 40, dtMs = 200, speed = 3) {
  const pts = [];
  let lat = 35.30, lon = 139.48;
  const t0 = 1_787_000_000_000;
  const mPerDegLon = 111_320 * Math.cos(lat * Math.PI / 180);
  for (let i = 0; i < n; i++) {
    pts.push({ t: t0 + i * dtMs, lat, lon, speed, bearing: 90, accuracy: 5 });
    lon += (speed * (dtMs / 1000)) / mPerDegLon; // 東へ
  }
  return pts;
}

test('computeCog: 東進トラックのCOGは約90度', () => {
  const samples = computeCog(eastwardTrack(), { windowMs: 1000, minSpeedMps: 1 });
  assert.ok(samples.length > 0);
  for (const s of samples) assert.ok(Math.abs(circDiffDeg(s.cog, 90)) < 2, `cog=${s.cog}`);
});

test('computeCog: 低速点を除外する', () => {
  const pts = eastwardTrack(10, 200, 0.5); // すべて低速
  const samples = computeCog(pts, { minSpeedMps: 1.5 });
  assert.equal(samples.length, 0);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL（`computeCog is not a function`）

- [ ] **Step 3: 最小実装**

`src/windaxis.js` に追記：

```js
// 位置から中心差分でCOGを算出し、speed>=閾値の点のみ返す
export function computeCog(points, opts = {}) {
  const windowMs = opts.windowMs ?? 3000;
  const minSpeedMps = opts.minSpeedMps ?? 1.5;
  const half = windowMs / 2;
  const out = [];
  for (const p of points) {
    const a = positionAt(points, p.t - half);
    const b = positionAt(points, p.t + half);
    if (!a || !b) continue; // 端点は窓が取れないので除外
    const sp = speedAt(points, p.t);
    if (sp == null || sp < minSpeedMps) continue;
    out.push({ t: p.t, lat: p.lat, lon: p.lon, cog: bearingDeg(a, b), speed: sp });
  }
  return out;
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): 位置からのCOG算出を追加"
```

---

### Task 3: レグ/マニューバ分割（`segmentLegs`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `haversineMeters`, `circDiffDeg`, `circMedianDeg`（Task 1）
- Produces:
  - `segmentLegs(samples: Sample[], opts?) → { legs: Leg[], maneuvers: Maneuver[] }`
    - 既定 `turnRateThreshDegPerSec=8, minLegSec=8, minLegM=20, settleSec=12, settleM=30`
    - `Leg = { startT, endT, headingDeg, meanSpeed, lenM, samples: Sample[], kind: 'unknown' }`
    - `Maneuver = { tMs, lat, lon, legBeforeIdx, legAfterIdx, headingBefore, headingAfter, turnDeg, minSpeed, speedDropRatio }`
    - `headingDeg` はセトリング区間（開始後 `settleSec`/`settleM`）と末尾の小区間を除いた「落ち着き区間」の `circMedianDeg`。除外後が空なら全体で代替。

- [ ] **Step 1: 失敗するテストを書く**

`test/windaxis.test.js` に追記。既知風向0°(北)のビート（スタボ45°→タック→ポート315°）を合成：

```js
import { segmentLegs } from '../src/windaxis.js';

// 指定方位・速度で一定時間直進するサンプル列を生成（cog付きSampleを直接作る）
function straightSamples(t0, headingDeg, seconds, speed = 3, dtMs = 500, startLL = null) {
  const out = [];
  let lat = startLL ? startLL.lat : 35.30;
  let lon = startLL ? startLL.lon : 139.48;
  const rad = headingDeg * Math.PI / 180;
  const mLat = 111_320, mLon = 111_320 * Math.cos(lat * Math.PI / 180);
  const n = Math.floor((seconds * 1000) / dtMs);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dtMs;
    out.push({ t, lat, lon, cog: headingDeg, speed });
    lat += (Math.cos(rad) * speed * (dtMs / 1000)) / mLat;
    lon += (Math.sin(rad) * speed * (dtMs / 1000)) / mLon;
  }
  return out;
}

// スタボ45° 30s → ポート315° 30s（間に1点だけ低速の旋回を挟む形は簡略化し連結）
function beatTwoLegs() {
  const t0 = 1_787_000_000_000;
  const leg1 = straightSamples(t0, 45, 30);
  const last = leg1[leg1.length - 1];
  const leg2 = straightSamples(last.t + 500, 315, 30, 3, 500, { lat: last.lat, lon: last.lon });
  return [...leg1, ...leg2];
}

test('segmentLegs: 2レグと1マニューバを検出し代表方位を復元', () => {
  const { legs, maneuvers } = segmentLegs(beatTwoLegs(), { minLegSec: 5, settleSec: 4 });
  assert.equal(legs.length, 2);
  assert.equal(maneuvers.length, 1);
  assert.ok(Math.abs(circDiffDeg(legs[0].headingDeg, 45)) < 3);
  assert.ok(Math.abs(circDiffDeg(legs[1].headingDeg, 315)) < 3);
  assert.ok(Math.abs(circDiffDeg(maneuvers[0].turnDeg, 90)) < 5 || Math.abs(maneuvers[0].turnDeg - 90) < 5);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL（`segmentLegs is not a function`）

- [ ] **Step 3: 最小実装**

`src/windaxis.js` に追記：

```js
// レグの落ち着き区間から代表方位を求める（セトリング＋末尾を除外して circMedianDeg）
function representativeHeading(seg, settleSec, settleM) {
  if (seg.length === 0) return { headingDeg: 0, meanSpeed: 0, lenM: 0 };
  // 距離累積
  let lenM = 0;
  for (let i = 1; i < seg.length; i++) lenM += haversineMeters(seg[i - 1], seg[i]);
  const start = seg[0];
  // 開始からの経過(時間 or 距離)がセトリングを超えた点だけを steady とする
  const steady = [];
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (i > 0) acc += haversineMeters(seg[i - 1], seg[i]);
    const dtSec = (seg[i].t - start.t) / 1000;
    if (dtSec >= settleSec && acc >= settleM) steady.push(seg[i]);
  }
  // 末尾の小区間(旋回直前)を軽く落とす: steady の最後10%を除外
  const trimmed = steady.slice(0, Math.max(1, Math.floor(steady.length * 0.9)));
  const use = trimmed.length ? trimmed : seg;
  const headingDeg = circMedianDeg(use.map((s) => s.cog));
  const meanSpeed = use.reduce((a, s) => a + s.speed, 0) / use.length;
  return { headingDeg, meanSpeed, lenM };
}

export function segmentLegs(samples, opts = {}) {
  const turnThresh = opts.turnRateThreshDegPerSec ?? 8;
  const minLegSec = opts.minLegSec ?? 8;
  const minLegM = opts.minLegM ?? 20;
  const settleSec = opts.settleSec ?? 12;
  const settleM = opts.settleM ?? 30;

  // 1) 各サンプル間の旋回レートで「旋回中」フラグを付ける
  const turning = new Array(samples.length).fill(false);
  for (let i = 1; i < samples.length; i++) {
    const dtSec = (samples[i].t - samples[i - 1].t) / 1000;
    if (dtSec <= 0) continue;
    const rate = Math.abs(circDiffDeg(samples[i].cog, samples[i - 1].cog)) / dtSec;
    if (rate > turnThresh) { turning[i] = true; turning[i - 1] = true; }
  }

  // 2) 非旋回の連続区間をレグ候補に、旋回区間をマニューバ帯にする
  const legs = [];
  const maneuverZones = []; // {startIdx,endIdx}
  let i = 0;
  while (i < samples.length) {
    if (turning[i]) {
      const s = i;
      while (i < samples.length && turning[i]) i++;
      maneuverZones.push({ startIdx: s, endIdx: i - 1 });
    } else {
      const s = i;
      while (i < samples.length && !turning[i]) i++;
      const seg = samples.slice(s, i);
      const durSec = seg.length ? (seg[seg.length - 1].t - seg[0].t) / 1000 : 0;
      const rep = representativeHeading(seg, settleSec, settleM);
      if (durSec >= minLegSec && rep.lenM >= minLegM) {
        legs.push({
          startT: seg[0].t, endT: seg[seg.length - 1].t,
          headingDeg: rep.headingDeg, meanSpeed: rep.meanSpeed, lenM: rep.lenM,
          samples: seg, kind: 'unknown',
        });
      }
    }
  }

  // 3) 隣接レグ間にマニューバを1つ作る
  const maneuvers = [];
  for (let k = 1; k < legs.length; k++) {
    const before = legs[k - 1], after = legs[k];
    // 間にある旋回帯の最低速
    const zone = maneuverZones.find((z) => samples[z.startIdx].t >= before.endT && samples[z.endIdx].t <= after.startT);
    let minSpeed = Math.min(before.meanSpeed, after.meanSpeed);
    let mid = { lat: (before.samples.at(-1).lat + after.samples[0].lat) / 2, lon: (before.samples.at(-1).lon + after.samples[0].lon) / 2 };
    if (zone) {
      for (let z = zone.startIdx; z <= zone.endIdx; z++) minSpeed = Math.min(minSpeed, samples[z].speed);
      const midSample = samples[Math.floor((zone.startIdx + zone.endIdx) / 2)];
      mid = { lat: midSample.lat, lon: midSample.lon };
    }
    const legAvg = (before.meanSpeed + after.meanSpeed) / 2 || 1;
    maneuvers.push({
      tMs: (before.endT + after.startT) / 2,
      lat: mid.lat, lon: mid.lon,
      legBeforeIdx: k - 1, legAfterIdx: k,
      headingBefore: before.headingDeg, headingAfter: after.headingDeg,
      turnDeg: Math.abs(circDiffDeg(after.headingDeg, before.headingDeg)),
      minSpeed, speedDropRatio: minSpeed / legAvg,
    });
  }
  return { legs, maneuvers };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): レグ/マニューバ分割とセトリング除外の代表方位を追加"
```

---

### Task 4: タック/ジャイブ判別（`classifyManeuver`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `Maneuver`（Task 3）
- Produces:
  - `classifyManeuver(m: Maneuver, opts?: {tackMaxSpeedDropRatio?}) → { type: 'tack'|'gybe', confidence: number }`
    - 既定 `tackMaxSpeedDropRatio=0.6`。`speedDropRatio < 閾値`（＝大きく失速）→ `'tack'`、そうでなければ `'gybe'`。
    - `confidence` は閾値からの距離を0..1にクランプ。

- [ ] **Step 1: 失敗するテストを書く**

```js
import { classifyManeuver } from '../src/windaxis.js';

test('classifyManeuver: 大きく失速=タック / 速度維持=ジャイブ', () => {
  const tack = classifyManeuver({ speedDropRatio: 0.3, turnDeg: 90 });
  const gybe = classifyManeuver({ speedDropRatio: 0.9, turnDeg: 90 });
  assert.equal(tack.type, 'tack');
  assert.equal(gybe.type, 'gybe');
  assert.ok(tack.confidence > 0 && tack.confidence <= 1);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL（`classifyManeuver is not a function`）

- [ ] **Step 3: 最小実装**

```js
// 減速比でタック/ジャイブを判別（タックは失速が大きい）
export function classifyManeuver(m, opts = {}) {
  const thr = opts.tackMaxSpeedDropRatio ?? 0.6;
  const type = m.speedDropRatio < thr ? 'tack' : 'gybe';
  const confidence = Math.max(0, Math.min(1, Math.abs(m.speedDropRatio - thr) / thr));
  return { type, confidence };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): 減速比によるタック/ジャイブ判別を追加"
```

---

### Task 5: マニューバからの風軸アンカー（`estimateWindFromManeuver`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `bisectorDeg`, `normalizeDeg`（Task 1）
- Produces:
  - `estimateWindFromManeuver(m: Maneuver & {type, confidence}) → Anchor`
    - `Anchor = { tMs, lat, lon, windFromDeg, type, confidence, headingBefore, headingAfter, source: 'anchor' }`
    - `windFromDeg = type==='tack' ? bisector : normalizeDeg(bisector+180)`（bisector は前後レグ方位の内側二等分）

- [ ] **Step 1: 失敗するテストを書く**

```js
import { estimateWindFromManeuver } from '../src/windaxis.js';

test('estimateWindFromManeuver: タックは風上=二等分、ジャイブは+180', () => {
  const base = { tMs: 1, lat: 35.3, lon: 139.48, headingBefore: 45, headingAfter: 315, confidence: 1 };
  const tack = estimateWindFromManeuver({ ...base, type: 'tack' });
  const gybe = estimateWindFromManeuver({ ...base, headingBefore: 135, headingAfter: 225, type: 'gybe' });
  assert.ok(Math.abs(circDiffDeg(tack.windFromDeg, 0)) < 0.5);   // 風上=北
  assert.ok(Math.abs(circDiffDeg(gybe.windFromDeg, 0)) < 0.5);   // 風下180 -> 風上0
  assert.equal(tack.source, 'anchor');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL

- [ ] **Step 3: 最小実装**

```js
// マニューバ前後レグの二等分から風向(風上)を推定。ジャイブは風下なので+180。
export function estimateWindFromManeuver(m) {
  const bis = bisectorDeg(m.headingBefore, m.headingAfter);
  const windFromDeg = m.type === 'tack' ? bis : normalizeDeg(bis + 180);
  return {
    tMs: m.tMs, lat: m.lat, lon: m.lon, windFromDeg,
    type: m.type, confidence: m.confidence,
    headingBefore: m.headingBefore, headingAfter: m.headingAfter,
    source: 'anchor',
  };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): マニューバ二等分からの風軸アンカー推定を追加"
```

---

### Task 6: 帆走角の学習（`learnPolarAngles`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `circDiffDeg`, `normalizeDeg`, `circMedianDeg`（Task 1）, `Anchor`（Task 5）
- Produces:
  - `learnPolarAngles(anchors: Anchor[]) → { betaCloseHauled: number|null, betaRun: number|null }`
    - タックアンカーから `betaCloseHauled = median(|circDiffDeg(heading, windFrom)|)`（before/after両方）
    - ジャイブアンカーから `betaRun = median(|circDiffDeg(heading, windFrom+180)|)`
    - 該当アンカーが無い側は `null`

- [ ] **Step 1: 失敗するテストを書く**

```js
import { learnPolarAngles } from '../src/windaxis.js';

test('learnPolarAngles: クローズ角とランニング角を学習', () => {
  const anchors = [
    { type: 'tack', windFromDeg: 0, headingBefore: 45, headingAfter: 315 },
    { type: 'gybe', windFromDeg: 0, headingBefore: 135, headingAfter: 225 },
  ];
  const { betaCloseHauled, betaRun } = learnPolarAngles(anchors);
  assert.ok(Math.abs(betaCloseHauled - 45) < 1);
  assert.ok(Math.abs(betaRun - 45) < 1);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL

- [ ] **Step 3: 最小実装**

```js
// 線形中央値（帆走角は0..90付近で北またぎしないため単純中央値でよい）
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// タック=クローズ角(風向からレグまでの角)、ジャイブ=ランニング半角(風下からレグまで)
export function learnPolarAngles(anchors) {
  const ch = [], run = [];
  for (const a of anchors) {
    if (a.type === 'tack') {
      ch.push(Math.abs(circDiffDeg(a.headingBefore, a.windFromDeg)));
      ch.push(Math.abs(circDiffDeg(a.headingAfter, a.windFromDeg)));
    } else if (a.type === 'gybe') {
      const down = normalizeDeg(a.windFromDeg + 180);
      run.push(Math.abs(circDiffDeg(a.headingBefore, down)));
      run.push(Math.abs(circDiffDeg(a.headingAfter, down)));
    }
  }
  return { betaCloseHauled: median(ch), betaRun: median(run) };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): タック/ジャイブからの帆走角学習を追加"
```

---

### Task 7: レグ種別判定とレグ内連続推定（`assignLegKinds` / `fillLegEstimates`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `circDiffDeg`, `normalizeDeg`（Task 1）, `Leg`/`Maneuver`（Task 3）, `Anchor`（Task 5）, polar（Task 6）
- Produces:
  - `assignLegKinds(legs: Leg[], maneuvers: (Maneuver & {type})[]) → Leg[]`（各 `leg.kind` を `'beat'|'run'|'reach'` に更新して返す。両側タック=beat、両側ジャイブ=run、それ以外=reach。片側のみの端レグは隣接マニューバ型で近似）
  - `fillLegEstimates(legs: Leg[], anchors: Anchor[], polar, opts?: {stepMs?}) → WindEstimate[]`
    - beat/run のレグのみ。最寄りアンカーの `windFromDeg` から符号 `s = sign(circDiffDeg(leg.headingDeg, ref))` を決め、各サンプルで
      beat: `windFrom = normalizeDeg(cog − s*betaCloseHauled)`、run: `windFrom = normalizeDeg(cog − (180 − s*betaRun))`
    - `WindEstimate = { tMs, windFromDeg, type: null, confidence, source: 'leg' }`（confidence は低め ~0.4）
    - 既定 `stepMs=5000`

- [ ] **Step 1: 失敗するテストを書く**

```js
import { assignLegKinds, fillLegEstimates } from '../src/windaxis.js';

test('assignLegKinds: 両側タックのレグはbeat', () => {
  const legs = [{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }];
  const mans = [
    { legBeforeIdx: 0, legAfterIdx: 1, type: 'tack' },
    { legBeforeIdx: 1, legAfterIdx: 2, type: 'tack' },
  ];
  const out = assignLegKinds(legs, mans);
  assert.equal(out[1].kind, 'beat');
});

test('fillLegEstimates: ビートのレグ内でcogからwindFromを逆算', () => {
  const legs = [{
    kind: 'beat', headingDeg: 45, startT: 0, endT: 20000,
    samples: [{ t: 0, cog: 45, lat: 35.3, lon: 139.48, speed: 3 },
              { t: 10000, cog: 48, lat: 35.3, lon: 139.48, speed: 3 }],
  }];
  const anchors = [{ tMs: 0, windFromDeg: 0, type: 'tack' }];
  const est = fillLegEstimates(legs, anchors, { betaCloseHauled: 45, betaRun: 45 }, { stepMs: 10000 });
  assert.ok(est.length >= 1);
  assert.equal(est[0].source, 'leg');
  assert.ok(Math.abs(circDiffDeg(est[0].windFromDeg, 0)) < 1);  // cog45 - 45 = 0
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL

- [ ] **Step 3: 最小実装**

```js
// 各レグを囲むマニューバ型からレグ種別を決める
export function assignLegKinds(legs, maneuvers) {
  for (let k = 0; k < legs.length; k++) {
    const prev = maneuvers.find((m) => m.legAfterIdx === k);
    const next = maneuvers.find((m) => m.legBeforeIdx === k);
    const types = [prev?.type, next?.type].filter(Boolean);
    if (types.length && types.every((t) => t === 'tack')) legs[k].kind = 'beat';
    else if (types.length && types.every((t) => t === 'gybe')) legs[k].kind = 'run';
    else legs[k].kind = 'reach';
  }
  return legs;
}

// 最寄りアンカー（時間差最小）
function nearestAnchor(anchors, tMs) {
  let best = null, bestDt = Infinity;
  for (const a of anchors) {
    const dt = Math.abs(a.tMs - tMs);
    if (dt < bestDt) { bestDt = dt; best = a; }
  }
  return best;
}

// beat/run のレグ内をcogから連続推定（アンカー基準で符号sを決定）
export function fillLegEstimates(legs, anchors, polar, opts = {}) {
  const stepMs = opts.stepMs ?? 5000;
  const out = [];
  for (const leg of legs) {
    if (leg.kind !== 'beat' && leg.kind !== 'run') continue;
    if (leg.kind === 'beat' && polar.betaCloseHauled == null) continue;
    if (leg.kind === 'run' && polar.betaRun == null) continue;
    const ref = nearestAnchor(anchors, (leg.startT + leg.endT) / 2);
    if (!ref) continue;
    const s = Math.sign(circDiffDeg(leg.headingDeg, ref.windFromDeg)) || 1;
    for (let t = leg.startT; t <= leg.endT; t += stepMs) {
      // レグ内の最寄りサンプルのcog
      let cog = leg.headingDeg, bestDt = Infinity;
      for (const smp of leg.samples) {
        const dt = Math.abs(smp.t - t);
        if (dt < bestDt) { bestDt = dt; cog = smp.cog; }
      }
      const windFromDeg = leg.kind === 'beat'
        ? normalizeDeg(cog - s * polar.betaCloseHauled)
        : normalizeDeg(cog - (180 - s * polar.betaRun));
      out.push({ tMs: t, windFromDeg, type: null, confidence: 0.4, source: 'leg' });
    }
  }
  return out;
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): レグ種別判定とレグ内連続推定を追加"
```

---

### Task 8: マーク近傍除去（`rejectMarkRoundings`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `haversineMeters`（gps.js）
- Produces:
  - `rejectMarkRoundings(maneuvers: Maneuver[], marks: {lat,lon}[], opts?: {radiusM?}) → Maneuver[]`
    - `marks` のいずれかから `radiusM`（既定30）以内のマニューバを除外。`marks` 空なら素通し。

- [ ] **Step 1: 失敗するテストを書く**

```js
import { rejectMarkRoundings } from '../src/windaxis.js';

test('rejectMarkRoundings: マーク近傍のマニューバを除外', () => {
  const mans = [
    { tMs: 1, lat: 35.2937, lon: 139.4898 }, // マーク直近
    { tMs: 2, lat: 35.3100, lon: 139.4800 }, // 遠い
  ];
  const marks = [{ lat: 35.2937, lon: 139.4898 }];
  const out = rejectMarkRoundings(mans, marks, { radiusM: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].tMs, 2);
});

test('rejectMarkRoundings: marks空なら素通し', () => {
  const mans = [{ tMs: 1, lat: 35.3, lon: 139.48 }];
  assert.equal(rejectMarkRoundings(mans, [], {}).length, 1);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL

- [ ] **Step 3: 最小実装**

```js
// マーク近傍(回航)のマニューバを除外
export function rejectMarkRoundings(maneuvers, marks, opts = {}) {
  const radiusM = opts.radiusM ?? 30;
  if (!marks || marks.length === 0) return maneuvers;
  return maneuvers.filter((m) => marks.every((mk) => haversineMeters(m, mk) > radiusM));
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): マーク近傍のマニューバ除去を追加"
```

---

### Task 9: ロバスト平滑化（`smoothWindSeries`）

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: `circDiffDeg`, `circMedianDeg`（Task 1）
- Produces:
  - `smoothWindSeries(series: WindEstimate[], opts?: {windowMs?, madK?, minMadDeg?}) → WindEstimate[]`
    - 時刻昇順にソート。各点で±`windowMs/2` の近傍の `circMedianDeg` を局所中央値とし、|偏差|>`max(madK*MAD, minMadDeg)` の点を外れ値として除去。
    - 残った点の `windFromDeg` を局所中央値に置換して返す（`confidence`/`source`/`type` は保持）。
    - 既定 `windowMs=120000, madK=3, minMadDeg=25`

- [ ] **Step 1: 失敗するテストを書く**

```js
import { smoothWindSeries } from '../src/windaxis.js';

test('smoothWindSeries: 飛び値を除去し局所中央値に平滑化', () => {
  const series = [
    { tMs: 0, windFromDeg: 10, confidence: 1, source: 'anchor', type: 'tack' },
    { tMs: 1000, windFromDeg: 12, confidence: 1, source: 'anchor', type: 'tack' },
    { tMs: 2000, windFromDeg: 200, confidence: 1, source: 'anchor', type: 'tack' }, // 飛び値
    { tMs: 3000, windFromDeg: 11, confidence: 1, source: 'anchor', type: 'tack' },
    { tMs: 4000, windFromDeg: 13, confidence: 1, source: 'anchor', type: 'tack' },
  ];
  const out = smoothWindSeries(series, { windowMs: 10000, madK: 3, minMadDeg: 20 });
  assert.ok(out.every((p) => Math.abs(circDiffDeg(p.windFromDeg, 11)) < 10));
  assert.ok(out.length < series.length); // 飛び値が落ちる
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL

- [ ] **Step 3: 最小実装**

```js
// 円周量の移動中央値＋MADで外れ値を除去し平滑化
export function smoothWindSeries(series, opts = {}) {
  const windowMs = opts.windowMs ?? 120000;
  const madK = opts.madK ?? 3;
  const minMadDeg = opts.minMadDeg ?? 25;
  const half = windowMs / 2;
  const sorted = [...series].sort((a, b) => a.tMs - b.tMs);
  if (sorted.length === 0) return [];

  const localMedian = (tMs) => {
    const near = sorted.filter((p) => Math.abs(p.tMs - tMs) <= half).map((p) => p.windFromDeg);
    return circMedianDeg(near.length ? near : sorted.map((p) => p.windFromDeg));
  };

  // 1) 偏差とMAD
  const devs = sorted.map((p) => Math.abs(circDiffDeg(p.windFromDeg, localMedian(p.tMs))));
  const madSorted = [...devs].sort((a, b) => a - b);
  const mad = madSorted[Math.floor(madSorted.length / 2)] || 0;
  const thr = Math.max(madK * mad, minMadDeg);

  // 2) 外れ値除去＋局所中央値へ置換
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    if (devs[i] > thr) continue;
    out.push({ ...sorted[i], windFromDeg: localMedian(sorted[i].tMs) });
  }
  return out;
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): ロバスト平滑化(円周中央値+MAD)を追加"
```

---

### Task 10: 統合エントリ（`estimateWindAxisSeries`）とエンドツーエンド検証

**Files:**
- Modify: `src/windaxis.js`
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: Task 2〜9 のすべて
- Produces:
  - `estimateWindAxisSeries(track: {points: Point[]}, options?: {marks?, opts?}) → WindEstimate[]`
    - パイプライン: `computeCog → segmentLegs → classifyManeuver（各マニューバに type/confidence 付与）→ rejectMarkRoundings → estimateWindFromManeuver（anchors）→ assignLegKinds → learnPolarAngles → fillLegEstimates → smoothWindSeries([...anchors, ...legEstimates])`
    - アンカーが0件なら `[]` を返す（校正不能）。
    - `opts` は Task 2〜9 の各既定を上書きする単一オブジェクト（全関数に横流し）。

- [ ] **Step 1: 失敗するテスト（E2E）を書く**

`straightSamples`/`beatTwoLegs` を再利用し、実 `points` から風向0°を復元する統合テスト。COG合成の都合上、点列は `computeCog` を通せる `{t,lat,lon,speed,bearing}` 形式で作る：

```js
import { estimateWindAxisSeries } from '../src/windaxis.js';

// beatTwoLegs のSampleを、computeCogが扱う生pointsへ変換（cogは捨て、speed/bearingを付与）
function samplesToPoints(samples) {
  return samples.map((s) => ({ t: s.t, lat: s.lat, lon: s.lon, speed: s.speed, bearing: -1, accuracy: 5 }));
}

test('estimateWindAxisSeries: ビートから風向≈0°(北)を復元', () => {
  // 45°→315°→45° の3レグ(2タック)で校正が効くようにする
  const t0 = 1_787_000_000_000;
  const l1 = straightSamples(t0, 45, 40);
  const a = l1.at(-1);
  const l2 = straightSamples(a.t + 500, 315, 40, 3, 500, { lat: a.lat, lon: a.lon });
  const b = l2.at(-1);
  const l3 = straightSamples(b.t + 500, 45, 40, 3, 500, { lat: b.lat, lon: b.lon });
  const points = samplesToPoints([...l1, ...l2, ...l3]);

  const series = estimateWindAxisSeries({ points }, { marks: [], opts: { minLegSec: 5, settleSec: 4, windowMs: 1000, minSpeedMps: 1 } });
  assert.ok(series.length > 0);
  // アンカー(tack)の風向が北付近
  const anchor = series.find((p) => p.source === 'anchor');
  assert.ok(anchor);
  assert.ok(Math.abs(circDiffDeg(anchor.windFromDeg, 0)) < 5, `windFrom=${anchor.windFromDeg}`);
});

test('estimateWindAxisSeries: アンカー無しなら空配列', () => {
  const points = samplesToPoints(straightSamples(1_787_000_000_000, 45, 40)); // 1レグのみ=マニューバ無し
  const series = estimateWindAxisSeries({ points }, { opts: { minLegSec: 5, windowMs: 1000, minSpeedMps: 1 } });
  assert.deepEqual(series, []);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL（`estimateWindAxisSeries is not a function`）

- [ ] **Step 3: 最小実装**

```js
// 統合エントリ: COG→分割→判別→除去→アンカー→種別→学習→レグ充填→平滑化
export function estimateWindAxisSeries(track, options = {}) {
  const opts = options.opts ?? {};
  const marks = options.marks ?? [];
  const samples = computeCog(track.points, opts);
  const { legs, maneuvers } = segmentLegs(samples, opts);
  for (const m of maneuvers) Object.assign(m, classifyManeuver(m, opts));
  const kept = rejectMarkRoundings(maneuvers, marks, opts);
  const anchors = kept.map(estimateWindFromManeuver);
  if (anchors.length === 0) return [];
  assignLegKinds(legs, kept);
  const polar = learnPolarAngles(anchors);
  const legEstimates = fillLegEstimates(legs, anchors, polar, opts);
  return smoothWindSeries([...anchors, ...legEstimates], opts);
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxis.test.js`
Expected: PASS。続けて全体テストも通す:

Run: `npm test`
Expected: 既存テスト＋windaxis すべて PASS

- [ ] **Step 5: 実データでスモーク確認（任意・手動）**

`demo-data/sailviz-20260823-1321.sailviz.json` のトラックで風向が相模湾の常識的な値に収まるか、簡易スクリプトで目視：

```bash
node -e "import('./src/windaxis.js').then(async (M)=>{const d=require('./demo-data/sailviz-20260823-1321.sailviz.json');const s=M.estimateWindAxisSeries(d.tracks[0],{marks:d.marks});console.log('estimates:',s.length);console.log('sample:',s.slice(0,5).map(p=>({t:new Date(p.tMs).toISOString(),wind:Math.round(p.windFromDeg),src:p.source})));})" 2>/dev/null || node --input-type=module -e "import * as M from './src/windaxis.js'; import { readFileSync } from 'node:fs'; const d=JSON.parse(readFileSync('./demo-data/sailviz-20260823-1321.sailviz.json')); const s=M.estimateWindAxisSeries(d.tracks[0],{marks:d.marks}); console.log('estimates',s.length, s.slice(0,5));"
```

Expected: 推定が0件でなく、windFromが破綻していない（NaN/極端な飛びが平滑化後に残らない）こと。破綻時は `opts`（`turnRateThreshDegPerSec` 等）を調整。

- [ ] **Step 6: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "feat(windaxis): 統合エントリ estimateWindAxisSeries とE2Eテストを追加"
```

---

### Task 11: 風軸グラフ用データ整形（`buildWindAxisDatasets`）

**Files:**
- Create: `src/windaxisview.js`
- Test: `test/windaxisview.test.js`

**Interfaces:**
- Consumes: `WindEstimate[]`（Task 10）
- Produces:
  - `buildWindAxisDatasets({ series, amedas }) → { datasets }`（Chart.js line 用）
    - `series`: `WindEstimate[]`。`amedas`（任意）: `{ obsMs, dirDeg }[]` の参考風向。
    - 風軸データセット `{ label:'推定風向', data: [{x:tMs, y:windFromDeg}], ... }` と、
      amedas 参考ライン `{ label:'辻堂(参考)', data:[{x,y}], borderDash:[4,4], ... }`（amedas空なら省略）。

- [ ] **Step 1: 失敗するテストを書く**

`test/windaxisview.test.js` を新規作成：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWindAxisDatasets } from '../src/windaxisview.js';

test('buildWindAxisDatasets: 推定風向データセットを作る', () => {
  const series = [
    { tMs: 0, windFromDeg: 10, source: 'anchor', confidence: 1 },
    { tMs: 1000, windFromDeg: 12, source: 'leg', confidence: 0.4 },
  ];
  const { datasets } = buildWindAxisDatasets({ series, amedas: [] });
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].data.length, 2);
  assert.deepEqual(datasets[0].data[0], { x: 0, y: 10 });
});

test('buildWindAxisDatasets: amedas参考ラインを追加', () => {
  const { datasets } = buildWindAxisDatasets({
    series: [{ tMs: 0, windFromDeg: 10, source: 'anchor', confidence: 1 }],
    amedas: [{ obsMs: 0, dirDeg: 200 }],
  });
  assert.equal(datasets.length, 2);
  assert.ok(datasets[1].borderDash);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test test/windaxisview.test.js`
Expected: FAIL

- [ ] **Step 3: 最小実装**

`src/windaxisview.js` を新規作成：

```js
// src/windaxisview.js
// 風軸推定系列を Chart.js の line データセットへ整形する純粋関数。
export function buildWindAxisDatasets({ series, amedas = [] }) {
  const datasets = [{
    label: '推定風向',
    data: series.map((p) => ({ x: p.tMs, y: p.windFromDeg })),
    borderColor: '#1c72b8',
    pointRadius: 0,
    tension: 0.2,
  }];
  if (amedas && amedas.length) {
    datasets.push({
      label: '辻堂(参考)',
      data: amedas.map((a) => ({ x: a.obsMs, y: a.dirDeg })),
      borderColor: '#888',
      borderDash: [4, 4],
      pointRadius: 0,
    });
  }
  return { datasets };
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `node --test test/windaxisview.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/windaxisview.js test/windaxisview.test.js
git commit -m "feat(windaxis): 風軸グラフ用データ整形を追加"
```

---

### Task 12: ダッシュボードへの風軸パネル配線（手動検証）

> このTaskはDOM/Chart.js配線で、ユニットテスト対象外（ロジックはTask 11で担保）。実行時に `src/app.js`/`src/dashboard.js` の実配線を確認し、既存の `renderChart`（chartview.js）パターンに合わせること。

**Files:**
- Modify: `index.html`（ダッシュボード画面に風軸グラフ用 `<canvas>` を1つ追加）
- Modify: `src/dashboard.js`（またはダッシュボードを組み立てる箇所）
- Modify: `src/app.js`（現在読込中GPSトラックと `marks`、`fetchWind` 由来の参考風向を供給）

**Interfaces:**
- Consumes: `estimateWindAxisSeries`（Task 10）, `buildWindAxisDatasets`（Task 11）, `renderChart`（`src/chartview.js`: `renderChart(canvas, { datasets, from, to, mini, fmtX })`）

- [ ] **Step 1: canvasを追加**

`index.html` のダッシュボード画面領域に、既存グラフグリッドとは別の「風軸」セクションと `<canvas id="windaxis-chart">` を追加する（既存グラフ用canvasのマークアップ・class命名に合わせる）。

- [ ] **Step 2: 描画関数を配線**

ダッシュボード組み立て箇所で、現在のGPSトラックに対し次を実行して `#windaxis-chart` に描画する：

```js
import { estimateWindAxisSeries } from './windaxis.js';
import { buildWindAxisDatasets } from './windaxisview.js';
import { renderChart } from './chartview.js';

function renderWindAxis(canvas, track, marks, amedas, range) {
  const series = estimateWindAxisSeries(track, { marks });
  const { datasets } = buildWindAxisDatasets({ series, amedas });
  return renderChart(canvas, {
    datasets, from: range?.from, to: range?.to, mini: false,
    fmtX: (ms) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
  });
}
```

`track` は現在読込中のGPSトラック、`marks` は `state.marks`、`amedas` は既存 `fetchWind`（`src/wind.js`）で得た風向を `{ obsMs, dirDeg }[]` に整形したもの（無ければ空配列で可）。

- [ ] **Step 3: 手動で動作確認**

Run: `npm run serve` → ブラウザで `http://localhost:8000` を開き、GPSトラックを読み込み、ダッシュボード画面で風軸グラフが描画されることを確認。

Expected:
- 風軸(推定風向)の折れ線が時系列で描かれる
- amedas参考ライン（破線）が重畳される（設定時）
- タック/ジャイブが少ない/無いデータではグラフが空でも落ちない

- [ ] **Step 4: 既存テストが壊れていないことを確認**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 5: コミット**

```bash
git add index.html src/dashboard.js src/app.js
git commit -m "feat(windaxis): ダッシュボードに風軸時系列グラフを追加"
```

---

## Self-Review（記入済み）

**1. Spec coverage:**
- ① COG算出 → Task 2 / ② レグ分割・セトリング除外の代表方位 → Task 3 / ③ タック・ジャイブ判別 → Task 4 /
  ④ 二等分アンカー(±180) → Task 5 / ⑤ 帆走角学習 → Task 6 / ⑥ レグ内連続推定＋レグ種別 → Task 7 /
  ⑦ マーク近傍除去 → Task 8（幾何フィルタ=Task3のminLeg、ロバストMAD=Task9） / ⑧ 平滑化 → Task 9 /
  統合エントリ → Task 10 / 円周演算 → Task 1 / ダッシュボード連携＋amedas参考 → Task 11,12。全項目に対応Taskあり。
- テスト方針1〜7・5b → Task 1〜10のテストに反映（5bのベアアウェイ検証は Task 3 のセトリング除外で担保。必要なら
  Task 3 に「開始直後にcogが下振れするレグでも代表方位が本来値に近い」テストを追加してよい）。

**2. Placeholder scan:** TBD/TODO/「適切に処理」等なし。全コードステップに実コードを記載。

**3. Type consistency:** `windFromDeg`/`tMs`/`headingBefore`/`headingAfter`/`kind`/`source`/`legBeforeIdx`/`legAfterIdx`/`betaCloseHauled`/`betaRun` は全Taskで一貫。`estimateWindAxisSeries` の `options={marks,opts}` と各関数の `opts` 横流しも整合。

## リスク/実行時に調整しうる点
- しきい値（`turnRateThreshDegPerSec` 等）は合成テストで通っても実データで再調整が要る。Task 10 Step 5 のスモークで確認。
- `positionAt`/`speedAt` の端点null挙動に依存（Task 2 で除外）。実データの精度フィルタ・外れ値除去は呼び出し前に適用済みである前提。
- Task 12 のDOM配線は `app.js`/`dashboard.js` の実構造に依存。データスコープ（風軸=1トラック vs 既存=チーム横断）に留意し、専用パネルとして独立配線する。
