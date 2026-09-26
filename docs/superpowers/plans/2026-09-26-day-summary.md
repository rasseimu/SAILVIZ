# 今日の練習サマリ（GPS読込後の自動表示） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPS を読み込んだ直後に「今日の練習サマリ」（練習全体・艇ごと・艇間比較）をモーダルで自動表示し、保存後はホームカードからいつでも再表示できるようにする。

**Architecture:** 計算は純関数 `computeDaySummary(tracks, { marks, now })`（`src/daysummary.js`）に集約し、推定値・算出不能になりうる項目は `{ ok:true, value } | { ok:false, reason }`（Est 型）で持つ。結果は `state.daySummary` として練習 JSON に保存し、`practiceSummary` 経由で `/api/summaries` の各行にも載る。保存形の検証は `isDaySummaryShape`（`src/daysummaryschema.js`）が全フィールドを見て行い、壊れていれば `null` に落とす。表示は `daySummary` だけから HTML を組む純関数 `renderDaySummaryHtml`（`src/daysummaryview.js`）で行う。「いつ計算し直すか・いつ自動表示するか・何を保存するか」の状態遷移は純関数（`src/daysummaryflow.js`）に切り出して自動テストし、`app.js` はその結果を `state` と DOM に反映するだけにする。サマリが今の GPS と一致しているかは、GPS から作る指紋 `sourceKey`（点列の軽量ハッシュを含む）で判定する。

**Tech Stack:** バニラ JS（ESM）、Node.js 組込みテストランナー `node --test`、依存追加なし。

**Spec:** `docs/superpowers/specs/2026-09-26-day-summary-design.md`（要件原文: `docs/2026-09-26-practice-summary-feature-prompt.md`）

## Global Constraints

- ランタイム依存を追加しない（既存どおり `node:*` とブラウザ標準 API のみ）。
- 画面上の風向は必ず「推定風軸」と表記する。タック・ジャイブ回数の見出しは「タック（推定）」「ジャイブ（推定）」。
- 算出不能の項目は `0` を出さず、理由の文言を出す。理由コードと文言は次の5つで固定:
  - `tacks-insufficient` → タック数が不足しています
  - `gps-poor` → GPS精度が不足しています
  - `no-overlap` → 比較可能な区間がありません
  - `wind-unavailable` → 推定風軸がないため算出できません
  - `not-moving` → 走行中のデータがありません
- 数値は SI 単位（m、ms、m/s、度）で保存し、表示時に km/m・時間/分・kt・方位名に変換する。1 m/s = 1.943844 kt。
- 時刻表示は JST 固定（`Intl.DateTimeFormat` の `timeZone: 'Asia/Tokyo'`）。
- 艇は id ではなく配列上の `index`・`name`・`color` で識別する（同名 CSV の id 重複があるため）。
- 平均速度は 1.5 m/s 以上のサンプルのみで平均する。最高速度は 1 秒グリッドの 5 秒移動平均の最大値。
- VMG 比較のバケット幅は 30 秒（`vmgminute.js` の既定と同じ）。VMG 最高艇は「同じ走種の艇が2艇以上いたバケット」だけで平均して比べる。
- GPS 品質: 良好＝記録間隔中央値 ≤2 秒かつ欠損率 <5% かつ精度中央値 ≤10m（精度列が無ければ精度条件は満たす扱い）／不足＝間隔 >5 秒、欠損率 ≥20%、精度 >25m のいずれか／それ以外は注意。欠損率＝10 秒超の空白の合計 ÷ 記録時間。練習全体は最も悪い艇に合わせる。
- 自動表示は GPS 読込（`loadFiles`）で GPS が1本以上追加され、かつ `sourceKey` が保存済みサマリと一致しないときだけ。保存済み練習を開く（`loadPractice`）ときは自動表示しない。
- サマリが今の GPS と食い違う状態（stale）は、フラグではなく `sourceKey` の比較で判定する。GPS の追加・削除・差し替えで `sourceKey` が変わるので、変更箇所ごとにフラグを立て忘れる心配がない。判定する場所は「GPS 読込後」「保存済み練習を開いた後」「トップバーの 📊 サマリ」「保存の直前」の4つ。
- 保存の直前に必ず `sourceKey` を確かめ、不一致なら再計算する。再計算に失敗したら `state.daySummary = null` にして古いサマリを保存しない（再計算ボタンでの失敗も同じ）。
- 艇名・色は `sourceKey` に含めない。一致していても保存・表示の前に、サマリ内の艇名・色（`boats[]` と VMG 最高艇）を現在のトラックに合わせる。数値は GPS 読込時点のまま変えない。
- `sourceKey` は各トラックの id・点数・開始・終了に、点列（時刻・緯度・経度・速度・精度）の 32bit ハッシュを加える。点数と範囲が同じで中身が違う GPS も別物と判定する。速度（平均・最高速度）と精度（GPS 品質）もサマリ計算に使うので、座標と時刻が同じで速度列・精度列だけ直した GPS も別物にする。方位（bearing）はサマリ計算に使わないので含めない。
- GPS 読込完了から表示まで 3 秒以内（同期計算、実測で数十 ms）。
- 艇名・色は練習 JSON 由来の信頼できない文字列として扱い、HTML に入れるときは必ずエスケープ、色は `#` + 16進 3〜8 桁以外なら `#888` に置き換える。

## Review Focus

- **片方の艇だけ GPS 品質が「不足」**: 練習全体の品質は「不足」になるが、推定風軸は品質が不足でない艇から推定して出すのが自然（1艇の不調で全体の風軸が消えるのは困る）。→ Task 4 のテスト「一部の艇が不足でも、他の艇から推定風軸を出す」。
- **ジャイブだけの練習（ダウンウインドのみ）**: タックが0なので推定風軸は `tacks-insufficient`、ジャイブ回数は数値で出る。0 タックは「算出不能」ではなく実際の回数なので `ok(0)` のまま出す。→ Task 4 のテスト「ジャイブだけならタック0・推定風軸は理由表示」。
- **全艇とも風軸が推定できない複数艇練習**: 艇間比較は「比較可能な区間がありません」ではなく「推定風軸がないため算出できません」と原因どおりに出る。→ Task 3 のテスト「どの艇にも風軸系列がなければ wind-unavailable」。
- **ホームから開いたサマリの導線を押したが、読込確認ダイアログでキャンセル**: 画面遷移せずホームに留まる（中途半端に軌跡画面へ行かない）。→ Task 7 のテスト「ホームから開いて読込をキャンセルしたら軌跡画面へ行かない」と Task 8 の手動確認 8-d。
- **色や艇名に HTML/CSS を仕込んだ練習 JSON**: 表示が壊れず、スクリプトも実行されない。→ Task 6 のテスト「艇名をエスケープし、不正な色は #888 にする」。
- **トラックを削除してそのまま保存**: 保存直前に `sourceKey` の不一致を見つけて再計算し、削除後の艇だけのサマリを保存する。再計算に失敗したら古いサマリは保存せず `null` にする。→ Task 7 のテスト「保存直前: トラック削除後は再計算する」「保存直前: 再計算に失敗したら古いサマリを残さない」。
- **艇名・色を変えてから保存**: サマリの数値は変えず、艇名・色だけ現在のトラックに合わせる（練習全体の GPS 品質の艇名も `boatIndex` 経由で追従）。→ Task 7 のテスト「艇名・色の変更はサマリに反映し、再計算はしない」。
- **中身が一部壊れた `daySummary`（`b.tacks` 欠落など）を含む練習 JSON**: 読込・一覧の時点で `null` に落ちるので、ホームカードのボタンが出ず、押した瞬間の例外も起きない。→ Task 5 の表駆動テスト「isDaySummaryShape: boat.tacks 欠落 なら false」ほか、フィールドごとの破損ケース。
- **点数・開始・終了が同じで座標だけ違う GPS に差し替え**: `sourceKey` が変わり、サマリを作り直す。→ Task 2 のテスト「点数と範囲が同じでも座標が違えば別のキー」。
- **点数・時刻・座標が同じで速度列や精度列だけ修正した GPS に差し替え**: 平均・最高速度や GPS 品質が変わりうるので、`sourceKey` が変わりサマリを作り直す（精度列が無い GPS と精度列がある GPS も別物）。→ Task 2 のテスト「点数・時刻・座標が同じでも speed が違えば別のキー」「accuracy だけ違っても別のキー」。

---

## ファイル構成

| ファイル | 種別 | 責務 |
|---|---|---|
| `src/windaxis.js` | 変更 | マニューバ検出を `detectManeuvers` として切り出して公開。`estimateWindAxisSeries` の出力は不変 |
| `src/daysummaryschema.js` | 新規 | 保存形の定義: `DAY_SUMMARY_VERSION`（Task 2）、`DAY_SUMMARY_REASONS` と全フィールドを見る `isDaySummaryShape`（Task 5） |
| `src/project.js` | 変更 | `serializeProject` / `deserializeProject` に `daySummary` を追加（`isDaySummaryShape` を通らなければ `null`） |
| `src/daysummary.js` | 新規 | 計算の純関数群: `ok` / `fail` / `daySummarySourceKey` / `gpsQuality` / `boatStats` / `boatLabel` / `computeComparison` / `computeDaySummary` / `syncDaySummaryLabels` |
| `src/daysummaryflow.js` | 新規 | 状態遷移の純関数群: `refreshDaySummary` / `daySummaryAfterGpsLoad` / `daySummaryAfterPracticeLoad` / `runDaySummaryAction` |
| `src/summary.js` | 変更 | `practiceSummary` が `daySummary` を返す（`/api/summaries` の各行に載る） |
| `src/daysummaryview.js` | 新規 | 表示の純関数: `REASON_TEXT` / 整形関数 / `renderDaySummaryHtml` |
| `src/app.js` | 変更 | モーダルの開閉、`daysummaryflow` の結果を `state` と DOM に反映、トップバーとホームカードのボタン |
| `index.html` / `styles.css` | 変更 | `#ds-modal` の骨組み、トップバー `#ds-open`、スタイル |
| `test/windaxis.test.js` | 変更 | `detectManeuvers` のテスト |
| `test/daysummary.test.js` | 新規 | 計算のテスト |
| `test/daysummaryschema.test.js` | 新規 | 形チェックのテスト（フィールド欠落・型違い・未知の理由コードごと） |
| `test/fixtures/day-summary-v1.json` | 新規 | 正しい形の `daySummary`（2艇・`ok:false` を含む）。形チェック・保存・一覧のテストで共用 |
| `test/daysummaryflow.test.js` | 新規 | 状態遷移のテスト（自動表示・stale・保存直前・導線のキャンセル） |
| `test/daysummaryview.test.js` | 新規 | 表示のテスト |
| `test/project.test.js` / `test/summary.test.js` / `test/server-api.test.js` | 変更 | 保存・一覧の往復テスト |

注: 要約サイドカー（`docs/superpowers/plans/2026-09-17-summary-sidecar.md`）は計画のみで未実装。現状 `/api/summaries` は毎回本体から `practiceSummary` を計算しているので、`practiceSummary` が `daySummary` を返せば一覧に載る。サイドカーが後で実装されても `practiceSummary` の結果をそのまま保存するため、追加対応は不要。

---

### Task 1: `detectManeuvers` を windaxis から切り出して公開

**Files:**
- Modify: `src/windaxis.js:330-369`（`estimateWindAxisSeries` の前半）
- Test: `test/windaxis.test.js`

**Interfaces:**
- Consumes: 既存の `computeCog` / `segmentLegs` / `classifyManeuver` / `rejectMarkRoundings` / `rejectMinorTurns` / `speedAt`。
- Produces: `detectManeuvers(track: {points}, options?: { marks?: Mark[], opts?: object }): Maneuver[]` — マーク近傍と微小旋回を除いたマニューバ。各要素は `{ tMs, lat, lon, type: 'tack'|'gybe', confidence, headingBefore, headingAfter, turnDeg, minSpeed, speedDropRatio, legBeforeIdx, legAfterIdx }`。

- [ ] **Step 1: 失敗するテストを書く**

`test/windaxis.test.js` の import（8行目付近の `estimateWindAxisSeries, windDirAt,` の並び）に `detectManeuvers` を追加し、`estimateWindAxisSeries: ビートから風向≈0°(北)を復元` テストの直後に追加する（`beatWithTacks` は同ファイル既存のヘルパ）。

```js
test('detectManeuvers: 2タックのビートから tack を2つ返す', () => {
  const points = beatWithTacks(1_787_000_000_000);
  const ms = detectManeuvers({ points }, {
    marks: [],
    opts: { minLegSec: 5, settleSec: 4, windowMs: 1000, minSpeedMps: 1.5 },
  });
  assert.deepEqual(ms.map((m) => m.type), ['tack', 'tack']);
});

test('detectManeuvers: マーク近傍のマニューバは除外する', () => {
  const points = beatWithTacks(1_787_000_000_000);
  const opts = { minLegSec: 5, settleSec: 4, windowMs: 1000, minSpeedMps: 1.5 };
  const all = detectManeuvers({ points }, { marks: [], opts });
  const mark = { lat: all[0].lat, lon: all[0].lon };
  const kept = detectManeuvers({ points }, { marks: [mark], opts });
  assert.equal(kept.length, all.length - 1);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/windaxis.test.js`
Expected: FAIL（`detectManeuvers` is not exported / not a function）

- [ ] **Step 3: 実装（切り出し）**

`src/windaxis.js` の `// 統合エントリ: COG→分割→…` コメントの直前に `detectManeuvers` を追加し、`estimateWindAxisSeries` の前半をそれの呼び出しに置き換える。

```js
// マニューバ(タック/ジャイブ)検出: COG→レグ分割→raw点で減速を再計測→判別→マーク近傍/微小旋回を除外。
// 風軸推定と「今日の練習サマリ」のタック/ジャイブ回数が同じ検出結果を使うために公開する。
export function detectManeuvers(track, options = {}) {
  const opts = options.opts ?? {};
  const marks = options.marks ?? [];
  const samples = computeCog(track.points, opts);
  const { legs, maneuvers } = segmentLegs(samples, opts);

  // Fix: computeCogが低速点を除外するため、マニューバの減速をraw点から測る。
  // segmentLegsが計算したminSpeed/speedDropRatioはフィルタ後サンプルに基づくため
  // タックの速度ディップを捉えられない。旋回区間をraw track.pointsから再サンプリングして上書きする。
  const rawPts = track.points;
  for (const m of maneuvers) {
    const startT = legs[m.legBeforeIdx].endT;
    const endT = legs[m.legAfterIdx].startT;
    const stepMs = 1000;
    const speeds = [];
    for (let t = startT; t <= endT + stepMs / 2; t += stepMs) {
      const clampedT = Math.min(t, endT);
      const sp = speedAt(rawPts, clampedT);
      if (sp != null && isFinite(sp) && sp >= 0) speeds.push(sp);
    }
    if (speeds.length > 0) {
      const rawMin = Math.min(...speeds);
      const legAvg = (legs[m.legBeforeIdx].meanSpeed + legs[m.legAfterIdx].meanSpeed) / 2 || 1;
      m.minSpeed = rawMin;
      m.speedDropRatio = rawMin / legAvg;
    }
  }

  for (const m of maneuvers) Object.assign(m, classifyManeuver(m, opts));
  // マーク近傍＋微小旋回(=実タック/ジャイブでない)を除外。
  return rejectMinorTurns(rejectMarkRoundings(maneuvers, marks, opts), opts);
}
```

`estimateWindAxisSeries` は次の形にする（既存コメントブロックはそのまま残し、本体の `const samples = …` から `const kept = …` までを置き換える）。

