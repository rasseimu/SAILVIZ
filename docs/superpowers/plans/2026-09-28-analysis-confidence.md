# 練習サマリの推定信頼度と艇間比較条件 Implementation Plan

**Goal:** GPS から推定した分析結果(風軸・VMG 艇間比較)に信頼度 `high` / `medium` / `low` / `unavailable` と理由を付け、艇間比較は Issue の6条件をすべて満たす区間だけで行う。データ不足を勝敗として見せない。

**Issue:** #30

**Branch:** `feature/30-analysis-confidence`(`origin/main` 0d82802 から作成)

**状態:** 承認済み(2026-09-28)→ 計画レビューの指摘(P1×3・P2×2)を反映して改訂 → 第2回レビュー(P1×2・明確化1)を反映して再改訂。**再改訂版を承認(2026-09-28)。実装中**

## 1. 要求の理解

- 分析結果に信頼度4段階と理由を必ず付ける。
- 艇間比較(VMG の勝敗)は次の6条件をすべて満たす区間だけで行う。
  1. 2艇以上の GPS 時刻が重なっている
  2. 同じ走種である
  3. 推定風軸がある
  4. GPS 精度が閾値以内
  5. 最低比較時間を満たす
  6. 異常速度を除外済み
- 受け入れ条件
  - [ ] 各分析結果が信頼度を返す
  - [ ] UI から信頼度の理由を確認できる
  - [ ] 比較区間の長さを表示する
  - [ ] データ不足を勝敗として表示しない
  - [ ] 境界条件の単体テストがある
- 「練習サマリ」の対象: 現在唯一艇間の勝敗を表示している練習画面の VMG ネオン凡例(`#vmg-legend`)と解釈する。ホームのカード要約(`src/summary.js` `practiceSummary`)は points を読まない設計のため対象外(Q1)。

## 2. 現状調査

### 艇間比較(UI に出ているもの)

- `src/app.js` `recomputeVmgWinners` → `src/vmgminute.js` `minuteWinners` で勝者を計算し、`renderVmgLegend` が占有率表を描く。
  - 勝者0件だと凡例を隠すため、「なぜ比較できないか」が見えない。
  - 勝者ゼロの艇は `0%` と表示され、データ不足が負けに見える。
- `minuteWinners` は30秒バケット(`BUCKET_MS`)内で**走種をまたいで** VMG 最大の艇を勝者にしている。Issue の「同じ走種」条件に反し、`test/vmgminute.test.js` の「走種をまたいでVMG大の艇が勝者」テストがこの挙動を仕様として固定している。
- 凡例・`index.html` の説明文は「1分ごと」だが、実際のバケットは30秒(Q6)。
- 再利用できるもの
  - `boatMinuteVmg`(バケットごとの走種と VMG。リーチ・短い往復は除外済み)
  - `detectHeightAdjustWindowsByTrack`(高さ調整局面の除外)
  - `subtractIntervals`(`src/vmgminute.js`、非公開)
  - `MAX_SPEED_MPS = 25` / `rejectOutliers`(`src/gps.js`)
- `src/vmg.js` の `analyzeFleetVmg` / `boatLegVmg`(数値 `confidence` を持つ)は UI 経路で使われておらず、6条件も満たさないので流用しない。

### 風軸推定

- `src/windaxis.js` `estimateWindAxisSeries` はアンカー0件なら `[]`。
- `windDirAt` は系列の範囲外で端点にクランプする。そのためアンカーから遠い時刻でも風軸が「ある」扱いになっている。「推定風軸が存在する」の判定では端点からの距離を見る必要がある。
- `src/windaxisoverride.js` の結果には手動固定(`source: 'manual'`)が混ざる。
- 風軸推定の結果に信頼度の段階はない。

### GPS 精度・異常速度・欠損

- `src/gps.js` が `horizontalAccuracy` を `point.accuracy` に読み込む(列がなければ `null`)。
- 精度フィルタ 50m は `src/app.js` `addTrack` にハードコード(オン/オフ可、既定オン)。サーバー取込(`server/sensorimport.js`)は精度フィルタをかけないため、保存データに精度の悪い点が残りうる。
- 異常速度は `rejectOutliers`(点間移動速度)で読込時に除外済み。ただし記録された `speed` 列の値は見ていない。
- `src/interpolate.js` は欠損をまたいで線形補間するため、`tRange` が重なっていても実データがない時間が含まれうる。
- 旧データには `accuracy` / `speed` のない点や、`tRange` のないトラック(サーバー取込)がありうる。

## 3. 実装方針

