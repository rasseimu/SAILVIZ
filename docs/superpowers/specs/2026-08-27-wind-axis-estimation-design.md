# GPS軌跡からの風軸推定 設計書

- 日付: 2026-08-27
- ステータス: 承認済み（実装計画待ち）
- 種別: 新規分析サブシステム（`src/windaxis.js`）＋ダッシュボード連携
- 関連: `src/gps.js`, `src/interpolate.js`, `src/projection.js`, `src/wind.js`, `src/chartview.js`

## 1. 目的とスコープ

GPS軌跡から、練習中の**各タイミングの風軸（風向の軸）を時系列で推定**する。
帆走中は比較的直線に動き、方向転換（タック／ジャイブ）の前後の帆走角の中央（二等分）が
風軸に対応する、という幾何を利用する。風は次第に回っていくものとして、マーク回航などの
飛び値を除去したうえで滑らかな時系列を得る。参考としてアメダス辻堂の風向を重畳する。

### 前提となる物理・幾何
- 帆走中の各レグはほぼ直線。前後レグ方位の**内側二等分線**が風軸（線＝双方向）に一致する。
- **タック**（風上を切る）では二等分線が**風上**方向を、**ジャイブ**（風下を回す）では**風下**方向を指す。
  よって進行方向と風軸の関係がタック／ジャイブで逆になる。
- タック角（前後レグの角度）が90°に近いほどクローズ。
- タックから**クローズ角**、ジャイブから**ランニング角**を学習でき、マニューバ間のレグ中の推定に使える。

### スコープ内
- 位置から算出したCOG（進行方位）に基づくレグ分割とマニューバ検出
- タック／ジャイブ判別（減速量＋旋回角）
- マニューバ二等分線からの風軸アンカー推定（タック/ジャイブで±180°）
- クローズ角／ランニング角の学習と、ビート／ランのレグ内連続推定
- マーク近傍＋幾何＋ロバスト統計による飛び値除去
- 円周量の移動中央値による平滑化と信頼度付与
- ダッシュボードへの風軸時系列グラフ追加、アメダス辻堂の参考ライン重畳

### スコープ外（YAGNI）
- 風速の推定（風向＝風軸のみ扱う。速度はアメダス値を参考表示するに留める）
- リーチ（クローズでもランでもない）レグでのレグ内連続推定（アンカーのみ）
- 潮流・リーウェイの補正
- 複数トラック（チーム横断）の同時風軸比較。まず読込中の1トラックを対象とする
- タック/ジャイブの手動ラベル付けUI

## 2. データモデルと入出力

### 入力
- 対象トラックの `points[]`（`src/gps.js` の Point 構造）。クロップ範囲内を対象とする。
  ```
  Point = { t: ms, lat, lon, speed: m/s|null, bearing: deg|null(-1無効), accuracy: m|null }
  ```
- `marks[]`（回航マーク座標 `{id, lat, lon, ...}`）。飛び値除去に使用。
- 任意: アメダス辻堂の風向（`src/wind.js` の `fetchWind` 由来）。参考重畳のみ。

`bearing` はCSV由来で `-1` 無効値やジッタが多いため、**位置から自前でCOGを再計算**して主指標とする。

### 中間表現
```
Sample     = { t, lat, lon, cog: deg, speed: m/s }         // COG付き移動サンプル
Leg        = { startT, endT, headingDeg, meanSpeed, lenM, kind:'beat'|'run'|'reach'|'unknown' }
Maneuver   = { tMs, lat, lon, type:'tack'|'gybe', turnDeg, speedDropRatio, confidence,
               headingBefore, headingAfter, side:'starboard'|'port' }
WindEstimate = { tMs, windFromDeg, source:'anchor'|'leg', type:'tack'|'gybe'|null, confidence:0..1 }
```

### 出力
- `estimateWindAxisSeries(track, {marks, opts})` → `WindEstimate[]`（時刻昇順、平滑化済み）
- `windFromDeg` は「風が吹いてくる方位」（0=北, 90=東, 360法）。

## 3. アルゴリズム

### ① 前処理 / COG算出 — `computeCog(points, {windowMs})`
1. 精度フィルタ・外れ値除去は既存（`accuracyFilter`, `rejectOutliers`）を通した点を前提とする。
2. 各点で中心差分の haversine 方位を小窓（既定 `windowMs≈3000`）で平滑化し `cog` とする。
3. `speed`（`speedAt` 利用、CSV欠損時は haversine/Δt）が閾値未満（既定 `minSpeedMps≈1.5`）の点は
   方位が無意味なため除外。