```js
export function estimateWindAxisSeries(track, options = {}) {
  const opts = options.opts ?? {};
  const kept = detectManeuvers(track, options);
  // クローズ(タック)を主に、前後をタックに挟まれたランニング(ジャイブ)アンカーは落とす。
  const preferred = preferCloseHauledAnchors(kept.map(estimateWindFromManeuver));
  // 誤判別による180°反転を大域風向の半球へ折り返す。
  const folded = foldAnchorsToHemisphere(preferred);
  if (folded.length === 0) return [];
  // 広窓中央値から外れる孤立スパイクを除去。
  const anchors = rejectAnchorOutliers(folded, opts);
  if (anchors.length === 0) return [];
  // レグ充填は出力しない: 学習ポーラ角に依存し、1本ごとの瞬間COGを使うため密で不安定。
  // アンカーのみを長めの窓(既定10分)で円周中央値平滑化し、緩やかに漂う安定した風軸を得る。
  return smoothWindSeries(anchors, { smoothWindowMs: 600000, ...opts });
}
```

- [ ] **Step 4: テストが通ることを確認（既存テストの出力不変も含む）**

Run: `node --test test/windaxis.test.js test/windaxisoverride.test.js test/vmgminute.test.js test/vmg.test.js`
Expected: PASS（既存の `estimateWindAxisSeries` 系テストも全て通る）

- [ ] **Step 5: コミット**

```bash
git add src/windaxis.js test/windaxis.test.js
git commit -m "refactor(windaxis): マニューバ検出を detectManeuvers として切り出し公開"
```

---

### Task 2: 計算の土台（Est 型・sourceKey・GPS品質・艇ごとの距離と速度）

**Files:**
- Create: `src/daysummaryschema.js`（この Task では `DAY_SUMMARY_VERSION` だけ。形チェックは Task 5）
- Create: `src/daysummary.js`
- Test: `test/daysummary.test.js`

**Interfaces:**
- Consumes: `haversineMeters`（`src/gps.js`）、`speedAt`（`src/interpolate.js`）、`circDiffDeg`（`src/windaxis.js`、テスト用ヘルパ）。
- Produces:
  - `src/daysummaryschema.js`: `DAY_SUMMARY_VERSION = 1`
  - `src/daysummary.js`:
    - `ok(value) → { ok: true, value }`、`fail(reason: string) → { ok: false, reason }`
    - `daySummarySourceKey(tracks: Track[]): string` — トラックごとに `"<id>|<点数>|<開始>|<終了>|<点列ハッシュ8桁16進>"` を `;` で連結
    - `gpsQuality(points: Point[]): { level: 'good'|'caution'|'poor', note: string }`
    - `boatStats(points: Point[]): { distanceM: number, durationMs: number, avgSpeedMps: Est<number>, maxSpeedMps: Est<number> }`

- [ ] **Step 1: 失敗するテストを書く**

`test/daysummary.test.js` を新規作成する。合成データのヘルパはこのファイル内に置き、Task 3・4 でも使う。

```js
// 今日の練習サマリ(計算)のテスト。合成GPS(等速直進・ジグザグ)で期待値を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ok, fail, daySummarySourceKey, gpsQuality, boatStats,
} from '../src/daysummary.js';
import { circDiffDeg } from '../src/windaxis.js';

const T0 = Date.UTC(2026, 7, 23, 4, 0, 0); // 2026-08-23 13:00 JST

// segments: [{ deg, toDeg?, sec, speed }] を順に等速で進む点列(1点/dtMs)。
// toDeg があると区間内で方位を deg→toDeg へ線形に回す(タック/ジャイブの回頭)。
function path(segments, { t0 = T0, dtMs = 1000, lat0 = 35.30, lon0 = 139.48, accuracy = 5 } = {}) {
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = [];
  let t = t0, lat = lat0, lon = lon0;
  for (const s of segments) {
    const n = Math.round((s.sec * 1000) / dtMs);
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0;
      const deg = s.toDeg == null ? s.deg : s.deg + circDiffDeg(s.toDeg, s.deg) * f;
      const r = (deg * Math.PI) / 180;
      const p = { t, lat, lon, speed: s.speed };
      if (accuracy != null) p.accuracy = accuracy;
      pts.push(p);
      lat += (Math.cos(r) * s.speed * dtMs) / 1000 / mLat;
      lon += (Math.sin(r) * s.speed * dtMs) / 1000 / mLon;
      t += dtMs;
    }
  }
  return pts;
}

// 風上0°のビート: 45°/315° を legSec 秒ずつ交互に走り、間に 8 秒・0.6m/s のタックを挟む。
function beatSegments(nLegs, { legSec = 90, speed = 3 } = {}) {
  const segs = [];
  for (let i = 0; i < nLegs; i++) {
    const deg = i % 2 ? 315 : 45;
    segs.push({ deg, sec: legSec, speed });
    if (i < nLegs - 1) segs.push({ deg, toDeg: i % 2 ? 45 : 315, sec: 8, speed: 0.6 });
  }
  return segs;
}

function toTrack(points, name = 'a.csv', color = '#1c72b8') {
  return {
    id: name, name, color, visible: true, points,
    tRange: { start: points[0].t, end: points[points.length - 1].t },
    windAxisOverrides: [],
  };
}

test('ok / fail は Est 型を作る', () => {
  assert.deepEqual(ok(3), { ok: true, value: 3 });
  assert.deepEqual(fail('gps-poor'), { ok: false, reason: 'gps-poor' });
});

test('daySummarySourceKey: 同じ入力なら同じキー、点数や範囲が変われば別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const b = toTrack(path([{ deg: 0, sec: 60, speed: 3 }], { t0: T0 + 1000 }), 'b.csv');
  assert.equal(daySummarySourceKey([a]), daySummarySourceKey([a]));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([a, b]));
  const shorter = toTrack(a.points.slice(0, 30));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([shorter]));
});

test('daySummarySourceKey: 点数と範囲が同じでも座標が違えば別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const moved = toTrack(a.points.map((p, i) => (i === 30 ? { ...p, lat: p.lat + 0.0001 } : p)));
  assert.equal(moved.points.length, a.points.length);
  assert.deepEqual(moved.tRange, a.tRange);
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([moved]));
});

test('daySummarySourceKey: 点数・時刻・座標が同じでも speed が違えば別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const faster = toTrack(a.points.map((p, i) => (i === 30 ? { ...p, speed: p.speed + 0.5 } : p)));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([faster]));
  // 速度列が無い(null)ことと、速度 0 は別物
  const zero = toTrack(a.points.map((p) => ({ ...p, speed: 0 })));
  const none = toTrack(a.points.map((p) => ({ ...p, speed: null })));
  assert.notEqual(daySummarySourceKey([zero]), daySummarySourceKey([none]));
});

test('daySummarySourceKey: accuracy だけ違っても別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }])); // accuracy 5
  const worse = toTrack(a.points.map((p, i) => (i === 30 ? { ...p, accuracy: 30 } : p)));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([worse]));
  // 精度列が無い GPS と、精度列がある GPS は別物
  const noAcc = toTrack(path([{ deg: 0, sec: 60, speed: 3 }], { accuracy: null }));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([noAcc]));
});

test('daySummarySourceKey: 艇名・色を変えてもキーは変わらない', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const renamed = { ...a, name: 'A艇', color: '#e67e22' };
  assert.equal(daySummarySourceKey([a]), daySummarySourceKey([renamed]));
});

test('gpsQuality: 1秒間隔・精度5m・欠損なしは良好', () => {
  const q = gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }]));
  assert.equal(q.level, 'good');
  assert.equal(q.note, '欠損0%・記録間隔1秒・精度5m');
});

test('gpsQuality: 記録間隔3秒は注意、6秒は不足', () => {
  assert.equal(gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { dtMs: 3000 })).level, 'caution');
  assert.equal(gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { dtMs: 6000 })).level, 'poor');
});

test('gpsQuality: 10秒超の空白が記録時間の5%以上なら注意', () => {
  const pts = path([{ deg: 0, sec: 300, speed: 3 }]);
  for (let i = 150; i < pts.length; i++) pts[i].t += 30_000; // 30秒の空白(約9%)
  assert.equal(gpsQuality(pts).level, 'caution');
});

test('gpsQuality: 精度中央値25m超は不足、精度列が無ければ精度条件は問わない', () => {
  assert.equal(gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { accuracy: 30 })).level, 'poor');
  const q = gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { accuracy: null }));
  assert.equal(q.level, 'good');
  assert.equal(q.note, '欠損0%・記録間隔1秒');
});

test('gpsQuality: 1点しかなければ不足', () => {
  assert.equal(gpsQuality(path([{ deg: 0, sec: 1, speed: 3 }])).level, 'poor');
});

test('boatStats: 等速直進の距離・記録時間・平均速度・最高速度', () => {
  const s = boatStats(path([{ deg: 0, sec: 100, speed: 3 }])); // 100点, 99区間
  assert.ok(Math.abs(s.distanceM - 297) < 3, `distanceM=${s.distanceM}`);
  assert.equal(s.durationMs, 99_000);
  assert.ok(s.avgSpeedMps.ok && Math.abs(s.avgSpeedMps.value - 3) < 0.01);
  assert.ok(s.maxSpeedMps.ok && Math.abs(s.maxSpeedMps.value - 3) < 0.01);
});

test('boatStats: 停船区間は平均速度に含めない', () => {
  const s = boatStats(path([{ deg: 0, sec: 60, speed: 3 }, { deg: 0, sec: 60, speed: 0 }]));
  assert.ok(Math.abs(s.avgSpeedMps.value - 3) < 0.01, `avg=${s.avgSpeedMps.value}`);
});

test('boatStats: 1点だけの速度スパイクは5秒移動平均で抑える', () => {
  const pts = path([{ deg: 0, sec: 100, speed: 3 }]);
  pts[50].speed = 20;
  const s = boatStats(pts);
  assert.ok(s.maxSpeedMps.value < 7, `max=${s.maxSpeedMps.value}`);
});

test('boatStats: 1点だけなら速度は gps-poor、ずっと停船なら not-moving', () => {
  const one = boatStats(path([{ deg: 0, sec: 1, speed: 3 }]));
  assert.equal(one.distanceM, 0);
  assert.deepEqual(one.avgSpeedMps, fail('gps-poor'));
  assert.deepEqual(one.maxSpeedMps, fail('gps-poor'));
  const still = boatStats(path([{ deg: 0, sec: 60, speed: 0 }]));
  assert.deepEqual(still.avgSpeedMps, fail('not-moving'));
  assert.deepEqual(still.maxSpeedMps, fail('not-moving'));
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/daysummary.test.js`
Expected: FAIL（`Cannot find module '../src/daysummary.js'`）

- [ ] **Step 3: 実装**

`src/daysummaryschema.js` を新規作成する（形チェック `isDaySummaryShape` は Task 5 でこのファイルに足す）。

```js
// src/daysummaryschema.js
// 今日の練習サマリ(daySummary)の保存形式の定義。計算(daysummary.js)・保存(project.js)・一覧(summary.js)が共有する。
// 保存形式のバージョン。フィールドの意味を変えたら上げる(古い版は読込時に null → 黙って再計算)。
export const DAY_SUMMARY_VERSION = 1;
```

`src/daysummary.js` を新規作成する。

```js
// src/daysummary.js
// GPS軌跡から「今日の練習サマリ」を作る純関数群。DOM/副作用なし。
// 推定値や算出不能になりうる項目は Est 型 { ok:true, value } | { ok:false, reason } で持ち、
// 算出不能を 0 で埋めない(表示側 daysummaryview.js が reason を文言に変える)。
import { haversineMeters } from './gps.js';
import { speedAt } from './interpolate.js';

const MOVING_MIN_MPS = 1.5;      // 走行中とみなす速度。computeCog の既定 minSpeedMps と同じ
const MAX_SPEED_WINDOW = 5;      // 最高速度の移動平均窓(1秒グリッドの点数=秒)
const GAP_MS = 10_000;           // これを超える記録の空白を欠損とみなす

export const ok = (value) => ({ ok: true, value });
export const fail = (reason) => ({ ok: false, reason });

// 点列の軽量ハッシュ(FNV-1a 風に 32bit 整数を混ぜる)。サマリ計算が使う列だけを使う:
// 時刻・緯度経度(1e-7度≈1cm)・速度(平均/最高速度に使う)・精度(GPS品質に使う)。方位はサマリに使わないので含めない。
// 点数・開始・終了が同じで中身だけ違う GPS を別物と判定するため。
// 保存 JSON は数値をそのまま往復させるので、読み直しても同じ値になる(Task 5 でテスト)。
function pointsHash(points) {
  let h = 0x811c9dc5;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
  // 速度・精度は欠けうる(null)。有限値なら印 1 と値(1e-3 単位)、それ以外は印 0 だけを混ぜ、null と 0 を区別する。
  const mixOptional = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) { mix(1); mix(Math.round(v * 1000)); }
    else mix(0);
  };
  for (const p of points || []) {
    mix(p.t);                          // 下位32bit
    mix(Math.floor(p.t / 4294967296)); // 上位
    mix(Math.round(p.lat * 1e7));
    mix(Math.round(p.lon * 1e7));
    mixOptional(p.speed);
    mixOptional(p.accuracy);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// サマリをどの GPS から計算したかの指紋。GPS が増減・差し替えされるとキーが変わる。
// 艇名・色は含めない(変更は syncDaySummaryLabels でサマリに反映する)。
export function daySummarySourceKey(tracks) {
  return (tracks || [])
    .map((t) => `${t.id}|${t.points?.length ?? 0}|${t.tRange?.start}|${t.tRange?.end}|${pointsHash(t.points)}`)
    .join(';');
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// 1艇のGPS品質。記録間隔の中央値・欠損率・精度の中央値(精度列がある場合のみ)で3段階に判定する。
export function gpsQuality(points) {
  const n = points.length;
  const durationMs = n ? points[n - 1].t - points[0].t : 0;
  const dts = [];
  let gapMs = 0;
  for (let i = 1; i < n; i++) {
    const dt = points[i].t - points[i - 1].t;
    dts.push(dt);
    if (dt > GAP_MS) gapMs += dt;
  }
  const intervalS = dts.length ? median(dts) / 1000 : null;
  const gapRatio = durationMs > 0 ? gapMs / durationMs : 1;
  const accs = points.map((p) => p.accuracy).filter((a) => typeof a === 'number' && Number.isFinite(a));
  const accuracyM = accs.length ? median(accs) : null;

  let level;
  if (intervalS == null || intervalS > 5 || gapRatio >= 0.2 || (accuracyM != null && accuracyM > 25)) {
    level = 'poor';
  } else if (intervalS <= 2 && gapRatio < 0.05 && (accuracyM == null || accuracyM <= 10)) {
    level = 'good';
  } else {
    level = 'caution';
  }
  const parts = [`欠損${Math.round(gapRatio * 100)}%`];
  if (intervalS != null) parts.push(`記録間隔${Number(intervalS.toFixed(1))}秒`);
  if (accuracyM != null) parts.push(`精度${Math.round(accuracyM)}m`);
  return { level, note: parts.join('・') };
}

// 1艇の走行距離・記録時間・平均速度(走行中のみ)・最高速度(5秒移動平均の最大)。
export function boatStats(points) {
  const n = points.length;
  let distanceM = 0;
  for (let i = 1; i < n; i++) distanceM += haversineMeters(points[i - 1], points[i]);
  const durationMs = n ? points[n - 1].t - points[0].t : 0;
  if (n < 2) {
    return { distanceM, durationMs, avgSpeedMps: fail('gps-poor'), maxSpeedMps: fail('gps-poor') };
  }

  // 1秒グリッドで速度を取る(記録間隔が不揃いでも時間で重み付けされる)。
  const speeds = [];
  for (let t = points[0].t; t <= points[n - 1].t; t += 1000) {
    const s = speedAt(points, t);
    speeds.push(s != null && Number.isFinite(s) ? s : null);
  }
  const moving = speeds.filter((s) => s != null && s >= MOVING_MIN_MPS);
  if (moving.length === 0) {
    return { distanceM, durationMs, avgSpeedMps: fail('not-moving'), maxSpeedMps: fail('not-moving') };
  }
  const avg = moving.reduce((a, b) => a + b, 0) / moving.length;

  let max = null;
  for (let i = 0; i + MAX_SPEED_WINDOW <= speeds.length; i++) {
    const w = speeds.slice(i, i + MAX_SPEED_WINDOW);
    if (w.some((v) => v == null)) continue;
    const m = w.reduce((a, b) => a + b, 0) / MAX_SPEED_WINDOW;
    if (max == null || m > max) max = m;
  }
  if (max == null) max = Math.max(...moving); // 5秒に満たない短いトラック

  return { distanceM, durationMs, avgSpeedMps: ok(avg), maxSpeedMps: ok(max) };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/daysummary.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/daysummaryschema.js src/daysummary.js test/daysummary.test.js
git commit -m "feat(daysummary): GPS品質と艇ごとの距離・速度の算出を追加"
```