- 判定ロジックは新規の純関数モジュール `src/analysisconfidence.js` にまとめる。DOM に触れず、保存データも増やさない(毎回その場で計算)。保存形式・サーバー・認証への影響はない。
- 比較は**実時刻の区間(ms)**で判定する。バケットに点があるかどうかでは判定しない(同じ30秒バケット内でも、A が前半だけ、B が後半だけなら重なりは0)。
- 手順
  1. **艇ごとの有効区間**: 隣り合う2点 `[p_i.t, p_{i+1}.t]` を、次をすべて満たすときだけ有効な小区間とし、連続する小区間を結合する。
     - 点間隔が `maxGapMs` 以下
     - 両端の点の `accuracy` が数値で、かつ `maxAccuracyM` 以下(`null` は「閾値以内と確認できない」ので**除外**。理由 `accuracy-unknown`)
     - 両端の点の `speed`(あれば)と点間移動速度が `maxSpeedMps`(分析用 15 m/s)以下
     - 風軸系列が空でなく、時刻が系列端から `windTolMs` 以内
  2. **走種の付与**: 有効区間を30秒バケット境界で分割し、各断片に `boatMinuteVmg(track, ws, {validIntervals})`(有効区間で対象サンプルを限定したもの。後述)のそのバケットの走種(upwind/downwind)を付ける。リーチ・判定なしのバケットの断片は捨てる。
  3. **高さ調整局面の除外**: `detectHeightAdjustWindowsByTrack` の区間を `subtractIntervals` で差し引く。
  4. **艇間の積集合**: 走種ごとに、同じ走種の断片が**2艇以上で実際に交差する時間**を求め、比較候補区間 `{lo, hi, pointOfSail, tracks}` とする(参加艇は交差している艇のみ)。
  5. **最低比較時間**: 候補区間は、**走種と参加艇の集合がどちらも同じ**で時間的に隣接する(`hi === 次の lo`)ものだけを結合する。参加艇の集合が変われば(途中で艇が加わる・抜ける)、そこで区間を切る。結合後の連続長が `minCompareMs` 未満の区間は**比較区間から除外**する(勝者計算にも渡さない)。除外があれば理由 `too-short` を付ける。
- 残った比較区間の合計長 `comparableMs`(走種別も)から時間レベルを決め、最終レベルは「時間レベル・風軸レベル」の最小値とする。比較区間が0なら `unavailable`。
- 理由は `{code, message}` の配列で返す。
- **除外した点を VMG に混ぜない**
  - `src/vmgminute.js` の `boatMinuteVmg` に `opts.validIntervals`(`[[lo, hi], ...]`)を追加する。
    - 指定時は、有効区間ごとに点を切り出してから `computeCog` を計算する(除外した点や区間をまたぐ COG を作らない)。
    - 有効区間外の時刻のサンプルは、走種判定・短いラン判定・平均のいずれにも使わない。
    - 未指定なら従来どおり(既存の呼び出しと既存テストの挙動は不変)。
  - 分類済みサンプル列を返す内部処理を `boatVmgSamples(track, ws, opts)` として切り出して export し、`boatMinuteVmg` はそれを集計する形にする(集計結果は不変)。
- ネオン勝者は、比較区間内の同じ走種の艇だけから選ぶ。
  - 判定単位は「30秒バケット ∩ 比較区間」の断片。勝者の `lo/hi` はこの断片に切り詰める(比較していない時間を光らせない)。
  - 各艇の VMG は、`boatVmgSamples(track, ws, {validIntervals})` のうち、その断片内の時刻で走種が一致するサンプルだけから**再計算**する。サンプル数が `minSamples` 未満の艇はその断片に参加しない。
  - 参加艇が2艇未満になった断片は勝者なしとし、どの艇の参加時間にも数えない。
- **占有率の分母を艇ごとの参加時間にする**
  - 艇ごと・走種ごとに `勝率 = その艇の勝者時間 / その艇が実際に比較へ参加した時間` とする。途中から参加した艇が、記録のない時間まで負け扱いにならないようにするため。
  - 「実際に比較へ参加した時間」は、上の断片のうち勝者が決まり、かつその艇が参加していた時間の合計。
  - `minuteWinners` の比較区間指定の経路は、内部で `{winners, participation: Map<track, {upwind, downwind}>}` を作る。`minuteWinnersDetailed(tracks, ws, opts)` として export し、`minuteWinners` は `.winners` を返す(既存の戻り値の形は不変)。
  - `assessComparison().perTrack` にも走種別の比較時間 `byPointOfSail: {upwind, downwind}` を持たせる(比較区間ベース。VMG サンプル不足の断片を含みうるため `participation` 以上の値になる。凡例の「比較区間の長さ」の表示に使う)。
  - `summarizeNeonShare(winners, tracks, participation)` の第3引数で分母を艇ごとの参加時間に切り替える。参加時間0の艇・走種は `null`(表示は `—`)。第3引数がなければ従来の分母(既存の呼び出し・テストとの互換)。
- `minuteWinners` の既定は安全側に変える: `opts.comparable`(`assessComparison().segments`)が未指定なら**勝者なし**。旧来の走種横断比較は `opts.legacyCrossPointOfSail: true` を明示したときだけ行う互換オプションとする。
  - 既定で `assessComparison` を内部呼び出ししないのは、`analysisconfidence.js` が `vmgminute.js` を import するため、逆方向の import で循環依存になるのを避けるため。呼び出し側(`app.js`)が `assessComparison` の結果を渡す。
- 風軸の信頼度 `assessWindAxis(series, track)`(閾値は Q3)
  - 系列が空 → `unavailable`
  - アンカー1点 → `low`
  - 2〜3点、または被覆率50%未満 → `medium`
  - それ以外 → `high`
  - 手動固定区間は `medium`+理由「手動設定」(Q8)
  - 結果に出所 `source: 'estimated' | 'manual' | 'mixed'` を持たせ、UI で「GPS推定」「手動設定」を表示し分ける
- 段階分割(Q9)
  - 段階A: 純ロジックとテスト(UI 変更なし)
  - 段階B: `minuteWinners` の同一走種化と凡例 UI
- 退けた案
  - `practiceSummary` / サイドカーに信頼度を載せる: 一覧のたびに全点解析が必要になり、points を読まない設計に反する。
  - `boatLegVmg` の数値 confidence を流用する: UI 経路で未使用、6条件を満たさない。

### 閾値(提案値)

