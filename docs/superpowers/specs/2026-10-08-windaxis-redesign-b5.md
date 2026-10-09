# 風軸推定 再設計仕様 (B5)

- 日付: 2026-10-08
- ステータス: 実装済み（H14 (a) 採用: 閾値版を採用・幾何判別は不採用）
- 種別: windaxis.js の推定ロジック改修（利用者設計 2026-10-06 確定）
- 関連: `src/windaxis.js`

## 背景・目的

「以前より粗い」という課題の解消。利用者が 2026-10-06 に確定した設計 (1)〜(6) を参考に、
風軸推定の閾値を改善する（H14 (a) 採用: 幾何でタック/ジャイブを断定する案は不採用）。

## 設計 (1)〜(6) 要点

1. **タック検知**: 約 90° の方向転換を検知してタックと断定（左右交互の条件は付けない）。
2. **風軸算出**: タック前後の進行方向の二等分線を風軸とし、艇が進む側を風上とする。
3. **ランニング/ジャイブ**: 推定風軸から見て風下に進んでいればランニング/リーチング。
   ジャイブも同じ二等分線で、艇が進む側が風下（風上はその反対）。
4. **タックに挟まれたジャイブは捨てる**: 現行の preferCloseHauledAnchors は正しい・残す。
5. **マーク回航・スタート**: 不規則な挙動なので周囲のタック/ジャイブで出した風軸に角度を合わせる。
   **【未実装・H14 (a)の範囲外】** 現行の `rejectMarkRoundings` はマーク近傍のマニューバを除外するのみ。
   「周囲の風軸に合わせ込む」補間処理は H14 (a) 採用（閾値版を採用）の範囲外として実装しない。
   将来実装する場合は別タスクで設計する。
6. **速度足切りを外す**: computeCog の minSpeedMps=1.5 を外す（opts で 0 または null）。

## 現行ルール総点検

| ルール | 閾値/仕様 | 設計 (1)〜(6) との対応 | 対処 |
|--------|-----------|------------------------|------|
| `computeCog` minSpeedMps=1.5 | 1.5 m/s 未満を除外 | (6) 外す | opts.minSpeedMps=0 をデフォルトに変更 |
| `classifyManeuver` tackMaxSpeedDropRatio=0.6 | 減速比<0.6=tack | (1) 90°回転で断定 | 判別ロジック変更なし（speed ベースのまま）。confidence の旋回角化のみ変更（H14 (a)） |
| `segmentLegs` turnRateThreshDegPerSec=8 | 旋回レート≥8°/s で旋回 | (1) と整合 | 変更なし（有効） |
| `segmentLegs` minLegSec=8, minLegM=20 | レグの最小長 | (1) と整合 | 変更なし |
| `segmentLegs` settleSec=12, settleM=30 | セトリング除外 | (2) の代表方位を正確に出すために必要 | 変更なし（有効） |
| `rejectMinorTurns` minManeuverTurnDeg=45 | 旋回角<45° を除外 | (1) 90° をタックとみなすなら 75° 以上が妥当 | minManeuverTurnDeg デフォルトを 75° に引き上げ |
| `foldAnchorsToHemisphere` 90° 半球折り返し | 誤判別補正 | 誤判別補正として有効 | 変更なし（有効） |
| `rejectAnchorOutliers` refHalfMs=900000, rejDeg=45 | 外れ値除去 | 有効 | 変更なし |
| `preferCloseHauledAnchors` | タック区間内ジャイブを捨てる | (4) と一致 | 変更なし（有効） |
| `smoothWindSeries` smoothWindowMs=120000 | 移動中央値平滑化 | 有効 | 変更なし |
| `smoothWindSeries` madK=3, minMadDeg=25 | 外れ値除去 | 有効 | 変更なし |
| `fillLegEstimates` | レグ内連続推定 | 出力しない（現行実装も出力しない）| 変更なし |
| `rejectMarkRoundings` radiusM=30 | マーク近傍除外 | (5) マーク回航は不規則→除外は正しい | 変更なし（有効） |

## 変更内容

### 変更 A: classifyManeuver のロジック改修

- 現行: 減速比（speedDropRatio < 0.6）でタック/ジャイブを判別
- **実装（H14 (a) 採用）: タック/ジャイブの判別は引き続き speed ベース（speedDropRatio < 0.6）を使う。**
  幾何でタック/ジャイブを断定する案（旋回角のみで分類）は H14 で (a)「現行の閾値版を採用」となり不採用。
  `opts.useGeometricTackClassification` や `opts.tackTurnDegMin` による幾何切り替えは実装しない。
- **変更点**: `rejectMinorTurns` の足切りを 45° → 75° に引き上げ（設計 (1) の「約90°の方向転換」に合わせたノイズ除外）。
- **confidence の改修**: 旋回角が 90° に近いほど confidence が高くなるよう旋回角化（angleFactor と speedFactor の平均）。
  タック/ジャイブの判別自体（type）は speed ベースのまま。

実装内容（実際のコード）:
- `classifyManeuver`: type は `speedDropRatio < 0.6` で決定（変更なし）。
  confidence = (angleFactor + speedFactor) / 2（旋回角 90° 近傍ほど高い）。
- `rejectMinorTurns`: opts.minManeuverTurnDeg デフォルト 45 → 75 に変更（足切りのみ、判別は変えない）。

### 変更 B: minSpeedMps デフォルトを 0 に

- `computeCog` の opts.minSpeedMps のデフォルトを 1.5 → 0 に変更（設計 (6)）。
- 旧互換: opts.minSpeedMps=1.5 を明示すると従来通り。

### 変更 C: minManeuverTurnDeg デフォルトを 75° に

- `rejectMinorTurns` の opts.minManeuverTurnDeg デフォルトを 45 → 75 に変更。
- 設計 (1) 「約 90° の方向転換をタックと断定」に合わせ、75° 未満の旋回は除外する。

## 後方互換

- `estimateWindAxisSeries` は既存 API を変更しない。
- opts で旧動作に戻せる：`{ minSpeedMps: 1.5, minManeuverTurnDeg: 45 }`
- `opts.useGeometricTackClassification` / `opts.tackTurnDegMin` は実装しない（H14 (a) で不採用）。
- 設計書に無い変更は行わない。

## 物差し（測定ハーネス）

`scripts/windaxis-measure.mjs` を新設:
- 合成データおよび CSV ファイルを読み込み、旧 opts 相当・現行（B5 前相当）・新実装 B5 の3設定で
  estimateWindAxisSeries を実行。
- 「旧 opts 相当」は現行コードに旧 opts（minSpeedMps=1.5, minTurnDeg=45）を渡したもの。
  d136a90 コミットの実装を再構築したものではない。confidence の改修は opts トグルがないため
  旧 opts 設定でも B5 の confidence ロジックが適用される。
- カバー率、アンカー数、艇間一致（複数艇があれば平均偏差）を並べて出力。
- 比較結果は stdout に件数・率のみ出力（実位置データは焼き込まない）。

## 足切りを外したリスクへの対処

minSpeedMps=0 にすると停船・上陸中の GPS ふらつきで向きが乱れる恐れがある。
物差しで悪化した場合は作業を止めて報告する（設計書に従う）。