---

### Task 3: 艇間比較（比較可能時間・クローズ/ランニング VMG 最高艇）

**Files:**
- Modify: `src/daysummary.js`
- Test: `test/daysummary.test.js`

**Interfaces:**
- Consumes: Task 2 の `ok` / `fail`。`boatMinuteVmg(track, windSeries, { bucketMs })`（`src/vmgminute.js`、戻り値 `Map<bucketIndex, { pointOfSail: 'upwind'|'downwind', vmg: number, n }>`）。`estimateWindAxisSeries`（テストで風軸系列を作るのに使う）。
- Produces:
  - `boatLabel(track: Track): { name: string, color: string }` — サマリに入れる艇名・色（`name ?? id ?? ''`、`color ?? '#888'` を文字列化）。Task 4 の `computeDaySummary` と Task 7 の `syncDaySummaryLabels` も使う。
  - `computeComparison(tracks: Track[], windSeriesByTrack: Map<Track, WindPoint[]>): { comparableMs: Est<number>, bestUpwind: Est<BoatRef>, bestDownwind: Est<BoatRef> }`。`BoatRef = { index: number, name: string, color: string, vmgMps: number }`。

- [ ] **Step 1: 失敗するテストを書く**

`test/daysummary.test.js` の import を次に差し替え、末尾にテストを追加する。

```js
import {
  ok, fail, daySummarySourceKey, gpsQuality, boatStats, boatLabel, computeComparison,
} from '../src/daysummary.js';
import { circDiffDeg, estimateWindAxisSeries } from '../src/windaxis.js';
```

```js
function windMap(tracks) {
  return new Map(tracks.map((t) => [t, estimateWindAxisSeries(t, {})]));
}

test('computeComparison: 並走した2艇のうち速い方がクローズVMG最高艇', () => {
  const a = toTrack(path(beatSegments(5, { speed: 3 })), 'a.csv', '#1c72b8');
  const b = toTrack(path(beatSegments(5, { speed: 2.5 }), { lon0: 139.481 }), 'b.csv', '#e67e22');
  const c = computeComparison([a, b], windMap([a, b]));
  assert.ok(c.comparableMs.ok && c.comparableMs.value > 0);
  assert.equal(c.comparableMs.value % 30_000, 0);
  assert.ok(c.bestUpwind.ok);
  assert.equal(c.bestUpwind.value.index, 0);
  assert.equal(c.bestUpwind.value.name, 'a.csv');
  assert.equal(c.bestUpwind.value.color, '#1c72b8');
  assert.ok(c.bestUpwind.value.vmgMps > 1.5);
  // 風下を走っていないので、ランニングは比較できない
  assert.deepEqual(c.bestDownwind, fail('no-overlap'));
});

test('computeComparison: 時間帯が重ならなければ no-overlap', () => {
  const a = toTrack(path(beatSegments(5)), 'a.csv');
  const b = toTrack(path(beatSegments(5), { t0: T0 + 86_400_000 }), 'b.csv');
  const c = computeComparison([a, b], windMap([a, b]));
  assert.deepEqual(c.comparableMs, fail('no-overlap'));
  assert.deepEqual(c.bestUpwind, fail('no-overlap'));
  assert.deepEqual(c.bestDownwind, fail('no-overlap'));
});

test('computeComparison: どの艇にも風軸系列がなければ wind-unavailable', () => {
  const a = toTrack(path([{ deg: 0, sec: 300, speed: 3 }]), 'a.csv');
  const b = toTrack(path([{ deg: 0, sec: 300, speed: 3 }], { lon0: 139.481 }), 'b.csv');
  const c = computeComparison([a, b], new Map([[a, []], [b, []]]));
  assert.deepEqual(c.comparableMs, fail('wind-unavailable'));
  assert.deepEqual(c.bestUpwind, fail('wind-unavailable'));
  assert.deepEqual(c.bestDownwind, fail('wind-unavailable'));
});

test('boatLabel: 名前が無ければ id、色が無ければ #888。常に文字列', () => {
  assert.deepEqual(boatLabel({ id: 'x.csv', name: 'A艇', color: '#123456' }), { name: 'A艇', color: '#123456' });
  assert.deepEqual(boatLabel({ id: 'x.csv' }), { name: 'x.csv', color: '#888' });
  assert.deepEqual(boatLabel({ id: 7 }), { name: '7', color: '#888' });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/daysummary.test.js`
Expected: FAIL（`computeComparison` is not a function）

- [ ] **Step 3: 実装**

`src/daysummary.js` の import に追加する。

```js
import { boatMinuteVmg } from './vmgminute.js';
```

定数に追加する。

```js
const BUCKET_MS = 30_000;        // VMG比較のバケット幅。vmgminute の既定と同じ
```

末尾に追加する。

```js
// サマリに入れる艇名・色。形チェック(isDaySummaryShape)が文字列を要求するので必ず文字列にする。
export function boatLabel(track) {
  return { name: String(track.name ?? track.id ?? ''), color: String(track.color ?? '#888') };
}

function boatRef(tracks, index, vmgMps) {
  return { index, ...boatLabel(tracks[index]), vmgMps };
}

// 艇間比較。30秒バケットごとに各艇の(走種, 平均VMG)を取り、
// - 比較可能時間: 2艇以上がVMGを持つバケット数 × 30秒
// - VMG最高艇: 同じ走種の艇が2艇以上いたバケットだけで艇ごとに平均し、最大の艇
//   (他艇がいない時間を含めると不公平になるため)
export function computeComparison(tracks, windSeriesByTrack) {
  const byBucket = new Map(); // bucketIndex -> [{ index, pointOfSail, vmg }]
  let anyWind = false;
  tracks.forEach((track, index) => {
    const ws = windSeriesByTrack.get(track) || [];
    if (!ws.length) return;
    anyWind = true;
    let mv;
    try { mv = boatMinuteVmg(track, ws, { bucketMs: BUCKET_MS }); } catch { return; }
    for (const [bi, rec] of mv) {
      let list = byBucket.get(bi);
      if (!list) { list = []; byBucket.set(bi, list); }
      list.push({ index, pointOfSail: rec.pointOfSail, vmg: rec.vmg });
    }
  });
  if (!anyWind) {
    const w = fail('wind-unavailable');
    return { comparableMs: w, bestUpwind: w, bestDownwind: w };
  }

  let comparable = 0;
  const acc = { upwind: new Map(), downwind: new Map() }; // index -> { sum, n }
  for (const list of byBucket.values()) {
    if (list.length >= 2) comparable++;
    for (const pos of ['upwind', 'downwind']) {
      const same = list.filter((r) => r.pointOfSail === pos);
      if (same.length < 2) continue;
      for (const r of same) {
        const a = acc[pos].get(r.index) ?? { sum: 0, n: 0 };
        a.sum += r.vmg; a.n++;
        acc[pos].set(r.index, a);
      }
    }
  }
  const best = (pos) => {
    let top = null;
    for (const [index, a] of acc[pos]) {
      const v = a.sum / a.n;
      if (!top || v > top.vmg) top = { index, vmg: v };
    }
    return top ? ok(boatRef(tracks, top.index, top.vmg)) : fail('no-overlap');
  };
  return {
    comparableMs: comparable ? ok(comparable * BUCKET_MS) : fail('no-overlap'),
    bestUpwind: best('upwind'),
    bestDownwind: best('downwind'),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/daysummary.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/daysummary.js test/daysummary.test.js
git commit -m "feat(daysummary): 艇間比較(比較可能時間とVMG最高艇)と艇ラベルを追加"
```

---

### Task 4: `computeDaySummary`（練習全体・推定風軸・変動幅・タック/ジャイブ回数の組み立て）

**Files:**
- Modify: `src/daysummary.js`
- Test: `test/daysummary.test.js`

**Interfaces:**
- Consumes: Task 1 `detectManeuvers`、Task 2 `ok` / `fail` / `daySummarySourceKey` / `gpsQuality` / `boatStats` / `DAY_SUMMARY_VERSION`（`src/daysummaryschema.js`）、Task 3 `boatLabel` / `computeComparison`。`applyWindAxisOverrides(track, { marks, overrides })`（`src/windaxisoverride.js`）。`circDiffDeg` / `circMedianDeg`（`src/windaxis.js`）。
- Produces: `computeDaySummary(tracks: Track[], options?: { marks?: Mark[], now?: number }): DaySummary`

```js
DaySummary = {
  version: 1,
  sourceKey: string,
  computedAt: number,
  overall: {
    startMs: number|null, endMs: number|null, durationMs: number|null, boatCount: number,
    // boatIndex: 2艇以上のとき最も悪い艇の index(表示時に艇名を前に付ける)。1艇なら null。
    // 艇名を note に埋め込まないのは、後で艇名を変えても表示が追従するようにするため。
    quality: { level: 'good'|'caution'|'poor', note: string, boatIndex: number|null },
    windAxis: Est<{ deg: number }>,              // 0..359 の整数
    windRange: Est<{ minDeg: number, maxDeg: number }>, // 中央値からの偏差(負=左/反時計回り)
  },
  boats: [{
    index: number, name: string, color: string,
    distanceM: number, durationMs: number,
    avgSpeedMps: Est<number>, maxSpeedMps: Est<number>,
    tacks: Est<number>, gybes: Est<number>,
    quality: { level, note },
  }],
  comparison: null | { comparableMs: Est<number>, bestUpwind: Est<BoatRef>, bestDownwind: Est<BoatRef> },
}
```

判定ルール（仕様セクション1を実装向けに具体化したもの）:
- 艇の `tacks` / `gybes`: その艇の品質が「不足」または点が2点未満なら `gps-poor`。それ以外は検出数（0 も実際の回数なので `ok(0)`）。
- 推定風軸は、品質が「不足」でない艇の風軸系列だけをまとめる。そういう艇が1艇もなければ `gps-poor`。まとめた系列が空、またはそれらの艇のタック合計が2回未満なら `tacks-insufficient`。
- 変動幅: 推定風軸が `ok:false` なら同じ理由。まとめた推定点が3点未満、または推定点の時間幅が10分未満なら `tacks-insufficient`。それ以外は偏差の10・90パーセンタイル（整数に丸める）。
- 練習全体の品質: 最も悪い艇の `level` と `note`。2艇以上なら `boatIndex` にその艇の index を入れ、1艇なら `null`（表示側が `boats[boatIndex].name` を前に付ける）。

- [ ] **Step 1: 失敗するテストを書く**

`test/daysummary.test.js` の import を次に差し替え、末尾にテストを追加する。

```js
import {
  ok, fail, daySummarySourceKey, gpsQuality, boatStats, boatLabel, computeComparison, computeDaySummary,
} from '../src/daysummary.js';
import { circDiffDeg, estimateWindAxisSeries } from '../src/windaxis.js';
```

```js
test('computeDaySummary: 1艇・4タックのビート', () => {
  const a = toTrack(path(beatSegments(5)), 'a.csv');
  const s = computeDaySummary([a], { marks: [], now: 123 });
  assert.equal(s.version, 1);
  assert.equal(s.computedAt, 123);
  assert.equal(s.sourceKey, daySummarySourceKey([a]));
  assert.equal(s.overall.boatCount, 1);
  assert.equal(s.overall.startMs, a.tRange.start);
  assert.equal(s.overall.endMs, a.tRange.end);
  assert.equal(s.overall.durationMs, a.tRange.end - a.tRange.start);
  assert.equal(s.overall.quality.level, 'good');
  assert.equal(s.overall.quality.boatIndex, null);
  assert.deepEqual(s.boats[0].tacks, ok(4));
  assert.deepEqual(s.boats[0].gybes, ok(0));
  assert.equal(s.boats[0].name, 'a.csv');
  assert.equal(s.boats[0].index, 0);
  assert.ok(s.overall.windAxis.ok);
  assert.ok(Math.abs(circDiffDeg(s.overall.windAxis.value.deg, 0)) <= 5,
    `deg=${s.overall.windAxis.value.deg}`);
  // 推定点の時間幅が約5分(<10分)なので変動幅は出さない
  assert.deepEqual(s.overall.windRange, fail('tacks-insufficient'));
  // 1艇なら艇間比較はない
  assert.equal(s.comparison, null);
});

test('computeDaySummary: 10分以上のビートなら変動幅を出す', () => {
  const a = toTrack(path(beatSegments(13)), 'a.csv');
  const s = computeDaySummary([a], { now: 0 });
  assert.ok(s.overall.windRange.ok);
  assert.ok(Math.abs(s.overall.windRange.value.minDeg) <= 3);
  assert.ok(Math.abs(s.overall.windRange.value.maxDeg) <= 3);
  assert.ok(s.overall.windRange.value.minDeg <= s.overall.windRange.value.maxDeg);
});

test('computeDaySummary: タックが無ければ推定風軸は 0 ではなく理由', () => {
  const a = toTrack(path([{ deg: 0, sec: 300, speed: 3 }]), 'a.csv');
  const s = computeDaySummary([a], { now: 0 });
  assert.deepEqual(s.boats[0].tacks, ok(0));
  assert.deepEqual(s.overall.windAxis, fail('tacks-insufficient'));
  assert.deepEqual(s.overall.windRange, fail('tacks-insufficient'));
});

test('computeDaySummary: ジャイブだけならタック0・推定風軸は理由表示', () => {
  const segs = [
    { deg: 135, sec: 90, speed: 3 }, { deg: 135, toDeg: 225, sec: 8, speed: 3 },
    { deg: 225, sec: 90, speed: 3 }, { deg: 225, toDeg: 135, sec: 8, speed: 3 },
    { deg: 135, sec: 90, speed: 3 },
  ];
  const s = computeDaySummary([toTrack(path(segs), 'a.csv')], { now: 0 });
  assert.deepEqual(s.boats[0].tacks, ok(0));
  assert.deepEqual(s.boats[0].gybes, ok(2));
  assert.deepEqual(s.overall.windAxis, fail('tacks-insufficient'));
});

test('computeDaySummary: GPS品質が不足ならタック数と推定風軸は gps-poor', () => {
  const a = toTrack(path(beatSegments(5), { dtMs: 10_000 }), 'a.csv');
  const s = computeDaySummary([a], { now: 0 });
  assert.equal(s.overall.quality.level, 'poor');
  assert.deepEqual(s.boats[0].tacks, fail('gps-poor'));
  assert.deepEqual(s.boats[0].gybes, fail('gps-poor'));
  assert.deepEqual(s.overall.windAxis, fail('gps-poor'));
});

test('computeDaySummary: 一部の艇が不足でも、他の艇から推定風軸を出す', () => {
  const good = toTrack(path(beatSegments(5)), 'good.csv');
  const poor = toTrack(path(beatSegments(5), { dtMs: 10_000, lon0: 139.481 }), 'poor.csv');
  const s = computeDaySummary([good, poor], { now: 0 });
  assert.equal(s.overall.quality.level, 'poor');
  assert.equal(s.overall.quality.boatIndex, 1);
  assert.ok(!s.overall.quality.note.includes('poor.csv')); // 艇名は note に埋め込まない
  assert.ok(s.overall.windAxis.ok);
  assert.ok(Math.abs(circDiffDeg(s.overall.windAxis.value.deg, 0)) <= 5);
});

test('computeDaySummary: 2艇なら艇間比較を持つ', () => {
  const a = toTrack(path(beatSegments(5, { speed: 3 })), 'a.csv');
  const b = toTrack(path(beatSegments(5, { speed: 2.5 }), { lon0: 139.481 }), 'b.csv');
  const s = computeDaySummary([a, b], { now: 0 });
  assert.equal(s.overall.boatCount, 2);
  assert.notEqual(s.comparison, null);
  assert.equal(s.comparison.bestUpwind.value.index, 0);
});

test('computeDaySummary: 実行時間は実データ相当(3艇×約1.3万点)でも1秒未満', () => {
  const tracks = [0, 1, 2].map((i) => toTrack(
    path(beatSegments(140, { legSec: 90 }), { lon0: 139.48 + i * 0.001 }), `b${i}.csv`));
  const t0 = performance.now();
  computeDaySummary(tracks, { now: 0 });
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `computeDaySummary took ${ms.toFixed(0)}ms`);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/daysummary.test.js`
Expected: FAIL（`computeDaySummary` is not a function）