| 項目 | 値 | 根拠 |
|---|---|---|
| `maxAccuracyM` | 50 | 既存 `addTrack` と同値。`gps.js` に `ACCURACY_FILTER_M` として定数化し両方から使う |
| `maxSpeedMps` | 15 | **比較判定用**の `ANALYSIS_MAX_SPEED_MPS`。読込時の `MAX_SPEED_MPS = 25`(`rejectOutliers`)は据え置き(Q4) |
| `maxGapMs` | 5000 | 1Hz 記録で5点以上欠けたら欠損 |
| `windTolMs` | 300000 | 風軸平滑化の半窓(10分窓の半分) |
| `minCompareMs` | 60000 | 30秒バケット2つ分。**連続する比較区間ごと**に適用し、未満の区間は比較から除外(勝者も出さない) |
| `mediumCompareMs` | 180000 | 60秒以上180秒未満は `low` |
| `highCompareMs` | 600000 | 180秒以上600秒未満は `medium`、以上は `high` |

## 4. 変更予定ファイル

### 段階A(純ロジック)

- `src/analysisconfidence.js`(新規)
  - 定数: `CONFIDENCE_LEVELS`、`DEFAULT_CONFIDENCE_OPTS`
  - 定数: `ANALYSIS_MAX_SPEED_MPS = 15`
  - 関数: `minLevel`、`levelForComparableMs`、`assessWindAxis`、`validIntervals(track, windSeries, opts)`(艇ごとの有効区間)、`intersectIntervals`、`assessComparison(tracks, windSeriesByTrack, opts)`、`formatConfidenceLabel(result)`
  - `assessComparison` の戻り値: `{level, reasons, comparableMs, byPointOfSail: {upwind, downwind}, overlapMs, segments: [{lo, hi, pointOfSail, tracks}], perTrack: Map<track, {comparableMs, byPointOfSail: {upwind, downwind}, windAxis}>}`
    - `overlapMs` は条件判定前の生の記録時刻の重なり(「重なっていない」と「重なっているが条件不足」を区別するため)
    - `segments` は最低比較時間を満たした区間のみ
- `src/gps.js`: `export const ACCURACY_FILTER_M = 50` を追加(既存関数は変えない)
- `src/vmgminute.js`
  - `subtractIntervals` を export(挙動不変)
  - `boatVmgSamples` を切り出して export し、`boatMinuteVmg` に `opts.validIntervals` を追加(未指定時の挙動は不変)

### 段階B(比較と UI)

- `src/vmgminute.js`
  - `minuteWinnersDetailed` を追加し、`minuteWinners` に `opts.comparable`(= `segments`)と `opts.validIntervalsByTrack` を追加。
  - 比較区間内の同じ走種の艇だけで、断片内の有効サンプルから VMG を再計算して勝者を決め、`lo/hi` を断片に切り詰める。
  - 比較区間の指定がなければ勝者なし。旧挙動は `opts.legacyCrossPointOfSail: true` のときのみ。
- `src/vmg.js`: `summarizeNeonShare(winners, tracks, participation)` に第3引数を追加。指定時は艇ごと・走種ごとの参加時間を分母にし、各行に `upwindParticipationMs` / `downwindParticipationMs` を追加。参加時間0は `null`。未指定時は従来どおり。
- `src/app.js`
  - `addTrack` の `50` を `ACCURACY_FILTER_M` に置換
  - `recomputeVmgWinners` で `assessComparison` を計算・保持
  - `renderVmgLegend`: VMG オンなら勝者0件でも表示。信頼度バッジ、比較区間の長さ(合計・クローズ/ランニング別)、理由一覧(`<details>`)、各艇の風軸の出所(「GPS推定」/「手動設定」/「GPS推定+手動設定」)と風軸信頼度。比較区間のない艇は `—(比較区間なし)`。
- `index.html`: `vmg-label` の title 文言(Q6 の場合のみ)
- `styles.css`: `#vmg-legend` にバッジ(`.vl-conf-high/medium/low/unavailable`)・理由一覧・比較区間行のスタイル。768px 以下で `max-width` / `max-height` とスクロール。

## 5. テスト計画

### `test/analysisconfidence.test.js`(新規)

合成トラック(`test/vmgminute.test.js` の `straightTrack` と同方式)のみを使い、実位置情報は使わない。

- `levelForComparableMs` 境界: 0 / 59999 → unavailable、60000 → low、179999 → low、180000 → medium、599999 → medium、600000 → high
- `minLevel`: high と low → low。unavailable を含めば unavailable
- 時刻の重なり
  - A 終了 = B 開始(重なり0ms) → `unavailable`、`no-overlap`、「比較不能：2艇の記録時刻が重なっていません」
  - **同一30秒バケット内だが時間は交差しない**(A がバケット前半のみ、B が後半のみ) → 重なり0、`no-overlap`
  - **一部だけ交差する**(A と B が 20秒だけ交差) → `overlapMs` が 20000、比較区間はその 20秒分以下
- 最低比較時間
  - 交差が 30秒だけ → `segments` 空、`comparableMs` 0、`unavailable`、`too-short`。**`minuteWinners` に渡しても勝者なし**
  - 交差がちょうど 60000ms → 比較区間1件(low)、59999ms → 比較区間なし
  - 60秒の区間+30秒の区間(非連続) → 30秒側は除外され `comparableMs` は 60000
  - 参加艇の集合が変わる: A+B が 40秒 → 続けて A+B+C が 40秒 → 結合せず両方除外(`too-short`)。A+B が 60秒 → A+B+C が 60秒 → 2区間とも残る
  - 同じ集合で隣接する 30秒+30秒 → 結合して 60000ms で残る
