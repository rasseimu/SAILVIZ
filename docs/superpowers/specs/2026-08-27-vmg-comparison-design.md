# 複数艇VMG比較・ハイライト 設計書

- 日付: 2026-08-27
- ステータス: 承認済み（実装計画待ち）
- 種別: 新規分析サブシステム（`src/vmg.js`）＋地図/ダッシュボード連携
- 関連: `src/windaxis.js`, `src/gps.js`, `src/interpolate.js`, `src/renderer.js`, `src/chartview.js`, `src/dashboard.js`
- 依存: `src/windaxis.js` の風軸推定パイプライン（`estimateWindAxisSeries`, Task 10）。本設計はそれを**疎結合に**利用する（下記）。

## 1. 目的とスコープ

同時に読み込んだ**複数艇（`state.tracks[]`）のGPS軌跡**を時系列で比較し、
各タイミングで **VMG（Velocity Made Good＝風軸方向への前進成分）が最も良い走りをハイライト**する。

ユーザーの言葉での定義:
- **ランニング（風下）**: 最も風下に進めている艇 ＝ **風下VMG最大**の艇。
- **クローズ（風上）**: 最も風上に高さが取れている艇 ＝ **風上VMG最大**の艇。
- クローズ／ランニング中は艇が上し下し（ピンチ／フット）で振れるため、**ある程度の範囲（レグ）で平均**してVMGを推定する。

### 前提となる物理・幾何
- 風軸 `windFromDeg`（風が吹いてくる方位、0=北、360法）を基準に、艇の速度ベクトルの風軸方向成分がVMG。
- 風上VMG = 速度 × cos(進行方位と風向の差)。風下VMG = その符号反転。
- クローズは前後レグで上し下しするため、レグ全体（セトリング除外区間）で平均すると真のVMGに近づく。

### スコープ内
- 複数艇の各レグごとの平均VMG算出（風上／風下を区別）
- 同一走種（風上同士・風下同士）・時間重複区間での勝ち艇判定と、地図トラック上のハイライト
- ダッシュボードのVMGランキング表＋VMG推移グラフ（風上／風下トグル）
- 全艇GPSから統合した単一風軸の生成（`unifyWindAxis`）

### スコープ外（YAGNI）
- リーチ（クローズでもランでもない）レグのVMG比較。デッドバンドで除外する。
- 「次マークへのVMG」等、風軸以外を基準にしたVMG。
- 風速の推定（風向＝風軸のみ）。
- 潮流・リーウェイ補正。
- タック/ジャイブや走種の手動ラベルUI。
- elapsed（相対時間）モードでの艇間比較（絶対時刻でのみ意味を持つ。無効化して通知）。

### 設計方針: 疎結合
VMGサブシステムは抽象的な**風軸時系列 `windFromDeg(t)` を入力として受け取る**。
風軸の生成方法（全艇統合／単一艇／アメダス）に依存しない。これにより:
- `src/windaxis.js` のパイプライン未完（現在 Task 3 まで）でも、モック風軸で本機能を**今すぐ実装・単体テスト可能**。
- 走種（点走種別）は windaxis の `leg.kind`（Task 7 で付与）に依存せず、**幾何から自前で判定**する。
- 唯一 windaxis の完成に依存するのは `unifyWindAxis`（最後のワイヤリング）のみ。

## 2. データモデルと入出力

### 入力
- `tracks[]`: 各艇 `{ id, name, color, points: Point[], ... }`（`src/project.js` の構造）。
  `Point = { t: ms(絶対epoch), lat, lon, speed: m/s|null, bearing, accuracy }`。
- `windSeries`: `WindEstimate[]`（時刻昇順）。抽象入力。実体は `unifyWindAxis` の出力／モック。
  `WindEstimate = { tMs, windFromDeg, source, type, confidence }`（windaxis 由来）。
- 任意: `marks[]`（`unifyWindAxis` が windaxis へ渡す飛び値除去用）。