- [ ] **Step 3: 実装**

`src/daysummary.js` の import を次のようにする。

```js
import { haversineMeters } from './gps.js';
import { speedAt } from './interpolate.js';
import { circDiffDeg, circMedianDeg, detectManeuvers } from './windaxis.js';
import { applyWindAxisOverrides } from './windaxisoverride.js';
import { boatMinuteVmg } from './vmgminute.js';
import { DAY_SUMMARY_VERSION } from './daysummaryschema.js';
```

定数に追加する。

```js
const RANGE_MIN_POINTS = 3;             // 変動幅を出すのに必要な推定点の数
const RANGE_MIN_SPAN_MS = 10 * 60_000;  // 変動幅を出すのに必要な推定点の時間幅
const QUALITY_RANK = { good: 0, caution: 1, poor: 2 };
```

末尾に追加する。

```js
function countManeuvers(track, marks) {
  let ms;
  try { ms = detectManeuvers(track, { marks }); } catch { ms = []; }
  return {
    tacks: ms.filter((m) => m.type === 'tack').length,
    gybes: ms.filter((m) => m.type === 'gybe').length,
  };
}

function windSeriesOf(track, marks) {
  try {
    return applyWindAxisOverrides(track, { marks, overrides: track.windAxisOverrides });
  } catch {
    return []; // 推定失敗は空系列(app.js の recomputeWindAxis と同じ扱い)
  }
}

// 推定風軸: 品質が不足でない艇の風軸系列をまとめた円周中央値。
function windAxisEst(usableBoatCount, usableTacks, pooled) {
  if (usableBoatCount === 0) return fail('gps-poor');
  if (usableTacks < 2 || pooled.length === 0) return fail('tacks-insufficient');
  return ok({ deg: Math.round(circMedianDeg(pooled.map((p) => p.windFromDeg))) % 360 });
}

// 変動幅: 推定点の中央値からの偏差の10〜90パーセンタイル(負=左/反時計回り)。
function windRangeEst(axis, pooled) {
  if (!axis.ok) return axis;
  const ts = pooled.map((p) => p.tMs);
  if (pooled.length < RANGE_MIN_POINTS || Math.max(...ts) - Math.min(...ts) < RANGE_MIN_SPAN_MS) {
    return fail('tacks-insufficient');
  }
  const devs = pooled.map((p) => circDiffDeg(p.windFromDeg, axis.value.deg)).sort((a, b) => a - b);
  const pct = (q) => devs[Math.round(q * (devs.length - 1))];
  return ok({ minDeg: Math.round(pct(0.1)), maxDeg: Math.round(pct(0.9)) });
}

// 今日の練習サマリ。tracks は state.tracks(可視/非可視を問わず全艇)。
export function computeDaySummary(tracks, { marks = [], now = Date.now() } = {}) {
  const list = tracks || [];
  const windSeriesByTrack = new Map();
  let usableBoatCount = 0, usableTacks = 0;
  const pooled = [];

  const boats = list.map((track, index) => {
    const pts = Array.isArray(track.points) ? track.points : [];
    const quality = gpsQuality(pts);
    const stats = boatStats(pts);
    const series = windSeriesOf(track, marks);
    windSeriesByTrack.set(track, series);
    const poor = quality.level === 'poor' || pts.length < 2;
    const m = poor ? null : countManeuvers(track, marks);
    if (!poor) {
      usableBoatCount++;
      usableTacks += m.tacks;
      pooled.push(...series);
    }
    return {
      index,
      ...boatLabel(track),
      ...stats,
      tacks: m ? ok(m.tacks) : fail('gps-poor'),
      gybes: m ? ok(m.gybes) : fail('gps-poor'),
      quality,
    };
  });

  const starts = list.map((t) => t.tRange?.start).filter(Number.isFinite);
  const ends = list.map((t) => t.tRange?.end).filter(Number.isFinite);
  const startMs = starts.length ? Math.min(...starts) : null;
  const endMs = ends.length ? Math.max(...ends) : null;

  const worst = boats.reduce(
    (w, b) => (!w || QUALITY_RANK[b.quality.level] > QUALITY_RANK[w.quality.level] ? b : w), null);
  const quality = worst
    ? { level: worst.quality.level, note: worst.quality.note, boatIndex: boats.length > 1 ? worst.index : null }
    : { level: 'poor', note: 'GPSデータがありません', boatIndex: null };

  const windAxis = windAxisEst(usableBoatCount, usableTacks, pooled);
  return {
    version: DAY_SUMMARY_VERSION,
    sourceKey: daySummarySourceKey(list),
    computedAt: now,
    overall: {
      startMs, endMs,
      durationMs: startMs != null && endMs != null ? endMs - startMs : null,
      boatCount: list.length,
      quality,
      windAxis,
      windRange: windRangeEst(windAxis, pooled),
    },
    boats,
    comparison: list.length >= 2 ? computeComparison(list, windSeriesByTrack) : null,
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/daysummary.test.js`
Expected: PASS（実行時間テストの所要時間も確認し、数百 ms を超えるようなら報告する）

- [ ] **Step 5: コミット**

```bash
git add src/daysummary.js test/daysummary.test.js
git commit -m "feat(daysummary): 練習全体・推定風軸・変動幅・タック/ジャイブ回数を組み立てる computeDaySummary"
```

---

### Task 5: 保存形の検証と、保存・一覧に `daySummary` を載せる

**Files:**
- Modify: `src/daysummaryschema.js`（`DAY_SUMMARY_REASONS` と `isDaySummaryShape` を追加）
- Modify: `src/project.js`（`serializeProject` / `deserializeProject`）
- Modify: `src/summary.js`（`practiceSummary`）
- Create: `test/fixtures/day-summary-v1.json`、`test/daysummaryschema.test.js`
- Test: `test/daysummary.test.js`、`test/project.test.js`、`test/summary.test.js`、`test/server-api.test.js`

**Interfaces:**
- Consumes: Task 2 の `DAY_SUMMARY_VERSION`、Task 4 の `DaySummary` 形と `computeDaySummary`。
- Produces:
  - `DAY_SUMMARY_REASONS: string[]`（Global Constraints の5つの理由コード）
  - `isDaySummaryShape(x: unknown): boolean` — 表示側（Task 6）が触る全フィールドを検証する。数値は有限値、`quality.level` は `good|caution|poor`、`ok:false` の `reason` は `DAY_SUMMARY_REASONS` のいずれか、`ok:true` の `value` は項目ごとの型、`overall.boatCount === boats.length`、`quality.boatIndex` は `null` か `boats` の範囲内。
  - `serializeProject(state)` の戻り値に `daySummary: DaySummary|null`（`state.daySummary` が形チェックを通れば、そのまま）。
  - `deserializeProject(obj)` の戻り値に `daySummary: DaySummary|null`。
  - `practiceSummary(project)` の戻り値に `daySummary: DaySummary|null`。`/api/summaries` の各行にもそのまま載る。

表示側は `isDaySummaryShape` を通ったものだけを受け取る前提で、`b.tacks.ok` などへ直接触れる。保存 JSON が壊れていても、読込（`deserializeProject`）と一覧（`practiceSummary`）の両方で `null` に落ちるので、ホームのボタンが出ず、押した瞬間に例外になることもない。

- [ ] **Step 1: 共用の fixture を作る**

`test/fixtures/day-summary-v1.json` を新規作成する。2艇・艇間比較あり、`ok:true` と `ok:false` の両方を含む正しい形。

```json
{
  "version": 1,
  "sourceKey": "a.csv|300|1787000000000|1787000299000|0a1b2c3d;b.csv|30|1787000000000|1787000290000|4e5f6a7b",
  "computedAt": 1787000400000,
  "overall": {
    "startMs": 1787000000000,
    "endMs": 1787000299000,
    "durationMs": 299000,
    "boatCount": 2,
    "quality": { "level": "poor", "note": "欠損0%・記録間隔10秒", "boatIndex": 1 },
    "windAxis": { "ok": true, "value": { "deg": 215 } },
    "windRange": { "ok": false, "reason": "tacks-insufficient" }
  },
  "boats": [
    {
      "index": 0, "name": "a.csv", "color": "#1c72b8",
      "distanceM": 870, "durationMs": 299000,
      "avgSpeedMps": { "ok": true, "value": 2.9 },
      "maxSpeedMps": { "ok": true, "value": 3.1 },
      "tacks": { "ok": true, "value": 4 },
      "gybes": { "ok": true, "value": 0 },
      "quality": { "level": "good", "note": "欠損0%・記録間隔1秒・精度5m" }
    },
    {
      "index": 1, "name": "b.csv", "color": "#e67e22",
      "distanceM": 850, "durationMs": 290000,
      "avgSpeedMps": { "ok": true, "value": 2.8 },
      "maxSpeedMps": { "ok": true, "value": 3.0 },
      "tacks": { "ok": false, "reason": "gps-poor" },
      "gybes": { "ok": false, "reason": "gps-poor" },
      "quality": { "level": "poor", "note": "欠損0%・記録間隔10秒" }
    }
  ],
  "comparison": {
    "comparableMs": { "ok": true, "value": 270000 },
    "bestUpwind": { "ok": true, "value": { "index": 0, "name": "a.csv", "color": "#1c72b8", "vmgMps": 1.9 } },
    "bestDownwind": { "ok": false, "reason": "no-overlap" }
  }
}
```

- [ ] **Step 2: 失敗するテストを書く**

`test/daysummaryschema.test.js` を新規作成する。フィールドを1つずつ壊し、どれでも `false` になることを表駆動で確かめる。

```js
// daySummary の形チェックのテスト。表示側が触る全フィールドを1つずつ壊して false になることを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDaySummaryShape, DAY_SUMMARY_REASONS } from '../src/daysummaryschema.js';

const VALID = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(VALID);

test('isDaySummaryShape: fixture(ok:true と ok:false を含む)は通る', () => {
  assert.equal(isDaySummaryShape(VALID), true);
});

test('isDaySummaryShape: 1艇(comparison null・boatIndex null)も通る', () => {
  const d = clone();
  d.boats = [d.boats[0]];
  d.overall.boatCount = 1;
  d.overall.quality.boatIndex = null;
  d.comparison = null;
  assert.equal(isDaySummaryShape(d), true);
});

test('isDaySummaryShape: 開始・終了が不明(null)でも通る', () => {
  const d = clone();
  d.overall.startMs = null; d.overall.endMs = null; d.overall.durationMs = null;
  assert.equal(isDaySummaryShape(d), true);
});

test('DAY_SUMMARY_REASONS は5つの理由コード', () => {
  assert.deepEqual([...DAY_SUMMARY_REASONS].sort(),
    ['gps-poor', 'no-overlap', 'not-moving', 'tacks-insufficient', 'wind-unavailable']);
});

const BROKEN = [
  ['null', () => null],
  ['文字列', () => 'x'],
  ['version 不一致', (d) => { d.version = 2; }],
  ['sourceKey 欠落', (d) => { delete d.sourceKey; }],
  ['computedAt 欠落', (d) => { delete d.computedAt; }],
  ['overall 欠落', (d) => { delete d.overall; }],
  ['overall.startMs が文字列', (d) => { d.overall.startMs = '13:21'; }],
  ['overall.durationMs が Infinity', (d) => { d.overall.durationMs = Infinity; }],
  ['overall.boatCount と boats の数が不一致', (d) => { d.overall.boatCount = 3; }],
  ['overall.quality 欠落', (d) => { delete d.overall.quality; }],
  ['overall.quality.level が未知', (d) => { d.overall.quality.level = 'bad'; }],
  ['overall.quality.note 欠落', (d) => { delete d.overall.quality.note; }],
  ['overall.quality.boatIndex 欠落', (d) => { delete d.overall.quality.boatIndex; }],
  ['overall.quality.boatIndex が範囲外', (d) => { d.overall.quality.boatIndex = 2; }],
  ['overall.windAxis 欠落', (d) => { delete d.overall.windAxis; }],
  ['overall.windAxis の ok が真偽値でない', (d) => { d.overall.windAxis = { value: { deg: 215 } }; }],
  ['overall.windAxis.value.deg 欠落', (d) => { d.overall.windAxis.value = {}; }],
  ['overall.windAxis.value.deg が 360', (d) => { d.overall.windAxis.value.deg = 360; }],
  ['overall.windRange の reason が未知', (d) => { d.overall.windRange.reason = 'oops'; }],
  ['overall.windRange ok:true で maxDeg 欠落', (d) => { d.overall.windRange = { ok: true, value: { minDeg: -8 } }; }],
  ['boats が配列でない', (d) => { d.boats = {}; }],
  ['boat.index 欠落', (d) => { delete d.boats[0].index; }],
  ['boat.name が数値', (d) => { d.boats[0].name = 1; }],
  ['boat.color 欠落', (d) => { delete d.boats[0].color; }],
  ['boat.distanceM 欠落', (d) => { delete d.boats[0].distanceM; }],
  ['boat.durationMs が NaN', (d) => { d.boats[0].durationMs = NaN; }],
  ['boat.avgSpeedMps.value が Infinity', (d) => { d.boats[0].avgSpeedMps.value = Infinity; }],
  ['boat.maxSpeedMps 欠落', (d) => { delete d.boats[0].maxSpeedMps; }],
  ['boat.tacks 欠落', (d) => { delete d.boats[0].tacks; }],
  ['boat.tacks が小数', (d) => { d.boats[0].tacks.value = 1.5; }],
  ['boat.gybes が負数', (d) => { d.boats[0].gybes.value = -1; }],
  ['boat.gybes の reason が未知', (d) => { d.boats[1].gybes.reason = 'x'; }],
  ['boat.quality 欠落', (d) => { delete d.boats[0].quality; }],
  ['boat.quality.level が未知', (d) => { d.boats[0].quality.level = 'ok'; }],
  ['comparison 欠落(undefined)', (d) => { delete d.comparison; }],
  ['comparison.comparableMs 欠落', (d) => { delete d.comparison.comparableMs; }],
  ['comparison.bestUpwind.value.vmgMps 欠落', (d) => { delete d.comparison.bestUpwind.value.vmgMps; }],
  ['comparison.bestUpwind.value.name 欠落', (d) => { delete d.comparison.bestUpwind.value.name; }],
  ['comparison.bestDownwind の reason が未知', (d) => { d.comparison.bestDownwind.reason = 'x'; }],
];

for (const [label, breakIt] of BROKEN) {
  test(`isDaySummaryShape: ${label} なら false`, () => {
    const d = clone();
    const replaced = breakIt(d);
    assert.equal(isDaySummaryShape(replaced === undefined ? d : replaced), false);
  });
}
```