- 艇数: 1艇のみ → `need-two-boats`
- 走種: A 風上・B 風下 → `no-same-point-of-sail`。両艇風上 → 比較可能
- 風軸: 片方の系列が `[]` → `no-wind-axis`。系列端から `windTolMs` ちょうど → 合格、+1ms → 不合格
- 精度: 50 → 合格、50.01 → 除外。全点 `null`(旧データ・列なし) → 例外なし・`unavailable`・`accuracy-unknown`。一部だけ `null` → その部分だけ除外
- 異常速度: `speed` 15 → 合格、15.01 → 除外。点間移動速度 15 m/s 超の小区間 → 除外。`MAX_SPEED_MPS` は 25 のまま
- 欠損: 点間隔 5000ms → 連続、5001ms → 除外
- 高さ調整局面: 比較時間に含めない
- 旧データ耐性: `tRange` なし、`points` 空、`speed` なし → 例外なし
- `assessWindAxis`: `[]` → unavailable、1点 → low、2・3点 → medium、4点以上かつ被覆率50%ちょうど → high、49.9% → medium、manual のみ → `medium`・理由 `manual`・`source: 'manual'`、推定のみ → `source: 'estimated'`
- `formatConfidenceLabel`: 「信頼度 高」「信頼度 中：比較可能時間が短いため参考値」「比較不能：…」

### 既存テストの更新・追加

- `test/vmgminute.test.js`
  - `comparable` 未指定 → 勝者なし(安全側の既定)
  - `comparable` 指定 → 走種をまたいだ勝者が出ない/比較区間外に勝者なし/勝者の `lo/hi` が比較区間内に収まる
  - 「走種をまたいでVMG大の艇が勝者」テストは `legacyCrossPointOfSail: true` を明示する形に書き換え(旧挙動の互換確認)
  - 既存の他のテストは、`assessComparison` の結果を渡す形か互換オプションで意図を保って更新する
- `test/vmgminute.test.js`(除外点の混入防止)
  - `boatMinuteVmg` に `validIntervals` 未指定 → 既存テストの結果と同じ
  - **同一バケット内の無効点(精度超過・異常速度)を極端な値(例: 逆向き 14 m/s、精度 500m)にしても、勝者と勝者の VMG が変わらない**
  - 有効区間外の点で走種が変わるように細工しても、断片の走種判定が変わらない
  - 断片内の有効サンプルが `minSamples` 未満の艇はその断片に参加しない。参加艇が1艇になった断片は勝者なし
- `test/vmg.test.js`(`summarizeNeonShare`)
  - 第3引数なし → 既存の結果と同じ
  - **途中参加の艇を欠損時間分だけ不利にしない**: A が 10分、B が後半 5分だけ参加し、B が参加中ずっと勝者 → B の勝率 100%、A の勝率は A 参加時間に対する比率(B の不在時間を B の負けに数えない)
  - 参加時間0の走種 → `null`
- `test/analysisconfidence.test.js`: `perTrack.byPointOfSail` が比較区間の走種別合計と一致し、`minuteWinnersDetailed().participation` 以上であること
- `test/gps.test.js`: `ACCURACY_FILTER_M === 50`。

### 実行コマンド

```bash
node --test test/analysisconfidence.test.js test/vmgminute.test.js test/vmg.test.js test/gps.test.js
npm test
```

## 6. ブラウザ確認項目

- 段階A: UI 変更なし。web-verifier 不要。
- 段階B: UI 変更あり。web-verifier を使う。`CLAUDE.md` のダミー資格情報と一時 `DATA_DIR` でローカル起動し、`sample-data/` の合成・サンプル CSV を使う。

| # | 操作 | 期待結果 | 画面幅 |
|---|---|---|---|
| 1 | 時刻が重なる2艇を読み込み、🏆VMG をオン | 信頼度、比較区間の長さ(合計・走種別)、風軸の出所(GPS推定/手動設定)が出る。表の割合は「参加時間中の勝率」と分かる見出し | 1280 / 390 |
| 2 | 凡例の「理由」を開く | 判定理由の一覧が読める | 1280 / 390 |
| 3 | 時刻が重ならない2艇で VMG をオン | 「比較不能：2艇の記録時刻が重なっていません」。占有率とネオンは出ない | 1280 / 390 |
| 4 | 1艇だけ表示 | 比較不能と理由。0% は出ない | 1280 |
| 5 | 比較区間のない艇がいる | その艇の行が `—` | 1280 |
| 6 | 390px で凡例表示 | 回転コントロール・タイムラインと重ならず、はみ出しはスクロール | 390 |
| 7 | VMG をオフ | 凡例とネオンが消える(既存どおり) | 1280 |

## 7. リスク・未確定事項

### リスク

- 後方互換: 保存形式は変えない(`PROJECT_VERSION` 据え置き)。`accuracy` / `speed` / `tRange` 欠落でも例外を出さないことをテストで担保。
- 認証: `server/` は変更しない。
- 個人情報: テストデータは合成座標のみ。ログ出力は追加しない。
- 挙動の変化: 同じ走種・最低比較時間・精度確認済みに限定するため、既存のネオン勝者の時間が減る(利用者に見える変化)。精度列のない旧データでは艇間比較が「比較不能」になる。
- 表示の意味の変化: 占有率(合計100%)から「参加時間中の勝率」(艇ごとの分母、合計は100%にならない)に変わる。凡例の見出しと説明文で明示する。
- 参加艇の集合で区間を切るため、艇の出入りが頻繁だと、各区間が60秒に届かず比較区間が減りうる。
- 性能: VMG 切替時・トラック変更時のみ計算。毎フレームの計算は増えない。

### 決定事項(2026-09-28 承認。推奨案どおり)