### 中間表現
```
LegVmg = {
  boatId, startT, endT,
  pointOfSail: 'upwind' | 'downwind',   // reach は生成しない（除外）
  meanVmg,        // m/s（風上VMG or 風下VMG。走種に対応する符号付き値）
  meanSpeed,      // m/s
  meanTwa,        // deg（|Δ_leg| 相当。参考）
  lenM, durSec, nSamples,
  confidence,     // 0..1（レグ長・サンプル数・風軸信頼度から）
}

Highlight = { boatId, color, lo, hi, pointOfSail, vmg }  // 地図ハイライト帯（時刻窓）

RankRow = {
  boatId, pointOfSail,
  meanVmg,        // 期間内の集約平均VMG
  winRatio,       // 勝ち時間 / 走種該当時間
  legCount, bestLegVmg,
}
```

### 出力（`src/vmg.js` 公開関数）
- `windFromAt(windSeries, t) → deg|null` — 円周補間した時刻 t の風向。
- `boatLegVmg(track, windSeries, opts) → LegVmg[]` — 1艇の beat/run レグごとの平均VMG。
- `winnerTimeline(perBoatLegVmg, opts) → Highlight[]` — 勝ち艇のハイライト帯。
- `rankVmg(perBoatLegVmg, { from, to }) → RankRow[]` — ダッシュボード表用集約。
- `unifyWindAxis(tracks, { marks, opts }) → WindEstimate[]` — 全艇統合風軸（windaxis 依存）。

いずれも純粋関数（`unifyWindAxis` は windaxis の純関数のみ呼ぶ）。DOM/副作用なし。

## 3. アルゴリズム

### ① 風軸の時刻補間 — `windFromAt(windSeries, t)`
- `windSeries` を時刻で挟む2点を円周補間（350°→10° の巻き戻りを扱う）。
- 範囲外は端点の値（または null）。実装は `circDiffDeg` を用いた線形補間: `a + circDiffDeg(b,a)·f` を `normalizeDeg`。

### ② 1サンプルVMG
時刻 t の艇サンプル `{ cog, speed: v }` と風向 `w = windFromAt(windSeries, t)` に対し:
- `Δ = circDiffDeg(cog, w)` … 進行方位と風向(from)の符号付き差 (−180,180]。
- `upwindVMG = v · cos(Δ·π/180)` … 風上前進成分。
- `downwindVMG = −v · cos(Δ·π/180)` … 風下前進成分。

### ③ レグ分割と走種判定 — `boatLegVmg(track, windSeries, opts)`
1. `computeCog(track.points)` → `segmentLegs(...)`（既存 windaxis）で `legs` を得る。
2. 各レグの代表方位 `leg.headingDeg` と、レグ中点時刻の風向から `|Δ_leg| = |circDiffDeg(headingDeg, w_mid)|`。
   - `|Δ_leg| < 90 − deadband` → `upwind`
   - `|Δ_leg| > 90 + deadband` → `downwind`
   - それ以外（リーチ）→ **除外**（`LegVmg` を生成しない）。既定 `deadband = 12`。
3. **レグ平均VMG（上し下しの平滑化）**: レグの**セトリング除外・末尾トリム後の落ち着き区間**
   （windaxis の `settleSec/settleM` と末尾10%除外に準拠）のサンプルについて、走種に対応するVMG
   （upwind→`upwindVMG`, downwind→`downwindVMG`）を平均。ピンチ（高い/遅い）とフット（低い/速い）が
   平均化され真のVMGに近づく。
4. `meanSpeed, meanTwa, lenM, durSec, nSamples` を算出。`minLegSec/minLegM` 未満のレグは
   勝ち判定から除外（`confidence` を下げ、描画は任意で薄く）。
5. `confidence` ＝ レグ長・持続・サンプル数・区間内 `WindEstimate.confidence` 平均の合成（0..1）。

### ④ 勝ち艇タイムライン — `winnerTimeline(perBoatLegVmg, opts)`
1. 各艇のVMG(t)は在レグの `meanVmg` で**区分定数**（beat/run レグ外は未定義）、走種タグ付き。
2. 全艇のレグ境界の**和集合**で時間を区間分割。各区間で艇を**走種でグループ化**。
   - 風上艇は風上艇とのみ、風下艇は風下艇とのみ比較（異走種のVMG比較は無意味）。
3. 各走種グループで参加艇が **`minBoats`（既定 2）以上**なら、`argmax meanVmg` を勝ち艇とし
   `Highlight{ boatId, color, lo, hi, pointOfSail, vmg }` を生成。
4. 隣接区間で同一勝ち艇・同一走種の帯は結合（描画を滑らかに）。
- **決定事項**: 参加艇が1艇のみの走種は勝者を宣言しない（比較対象が無い）。