`test/daysummary.test.js` の import に `import { isDaySummaryShape } from '../src/daysummaryschema.js';` を追加し、末尾に「計算結果は必ず形チェックを通る」契約テストを追加する（計算側と検証側が食い違うと、保存したサマリが読込で消えるため）。

```js
test('computeDaySummary の結果は、どの分岐でも isDaySummaryShape を通る', () => {
  const cases = [
    [toTrack(path(beatSegments(5)), 'a.csv')],                                    // 1艇・推定風軸あり
    [toTrack(path([{ deg: 0, sec: 300, speed: 3 }]), 'a.csv')],                   // タック無し
    [toTrack(path(beatSegments(5), { dtMs: 10_000 }), 'a.csv')],                  // GPS不足
    [toTrack(path([{ deg: 0, sec: 60, speed: 0 }]), 'a.csv')],                    // 停船のみ
    [toTrack(path(beatSegments(5)), 'a.csv'),
      toTrack(path(beatSegments(5), { lon0: 139.481 }), 'b.csv')],                 // 2艇・比較あり
    [toTrack(path(beatSegments(5)), 'a.csv'),
      toTrack(path(beatSegments(5), { t0: T0 + 86_400_000 }), 'b.csv')],           // 2艇・重なり無し
  ];
  for (const tracks of cases) {
    const s = computeDaySummary(tracks, { now: 0 });
    assert.equal(isDaySummaryShape(s), true, JSON.stringify(s).slice(0, 300));
  }
});
```

`test/project.test.js` の import に `import { readFileSync } from 'node:fs';` と `import { daySummarySourceKey } from '../src/daysummary.js';` を追加し、末尾に追加する（`sampleState` は同ファイル既存）。

```js
const DS = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));

test('daySummary が serialize→deserialize で往復する', () => {
  const out = deserializeProject(serializeProject({ ...sampleState(), daySummary: DS }));
  assert.deepEqual(out.daySummary, DS);
});

test('daySummary が無い・壊れている場合は null', () => {
  assert.equal(deserializeProject(serializeProject(sampleState())).daySummary, null);
  const obj = serializeProject(sampleState());
  assert.equal(deserializeProject({ ...obj, daySummary: { version: 99 } }).daySummary, null);
  assert.equal(deserializeProject({ ...obj, daySummary: 'x' }).daySummary, null);
  const noTacks = structuredClone(DS);
  delete noTacks.boats[0].tacks;
  assert.equal(deserializeProject({ ...obj, daySummary: noTacks }).daySummary, null);
});

test('保存JSONを読み直しても sourceKey は変わらない(開き直しで stale 扱いにならない)', () => {
  const state = sampleState();
  const reloaded = deserializeProject(JSON.parse(JSON.stringify(serializeProject(state))));
  assert.equal(daySummarySourceKey(reloaded.tracks), daySummarySourceKey(state.tracks));
});
```

`test/summary.test.js` の import に `import { readFileSync } from 'node:fs';` を追加し、末尾に追加する。

```js
test('practiceSummary: daySummary をそのまま返し、無い・壊れていれば null', () => {
  const ds = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(practiceSummary({ daySummary: ds }).daySummary, ds);
  assert.equal(practiceSummary({}).daySummary, null);
  assert.equal(practiceSummary({ daySummary: { ...ds, version: 2 } }).daySummary, null);
  assert.equal(practiceSummary({ daySummary: { ...ds, boats: [{}] } }).daySummary, null);
});
```

`test/server-api.test.js` の import に `import { readFileSync } from 'node:fs';` を追加し、`summaries returns lightweight rows` テストの直後に追加する。

```js
test('summaries rows include daySummary saved with the project', async () => {
  const name = 'sailviz-20260102-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const ds = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));
  const put = await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: bearer, body: JSON.stringify({ version: 1, tracks: [], daySummary: ds }),
  });
  assert.equal(put.status, 200);
  const rows = await (await fetch(`${base}/api/summaries`)).json();
  assert.deepEqual(rows.find((r) => r.name === name)?.daySummary, ds);
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `node --test test/daysummaryschema.test.js test/daysummary.test.js test/project.test.js test/summary.test.js test/server-api.test.js`
Expected: FAIL（`isDaySummaryShape` が未定義、`daySummary` が `undefined`）

- [ ] **Step 4: 実装**

`src/daysummaryschema.js` の末尾に追加する。

```js
// 算出不能の理由コード。表示側(daysummaryview.js の REASON_TEXT)と一致させる。
export const DAY_SUMMARY_REASONS = [
  'tacks-insufficient', 'gps-poor', 'no-overlap', 'wind-unavailable', 'not-moving',
];
const QUALITY_LEVELS = ['good', 'caution', 'poor'];

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isNumOrNull = (x) => x === null || isNum(x);
const isStr = (x) => typeof x === 'string';
const isCount = (x) => Number.isInteger(x) && x >= 0;

// Est 型: ok:true なら value が valueOk を満たし、ok:false なら reason が既知のコード。
function isEst(e, valueOk) {
  if (!isObj(e)) return false;
  if (e.ok === true) return valueOk(e.value);
  if (e.ok === false) return DAY_SUMMARY_REASONS.includes(e.reason);
  return false;
}
const isBoatQuality = (q) => isObj(q) && QUALITY_LEVELS.includes(q.level) && isStr(q.note);
const isBoatRef = (v) => isObj(v) && isCount(v.index) && isStr(v.name) && isStr(v.color) && isNum(v.vmgMps);

function isOverall(o, boatCount) {
  return isObj(o)
    && isNumOrNull(o.startMs) && isNumOrNull(o.endMs) && isNumOrNull(o.durationMs)
    && o.boatCount === boatCount
    && isBoatQuality(o.quality)
    && (o.quality.boatIndex === null || (isCount(o.quality.boatIndex) && o.quality.boatIndex < boatCount))
    && isEst(o.windAxis, (v) => isObj(v) && isNum(v.deg) && v.deg >= 0 && v.deg < 360)
    && isEst(o.windRange, (v) => isObj(v) && isNum(v.minDeg) && isNum(v.maxDeg));
}

function isBoat(b) {
  return isObj(b) && isCount(b.index) && isStr(b.name) && isStr(b.color)
    && isNum(b.distanceM) && isNum(b.durationMs)
    && isEst(b.avgSpeedMps, isNum) && isEst(b.maxSpeedMps, isNum)
    && isEst(b.tacks, isCount) && isEst(b.gybes, isCount)
    && isBoatQuality(b.quality);
}

function isComparison(c) {
  return c === null || (isObj(c)
    && isEst(c.comparableMs, isNum)
    && isEst(c.bestUpwind, isBoatRef) && isEst(c.bestDownwind, isBoatRef));
}

// daySummary の形チェック。表示側(renderDaySummaryHtml)が触る全フィールドを見る。
// 壊れていれば読込・一覧の側で null に落とし、次に練習を開いたとき黙って再計算させる。
export function isDaySummaryShape(x) {
  return isObj(x) && x.version === DAY_SUMMARY_VERSION
    && isStr(x.sourceKey) && isNum(x.computedAt)
    && Array.isArray(x.boats) && x.boats.every(isBoat)
    && isOverall(x.overall, x.boats.length)
    && isComparison(x.comparison);
}
```

`src/project.js` の import に追加する。

```js
import { isDaySummaryShape } from './daysummaryschema.js';
```

`serializeProject` の戻り値で、`basemap: serializeBasemap(state.basemap),` の直後に追加する。

```js
    // 今日の練習サマリ(GPS読込時点のスナップショット)。形が壊れていれば保存しない。
    daySummary: isDaySummaryShape(state.daySummary) ? state.daySummary : null,
```

`deserializeProject` の戻り値で、`basemap: deserializeBasemap(obj.basemap),` の直後に追加する。

```js
    daySummary: isDaySummaryShape(obj.daySummary) ? obj.daySummary : null,
```

`src/summary.js` の import に追加する。

```js
import { isDaySummaryShape } from './daysummaryschema.js';
```

`practiceSummary` の戻り値で、`wind: windText(firstWind),` の直後に追加する。

```js
    // 今日の練習サマリ。ホームカードから本体を読まずにモーダルを開くために一覧へ載せる。
    daySummary: isDaySummaryShape(p.daySummary) ? p.daySummary : null,
```

- [ ] **Step 5: テストが通ることを確認**

Run: `node --test test/daysummaryschema.test.js test/daysummary.test.js test/project.test.js test/summary.test.js test/server-api.test.js test/server-storage.test.js`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/daysummaryschema.js src/project.js src/summary.js test/fixtures/day-summary-v1.json \
  test/daysummaryschema.test.js test/daysummary.test.js test/project.test.js test/summary.test.js test/server-api.test.js
git commit -m "feat(daysummary): daySummary の全フィールド検証と、練習JSON・一覧APIへの搭載"
```

---

### Task 6: 表示の純関数 `renderDaySummaryHtml`

**Files:**
- Create: `src/daysummaryview.js`
- Test: `test/daysummaryview.test.js`

**Interfaces:**
- Consumes: Task 4 の `DaySummary` 形（`daySummary` オブジェクトだけを見る。トラックの点データは参照しない）。前提として、渡されるのは Task 5 の `isDaySummaryShape` を通ったもの（計算直後の値か、読込・一覧で検証済みの値）だけ。
- Produces:
  - `REASON_TEXT: Record<string, string>`（キーは `DAY_SUMMARY_REASONS` と一致）
  - `formatKt(mps: number): string`（例 `'6.0kt'`）、`formatDuration(ms: number): string`（例 `'2時間27分'`、`'45分'`）、`formatDistance(m: number): string`（例 `'18.2km'`、`'297m'`）、`formatWindDeg(deg: number): string`（例 `'215°（南西）'`）、`formatWindRange({ minDeg, maxDeg }): string`（例 `'左8°〜右14°'`）
  - `renderDaySummaryHtml(ds: DaySummary, options?: { canRecompute?: boolean, unsaved?: boolean }): string` — モーダル内側の HTML。ボタンは `data-ds-action` 属性（`close` / `recompute` / `track` / `compare` / `reflect`）で識別する。

- [ ] **Step 1: 失敗するテストを書く**

`test/daysummaryview.test.js` を新規作成する。

```js
// 今日の練習サマリ(表示)のテスト。daySummary オブジェクトだけから HTML を組むことを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REASON_TEXT, formatKt, formatDuration, formatDistance, formatWindDeg, formatWindRange,
  renderDaySummaryHtml,
} from '../src/daysummaryview.js';
import { DAY_SUMMARY_REASONS } from '../src/daysummaryschema.js';

const START = Date.UTC(2026, 7, 23, 4, 21); // 2026-08-23 13:21 JST
const END = START + (2 * 60 + 27) * 60_000; // 15:48 JST

function boat(i, over = {}) {
  return {
    index: i, name: `boat${i}.csv`, color: '#1c72b8',
    distanceM: 18_200, durationMs: (2 * 60 + 21) * 60_000,
    avgSpeedMps: { ok: true, value: 3.0864 }, maxSpeedMps: { ok: true, value: 5.04 },
    tacks: { ok: true, value: 24 }, gybes: { ok: true, value: 11 },
    quality: { level: 'good', note: '欠損0%・記録間隔1秒・精度5m' },
    ...over,
  };
}

function fixture(over = {}) {
  return {
    version: 1, sourceKey: 'k', computedAt: 0,
    overall: {
      startMs: START, endMs: END, durationMs: END - START, boatCount: 1,
      quality: { level: 'caution', note: '欠損12%・記録間隔2秒', boatIndex: null },
      windAxis: { ok: true, value: { deg: 215 } },
      windRange: { ok: true, value: { minDeg: -8, maxDeg: 14 } },
    },
    boats: [boat(0)],
    comparison: null,
    ...over,
  };
}

function twoBoats() {
  return fixture({
    overall: { ...fixture().overall, boatCount: 2 },
    boats: [boat(0), boat(1, { color: '#e67e22' })],
    comparison: {
      comparableMs: { ok: true, value: 102 * 60_000 },
      bestUpwind: { ok: true, value: { index: 0, name: 'boat0.csv', color: '#1c72b8', vmgMps: 1.75 } },
      bestDownwind: { ok: false, reason: 'no-overlap' },
    },
  });
}

test('REASON_TEXT は保存形の理由コードをすべて持つ', () => {
  assert.deepEqual(Object.keys(REASON_TEXT).sort(), [...DAY_SUMMARY_REASONS].sort());
});

test('形チェック用 fixture(2艇・ok:false 混在)を例外なく描画できる', () => {
  const ds = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));
  const html = renderDaySummaryHtml(ds);
  assert.ok(html.includes('b.csv: 欠損0%・記録間隔10秒'));
  assert.ok(html.includes(REASON_TEXT['gps-poor']));
});

test('整形: kt・時間・距離・方位・変動幅', () => {
  assert.equal(formatKt(3.0864), '6.0kt');
  assert.equal(formatDuration((2 * 60 + 27) * 60_000), '2時間27分');
  assert.equal(formatDuration(45 * 60_000), '45分');
  assert.equal(formatDistance(18_200), '18.2km');
  assert.equal(formatDistance(297), '297m');
  assert.equal(formatWindDeg(215), '215°（南西）');
  assert.equal(formatWindDeg(0), '0°（北）');
  assert.equal(formatWindRange({ minDeg: -8, maxDeg: 14 }), '左8°〜右14°');
});

test('練習全体: JSTの開始〜終了・練習時間・艇数・品質・推定風軸', () => {
  const html = renderDaySummaryHtml(fixture());
  assert.ok(html.includes('2026-08-23 13:21〜15:48（2時間27分）'));
  assert.ok(html.includes('GPS取得 1艇'));
  assert.ok(html.includes('注意'));
  assert.ok(html.includes('欠損12%・記録間隔2秒'));
  assert.ok(html.includes('215°（南西）'));
  assert.ok(html.includes('左8°〜右14°'));
});

test('2艇で quality.boatIndex があれば、その艇の現在の名前を品質の根拠の前に付ける', () => {
  const ds = twoBoats();
  ds.overall.quality = { level: 'poor', note: '欠損0%・記録間隔10秒', boatIndex: 1 };
  ds.boats[1].name = 'B艇';
  assert.ok(renderDaySummaryHtml(ds).includes('B艇: 欠損0%・記録間隔10秒'));
});

test('推定値の見出しに「推定」が付く', () => {
  const html = renderDaySummaryHtml(fixture());
  assert.ok(html.includes('推定風軸'));
  assert.ok(html.includes('推定風軸の変動幅'));
  assert.ok(html.includes('タック（推定）'));
  assert.ok(html.includes('ジャイブ（推定）'));
  assert.ok(html.includes('GPS軌跡からの推定値'));
});

test('算出不能の項目は数値ではなく理由を出す', () => {
  const ds = fixture({
    overall: {
      ...fixture().overall,
      windAxis: { ok: false, reason: 'tacks-insufficient' },
      windRange: { ok: false, reason: 'tacks-insufficient' },
    },
    boats: [boat(0, {
      tacks: { ok: false, reason: 'gps-poor' }, gybes: { ok: false, reason: 'gps-poor' },
      avgSpeedMps: { ok: false, reason: 'not-moving' }, maxSpeedMps: { ok: false, reason: 'not-moving' },
    })],
  });
  const html = renderDaySummaryHtml(ds);
  const axisRow = html.match(/<div class="ds-axis">([\s\S]*?)<\/div>/)[1];
  assert.ok(axisRow.includes(REASON_TEXT['tacks-insufficient']));
  assert.ok(!/\d+°/.test(axisRow), `axis row should have no degrees: ${axisRow}`);
  assert.ok(html.includes(REASON_TEXT['gps-poor']));
  assert.ok(html.includes(REASON_TEXT['not-moving']));
  assert.ok(!html.includes('0kt'));
  // タックとジャイブが同じ理由なら1セルにまとめる
  assert.ok(html.includes(`<td colspan="2"><span class="ds-reason">${REASON_TEXT['gps-poor']}</span></td>`));
});

test('1艇なら艇間比較と「艇ごとに比較する」を出さない', () => {
  const html = renderDaySummaryHtml(fixture());
  assert.ok(!html.includes('艇間比較'));
  assert.ok(!html.includes('data-ds-action="compare"'));
  assert.ok(html.includes('data-ds-action="track"'));
  assert.ok(html.includes('data-ds-action="reflect"'));
});

test('2艇なら艇間比較と「艇ごとに比較する」を出す', () => {
  const html = renderDaySummaryHtml(twoBoats());
  assert.ok(html.includes('艇間比較'));
  assert.ok(html.includes('比較可能だった時間'));
  assert.ok(html.includes('1時間42分'));
  assert.ok(html.includes('クローズVMG最高'));
  assert.ok(html.includes('boat0.csv'));
  assert.ok(html.includes('3.4kt'));
  assert.ok(html.includes(REASON_TEXT['no-overlap']));
  assert.ok(html.includes('data-ds-action="compare"'));
});

test('艇名をエスケープし、不正な色は #888 にする', () => {
  const ds = fixture({ boats: [boat(0, { name: '<script>alert(1)</script>', color: 'red;background:url(x)' })] });
  const html = renderDaySummaryHtml(ds);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('url(x)'));
  assert.ok(html.includes('background:#888'));
});

test('保存案内と再計算ボタンはオプションで出し分ける', () => {
  const base = renderDaySummaryHtml(fixture());
  assert.ok(!base.includes('保存するとホームからいつでも開けます'));
  assert.ok(!base.includes('data-ds-action="recompute"'));
  const html = renderDaySummaryHtml(fixture(), { unsaved: true, canRecompute: true });
  assert.ok(html.includes('保存するとホームからいつでも開けます'));
  assert.ok(html.includes('data-ds-action="recompute"'));
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/daysummaryview.test.js`
Expected: FAIL（`Cannot find module '../src/daysummaryview.js'`）