| # | 論点 | 決定 |
|---|---|---|
| Q1 | 「練習サマリ」の範囲 | 練習画面の VMG 凡例+各艇の風軸信頼度。ホームのカードはサイドカー実装を前提に別 Issue |
| Q2 | `minuteWinners` の既定を同一走種・比較可能区間に変えるか | 変える。比較区間の指定がなければ勝者なし(安全側)。旧挙動は `legacyCrossPointOfSail: true` の明示時のみ |
| Q3 | 閾値(3章の表・風軸アンカー数・被覆率50%) | 提案値で開始し、定数として1か所にまとめて後で調整可能にする |
| Q4 | 異常速度の閾値 | 読込時 25 m/s(`MAX_SPEED_MPS`)は据え置き、比較判定時は 15 m/s(`ANALYSIS_MAX_SPEED_MPS`) |
| Q5 | 精度 `null` の扱い/フィルタオフ・サーバー取込時 | **(レビューで改訂)** `null` は「閾値以内と確認できない」ため比較対象外(Issue 本文どおり、理由 `accuracy-unknown`)。分析時は常に 50m で判定する |
| Q6 | 「1分ごと」→「30秒ごと」の文言修正 | 含める(凡例を触るため同時に直す方が自然) |
| Q7 | 風軸信頼度の表示場所 | VMG 凡例の各艇行のみ(サイドバーのバッジは別 Issue) |
| Q8 | 手動固定風軸の信頼度 | `medium`+理由「手動設定」(利用者の指定であり GPS 推定ではないが、実測値でもないため) |
| Q9 | 段階A・B の PR 分割 | 1 PR・2コミット(A: ロジック+テスト、B: UI) |

### 計画レビューによる改訂(2026-09-28)

| # | 指摘 | 対応 |
|---|---|---|
| 1 | [P1] 最低比較時間未満でも勝者が出る | 連続区間ごとに `minCompareMs` 未満を比較区間から除外し、勝者計算にも渡さない。30秒のみの交差で勝者なしのテストを追加 |
| 2 | [P1] 同一バケットに入っただけで重なり扱い | バケット単位の在否判定をやめ、艇ごとの有効区間の実時刻の積集合で判定。「同一バケットだが非交差」「一部交差」のテストを追加 |
| 3 | [P1] 精度不明を比較可能にしていた | Issue 本文どおり比較対象外に変更(Q5 改訂) |
| 4 | [P2] 異常速度閾値の矛盾 | 閾値表を「読込時 25 / 比較判定時 15」に統一 |
| 5 | [P2] `minuteWinners` 既定の矛盾 | 既定を安全側(比較区間なしなら勝者なし)に統一し、旧挙動は明示の互換オプションに |
| 補足 | 手動風軸も「GPS推定」と表示 | `assessWindAxis` に `source` を持たせ、UI で「GPS推定」/「手動設定」を表示し分ける |
| 6 | [P1] 除外した GPS 点が VMG 値に混入する | `boatMinuteVmg` に `validIntervals` を追加して対象サンプルを限定し、勝者の VMG は「バケット ∩ 比較区間」内の有効サンプルから再計算。無効点を極端な値にしても勝者が変わらないテストを追加 |
| 7 | [P1] 途中参加の艇がデータ不足で不利に表示される | 分母を艇ごと・走種ごとの実参加時間に変更(`minuteWinnersDetailed().participation` → `summarizeNeonShare` 第3引数)。`perTrack` に走種別比較時間を追加。途中参加の艇を不利にしないテストを追加 |
| 明確化 | 参加艇の組み合わせが変わったときの結合 | 走種と参加艇集合がどちらも同じ隣接区間だけを結合する |

### 作業ツリーの途中変更

最初の engineer 起動が中断される前に、改訂前の計画に基づく変更が作業ツリーに残っている(未コミット)。破棄はしていない。

- `src/analysisconfidence.js`(新規、バケット単位判定の `bucketQuality` を含む)
- `src/gps.js`(`ACCURACY_FILTER_M` 追加。改訂後の計画とも一致)
- `src/vmgminute.js`(`subtractIntervals` の export のみ。改訂後の計画とも一致。`boatVmgSamples` の切り出しは未着手)

実装を再開するときは、engineer が改訂後の計画に合わせて `src/analysisconfidence.js` を作り直す。

### 段階A 実装レビューの決定(2026-09-28)

レビュー結果: P0/P1 なし(P2×4・P3×7)。メイン agent の判断は次のとおり。

| 指摘 | 決定 |
|---|---|
| P2-1 高さ調整局面の検出に無効点が混ざる | 修正する。有効区間の断片ごとに COG を計算したサンプルで検出する |
| P2-2 負の `accuracy` を閾値以内として扱う | 修正する。負の値は `accuracy-unknown`(比較対象外) |
| P2-3 追加した理由コード・主理由分岐のテスト不足 | テストを追加する |
| P2-4 有効区間の境目で短いラン判定を切る(計画外の解釈) | **採用する**。除外点をまたいだランを作らないため。比較時間が減る方向で誤った勝敗は出ない。境目付近の断片(クローズ約30秒・ランニング約60秒以下)は走種なしになりうる |
| P3-2 非数の風軸系列 / P3-3 同時刻の重複点 / P3-5 前提のコメント / P3-6 import の位置 | 修正する |
| P3-1 風軸系列内部の空白(アンカー間が長くても「風軸あり」) | 今回は対応しない(既知の制約・今後の課題) |
| P3-4 区間切り出しの計算量 | 今回は対応しない(性能問題が出たら対応) |
| P3-7 `formatConfidenceLabel` の `unavailableLabel` | 段階Bで風軸の結果を表示するときに必ず渡す |