### ② レグ分割 — `segmentLegs(samples, opts)`
1. 平滑COGの**旋回レート** `dHeading/dt`（円周差分）を計算。
2. 旋回レートが閾値未満の連続区間＝**レグ**、閾値以上の連続区間＝**マニューバ**。
   （既定 `turnRateThreshDegPerSec`, 最小レグ継続 `minLegSec`, 最小レグ距離 `minLegM`）
3. 各レグの代表方位 `headingDeg` ＝旋回部と**セトリング区間を除いた「落ち着いた区間」のCOG円周中央値**。
   - **セトリング除外**: タック/ジャイブ直後は艇が加速・ベアアウェイ（下って走る）しがちで、
     直後のCOGは本来のクローズ角より下振れする。マニューバ直後 `settleSec`/`settleM`（既定 ~10–20s）を
     代表方位の算出から除外する。前側にもラフィングアップ相当の小さな除外を設ける。
   - **できるだけ広くとる**: 除外後は次のマニューバ/マーク手前まで、落ち着いた区間を**可能な限り広く**とって
     円周中央値を求める（レグ内の一時的な振れは平均化され、アンカーの下振れバイアスを抑える）。
     レグ内の風向トレンドは⑥のレグ内連続推定で別途捉えるため、ここは広い窓で問題ない。
4. 各レグの `meanSpeed`, `lenM` を算出。

### ③ マニューバ判別 — `classifyManeuver(...)`
- 旋回角 `turnDeg` ＝前後レグ方位の円周差の絶対値。
- 減速比 `speedDropRatio` ＝旋回中の最低速 / 前後レグ平均速。
- 判定: **減速比が小さい（＝大きく失速）→タック**、**減速比が大きい（速度維持）→ジャイブ**を主判定、
  旋回角を従（`turnDeg` が想定タック角付近か等）として `confidence` を算出。
- `side`（starboard/port）は旋回の向き（時計回り/反時計回り）から決定。

### ④ 風軸アンカー — `estimateWindFromManeuver(...)`
- `headingBefore` / `headingAfter` は②の**セトリング区間を除いた広い落ち着き区間**の代表方位を使う
  （タック直後のベアアウェイでアンカーが下振れするのを防ぐ）。
- `bisector = bisectorDeg(headingBefore, headingAfter)`（内側＝短い弧側の円周平均）。
- `windFromDeg = (type==='tack') ? bisector : bisector + 180`。
- 検証:
  - タック例: 風向0°、スタボ45°/ポート315° → 内側二等分=0°=風上 ✓
  - ジャイブ例: 風向0°、スタボ135°/ポート225° → 内側二等分=180°=風下 → +180で風上0° ✓
- 出力: `{ tMs: マニューバ中点, windFromDeg, type, confidence, source:'anchor' }`。

### ⑤ 帆走角の学習 — `learnPolarAngles(anchors)`
- 各タックの **クローズ角** `beta_ch = |headingLeg − windFromDeg|`（タック角の半分）。`headingLeg` は
  セトリング区間を除いた代表方位を使う（ベアアウェイ区間を含めると `beta_ch` を過小推定するため）。
- 各ジャイブの **ランニング半角** `beta_run` ＝風下方向(windFrom+180)からレグ方位までの角。
- それぞれ全マニューバの**円周中央値**でロバスト推定（緩やかな時変も許容: 移動中央値）。

### ⑥ レグ内連続推定 — `fillLegEstimates(legs, polar, anchors)`
- レグの点走種別 `kind` を判定: **両側タック=beat**、**両側ジャイブ=run**、それ以外=reach（逆算対象外）。
- beat レグ: `windFromDeg(t) = cog(t) ∓ beta_ch`（∓はレグの `side` で決定）。
  - 例: スタボ・クローズ heading=45°, beta_ch=45° → 0°。heading が48°に振れれば windFrom=3°（ヘッダー）を検出。
- run レグ: `windFromDeg(t) = cog(t) ∓ beta_run + 180`。
  - 例: スタボ・ラン heading=135°, beta_run=45° → 135−45+180=0° ✓
- 出力は `source:'leg'`。**アンカーより低信頼**（「艇は一定帆走角で走る」前提のピンチ/フット誤差を含む）。

### ⑦ 飛び値／マーク回航の除去 — `rejectMarkRoundings(maneuvers, marks, {radiusM})`
1. **マーク近傍除外**: マニューバ中点が `marks[]` のいずれかから半径 `radiusM`（既定 ~30m）内なら除外。
2. **幾何フィルタ**: 前後レグが十分長い/直進（`minLegSec` / `minLegM` / 低方位分散）のマニューバのみ採用。
   点走種別が切替（逆進行の綺麗なタック/ジャイブ対でない＝回り込み・ベアアウェイ）は除外。