- [ ] **Step 3: 実装**

`src/daysummaryview.js` を新規作成する。

```js
// src/daysummaryview.js
// 今日の練習サマリ(daySummary)をモーダル内側の HTML 文字列にする純関数群。DOM 非依存。
// daySummary だけを見て組み立てる(トラックの点データを参照しない)ので、
// 読込直後でもホームカードから開いても同じ表示になる。
export const REASON_TEXT = {
  'tacks-insufficient': 'タック数が不足しています',
  'gps-poor': 'GPS精度が不足しています',
  'no-overlap': '比較可能な区間がありません',
  'wind-unavailable': '推定風軸がないため算出できません',
  'not-moving': '走行中のデータがありません',
};
const QUALITY_TEXT = { good: '良好', caution: '注意', poor: '不足' };
const DIRS16 = [
  '北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西',
];
const MPS_TO_KT = 1.943844;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 練習JSON由来の色は信頼しない。#RGB〜#RRGGBBAA 以外は既定色にする。
function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#888';
}

export function formatKt(mps) { return `${(mps * MPS_TO_KT).toFixed(1)}kt`; }
export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h ? `${h}時間${m}分` : `${m}分`;
}
export function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}
export function formatWindDeg(deg) {
  return `${deg}°（${DIRS16[Math.round(deg / 22.5) % 16]}）`;
}
export function formatWindRange({ minDeg, maxDeg }) {
  const side = (v) => (v < 0 ? `左${-v}°` : `右${v}°`);
  return `${side(minDeg)}〜${side(maxDeg)}`;
}

const jstDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const jstClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
});

function reason(r) {
  return `<span class="ds-reason">${escapeHtml(REASON_TEXT[r] ?? '算出できません')}</span>`;
}
// Est 型を表示用 HTML に。ok なら fmt(value) をエスケープ、ok:false なら理由の文言。
function est(e, fmt) {
  if (!e || !e.ok) return reason(e?.reason);
  return escapeHtml(fmt(e.value));
}
function swatch(color) {
  return `<span class="ds-swatch" style="background:${safeColor(color)}"></span>`;
}

function overallHtml(o, boats) {
  const when = o.startMs != null && o.endMs != null
    ? `${jstDate.format(new Date(o.startMs))} ${jstClock.format(new Date(o.startMs))}`
      + `〜${jstClock.format(new Date(o.endMs))}（${formatDuration(o.durationMs)}）`
    : '時刻不明';
  const q = o.quality || { level: 'poor', note: '', boatIndex: null };
  // どの艇の品質かは boatIndex で持つ(艇名を後で変えても追従する)。
  const who = q.boatIndex != null && boats[q.boatIndex] ? `${boats[q.boatIndex].name}: ` : '';
  const note = q.note ? `${who}${q.note}` : '';
  return '<section class="ds-overall">'
    + `<div class="ds-when">${escapeHtml(when)}</div>`
    + `<div>GPS取得 ${o.boatCount}艇</div>`
    + `<div>GPS品質: <span class="ds-q ds-q-${escapeHtml(q.level)}">${escapeHtml(QUALITY_TEXT[q.level] ?? q.level)}</span>`
    + `${note ? ` — ${escapeHtml(note)}` : ''}</div>`
    + `<div class="ds-axis">推定風軸: ${est(o.windAxis, (v) => formatWindDeg(v.deg))}</div>`
    + `<div class="ds-range">推定風軸の変動幅: ${est(o.windRange, formatWindRange)}</div>`
    + '<div class="ds-note">※ 推定風軸はGPS軌跡からの推定値です（実測ではありません）</div>'
    + '</section>';
}

function boatRowHtml(b) {
  const mTd = (!b.tacks.ok && !b.gybes.ok && b.tacks.reason === b.gybes.reason)
    ? `<td colspan="2">${reason(b.tacks.reason)}</td>`
    : `<td>${est(b.tacks, String)}</td><td>${est(b.gybes, String)}</td>`;
  return '<tr>'
    + `<td>${swatch(b.color)}${escapeHtml(b.name)}</td>`
    + `<td>${escapeHtml(formatDistance(b.distanceM))}</td>`
    + `<td>${escapeHtml(formatDuration(b.durationMs))}</td>`
    + `<td>${est(b.avgSpeedMps, formatKt)}</td>`
    + `<td>${est(b.maxSpeedMps, formatKt)}</td>`
    + mTd
    + '</tr>';
}

function boatsHtml(boats) {
  return '<section><h3>艇ごと</h3><div class="ds-table-wrap"><table class="ds-table">'
    + '<thead><tr><th>艇</th><th>走行距離</th><th>記録時間</th><th>平均速度</th><th>最高速度</th>'
    + '<th>タック（推定）</th><th>ジャイブ（推定）</th></tr></thead>'
    + `<tbody>${boats.map(boatRowHtml).join('')}</tbody></table></div></section>`;
}

function bestHtml(e) {
  if (!e || !e.ok) return reason(e?.reason);
  const v = e.value;
  return `${swatch(v.color)}${escapeHtml(v.name)}（平均 ${escapeHtml(formatKt(v.vmgMps))}）`;
}

function comparisonHtml(c) {
  return '<section class="ds-compare"><h3>艇間比較</h3>'
    + `<div>比較可能だった時間: ${est(c.comparableMs, formatDuration)}</div>`
    + `<div>クローズVMG最高: ${bestHtml(c.bestUpwind)}</div>`
    + `<div>ランニングVMG最高: ${bestHtml(c.bestDownwind)}</div>`
    + '</section>';
}

export function renderDaySummaryHtml(ds, { canRecompute = false, unsaved = false } = {}) {
  const boats = Array.isArray(ds.boats) ? ds.boats : [];
  const head = '<div class="ds-head"><strong>今日の練習サマリ</strong>'
    + (canRecompute ? '<button type="button" class="ds-btn" data-ds-action="recompute">再計算</button>' : '')
    + '<button type="button" class="ds-btn" data-ds-action="close" title="閉じる (Esc)">×</button></div>';
  const body = '<div class="ds-body">'
    + overallHtml(ds.overall || {}, boats)
    + boatsHtml(boats)
    + (ds.comparison ? comparisonHtml(ds.comparison) : '')
    + '</div>';
  const actions = '<div class="ds-actions">'
    + '<button type="button" class="ds-btn" data-ds-action="track">軌跡を見る</button>'
    + (ds.comparison ? '<button type="button" class="ds-btn" data-ds-action="compare">艇ごとに比較する</button>' : '')
    + '<button type="button" class="ds-btn" data-ds-action="reflect">今日の反省を書く</button>'
    + (unsaved ? '<div class="ds-hint">保存するとホームからいつでも開けます</div>' : '')
    + '</div>';
  return head + body + actions;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/daysummaryview.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/daysummaryview.js test/daysummaryview.test.js
git commit -m "feat(daysummary): サマリをHTMLにする renderDaySummaryHtml を追加"
```

---

### Task 7: 状態遷移の純関数（自動表示・stale・保存直前・導線）

**Files:**
- Modify: `src/daysummary.js`（`syncDaySummaryLabels` を追加）
- Create: `src/daysummaryflow.js`
- Test: `test/daysummary.test.js`、`test/daysummaryflow.test.js`

**Interfaces:**
- Consumes: Task 2 `daySummarySourceKey`、Task 3 `boatLabel`、Task 4 `computeDaySummary`、Task 5 `isDaySummaryShape`（テストのみ）。
- Produces:
  - `src/daysummary.js`: `syncDaySummaryLabels(ds: DaySummary, tracks: Track[]): DaySummary` — `boats[]` と VMG 最高艇の艇名・色を `tracks[index]` に合わせる。数値と `sourceKey` は変えない。変わるものが無ければ**同じオブジェクト**を返す（呼び出し側は `===` で「未保存になったか」を判定する）。
  - `src/daysummaryflow.js`（結果はどれも `{ summary: DaySummary|null, saved: boolean, recomputed: boolean, error: Error|null }` を基本形にする。`summary` はそのまま `state.daySummary` に、`saved` は `state.daySummarySaved` に入れる値）:
    - `refreshDaySummary(current: { summary, saved }, tracks, { marks?, compute?, force? }?)` — GPS が無ければ `null`。`sourceKey` が一致すれば艇名・色だけ同期。不一致・未計算・`force` なら再計算し、失敗したら `summary: null`（古いサマリを残さない）。トップバーの 📊 サマリ、保存の直前、再計算ボタン（`force: true`）で使う。
    - `daySummaryAfterGpsLoad(current, tracks, tracksBefore, opts?)` — 上の結果に `autoOpen: boolean` を足す。GPS が増えて再計算に成功したときだけ `autoOpen: true`。GPS が増えていなければ何もしない。
    - `daySummaryAfterPracticeLoad(savedSummary: DaySummary|null, tracks, opts?)` — 上の結果に `autoOpen: false` を足す（練習を開いたときは自動表示しない）。保存サマリが無い・食い違うときは黙って再計算。
    - `runDaySummaryAction(action, { fromHomeName? }, deps: { loadPractice, showTrack, setVmgOn, openReflectionEditor }): Promise<boolean>` — モーダルの導線。ホームから開いたときは先に `loadPractice`、`false`（確認キャンセル・読込失敗）なら何もせず `false`。
  - `compute` の既定は `computeDaySummary`。テストでは呼び出し回数と失敗を制御できる偽物に差し替える。

このタスクは、Task 8 の `app.js` に置くと手動確認でしか守れない状態遷移を、DOM 非依存の関数に切り出して自動テストするためのもの。stale（GPS と食い違うサマリ）はフラグを持たず、使う直前に `sourceKey` を比べて判定する。トラックの削除・差し替えのハンドラに手を入れなくても、保存・表示の前に必ず照合される。

- [ ] **Step 1: 失敗するテストを書く（ラベル同期）**

`test/daysummary.test.js` の import に `syncDaySummaryLabels` を追加し、末尾にテストを追加する。

```js
test('syncDaySummaryLabels: 艇名・色だけ現在のトラックに合わせ、数値は変えない', () => {
  const a = toTrack(path(beatSegments(5, { speed: 3 })), 'a.csv', '#1c72b8');
  const b = toTrack(path(beatSegments(5, { speed: 2.5 }), { lon0: 139.481 }), 'b.csv', '#e67e22');
  const s = computeDaySummary([a, b], { now: 0 });
  assert.equal(syncDaySummaryLabels(s, [a, b]), s); // 変化が無ければ同じオブジェクト
  const t = syncDaySummaryLabels(s, [{ ...a, name: 'A艇', color: '#000000' }, b]);
  assert.notEqual(t, s);
  assert.equal(t.boats[0].name, 'A艇');
  assert.equal(t.boats[0].color, '#000000');
  assert.equal(t.boats[0].distanceM, s.boats[0].distanceM);
  assert.equal(t.comparison.bestUpwind.value.name, 'A艇');
  assert.equal(t.sourceKey, s.sourceKey);
  assert.equal(s.boats[0].name, 'a.csv'); // 元のサマリは書き換えない
  assert.equal(isDaySummaryShape(t), true);
});
```

- [ ] **Step 2: 失敗するテストを書く（状態遷移）**

`test/daysummaryflow.test.js` を新規作成する。