### ⑤ ランキング集約 — `rankVmg(perBoatLegVmg, { from, to })`
- 期間 `[from,to]` に交差する `LegVmg` を、艇×走種で集約。
- `meanVmg`（時間重み平均）、`winRatio`（勝ち時間/該当時間、`winnerTimeline` から）、`legCount`、`bestLegVmg`。
- 走種内でVMG降順ソート。首位艇を強調。

### ⑥ 統合風軸 — `unifyWindAxis(tracks, { marks, opts })`
1. 各艇に `estimateWindAxisSeries(track, { marks })`（windaxis Task 10）を適用 → 艇ごと `WindEstimate[]`。
2. 共通時間グリッドで、近傍推定を持つ艇の `windFromDeg` を **`circMedianDeg`（信頼度重み）** で統合。
   - 円周中央値のため、不調な1艇の外れ推定は自然に棄却される。
3. 既存の移動中央値で平滑化し、単一 `WindEstimate[]` を返す。
- windaxis 未完の間は**モック／単一艇 `WindEstimate[]`** を代用（本機能は疎結合で成立）。

## 4. 連携（地図・ダッシュボード・アプリ）

### 地図 — `src/renderer.js`
- 任意の `state.vmgHighlights = [{ boatId, color, lo, hi }]` を読む。
- 現在地マーカー描画の前に、各勝ち艇トラックの `p.t ∈ [lo,hi]` 区間を**太い低透明グロー**（艇色）で
  既存2px線の下に重ね描き（`strokePolyline` の `include` 述語を再利用）。新規ジオメトリ・マーカーは足さない。

### ダッシュボードパネル — `src/vmgview.js`（新規）
- `dashboard.js` の構成（ミニグラフ＋表＋期間バー）を範に:
  - **ランキング表**: `rankVmg` 行。走種ごとに首位艇を強調。
  - **VMG推移グラフ**: `chartview.js` を再利用。`series[boat] = レグ中点時刻の meanVmg`。
  - **風上／風下トグル**: 表示する走種を切替（VMGの符号が異なり軸を共有しないため）。

### アプリ配線 — `src/app.js`
- 「VMG強調」トグル（既定オフ）。オン時: 可視トラック×`windSeries` から
  `boatLegVmg → winnerTimeline` を再計算し `state.vmgHighlights` を更新、パネルを再描画。
- クロップ（表示範囲）変更時に再計算。

## 5. エッジケース
- **時間重複が前提**: 比較は絶対epoch上。時間重複しない艇同士は比較しない（偽の勝者を出さない）。
- **elapsed モード**: 艇間VMG比較は絶対時刻でのみ有効。elapsed 時はハイライトを無効化し1行通知。
- **単一艇 / 風軸なし**: 単一艇は自艇VMGグラフのみ表示し勝者を宣言しない。
  windaxis 未完時はパネルに「風軸未推定」を表示。
- **リーチ／短レグ**: 勝ち判定から除外。任意で薄く描画。

## 6. テスト方針（`test/vmg.test.js`, `node:test`）
純粋関数を合成データで検証（TDD）:
1. `windFromAt`: 350°→10° を跨ぐ円周補間が中間で 0°(360) 近傍を返す。
2. 走種判定: heading 45°/風0 → upwind、170° → downwind、90° → reach（除外）。
3. VMG現実性: ピンチ艇(35°, 2.5m/s) vs フット艇(50°, 3.2m/s)・風0 → 風上VMG(2.05 vs 2.06)で
   フット艇が勝つ。上し下しのトレードオフを指標が捉えることを確認。
4. `winnerTimeline`: 時間重複する風上2艇でVMG明確差 → 帯が勝ち艇に帰属。
   同区間の風下艇はこの比較に参加しない。
5. 風下符号: ランニング艇 175°/風0 → `downwindVMG ≈ v`。

## 7. 実装順序（疎結合を活かす）
1. `src/vmg.js`: `windFromAt` → `boatLegVmg` → `winnerTimeline` → `rankVmg`（モック風軸でTDD）。
2. `renderer.js` のハイライト重ね描き＋`app.js` トグル配線。
3. `src/vmgview.js` ダッシュボードパネル（`chartview.js` 再利用）。
4. `unifyWindAxis`（windaxis の `estimateWindAxisSeries` 完成後に実配線。それまでモック）。