計画外として追加した理由コード `invalid-position` / `no-point-of-sail` / `short-compare`、`assessWindAxis` の `source: null`(系列が空)、`formatConfidenceLabel` の第2引数はそのまま採用する。

### 段階A 完了(2026-09-28)

- 再レビュー(ループ1回目の修正後): P0/P1 なし。前回の修正対象はすべて解消。新規 P2×1(高さ調整で同走種の重なりが全部消えたとき主理由が「最長0秒」)・P3×2(古いコメント・cogAt 許容幅の注記)をループ2回目で修正し、メイン agent が分岐順(`samePosPostMs <= 0` → `preQualified` → `too-short`)を確認した。
- ループ2回目の追加変更: 残り区間が1秒未満のときは「最長1秒未満」と表示する。
- 追加した export: `cogSamplesByIntervals`(`src/vmgminute.js`)、`detectHeightAdjustWindowsFromSamples`(`src/vmg.js`。艇を配列位置で区別)。
- テスト: `npm test` 658 件すべて pass。
- 段階Aでは UI を変更していない(web-verifier は段階Bで実施)。

### 段階B 実装・レビュー(2026-09-28)

- レビュー: P0/P1 なし(P2×2・P3×5)。すべて修正した。
  - P2-1/P2-2: 「途中参加」「無効点の極端値」テストが退行を検出できなかった → 勝者あり・参加時間>0・勝率の検証、同じ走種で高速な無効点の肯定側/否定側の両方を検証する形に強化。
  - P3-1: `comparable` 指定時に `validIntervalsByTrack` がなければサンプルなし(勝者なし)の安全側に。
  - P3-2: `summarizeNeonShare` の「1で上限」を外し、勝者時間 ≤ 参加時間をテストで検証。
  - P3-3: 比較区間はあるがサンプル不足の艇は「—（比較できるサンプル不足）」と出し分け。
  - P3-4: 合計に「（時刻の重複を除く）」を付け、走種別の和が合計を上回りうることを title で説明。
  - P3-5: 艇名・色の変更時に凡例を再描画。
- 元のレビューに P0/P1 がなかったため再レビューは行わず、修正箇所はメイン agent が確認した。
- テスト: `npm test` 672 件すべて pass。
- 高さ調整局面は `minuteWinnersDetailed` で再適用しない(`segments` で差し引き済み。全点で再検出すると除外点が戻るため)。
- 390px: 既存 CSS で 768px 以下は `#stage` と VMG トグルが非表示のため、凡例はモバイルでは表示されない。6章の390px項目は「レイアウトが崩れないこと」の確認に読み替える。
- **ブラウザ確認: 未実施。** web-verifier を起動したが、Claude in Chrome のツールがセッションに提供されておらず操作できなかった。Chrome 連携を有効にして再実行するか、利用者が手動で確認する必要がある。
  - 確認用データ: 合成 CSV(架空座標)から作ったダミー練習データ6件を一時 `DATA_DIR` に配置(10:00=A+B、10:01=A+F-short、10:02=A+C-late、10:03=A+B+C-late、10:04=A+B+D-join、10:05=A+E-noacc)。

### ブラウザ確認の引き継ぎ(2026-09-28)

web-verifier を2回起動したが、どちらも Claude in Chrome のツールが提供されず未実施(`/chrome` も「この環境では使えない」)。Chrome 連携を有効にした新しいセッション(例: CLI で `claude --chrome`)で再開する。

再開手順:

1. 確認用データ(合成・架空座標)は `C:\LMSTemp\sailviz-issue30-e2e\` に退避済み。
   - `sailviz-e2e\projects\` … ダミー練習データ6件(そのまま `DATA_DIR` に使える)
   - `e2e-data\` … 合成 CSV、`gen-synthetic.mjs` … CSV 生成、`seed-projects.mjs` … CSV から練習データを作る(`node seed-projects.mjs <repoDir> <csvDir> <dataDir>`)
2. 8000 番は別の常駐プロセスが使っているため、8010 番で起動する(PowerShell):

   ```powershell
   $env:PORT='8010'; $env:SAILVIZ_WRITE_TOKEN='dummy-write'; $env:SAILVIZ_VIEW_USER='dummy-user'; $env:SAILVIZ_VIEW_PASSWORD='dummy-pass'; $env:DATA_DIR='C:\LMSTemp\sailviz-issue30-e2e\sailviz-e2e'; npm start
   ```

3. web-verifier に次の手順を渡す(練習一覧のラベル: 10:00=A+B、10:01=A+F-short、10:02=A+C-late、10:03=A+B+C-late、10:04=A+B+D-join、10:05=A+E-noacc。地図右上「🏆VMG」でオン)。書込・保存・艇名/色変更・風軸の手動設定はしない。

| # | 操作 | 期待結果 | 幅 |
|---|---|---|---|
| 1 | 10:00 で VMG オン | 「信頼度 高」、比較区間 合計 約15分53秒（時刻の重複を除く）、見出し「クローズ勝率/ランニング勝率/風軸」、A クローズ約100%・B 0%、ランニング「—」、風軸「GPS推定」、説明に「30秒ごと」「参加時間中の勝率」、A がネオン発光、合計に title | 1280 |
| 2 | 「判定の理由」を開く | 一覧が読める(0件なら details なし) | 1280 |
| 3 | 10:01 | 「信頼度 中：比較可能時間が短いため参考値」、約3分53秒 | 1280 |
| 4 | 10:02 | 「比較不能：2艇の記録時刻が重なっていません」、0秒、「艇/風軸」のみ、0%・ネオンなし | 1280 |
| 5 | 10:00 で B 非表示 → 再表示 | 比較不能(2艇以上必要)・0%なし・ネオンなし → 手順1に戻る | 1280 |
| 6 | 10:03 | 信頼度 高、C-late 行「—（比較区間なし）」 | 1280 |
| 7 | 10:04 / 10:05 | D-join は参加時間(約7分53秒)基準の勝率 / 「比較不能：GPS 精度の記録がないため比較できません」相当 | 1280 |
| 8 | 390px で 10:00 | 地図と VMG トグルは非表示(既存仕様)。崩れ・横スクロールなし | 390 |
| 9 | VMG オフ | 凡例とネオンが消える | 1280 |
| 10 | 手順1・4 の凡例 | 他 UI と重ならず読める、長ければスクロール可 | 1280 |
| 11 | 全手順 | コンソールエラーなし | — |

### ブラウザ確認の結果(2026-09-28)

メイン agent が Claude in Chrome で直接確認した(web-verifier の定義のツール名 `tabs_context` / `tabs_create` が実名 `tabs_context_mcp` / `tabs_create_mcp` と違っていたため。定義とテストは修正済み)。手順1〜11 はすべて期待どおり。ただし 390px は、ウィンドウが最大化されていてサイズを変えられず、幅 390px の iframe で確認した。コンソールは記録開始後の範囲のみ。

### 外部レビューの指摘と修正計画(2026-09-28、利用者承認済み)

| 指摘 | 決定 |
|---|---|
| [P1] 読込時に削除した点の前後が、分析で正常区間としてつながる | 除外区間をトラックの任意項目 `excludedIntervals` として記録・保存し、分析で必ず差し引く。項目のない旧データは記録間隔から穴を判定して除外 |
| [P1] 信頼度が高のとき理由が空で、UI でも理由を確認できない | 肯定的な判定理由を返す |
| [P2] 390px では `#stage` ごと非表示で、凡例のモバイル用 CSS が効かない | モバイル対応は別 Issue に分ける。効かない CSS は削除し、6章の 390px 項目は対象外とする |

#### 修正1: 除外区間の記録(P1)

- `src/gps.js` に純関数を追加する(既存の `rejectOutliers` / `parseGpsPoints` のシグネチャ・挙動は変えない)。
  - `filterPointsWithExclusions(points, {accuracyFilter, maxAccuracyM = ACCURACY_FILTER_M, maxSpeedMps = MAX_SPEED_MPS})` → `{points, removed, excludedIntervals}`
    - 精度フィルタ(`accuracyFilter` が true のとき。既存 `addTrack` と同じ条件 `accuracy == null || accuracy <= maxAccuracyM` を残す)→ `rejectOutliers` と同じ判定の順に処理する。
    - 削除した点ごとに、**前の採用点〜次の採用点**の橋渡し区間全体を `{lo, hi, code}` として記録する(`code`: 精度で削除 = `'accuracy'`、速度で削除 = `'speed'`)。先頭側の削除は「削除点の時刻〜次の採用点」、末尾側は「前の採用点〜削除点の時刻」。連続する複数の削除も、両端の採用点どうしの区間全体を覆う。
    - 同じ code で重なる・接する区間は結合する。code が違う区間は重なってよい。
    - 時刻が前の採用点以下(`dt <= 0`)で削除した点は、長さ0なので記録しない。
  - `prepareTrackPoints(header, rows, {accuracyFilter})` → `{points, removed, excludedIntervals}`。`parseGpsPoints` と `filterPointsWithExclusions` をつなぐ読込処理で、`addTrack` はこれを使う(統合テストの対象)。
- `src/app.js` `addTrack`: `prepareTrackPoints` を使い、トラックに `excludedIntervals` を持たせる。
- `server/sensorimport.js`: `parseSensorCsv` も `filterPointsWithExclusions`(精度フィルタなし=既存どおり)を使い、`excludedIntervals` を返して `buildTrack` でトラックに載せる。
- `src/project.js`: 保存時は `excludedIntervals` を、`lo < hi` の数値で code が文字列の要素だけに絞って書き出す。**トラックに項目がないときは書き出さない**(旧データと区別するため)。読込は `...t` でそのまま通す。`PROJECT_VERSION` は据え置き。
- `src/analysisconfidence.js` `validIntervalsDetailed`:
  - `track.excludedIntervals` が配列なら、有効区間からそれを差し引き、差し引いた部分を `excluded` にそのコード(`accuracy` / `speed`)で記録する。既存の理由文言(「GPS 精度が50mを超える時間帯を除外しました」など)がそのまま出る。
  - 項目がない(配列でない)旧データは、正の点間隔の中央値 `m` を求め、`dt > 1.5 × m` の小区間を新しいコード `record-gap` で除外する(安全側)。文言は「記録間隔が普段より長い時間帯(読込時に除外された点の可能性)を除外しました」、比較区間が0になった主な原因のときは「記録間隔が普段より長い時間帯が多く、比較できる時間が重なりません」。
  - `validIntervalsByTrack` は `minuteWinnersDetailed` と高さ調整の検出でも使うため、除外が VMG の値にも反映されることをテストで確認する。

#### 修正2: 肯定的な判定理由(P1)

- `assessWindAxisRaw`: 系列が空でない場合は、次を `cap: 'high'` で必ず付ける。
  - `wind-anchors`「タック/ジャイブ N回から推定」(推定点が1点以上のとき。少ない場合の既存の理由とは別に、N回の事実として付ける。既存の `wind-few-anchors` があれば重ねない)
  - `wind-coverage`「記録時間の X% を覆う」(被覆率を計算できたとき。`wind-low-coverage` があれば重ねない)