```js
// 今日の練習サマリの状態遷移のテスト。compute は呼び出し回数と失敗を制御できる偽物に差し替える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshDaySummary, daySummaryAfterGpsLoad, daySummaryAfterPracticeLoad, runDaySummaryAction,
} from '../src/daysummaryflow.js';
import { daySummarySourceKey, boatLabel } from '../src/daysummary.js';

function track(id, n = 3) {
  const points = Array.from({ length: n }, (_, i) => ({
    t: 1_787_000_000_000 + i * 1000, lat: 35.3 + i * 1e-5, lon: 139.48,
  }));
  return { id, name: id, color: '#1c72b8', points, tRange: { start: points[0].t, end: points[n - 1].t } };
}

// computeDaySummary の代わり。sourceKey と艇ラベルだけ本物と同じ形で持つ。
function fakeCompute() {
  const f = (tracks) => {
    f.calls++;
    if (f.fail) throw new Error('boom');
    return {
      sourceKey: daySummarySourceKey(tracks),
      boats: tracks.map((t, index) => ({ index, ...boatLabel(t) })),
      comparison: null,
    };
  };
  f.calls = 0;
  f.fail = false;
  return f;
}
const EMPTY = { summary: null, saved: false };

// --- GPS 読込(loadFiles) ---

test('GPS読込: 初回は計算して自動表示する(未保存)', () => {
  const compute = fakeCompute();
  const r = daySummaryAfterGpsLoad(EMPTY, [track('a')], 0, { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.autoOpen, true);
  assert.equal(r.saved, false);
  assert.ok(r.summary);
});

test('GPS読込: GPS が増えなければ(タグCSVだけ等)計算も自動表示もしない', () => {
  const compute = fakeCompute();
  const cur = { summary: { sourceKey: 'x' }, saved: true };
  const r = daySummaryAfterGpsLoad(cur, [track('a')], 1, { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.autoOpen, false);
  assert.equal(r.summary, cur.summary);
  assert.equal(r.saved, true);
});

test('GPS読込: 保存済みの練習に GPS を後付けしたら再計算して自動表示する', () => {
  const compute = fakeCompute();
  const a = track('a');
  const first = daySummaryAfterGpsLoad(EMPTY, [a], 0, { compute });
  const r = daySummaryAfterGpsLoad({ summary: first.summary, saved: true }, [a, track('b', 4)], 1, { compute });
  assert.equal(compute.calls, 2);
  assert.equal(r.autoOpen, true);
  assert.equal(r.saved, false);
  assert.equal(r.summary.boats.length, 2);
});

test('GPS読込: 計算に失敗したら自動表示せず、サマリは null・エラーを返す', () => {
  const compute = fakeCompute();
  compute.fail = true;
  const r = daySummaryAfterGpsLoad(EMPTY, [track('a')], 0, { compute });
  assert.equal(r.autoOpen, false);
  assert.equal(r.summary, null);
  assert.ok(r.error instanceof Error);
});

// --- 保存済み練習を開く(loadPractice) ---

test('練習を開く: 保存サマリが GPS と一致すれば、そのまま使い自動表示しない', () => {
  const compute = fakeCompute();
  const tracks = [track('a')];
  const saved = fakeCompute()(tracks);
  const r = daySummaryAfterPracticeLoad(saved, tracks, { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.autoOpen, false);
  assert.equal(r.summary, saved);
  assert.equal(r.saved, true);
});

test('練習を開く: サマリが無い(機能追加前の練習)なら黙って計算し、自動表示しない', () => {
  const compute = fakeCompute();
  const r = daySummaryAfterPracticeLoad(null, [track('a')], { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.autoOpen, false);
  assert.equal(r.saved, false);
  assert.ok(r.summary);
});

test('練習を開く: GPS と食い違うサマリは黙って作り直し、未保存扱いにする', () => {
  const compute = fakeCompute();
  const r = daySummaryAfterPracticeLoad({ sourceKey: 'old', boats: [], comparison: null }, [track('a')], { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.autoOpen, false);
  assert.equal(r.saved, false);
});

// --- 保存直前・トップバー(refreshDaySummary) ---

test('保存直前: GPS と一致していれば計算せず、保存済みのまま', () => {
  const compute = fakeCompute();
  const tracks = [track('a')];
  const cur = { summary: fakeCompute()(tracks), saved: true };
  const r = refreshDaySummary(cur, tracks, { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.summary, cur.summary);
  assert.equal(r.saved, true);
});

test('保存直前: トラック削除後は再計算する(stale のまま保存しない)', () => {
  const compute = fakeCompute();
  const a = track('a');
  const cur = { summary: fakeCompute()([a, track('b', 4)]), saved: true };
  const r = refreshDaySummary(cur, [a], { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.recomputed, true);
  assert.equal(r.summary.boats.length, 1);
  assert.equal(r.saved, false);
});

test('保存直前: 再計算に失敗したら古いサマリを残さない', () => {
  const compute = fakeCompute();
  compute.fail = true;
  const a = track('a');
  const cur = { summary: fakeCompute()([a, track('b', 4)]), saved: true };
  const r = refreshDaySummary(cur, [a], { compute });
  assert.equal(r.summary, null);
  assert.equal(r.saved, false);
  assert.ok(r.error instanceof Error);
});

test('保存直前: トラックが全部消えたらサマリは null', () => {
  const compute = fakeCompute();
  const cur = { summary: fakeCompute()([track('a')]), saved: true };
  const r = refreshDaySummary(cur, [], { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.summary, null);
  assert.equal(r.saved, false);
});

test('艇名・色の変更はサマリに反映し、再計算はしない(未保存になる)', () => {
  const compute = fakeCompute();
  const a = track('a');
  const cur = { summary: fakeCompute()([a]), saved: true };
  const r = refreshDaySummary(cur, [{ ...a, name: 'A艇', color: '#000000' }], { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.summary.boats[0].name, 'A艇');
  assert.equal(r.summary.boats[0].color, '#000000');
  assert.equal(r.saved, false);
});

test('再計算ボタン(force): 一致していても計算し直し、失敗なら null', () => {
  const compute = fakeCompute();
  const tracks = [track('a')];
  const cur = { summary: fakeCompute()(tracks), saved: true };
  const r = refreshDaySummary(cur, tracks, { compute, force: true });
  assert.equal(compute.calls, 1);
  assert.equal(r.saved, false);
  compute.fail = true;
  assert.equal(refreshDaySummary(cur, tracks, { compute, force: true }).summary, null);
});

// --- 導線(runDaySummaryAction) ---

function recorder(loadResult) {
  const log = [];
  const deps = {
    loadPractice: async (name) => { log.push(`load:${name}`); return loadResult; },
    showTrack: () => log.push('track'),
    setVmgOn: (on) => log.push(`vmg:${on}`),
    openReflectionEditor: async () => { log.push('reflect'); },
  };
  return { log, deps };
}

test('導線: ホームから開いて読込をキャンセルしたら軌跡画面へ行かない', async () => {
  const { log, deps } = recorder(false);
  assert.equal(await runDaySummaryAction('reflect', { fromHomeName: 'x.json' }, deps), false);
  assert.deepEqual(log, ['load:x.json']);
});

test('導線: ホームから開いたら、読み込んでから比較(VMG ON)する', async () => {
  const { log, deps } = recorder(true);
  assert.equal(await runDaySummaryAction('compare', { fromHomeName: 'x.json' }, deps), true);
  assert.deepEqual(log, ['load:x.json', 'track', 'vmg:true']);
});

test('導線: 軌跡画面から開いたときは読み込まずに反省エディタを開く', async () => {
  const { log, deps } = recorder(true);
  await runDaySummaryAction('reflect', {}, deps);
  assert.deepEqual(log, ['track', 'reflect']);
});

test('導線: 軌跡を見るは軌跡画面を出すだけ', async () => {
  const { log, deps } = recorder(true);
  await runDaySummaryAction('track', {}, deps);
  assert.deepEqual(log, ['track']);
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `node --test test/daysummary.test.js test/daysummaryflow.test.js`
Expected: FAIL（`syncDaySummaryLabels` is not a function、`Cannot find module '../src/daysummaryflow.js'`）

- [ ] **Step 4: 実装**

`src/daysummary.js` の末尾に追加する。

```js
// 艇名・色を現在のトラックに合わせる(数値と sourceKey は変えない)。
// sourceKey が一致する=同じ並びのトラックである前提で、index で対応づける。
// 変わるものが無ければ同じオブジェクトを返す(呼び出し側が === で未保存になったかを判定する)。
export function syncDaySummaryLabels(ds, tracks) {
  let changed = false;
  const relabel = (x) => {
    const t = tracks[x.index];
    if (!t) return x;
    const label = boatLabel(t);
    if (x.name === label.name && x.color === label.color) return x;
    changed = true;
    return { ...x, ...label };
  };
  const relabelBest = (e) => {
    if (!e?.ok) return e;
    const v = relabel(e.value);
    return v === e.value ? e : { ...e, value: v };
  };
  const boats = ds.boats.map(relabel);
  const comparison = ds.comparison && {
    ...ds.comparison,
    bestUpwind: relabelBest(ds.comparison.bestUpwind),
    bestDownwind: relabelBest(ds.comparison.bestDownwind),
  };
  return changed ? { ...ds, boats, comparison } : ds;
}
```

`src/daysummaryflow.js` を新規作成する。

```js
// src/daysummaryflow.js
// 今日の練習サマリの状態遷移(いつ作り直すか・いつ自動表示するか・何を保存するか)。DOM 非依存の純関数。
// app.js は結果を state と DOM に反映するだけにし、振る舞いはここのテストで守る。
// 結果の基本形: { summary, saved, recomputed, error }
//   summary: state.daySummary に入れる値 / saved: それが保存済みの内容と同じか
import { computeDaySummary, daySummarySourceKey, syncDaySummaryLabels } from './daysummary.js';

// 現在の GPS と一致するサマリにする。
// - GPS が無ければ null
// - sourceKey が一致すれば艇名・色だけ現在のトラックに合わせる(数値は GPS 読込時点のまま)
// - 不一致・未計算・force なら再計算。失敗したら null(GPS と食い違う古いサマリを残さない)
export function refreshDaySummary(
  { summary, saved }, tracks, { marks = [], compute = computeDaySummary, force = false } = {},
) {
  const list = tracks || [];
  if (!list.length) return { summary: null, saved: false, recomputed: false, error: null };
  if (!force && summary && summary.sourceKey === daySummarySourceKey(list)) {
    const synced = syncDaySummaryLabels(summary, list);
    return { summary: synced, saved: saved && synced === summary, recomputed: false, error: null };
  }
  try {
    return { summary: compute(list, { marks }), saved: false, recomputed: true, error: null };
  } catch (error) {
    return { summary: null, saved: false, recomputed: false, error };
  }
}

// GPS 読込(loadFiles)の後。GPS が増えて作り直せたときだけ自動表示する(初回・後付けGPS)。
export function daySummaryAfterGpsLoad(current, tracks, tracksBefore, opts) {
  if ((tracks || []).length <= tracksBefore) {
    return { ...current, recomputed: false, error: null, autoOpen: false };
  }
  const r = refreshDaySummary(current, tracks, opts);
  return { ...r, autoOpen: r.recomputed };
}

// 保存済み練習を開いた(loadPractice)後。自動表示はしない。
// サマリが無い(機能追加前の練習)・GPS と食い違うときは黙って作り直す(次の保存で永続化)。
export function daySummaryAfterPracticeLoad(savedSummary, tracks, opts) {
  const r = refreshDaySummary({ summary: savedSummary, saved: savedSummary != null }, tracks, opts);
  return { ...r, autoOpen: false };
}

