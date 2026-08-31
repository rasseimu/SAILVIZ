# 風軸 部分再推定（範囲選択リード直し）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ダッシュボードの風軸グラフで悪い区間をドラッグ選択し、その範囲だけで風軸を再推定してプロジェクトに保存し、地図・VMGにも反映する。

**Architecture:** 補正範囲を各トラックオブジェクトの `windAxisOverrides` に保持する。純関数 `applyWindAxisOverrides` が「全体推定」に「範囲だけの分離推定」をスプライスした系列を返し、ダッシュボード・地図・VMG がこの一関数を共通経路として使う。永続化はトラックに同梱する追加的変更（バージョン据え置き）。

**Tech Stack:** バニラ ES Modules、Chart.js 4.4.6（`vendor/chart.esm.js`）、`node --test`。ビルドなし。

**Spec:** `docs/superpowers/specs/2026-08-31-wind-axis-range-reestimate-design.md`

## Global Constraints

- ES Modules（`"type": "module"`）。ビルド工程なし・追加依存なし。
- テストは `npm test`（= `node --test`）。DOM/Chart.js 描画は手動確認（既存 `renderChart` と同方針）。
- トラックは **`id` が重複しうる**ため、補正はトラックオブジェクトに保持する（`id` キー禁止）。
- 系列サンプルの形は `{ tMs, windFromDeg, ... }`（絶対 epoch ms）。
- `PROJECT_VERSION` は据え置き（追加的・寛容な変更）。旧データは `windAxisOverrides = []`。
- コミットメッセージ末尾に必ず付与:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 作業ブランチは現在の `fix/merge-breakage-vmg`（HEAD）系列上でよい。無関係な作業ツリー変更（`src/progress.js`, `styles.css` の既存差分, 未追跡 `demo-data/`, `src/Component 3.png`）はステージしない。

---

## File Structure

- **新規 `src/windaxisoverride.js`** — 純関数。`normalizeOverrides`（範囲の正規化・マージ）と `applyWindAxisOverrides`（分離再推定＋スプライス）。DOM 非依存。
- **新規 `test/windaxisoverride.test.js`** — 上記の単体テスト。
- **`src/project.js`** — `serializeProject`/`deserializeProject` に `windAxisOverrides` を追加・正規化。
- **`test/project.test.js`**（無ければ新規）— ラウンドトリップ・後方互換テスト。
- **`src/chartview.js`** — `renderChart` に任意 `plugins` 配列を受け取る口を追加（後方互換）。
- **`src/app.js`** — `recomputeWindAxis` と `unifyWindAxis` 呼び出しを `applyWindAxisOverrides` 経由に変更。`createDashboard` に `onWindAxisChange` を配線。
- **`src/dashboard.js`** — 風軸グラフのドラッグ選択・帯描画プラグイン・クリア操作・`renderWindAxis` の系列生成差し替え。
- **`index.html`** — `#windaxis-section` にクリアボタンとヘルプ文言を追加。
- **`styles.css`** — クリアボタン/ヘルプの軽微なスタイル。

---

## Task 1: コア純関数 `windaxisoverride.js`

**Files:**
- Create: `src/windaxisoverride.js`
- Test: `test/windaxisoverride.test.js`

**Interfaces:**
- Consumes: `estimateWindAxisSeries(track, { marks })` from `./windaxis.js`（既存）。
- Produces:
  - `normalizeOverrides(overrides: Array<{start:number,end:number}>) -> Array<{start,end}>`
    （`start<end` のみ採用、`start` 昇順ソート、重なり/接触 `next.start <= cur.end` をマージ）
  - `applyWindAxisOverrides(track, { marks?: any[], overrides?: Array<{start,end}> }) -> Array<{tMs, windFromDeg, ...}>`

- [ ] **Step 1: 失敗するテストを書く**

`test/windaxisoverride.test.js`:

```javascript
// 風軸 部分再推定（範囲選択リード直し）のコア純関数テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCsv } from '../src/csv.js';
import { parseGpsPoints, rejectOutliers } from '../src/gps.js';
import { computeBounds } from '../src/projection.js';
import { estimateWindAxisSeries } from '../src/windaxis.js';
import { normalizeOverrides, applyWindAxisOverrides } from '../src/windaxisoverride.js';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadTrack(fileName) {
  const text = readFileSync(join(__dir, '..', 'sample-data', fileName), 'utf8');
  const { header, rows } = parseCsv(text);
  const { points } = rejectOutliers(parseGpsPoints(header, rows));
  return {
    id: fileName, name: fileName, color: '#1c72b8', visible: true, points,
    bounds: computeBounds([{ visible: true, points }]),
    tRange: { start: points[0].t, end: points[points.length - 1].t },
  };
}

test('normalizeOverrides: start<end のみ採用しソートする', () => {
  const out = normalizeOverrides([
    { start: 50, end: 40 },   // 不正(start>=end) → 除外
    { start: 30, end: 35 },
    { start: 10, end: 20 },
  ]);
  assert.deepEqual(out, [{ start: 10, end: 20 }, { start: 30, end: 35 }]);
});

test('normalizeOverrides: 重なり/接触する範囲をマージする', () => {
  const out = normalizeOverrides([
    { start: 10, end: 20 },
    { start: 15, end: 25 }, // 重なり
    { start: 25, end: 30 }, // 接触(next.start == cur.end)
    { start: 40, end: 50 }, // 独立
  ]);
  assert.deepEqual(out, [{ start: 10, end: 30 }, { start: 40, end: 50 }]);
});

test('normalizeOverrides: 空/未定義は空配列', () => {
  assert.deepEqual(normalizeOverrides([]), []);
  assert.deepEqual(normalizeOverrides(undefined), []);
});

test('applyWindAxisOverrides: overrides なしは全体推定と一致(no-op)', () => {
  const track = loadTrack('Location0807.csv');
  const base = estimateWindAxisSeries(track, { marks: [] });
  const got = applyWindAxisOverrides(track, { marks: [], overrides: [] });
  assert.deepEqual(got, base);
});

test('applyWindAxisOverrides: トラック範囲外の override は no-op', () => {
  const track = loadTrack('Location0807.csv');
  const base = estimateWindAxisSeries(track, { marks: [] });
  const after = track.tRange.end + 60000;
  const got = applyWindAxisOverrides(track, {
    marks: [], overrides: [{ start: after, end: after + 60000 }],
  });
  assert.deepEqual(got, base);
});

test('applyWindAxisOverrides: 範囲外は不変・範囲内は分離推定に一致', () => {
  const track = loadTrack('Location0807.csv');
  const base = estimateWindAxisSeries(track, { marks: [] });
  // トラック中央の40%を補正範囲にする
  const span = track.tRange.end - track.tRange.start;
  const r = { start: track.tRange.start + span * 0.3, end: track.tRange.start + span * 0.7 };

  const got = applyWindAxisOverrides(track, { marks: [], overrides: [r] });

  const inR = (t) => t >= r.start && t <= r.end;
  // 範囲外: base と一致
  assert.deepEqual(
    got.filter((s) => !inR(s.tMs)),
    base.filter((s) => !inR(s.tMs)),
  );
  // 範囲内: 分離推定(その範囲の点だけ)の範囲内サンプルと一致
  const subset = track.points.filter((p) => inR(p.t));
  const local = estimateWindAxisSeries({ ...track, points: subset }, { marks: [] });
  assert.deepEqual(
    got.filter((s) => inR(s.tMs)),
    local.filter((s) => inR(s.tMs)),
  );
  // 全体は tMs 昇順
  for (let i = 1; i < got.length; i++) assert.ok(got[i].tMs >= got[i - 1].tMs);
});

test('applyWindAxisOverrides: 分離推定が空の範囲はギャップになる(補充されない)', () => {
  // 合成トラック: マニューバの無い一直線 → 分離推定は空
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    pts.push({ t: i * 1000, lat: 35.0 + i * 0.0001, lon: 139.0, speed: 4 });
  }
  const track = {
    id: 't', name: 't', color: '#1c72b8', visible: true, points: pts,
    bounds: computeBounds([{ visible: true, points: pts }]),
    tRange: { start: 0, end: 60000 },
  };
  const r = { start: 20000, end: 40000 };
  const got = applyWindAxisOverrides(track, { marks: [], overrides: [r] });
  // 範囲内サンプルは存在しない(ギャップ)
  assert.equal(got.filter((s) => s.tMs >= r.start && s.tMs <= r.end).length, 0);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/windaxisoverride.test.js`