- `assessComparison`: 比較区間があるときは `compare-time`「連続して比較できる区間 N件・合計 X（最低 Y 以上）」を `cap: 'high'` で付ける。
- 肯定的な理由は `cap: 'high'` なので並べ替えで後ろに回り、中・低の見出し(`reasons[0]`)は変わらない。これをテストで確認する。
- UI: 信頼度が高でも「判定の理由」を開けること(比較の結果は常に理由が1件以上になる)。
- テスト: 高のとき理由が空でない(比較・風軸とも)。`test/analysisconfidence.test.js` の `reasons` が `[]` になる前提の箇所を更新する。

#### 修正3: モバイル(P2)

- `styles.css` の `@media (max-width: 768px) { #vmg-legend ... }` を削除する(`#stage` が非表示のため効かない)。
- 6章の 390px 項目は対象外とし、モバイルでの VMG 凡例表示は別 Issue で扱う(Issue の作成は利用者が行う)。

#### テスト(追加)

- `filterPointsWithExclusions` / `prepareTrackPoints`: 「正常 → 精度500m → 正常」で中間点が削除され、`[前の採用点, 次の採用点]` が `accuracy` で記録される。連続した複数の除外、先頭・末尾の除外、速度による除外、`accuracyFilter: false`、`dt <= 0` は記録しない。
- 統合: `prepareTrackPoints` の結果で作ったトラック2艇を `assessComparison` に通し、除外区間が比較区間に入らないこと(修正前は [0, 2000ms] が有効になっていた)。`minuteWinnersDetailed` の勝者もその時間に出ない。
- `project`: `excludedIntervals` の保存・読込の往復。項目がないトラックでは書き出さない。
- `sensorimport`: 速度で除外した点の区間が `excludedIntervals` に入る。
- 旧データ(項目なし): 1Hz の中で1点抜けた穴(2秒)が `record-gap` で除外される。等間隔なら何も除外しない。点が2つ以下・間隔が全部同じなどの境界で例外が出ない。`excludedIntervals: []` のトラックでは間隔による判定をしない。

#### 修正の結果(2026-09-28)

- 実装: 計画どおり。計画外の変更は、メイン agent が承認した次の2点。
  - `server/api.js` の commit 処理で `buildTrack` に `excludedIntervals` を渡す1行(認証の判定より後。サーバー取込のトラックにも除外区間を保存するため)
  - 穴判定の倍率を `DEFAULT_CONFIDENCE_OPTS.recordGapFactor` にまとめた
- テスト: `npm test` 696 件すべて pass(修正前 672 件)。
- レビュー: P0/P1 なし、P3×2。どちらもコードは変えず、既知の制約として残す。
  - 橋渡し区間が `maxGapMs`(5秒)を超えるほど長い除外(例: 精度不良が10秒続く)は、理由が `accuracy` / `speed` ではなく `gps-gap` として出る。区間は正しく除外される。
  - 旧データの穴判定(点間隔の中央値×1.5)は、精度フィルタで点の約半数以上が抜けたデータでは中央値が上がるため、穴を検出できない。記録間隔のばらつきが大きい端末では、正常な間隔まで除外されることがある(安全側)。
- ブラウザ確認(メイン agent が Claude in Chrome で実施、1280px 相当): いずれも期待どおり、コンソールエラーなし。
  - 保存済みの 10:00(旧データ)で信頼度 高 のとき、「判定の理由（5件）」が開け、比較区間と風軸の肯定的な理由が並ぶ。
  - 画面の「CSV読込」で syn-A と syn-B-badacc(syn-B の 10:05:00〜10:05:02 の3点だけ精度 500m)を読み込むと、次のとおり。
    - B は951点になった
    - 比較区間は 15分53秒 → 15分49秒(除外の4秒ぶん)で、区間2件に分かれた
    - 理由に「GPS 精度が50mを超える時間帯を除外しました」が出た
  - 残課題(表示の揃え): `compare-time` の理由は「合計953秒」と秒だけで表示され、凡例の「15分53秒」表記と揃っていない。
- モバイルでの VMG 凡例表示: 別 Issue #48 で扱う。

### 外部再レビューの指摘と修正(2026-09-28)

- 前回の P1 2件は解消済みと確認された。残りは [P2] 1件: 比較に参加していない艇の風軸の判定理由を UI で確認できない(`src/app.js` の風軸セルは `title` に主な理由1件だけを出し、比較全体の理由には参加艇の風軸理由しか入らない)。
- 修正(メイン agent が直接実装。数十行の変更のため subagent は使わなかった):
  - `src/analysisconfidence.js`: `windAxisReasonRows(tracks, perTrack)` を追加した。表示中の全艇について、風軸の信頼度・理由・比較への参加有無を返す純関数。
  - `src/app.js`: 凡例に「各艇の風軸の判定理由」(`<details>`)を追加した。全艇の信頼度とすべての理由を並べ、不参加の艇には「（比較に不参加）」を付ける。
  - テスト2件を追加した(不参加の艇と風軸なしの艇を含む4艇 / `perTrack` なし・不正な入力)。`npm test` 698 件すべて pass、`git diff --check` OK。
- ブラウザ確認(Claude in Chrome、1280px 相当): 10:03(A+B+C-late)で、比較に参加していない syn-C-late に「信頼度 高（比較に不参加）」と風軸の理由2件が出た。凡例の表示崩れ・コンソールエラーなし。