// モーダルの導線ボタン。ホームから開いた(練習未読込)ときは先に読み込み、
// 確認ダイアログのキャンセルや読込失敗なら画面遷移しない。戻り値は導線を実行したか。
export async function runDaySummaryAction(action, { fromHomeName = null } = {}, deps) {
  if (fromHomeName && !(await deps.loadPractice(fromHomeName))) return false;
  deps.showTrack();
  if (action === 'compare') deps.setVmgOn(true);
  else if (action === 'reflect') await deps.openReflectionEditor();
  return true;
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `node --test test/daysummary.test.js test/daysummaryflow.test.js`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/daysummary.js src/daysummaryflow.js test/daysummary.test.js test/daysummaryflow.test.js
git commit -m "feat(daysummary): 自動表示・stale判定・保存直前の照合・導線を純関数に切り出す"
```

---

### Task 8: 画面への配線（モーダル・自動表示・ボタン・3つの導線）

**Files:**
- Modify: `index.html`（`#kb-modal` の直後にモーダル、`#topbar` にボタン）
- Modify: `styles.css`（末尾に追記）
- Modify: `src/app.js`
- Test: 既存の `test/html-ids.test.js`（id 重複）と全体テスト、ブラウザでの手動確認（振る舞いの自動テストは Task 7）

**Interfaces:**
- Consumes: Task 5 の `isDaySummaryShape`・`deserializeProject(...).daySummary`・`/api/summaries` 行の `daySummary`、Task 6 `renderDaySummaryHtml`、Task 7 の `refreshDaySummary` / `daySummaryAfterGpsLoad` / `daySummaryAfterPracticeLoad` / `runDaySummaryAction`。既存の `loadPractice(name)`・`showTrack()`・`openReflectionEditor()`・`recomputeVmgWinners()`・`draw()`・`renderSidebar()`・`statusEl`。
- Produces: `state.daySummary: DaySummary|null`、`state.daySummarySaved: boolean`。DOM id `ds-modal` / `ds-modal-inner` / `ds-open`。

このタスクは DOM 配線のみ。「いつ作り直すか・自動表示するか・何を保存するか・導線のキャンセル」は Task 7 の関数に任せ、ここでは結果を `state` と DOM に反映するだけにする（`app.js` 側で条件分岐を書き足さない）。stale の判定は `sourceKey` の比較で行うので、トラックの削除・名前変更・色変更のハンドラには手を入れない。自動テストは id 重複ガードと全体の回帰、見た目と DOM のつながりは Step 7 の手動手順で確かめる。

- [ ] **Step 1: `index.html` にモーダルとボタンを追加**

`<div id="kb-modal" …>…</div>` の閉じタグの直後に追加する。

```html
  <div id="ds-modal" class="ds-modal" hidden>
    <div id="ds-modal-inner" class="ds-modal-inner" role="dialog" aria-modal="true" aria-label="今日の練習サマリ"></div>
  </div>
```

`#topbar` 内、`<button id="project-save" …>💾 保存</button>` の直後に追加する。

```html
    <button id="ds-open" class="btn" title="今日の練習サマリを開く" disabled>📊 サマリ</button>
```

- [ ] **Step 2: `styles.css` の末尾にスタイルを追加**

```css
/* 今日の練習サマリ(モーダル)。構造と見た目は #kb-modal に揃える */
.ds-modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 60; display: flex; align-items: center; justify-content: center; }
.ds-modal[hidden] { display: none; }
.ds-modal-inner { background: #fff; border-radius: 8px; width: min(680px, 92vw); max-height: 82vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.25); }
.ds-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #eee; }
.ds-head strong { flex: 1; }
.ds-body { flex: 1; overflow: auto; padding: 12px 14px; font-size: 13px; line-height: 1.6; }
.ds-body h3 { font-size: 13px; margin: 14px 0 6px; }
.ds-when { font-weight: 600; }
.ds-note { font-size: 12px; color: #666; }
.ds-reason { color: #b3261e; }
.ds-q-good { color: #188038; }
.ds-q-caution { color: #b06000; }
.ds-q-poor { color: #b3261e; }
.ds-table-wrap { overflow-x: auto; }
.ds-table { border-collapse: collapse; width: 100%; white-space: nowrap; }
.ds-table th, .ds-table td { padding: 4px 8px; border-bottom: 1px solid #eee; text-align: right; }
.ds-table th:first-child, .ds-table td:first-child { text-align: left; }
.ds-table td[colspan] { text-align: center; }
.ds-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.ds-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 14px; border-top: 1px solid #eee; }
.ds-btn { font: inherit; font-size: 13px; padding: 6px 12px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; cursor: pointer; }
.ds-btn:hover { background: #f3f6fa; }
.ds-hint { flex-basis: 100%; font-size: 12px; color: #666; }
/* ホームカード右下の「📊 サマリ」。カード本体のクリックとは別ボタン */
.home-card-ds { position: absolute; bottom: 8px; right: 8px; z-index: 1; border: 1px solid var(--gd-border);
  background: var(--gd-surface); border-radius: 6px; font: inherit; font-size: 12px; padding: 2px 8px; cursor: pointer; }
.home-card-ds:hover { background: var(--gd-hover); }
```

- [ ] **Step 3: `src/app.js` に state と import を追加**

import 群（`import { summarizeNeonShare } from './vmg.js';` の直後）に追加する。

```js
import {
  refreshDaySummary, daySummaryAfterGpsLoad, daySummaryAfterPracticeLoad, runDaySummaryAction,
} from './daysummaryflow.js';
import { renderDaySummaryHtml } from './daysummaryview.js';
import { isDaySummaryShape } from './daysummaryschema.js';
```

`const state = { … }` の `basemap: null,` 行の直後に追加する。

```js
  daySummary: null,        // 今日の練習サマリ(GPS読込時点のスナップショット)。保存対象。
  daySummarySaved: false,  // daySummary が保存済みの内容と同じか(未保存ならモーダルに保存案内を出す)。
```

- [ ] **Step 4: `src/app.js` にサマリの計算・モーダル・導線を追加**

VMG トグルのハンドラ（`$('vmg-minute-toggle').addEventListener('change', …)`）を、導線から呼べる関数に置き換える。

```js
// VMG勝者ネオン トグル: ONで1分ごと最良VMG艇を発光表示。OFFで消灯。表示のみ・保存しない。
// サマリの「艇ごとに比較する」からも ON にする。
function setVmgOn(on) {
  vmgOn = on;
  $('vmg-minute-toggle').checked = on;
  recomputeVmgWinners();
  draw();
}
$('vmg-minute-toggle').addEventListener('change', (e) => setVmgOn(e.target.checked));
```

`// ================= ホーム画面(カード型ランチャー) =================` の直前に追加する。

```js
// ================= 今日の練習サマリ =================
// 状態遷移(作り直す・自動表示する・保存する)は daysummaryflow.js でテスト済み。
// ここはその結果を state と DOM に反映するだけにする。

// 開いているサマリの文脈。fromHomeName があればホームカードから開いた(練習は未読込)。
let dsContext = null;

function openDaySummary(summary, { fromHomeName = null } = {}) {
  dsContext = { fromHomeName };
  $('ds-modal-inner').innerHTML = renderDaySummaryHtml(summary, {
    canRecompute: !fromHomeName && state.tracks.length > 0,
    unsaved: !fromHomeName && !state.daySummarySaved,
  });
  $('ds-modal').hidden = false;
}

function closeDaySummary() {
  $('ds-modal').hidden = true;
  dsContext = null;
}

const currentDaySummary = () => ({ summary: state.daySummary, saved: state.daySummarySaved });
const daySummaryOpts = (extra = {}) => ({ marks: state.marks, ...extra });

// daysummaryflow の結果を state に反映する。計算失敗は null になっており(古いサマリは残さない)、
// ステータスバーに出す(GPS読込・保存自体は成功扱い)。
function applyDaySummary(r) {
  state.daySummary = r.summary;
  state.daySummarySaved = r.saved;
  if (r.error) {
    console.error(r.error);
    statusEl.textContent = 'サマリの計算に失敗しました';
  }
  return r;
}

// トップバー: 開く直前に GPS と照合する(削除・差し替え後なら作り直し、艇名・色は同期)。
$('ds-open').addEventListener('click', () => {
  const r = applyDaySummary(refreshDaySummary(currentDaySummary(), state.tracks, daySummaryOpts()));
  if (r.summary) openDaySummary(r.summary);
});

$('ds-modal').addEventListener('click', async (e) => {
  if (e.target === $('ds-modal')) { closeDaySummary(); return; } // 背景クリック
  const btn = e.target.closest('[data-ds-action]');
  if (!btn) return;
  const action = btn.dataset.dsAction;
  if (action === 'close') { closeDaySummary(); return; }
  if (action === 'recompute') {
    // 現在のマーク・風軸補正で作り直す。失敗したら null にしてモーダルを閉じる。
    const r = applyDaySummary(refreshDaySummary(currentDaySummary(), state.tracks, daySummaryOpts({ force: true })));
    if (r.summary) openDaySummary(r.summary); else closeDaySummary();
    return;
  }
  // 導線: ホームから開いた場合は先に練習を読み込む(確認ダイアログでキャンセルなら何もしない)
  const fromHomeName = dsContext?.fromHomeName ?? null;
  closeDaySummary();
  await runDaySummaryAction(action, { fromHomeName },
    { loadPractice, showTrack, setVmgOn, openReflectionEditor });
});
```

- [ ] **Step 5: 既存フローへ配線する**

(a) `loadFiles` に2か所追加する。関数の1行目（`for (const file of fileList) {` の直前）に:

```js
  const tracksBefore = state.tracks.length;
```

関数の最後（`if (state.tracks.length) ensureBasemap();` の直後、閉じ括弧の前）に:

```js
  // GPS が増えたら(初回・後付け)今日の練習サマリを作り直して自動表示する。
  const ds = applyDaySummary(
    daySummaryAfterGpsLoad(currentDaySummary(), state.tracks, tracksBefore, daySummaryOpts()));
  if (ds.autoOpen) openDaySummary(ds.summary);
```

(b) `loadPractice` で、`state.practiceDate = data.practiceDate ?? null;` の直後に追加する（`state.tracks` / `state.marks` の代入より後）。

```js
  // 保存済み練習を開いても自動表示しない。サマリが無い(機能追加前)・GPSと食い違うときは
  // 黙って作り直す(次の保存で永続化)。
  applyDaySummary(daySummaryAfterPracticeLoad(data.daySummary, state.tracks, daySummaryOpts()));
```

(c) `resetState` の `state.practiceDate = null;` の直後に追加する。

```js
  state.daySummary = null;
  state.daySummarySaved = false;
```

(d) `saveProject` を3か所変える。関数の1行目（`const obj = serializeProject(…)` の直前）に:

```js
  // 保存の直前に GPS と照合する。削除・差し替え後なら作り直し、艇名・色は同期する。
  // 作り直しに失敗したら null になり、GPS と食い違う古いサマリは保存しない。
  const ds = applyDaySummary(refreshDaySummary(currentDaySummary(), state.tracks, daySummaryOpts()));
```

`invalidateProjectEntriesCache();` の直前に:

```js
  state.daySummarySaved = !!state.daySummary;
```

最後の ``statusEl.textContent = `保存しました: ${name}`;`` を次に置き換える（計算失敗の表示が上書きで消えないように）。

```js
  statusEl.textContent = ds.error
    ? `保存しました: ${name}（サマリは計算に失敗したため保存していません）`
    : `保存しました: ${name}`;
```

(e) `renderSidebar` の先頭（`const tl = $('track-list'); tl.innerHTML = '';` の直前）に追加する。

```js
  $('ds-open').disabled = !state.tracks.length; // GPS が無ければサマリは開けない
```

(f) Esc で閉じる: 既存の `window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); hideColorMenu(); cancelPending(); closeVideoPanel(); } });` の中に `closeDaySummary();` を追加する。

```js
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); hideColorMenu(); cancelPending(); closeVideoPanel(); closeDaySummary(); } });
```

(g) ホームカードのボタン: `renderHome` のループで `wrap.appendChild(del);` の直後に追加する。

```js
    // 保存済みサマリがある練習だけ「📊 サマリ」を出す。本体を読まずにモーダルを開く。
    // 一覧APIで検証済みだが、表示側は形を前提にするのでここでも確かめる。
    if (isDaySummaryShape(it.daySummary)) {
      const dsBtn = document.createElement('button');
      dsBtn.className = 'home-card-ds';
      dsBtn.textContent = '📊 サマリ';
      dsBtn.title = '今日の練習サマリを開く';
      dsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDaySummary(it.daySummary, { fromHomeName: it.name });
      });
      wrap.appendChild(dsBtn);
    }
```

- [ ] **Step 6: 全体テストと id 重複を確認**

Run: `npm test`
Expected: PASS（`html-ids.test.js` を含む全テスト。件数は 584 + 本計画で追加した分）

- [ ] **Step 7: ブラウザで手動確認**

実データ（`data/projects/`）を汚さないよう、一時ディレクトリをデータ置き場にして起動する。3艇が同じ時間帯を走ったデモ練習（機能追加前の保存形式）もそこへコピーしておく。閲覧ログインの資格情報も確認用の `dev` / `dev` に差し替える（既定は部内共有アカウント）。

```bash
export SV_TMP=$(mktemp -d) && mkdir -p "$SV_TMP/projects" \
  && cp demo-data/sailviz-20260823-1321.sailviz.json "$SV_TMP/projects/" \
  && DATA_DIR="$SV_TMP" SAILVIZ_VIEW_USER=dev SAILVIZ_VIEW_PASSWORD=dev npm start
```

表示された URL（既定 `http://localhost:8000`）を Chrome で開き、ユーザー名 `dev`・パスワード `dev` で閲覧ログインする。編集モードは廃止済みで、閲覧ログインが保存などの書き込み権限も兼ねる（サーバーは書き込みを `isViewer` で許可する）ので、`SAILVIZ_WRITE_TOKEN` は不要。起動ログの `write=OFF` は書き込みトークン未設定の意味で、閲覧ログイン後の保存は通る。`sample-data/Location0807.csv`・`0808`・`0809` は別々の日の GPS なので、同時に読むと「比較可能な区間がありません」になるのが正しい。次の手順を順に確かめる。

- 8-a（1艇・自動表示）: ホームで「＋ 新規練習」→ `sample-data/Location0807.csv` を1本だけ読み込む。読込完了から3秒以内にサマリが開き、艇間比較セクションと「艇ごとに比較する」が無く、「推定風軸」「タック（推定）」表記と「保存するとホームからいつでも開けます」が出る。Esc・×・背景クリックでそれぞれ閉じる。
- 8-b（後付けGPS・導線）: 8-a の練習に `Location0808.csv` を追加でドロップ。サマリが再計算されて自動表示され、2艇分の行と艇間比較（別日なので理由の文言）、「艇ごとに比較する」が出る。「艇ごとに比較する」で軌跡画面に戻り 🏆VMG が ON になる。トップバー「📊 サマリ」で再度開き、「今日の反省を書く」で反省エディタが開く。
- 8-c（保存・2回目以降・ホーム）: 💾 保存 → ホームへ戻る。カード右下に「📊 サマリ」が出て、押すと本体を読まずに同じ内容が開く（再計算ボタンと保存案内は出ない）。「軌跡を見る」で練習が開き、サマリは自動表示されない。
- 8-d（ホームからの導線をキャンセル）: 8-c の練習を開いた状態でホームへ戻り、同じカードの「📊 サマリ」→「今日の反省を書く」を押す。読込確認ダイアログでキャンセルするとホームに留まり、軌跡画面へ遷移しない。
- 8-e（既存練習・艇間比較の数値）: ホームからデモ練習（2026-08-23 13:21）を開く。サマリは自動表示されず、カードにも「📊 サマリ」はまだ出ない。トップバー「📊 サマリ」で開くと3艇分の行と、比較可能時間・VMG最高艇の数値が出る。
- 8-f（スマホ幅）: DevTools のデバイスモード（幅 375px）で 8-e のサマリを開き、ページ全体が横スクロールせず、艇ごとの表だけが横スクロールする。
- 8-g（削除してそのまま保存）: 8-e の練習でトラックを1本 × で削除し、サマリを開かずに 💾 保存 → ホームへ戻る。カードの「📊 サマリ」で開くと、削除後の2艇分の行だけが出る（削除前の3艇のサマリが残っていない）。
- 8-h（艇名・色の変更）: 8-g の練習を開き、トラック名をダブルクリックで「A艇」に変え、色も変える。トップバー「📊 サマリ」で開くと、行の艇名・色丸（とVMG最高艇が該当すればその表記）が「A艇」・新しい色になり、数値は変わらず、保存案内が出る。💾 保存してホームのカードから開いても「A艇」になっている。

確認が終わったらサーバーを止め、`rm -rf "$SV_TMP"` で一時ディレクトリを消す。

問題があれば該当箇所を直してから次へ進む。

- [ ] **Step 8: コミット**

```bash
git add index.html styles.css src/app.js
git commit -m "feat(daysummary): GPS読込後のサマリ自動表示・ホームカードとトップバーの入口・3つの導線を配線"
```

---

### Task 9: 実データでの性能確認と仕様書・ロードマップの更新

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-day-summary-design.md`（ステータス行）
- Modify: `docs/roadmap.md`（項目追加）

**Interfaces:**
- Consumes: Task 4 `computeDaySummary`、Task 5 `deserializeProject`。
- Produces: なし（検証記録のみ）。

- [ ] **Step 1: 実データで所要時間を測る**

Run:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { deserializeProject } from './src/project.js';
import { computeDaySummary } from './src/daysummary.js';
const p = deserializeProject(JSON.parse(readFileSync('demo-data/sailviz-20260823-1321.sailviz.json', 'utf8')));
const t0 = performance.now();
const s = computeDaySummary(p.tracks, { marks: p.marks });
console.log('ms', (performance.now() - t0).toFixed(0), 'boats', s.boats.length,
  'axis', JSON.stringify(s.overall.windAxis), 'tacks', s.boats.map((b) => JSON.stringify(b.tacks)).join(' '));
"
```

Expected: `ms` が 3000 を大きく下回る（計画時点の見積もりは約 30〜100ms）。出力を控えておく。

- [ ] **Step 2: 仕様書のステータスを更新**

`docs/superpowers/specs/2026-09-26-day-summary-design.md` の4行目を次にする（`<ms>` は Step 1 の実測値）。

```markdown
- ステータス: **実装済み** — 全セクションをユーザーが承認済み（2026-09-26）。実データ3艇での計算時間 <ms>ms。
```

- [ ] **Step 3: ロードマップに項目を追加**

`docs/roadmap.md` のバックログ末尾（最後の項目の後）に、既存テンプレートに倣って追加する。番号は既存の最大番号 + 1 にする。

```markdown
### <番号>. 今日の練習サマリ（GPS読込後の自動表示）
- **ステータス**: ✅ 完了（`src/daysummary.js` で練習全体・艇ごと・艇間比較を計算し、`src/daysummaryview.js` でモーダル表示。GPS読込で自動表示、2回目以降はホームカード/トップバーの「📊 サマリ」から開く。推定値は「推定」表記、算出不能は理由を表示）
- **カテゴリ**: 解析 / 可視化
- **概要**: GPSを読み込んだ直後に、練習時間・GPS品質・推定風軸・艇ごとの距離/速度/タック数・VMG最高艇をまとめて表示する。
- **動機**: 初回利用でも複雑な操作なしに振り返りを始められるようにする。
- **メモ**: 設計 `docs/superpowers/specs/2026-09-26-day-summary-design.md`、計画 `docs/superpowers/plans/2026-09-26-day-summary.md`。サマリはGPS読込時点のスナップショットで、マーク/風軸補正の変更はモーダルの「再計算」で反映。GPSの追加・削除・差し替えは `sourceKey`（点列ハッシュ込み）で検出し、表示・保存の直前に作り直す（失敗時は古いサマリを保存しない）。艇名・色の変更は数値を変えずに追従。
```

- [ ] **Step 4: 全体テストを再実行**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add docs/superpowers/specs/2026-09-26-day-summary-design.md docs/roadmap.md
git commit -m "docs: 今日の練習サマリの実装完了をロードマップと仕様書に反映"
```