Expected: FAIL（`Cannot find module '../src/windaxisoverride.js'`）

- [ ] **Step 3: 最小実装を書く**

`src/windaxisoverride.js`:

```javascript
// 風軸の部分再推定。全体推定に「選択範囲だけの分離推定」をスプライスした系列を返す。
// トラック全体の平滑化/外れ値除去で巻き添えになった区間を、その範囲の点だけで
// 推定し直して局所的に上書きする。純関数(DOM非依存・テスト可能)。
import { estimateWindAxisSeries } from './windaxis.js';

// 範囲リストを正規化: start<end のみ採用し、start昇順ソート、重なり/接触をマージ。
export function normalizeOverrides(overrides) {
  const valid = (Array.isArray(overrides) ? overrides : [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start < r.end)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end); // 重なり/接触をマージ
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// track 全体の推定に、各 override 範囲の分離推定を上書きした系列を返す。
export function applyWindAxisOverrides(track, { marks = [], overrides = [] } = {}) {
  const base = estimateWindAxisSeries(track, { marks });
  const ranges = normalizeOverrides(overrides);
  if (ranges.length === 0) return base;

  const inAnyRange = (t) => ranges.some((r) => t >= r.start && t <= r.end);
  const kept = base.filter((s) => !inAnyRange(s.tMs)); // 範囲外はそのまま残す

  const locals = [];
  const pts = Array.isArray(track.points) ? track.points : [];
  for (const r of ranges) {
    const subset = pts.filter((p) => p.t >= r.start && p.t <= r.end);
    if (subset.length === 0) continue; // 点が無い範囲はギャップ
    let local;
    try {
      local = estimateWindAxisSeries({ ...track, points: subset }, { marks });
    } catch {
      local = []; // 分離推定失敗もギャップ扱い
    }
    for (const s of local) {
      if (s.tMs >= r.start && s.tMs <= r.end) locals.push(s);
    }
  }
  return [...kept, ...locals].sort((a, b) => a.tMs - b.tMs);
}
```

- [ ] **Step 4: テストを実行して通過を確認**

Run: `node --test test/windaxisoverride.test.js`
Expected: PASS（7 テスト）

- [ ] **Step 5: コミット**