3. **ロバスト外れ値除去**: windFrom 推定列に移動窓の**円周中央値＋MAD**を適用し外れ点を棄却
   （マーク未設定でも有効）。

### ⑧ 時系列化と平滑化 — `smoothWindSeries(series, {windowMs})`
- アンカー＋レグ連続フィルを時刻順に統合。円周量として**移動中央値**で平滑化。
- 各推定に `confidence`（レグ長・減速比の明瞭さ・近傍一致度から算出）。アンカー高・レグ低で重み付け。
- 「風は次第に回る」前提に沿い、緩やかなトレンドを残しつつ突発ノイズを抑制。

### 統合エントリ — `estimateWindAxisSeries(track, {marks, opts})`
`computeCog → segmentLegs → classifyManeuver → estimateWindFromManeuver → rejectMarkRoundings
→ learnPolarAngles → fillLegEstimates → smoothWindSeries` の順に合成し `WindEstimate[]` を返す。

## 4. 円周演算ユーティリティ（`src/windaxis.js` 内）
- `circMeanDeg(degs, weights?)` — 円周平均
- `circDiffDeg(a, b)` — 符号付き最小差 (−180,180]
- `circMedianDeg(degs)` — 円周中央値（ロバスト）
- `bisectorDeg(a, b)` — 内側（短弧）二等分方位

いずれも純粋関数。既存 `haversineMeters`（`gps.js`）と方位計算はここに集約する。

## 5. ダッシュボード連携
- `src/chartview.js` を再利用し、風軸(方位)の時系列 Chart.js グラフを追加する。
- **データスコープの相違**: 現ダッシュボード（`dashboard.js` / `tuning.js`）はチーム横断のチューニング値が対象。
  風軸は**読込中GPSトラック（1艇の練習）由来**。→ 風軸グラフは「現在のGPSトラック」を入力にした
  **専用パネル**としてダッシュボードに追加する（承認済み方針）。
- **アメダス辻堂**の風向を同グラフに**参考ライン**として重畳（`wind.js` 既存取得を利用、任意表示）。
- 信頼度に応じた表現（低信頼のレグ推定は薄く／破線など）を検討（詳細は実装計画で）。

## 6. テスト方針（`test/windaxis.test.js`, `node:test`）
合成トラックで検証（TDD）:
1. 既知風向0°のビート（3タック）→ `windFromDeg ≈ 0°` を復元。
2. ジャイブ→ +180° 補正が正しく効く。減速比でタック／ジャイブが判別される。
3. マーク座標付近の回航マニューバが除外される。
4. 途中で風が回る合成データ→平滑化後にトレンドを追従する。
5. ビートのレグ内で heading を振らせる→ リフト/ヘッダーとして `windFromDeg` が動く。
5b. タック直後にベアアウェイ（COGが一旦下がってから本来のクローズに戻る）する合成レグで、
    セトリング区間を除外した代表方位により風軸/クローズ角が下振れしないことを検証。
6. 円周演算（`circDiffDeg` の符号境界、`bisectorDeg` の内側選択、北またぎ 350°/10° 等）の単体テスト。
7. `speed`/`bearing` 欠損・`-1` を含む点列の頑健性。

## 7. 主要パラメータ（既定値・実装時に調整）
| 名前 | 既定 | 意味 |
|------|------|------|
| `windowMs`（COG平滑） | ~3000 | COG中心差分の窓 |
| `minSpeedMps` | ~1.5 | 方位を信頼する最低速 |
| `turnRateThreshDegPerSec` | 調整 | レグ/マニューバ境界 |
| `minLegSec` / `minLegM` | 調整 | 有効レグの最小継続/距離 |
| `settleSec` / `settleM` | ~10–20s | マニューバ直後の代表方位除外（ベアアウェイ対策） |
| `radiusM`（マーク近傍） | ~30 | マーク回航除外半径 |
| `smoothWindowMs` | 調整 | 風軸時系列の平滑窓 |

## 8. リスク・留意点
- レグ内連続推定は「艇が一定の帆走角で走る」前提に依存。ピンチ/フットで誤差が出るため
  アンカーより低信頼として扱い平滑化する。
- タック／ジャイブ判別は減速比が主。微風や短いレグで減速比が不明瞭な場合は `confidence` を下げ、
  必要ならアメダス辻堂の風向で整合チェック（将来拡張）。
- マーク未設定の練習では幾何＋ロバスト統計フィルタのみで飛び値を除去する。
- 相模湾の潮流・リーウェイは未補正。COGとヘディングの差は誤差として残る。
- タック直後のベアアウェイ量は個人差が大きい。固定の `settleSec`/`settleM` を既定とし、将来的には
  速度が定常化する点を検出する適応的セトリング（加速が収まった時点から代表方位を採る）に拡張しうる。