```bash
git add src/windaxisoverride.js test/windaxisoverride.test.js
git commit -m "$(cat <<'EOF'
feat(windaxis): 範囲だけで再推定する applyWindAxisOverrides を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 永続化（`project.js`）

**Files:**
- Modify: `src/project.js`（`serializeProject` のトラックマップ、`deserializeProject` のトラック正規化）
- Test: `test/project.test.js`（無ければ新規）

**Interfaces:**
- Consumes: `serializeProject(state, {savedAt?})`, `deserializeProject(obj)`（既存）。
- Produces: 直列化トラックに `windAxisOverrides: Array<{start,end}>` を含める／復元時に必ず配列化。

- [ ] **Step 1: 失敗するテストを書く**

`test/project.test.js` に以下を追加（ファイルが無ければ新規作成し import ヘッダを付ける）:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, deserializeProject } from '../src/project.js';

function baseState() {
  return {
    mode: 'absolute', accuracyFilter: true,
    crop: { start: 0, end: 1000 },
    tracks: [{
      id: 'Location.csv', name: 'A', color: '#111', visible: true,
      points: [{ t: 0, lat: 35, lon: 139 }], bounds: {}, tRange: { start: 0, end: 1000 },
      windAxisOverrides: [{ start: 200, end: 400 }],
    }],
    events: [], marks: [], pins: [], videos: [], reflections: [],
  };
}

test('serialize/deserialize: windAxisOverrides が保持される', () => {
  const obj = serializeProject(baseState());
  assert.deepEqual(obj.tracks[0].windAxisOverrides, [{ start: 200, end: 400 }]);
  const back = deserializeProject(obj);
  assert.deepEqual(back.tracks[0].windAxisOverrides, [{ start: 200, end: 400 }]);
});

test('deserialize: 旧データ(フィールド無し)は windAxisOverrides=[] にフォールバック', () => {
  const obj = serializeProject(baseState());
  delete obj.tracks[0].windAxisOverrides; // 旧形式を模す
  const back = deserializeProject(obj);
  assert.deepEqual(back.tracks[0].windAxisOverrides, []);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/project.test.js`
Expected: FAIL（`windAxisOverrides` が `undefined`）

- [ ] **Step 3: 最小実装を書く**

`src/project.js` の `serializeProject` 内トラックマップに `windAxisOverrides` を追加:

```javascript
    tracks: state.tracks.map((t) => ({
      id: t.id, name: t.name, color: t.color, visible: t.visible,
      points: t.points, bounds: t.bounds, tRange: t.tRange,
      windAxisOverrides: Array.isArray(t.windAxisOverrides) ? t.windAxisOverrides : [],
    })),
```

`deserializeProject` の `tracks:` を正規化に変更:

```javascript
    tracks: arr(obj.tracks).map((t) => ({
      ...t,
      windAxisOverrides: arr(t && t.windAxisOverrides),
    })),
```

- [ ] **Step 4: テストを実行して通過を確認**

Run: `node --test test/project.test.js`
Expected: PASS

- [ ] **Step 5: 全テストを実行**

Run: `npm test`
Expected: 既存を含め全て PASS

- [ ] **Step 6: コミット**

```bash
git add src/project.js test/project.test.js
git commit -m "$(cat <<'EOF'
feat(project): トラックの windAxisOverrides を保存/復元(旧データは空配列)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 描画層への配線（`chartview.js` / `app.js`）

DOM/Chart.js 依存のため TDD ではなく、`node --check` と既存 `npm test`、手動確認で検証する。

**Files:**
- Modify: `src/chartview.js:25`（`renderChart` に `plugins` 引数）
- Modify: `src/app.js`（`recomputeWindAxis`, `unifyWindAxis` 呼び出し, `createDashboard` 配線, import 追加）

**Interfaces:**
- Consumes: `applyWindAxisOverrides` from `./windaxisoverride.js`（Task 1）。
- Produces:
  - `renderChart(canvas, { datasets, from, to, mini?, fmtX?, yBeginAtZero?, plugins? })` — `plugins` は Chart.js インラインプラグイン配列（既定 `[]`）。
  - `createDashboard({ ..., onWindAxisChange?: () => void })` を受け付ける（Task 4 で使用）。

- [ ] **Step 1: `renderChart` に plugins 口を追加**

`src/chartview.js` の該当箇所:

```javascript
export function renderChart(canvas, { datasets, from, to, mini = false, fmtX = null, yBeginAtZero = false, plugins = [] }) {
  return new Chart(canvas, {
    type: 'line',
    data: { datasets },
    plugins,
    options: {
```

（`options` 以降は変更なし。`plugins` は `new Chart` 設定のトップレベルに置く。）

- [ ] **Step 2: `app.js` に import 追加**

`src/app.js` の import 群（`estimateWindAxisSeries` の行の近く）に追加:

```javascript
import { applyWindAxisOverrides } from './windaxisoverride.js';
```

- [ ] **Step 3: `recomputeWindAxis` をオーバーライド適用に変更**

`src/app.js` の `recomputeWindAxis` 内、`windSeriesByTrack.set(...)` の行を置換:

```javascript
      windSeriesByTrack.set(tr, applyWindAxisOverrides(tr, {
        marks: state.marks, overrides: tr.windAxisOverrides,
      }));
```

- [ ] **Step 4: `unifyWindAxis` の estimator をオーバーライド適用版に**

`src/app.js` の `unifyWindAxis(visibleTracks, { estimator: estimateWindAxisSeries, marks: state.marks })` を置換:

```javascript
    windSeries = unifyWindAxis(visibleTracks, {
      estimator: (t, o) => applyWindAxisOverrides(t, { ...o, overrides: t.windAxisOverrides }),
      marks: state.marks,
    });
```

- [ ] **Step 5: `createDashboard` に `onWindAxisChange` を配線**

`src/app.js` の `createDashboard({ ... })`（`getCrop: () => state.crop,` の行の後）に追加:

```javascript
  onWindAxisChange: () => { recomputeWindAxis(); draw(); },
```

- [ ] **Step 6: 構文チェックと全テスト**

Run: `node --check src/app.js && node --check src/chartview.js && npm test`
Expected: パース OK・全テスト PASS（この段階では挙動変化なし＝overrides は空のまま）

- [ ] **Step 7: コミット**

```bash
git add src/chartview.js src/app.js
git commit -m "$(cat <<'EOF'
feat(windaxis): 地図/VMG/グラフを applyWindAxisOverrides 経由に統一

renderChart に plugins 口を追加。recomputeWindAxis と unifyWindAxis を
オーバーライド適用版に差し替え、createDashboard に onWindAxisChange を配線。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: ダッシュボードUI（ドラッグ選択・帯・クリア）

DOM/Chart.js 依存のため手動確認で検証する。

**Files:**
- Modify: `index.html`（`#windaxis-section` にヘルプとクリアボタン）
- Modify: `src/dashboard.js`（`renderWindAxis` の系列生成差し替え・ドラッグ配線・帯プラグイン・クリア）
- Modify: `styles.css`（ボタン/ヘルプの軽微スタイル）

**Interfaces:**
- Consumes: `applyWindAxisOverrides` from `./windaxisoverride.js`; `renderChart(..., { plugins })`（Task 3）; `onWindAxisChange`（Task 3 で app.js から注入）。
- Produces: なし（UI 末端）。

- [ ] **Step 1: `index.html` にヘルプとクリアボタンを追加**

`#windaxis-section` の `<h3>` 行を次のように置換:

```html
        <section id="windaxis-section" class="hidden">
          <div id="windaxis-head">
            <h3 id="windaxis-title">風軸（推定風向）</h3>
            <span id="windaxis-hint">グラフをドラッグした区間だけで風軸を推定し直します（帯クリックで解除）</span>
            <button id="windaxis-clear" class="btn" type="button">風軸補正をクリア</button>
          </div>
          <div id="windaxis-wrap">
            <canvas id="windaxis-chart"></canvas>
          </div>
          <p id="windaxis-empty" class="hidden">タック・ジャイブが検出されませんでした（推定できませんでした）</p>
        </section>
```

- [ ] **Step 2: `dashboard.js` の import とコントローラ状態を追加**

`src/dashboard.js` の import に追加:

```javascript
import { applyWindAxisOverrides } from './windaxisoverride.js';
```

`createDashboard({ ... })` のシグネチャに `onWindAxisChange = null` を追加し、コントローラ変数（`let windAxisChart = null;` の近く）に追加:

```javascript
  let windAxisTrack = null;     // 風軸グラフの対象トラック(帯/ドラッグの参照先)
  let windAxisDrag = null;      // ドラッグ中の {start,end}(ms) or null
  let windAxisWired = false;    // canvas へのポインタ配線は一度だけ
```

- [ ] **Step 3: 帯描画プラグインと再描画ヘルパを追加**

`renderWindAxis` の直前（`function renderWindAxis()` の上）に追加:

```javascript
  // 保存済みオーバーライド範囲とドラッグ中矩形を chartArea に塗るプラグイン。
  const windAxisBandsPlugin = {
    id: 'windAxisBands',
    afterDraw(chart) {
      const x = chart.scales.x; const area = chart.chartArea;
      if (!x || !area) return;
      const paint = (start, end, fill) => {
        const x0 = x.getPixelForValue(start); const x1 = x.getPixelForValue(end);
        const lo = Math.max(area.left, Math.min(x0, x1));
        const hi = Math.min(area.right, Math.max(x0, x1));
        if (hi <= lo) return;
        chart.ctx.save();
        chart.ctx.fillStyle = fill;
        chart.ctx.fillRect(lo, area.top, hi - lo, area.bottom - area.top);
        chart.ctx.restore();
      };
      const ovs = (windAxisTrack && windAxisTrack.windAxisOverrides) || [];
      for (const r of ovs) paint(r.start, r.end, 'rgba(230,126,34,0.15)');
      if (windAxisDrag) paint(windAxisDrag.start, windAxisDrag.end, 'rgba(52,152,219,0.20)');
    },
  };

  // px→ms 変換(トラック時間範囲にクランプ)。chart 未生成時は null。
  function windAxisMsAtPixel(px) {
    if (!windAxisChart || !windAxisTrack) return null;
    const x = windAxisChart.scales.x;
    const ms = x.getValueForPixel(px);
    return Math.max(windAxisTrack.tRange.start, Math.min(windAxisTrack.tRange.end, ms));
  }
```

- [ ] **Step 4: `renderWindAxis` の系列生成を差し替え、対象トラックを記録**

`renderWindAxis` 内の系列生成ブロックを置換:

```javascript
    windAxisTrack = track; // 帯/ドラッグの参照先(state.tracks と同一オブジェクト)

    let series;
    try {
      series = applyWindAxisOverrides(analysisTrack, {
        marks, overrides: track.windAxisOverrides,
      });
    } catch (e) {
      series = [];
    }
```

同関数の `renderChart(...)` 呼び出しに `plugins` を渡す:

```javascript
    windAxisChart = renderChart(canvas, { datasets, from, to, mini: false, fmtX, plugins: [windAxisBandsPlugin] });
    wireWindAxisInteraction(canvas);
```

- [ ] **Step 5: ドラッグ選択・帯クリック解除・クリアボタンを配線**

`renderWindAxis` の下（`async function render()` の上）に追加:

```javascript
  // canvas のポインタ操作を一度だけ配線する。chart/track は closure 変数を都度参照。
  function wireWindAxisInteraction(canvas) {
    if (windAxisWired) return;
    windAxisWired = true;
    const DRAG_PX = 4; // これ未満はクリック扱い

    let downPx = null;
    const rectLeft = () => canvas.getBoundingClientRect().left;

    canvas.addEventListener('pointerdown', (e) => {
      if (!windAxisChart || !windAxisTrack) return;
      downPx = e.clientX - rectLeft();
      const ms = windAxisMsAtPixel(downPx);
      windAxisDrag = { start: ms, end: ms };
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (downPx == null || !windAxisDrag) return;
      windAxisDrag.end = windAxisMsAtPixel(e.clientX - rectLeft());
      windAxisChart.draw();
    });

    canvas.addEventListener('pointerup', (e) => {
      if (downPx == null) return;
      const upPx = e.clientX - rectLeft();
      const movedPx = Math.abs(upPx - downPx);
      const drag = windAxisDrag;
      windAxisDrag = null;
      downPx = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* 無視 */ }
      if (!windAxisTrack) return;
      const ovs = windAxisTrack.windAxisOverrides || (windAxisTrack.windAxisOverrides = []);

      if (movedPx >= DRAG_PX && drag) {
        // 範囲追加
        const start = Math.min(drag.start, drag.end);
        const end = Math.max(drag.start, drag.end);
        if (end > start) { ovs.push({ start, end }); afterWindAxisChange(); }
      } else {
        // クリック: カーソル位置の帯を解除
        const ms = windAxisMsAtPixel(upPx);
        const idx = ovs.findIndex((r) => ms >= r.start && ms <= r.end);
        if (idx >= 0) { ovs.splice(idx, 1); afterWindAxisChange(); }
      }
    });

    const clearBtn = $('windaxis-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (!windAxisTrack) return;
        windAxisTrack.windAxisOverrides = [];
        afterWindAxisChange();
      });
    }
  }

  // 補正変更後: 風軸グラフを再描画し、地図/VMG へ通知する。
  function afterWindAxisChange() {
    renderWindAxis();
    if (typeof onWindAxisChange === 'function') onWindAxisChange();
  }
```

- [ ] **Step 6: `styles.css` に軽微スタイルを追加**

`styles.css` 末尾に追加:

```css
#windaxis-head { display: flex; align-items: center; gap: 12px; }
#windaxis-hint { color: #888; font-size: 12px; }
#windaxis-clear { margin-left: auto; }
```

- [ ] **Step 7: 構文チェックと自動テスト**

Run: `node --check src/dashboard.js && npm test`
Expected: パース OK・全テスト PASS（`html-ids` の重複 id 無し・`parse-smoke` OK を含む）

- [ ] **Step 8: 手動確認**

`npm run serve` で `http://localhost:8000/` を開き:
1. GPS CSV を読み込み、チューニングダッシュボードを開く。風軸グラフが表示される。
2. グラフ上を水平ドラッグ→青い選択矩形が出て、離すと橙の帯が残る。その区間の線が再推定で変化する。
3. 帯をクリック→帯が消え、線が元の全体推定に戻る。
4. 「風軸補正をクリア」→全帯が消える。
5. 練習画面に戻り、風軸↑や🏆VMG が補正後の風向で動くことを確認。
6. 💾保存→再読込→補正帯が復元されることを確認。

- [ ] **Step 9: コミット**

```bash
git add index.html src/dashboard.js styles.css
git commit -m "$(cat <<'EOF'
feat(dashboard): 風軸グラフの範囲ドラッグで部分再推定・帯表示・クリアを追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §5 コア再推定/マージ → Task 1（`normalizeOverrides` / `applyWindAxisOverrides` + ギャップ挙動テスト）✓
- §6 ダッシュボードUI（ドラッグ・帯・帯クリック解除・クリアボタン・ヘルプ） → Task 4 ✓
- §7 地図/VMG 反映（`recomputeWindAxis` / `unifyWindAxis` / `onWindAxisChange`） → Task 3 ✓
- §8 永続化（serialize/deserialize・後方互換・バージョン据え置き） → Task 2 ✓
- §9 テスト（コア単体・project ラウンドトリップ・UI 手動） → Task 1/2 自動、Task 4 手動 ✓

**Placeholder scan:** TODO/TBD/「適切に」等なし。各コードステップに実コードを記載。

**Type consistency:**
- サンプル形 `{ tMs, windFromDeg }` を全タスクで一貫使用。
- `applyWindAxisOverrides(track, { marks, overrides })` の呼び出し（Task 3 の recompute/unify、Task 4 の renderWindAxis）が定義（Task 1）と一致。
- `renderChart(..., { plugins })`（Task 3 定義）を Task 4 が同名で使用。
- `onWindAxisChange`（Task 3 で app.js が注入、Task 4 dashboard が呼ぶ）名称一致。
- `windAxisTrack.windAxisOverrides` は Task 2 の永続化フィールド名と一致。
