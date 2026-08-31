# 風軸 部分再推定（範囲選択リード直し）設計

作成日: 2026-08-31

## 1. 目的と背景

風軸推定（`estimateWindAxisSeries`）は、各艇のGPS軌跡からタック/ジャイブを検出して
風向を推定し、外れ値除去と10分円周中央値平滑化を**トラック全体に対して**適用する。
この大域処理により、局所的に誤検出・巻き添え平滑化が起きた区間で風向がずれることがある。

ユーザーが、ダッシュボードの風軸グラフ上で**うまく読めていない区間をドラッグ選択**し、
**その範囲だけで風軸を推定し直す**機能を追加する。補正はプロジェクトに保存し、
ダッシュボードだけでなく練習画面（風軸↑回転・風軸ストリップ）とVMG計算にも反映する。

## 2. スコープ

含む:
- ダッシュボード風軸グラフ上でのドラッグによる範囲選択
- 選択範囲のみを分離して再推定し、全体系列へスプライスする純関数
- 補正範囲のプロジェクト保存（トラック単位）
- 地図（windUp/windストリップ）・VMG（`minuteWinners`/`unifyWindAxis`）への反映
- 補正範囲の可視化（帯）とクリア（単体/全体）

含まない:
- 練習画面タイムライン側での範囲選択（今回はダッシュボードのみ）
- 手動での風向数値入力・パラメータ調整による再推定（採用したのは「範囲だけで再推定」方式）
- 複数艇同時補正のダッシュボードUI（ダッシュボード風軸グラフは先頭可視トラック1艇が対象）

## 3. 用語・前提

- 風軸系列は**トラックオブジェクト単位**で保持される（`windSeriesByTrack: Map<track, series>`）。
  各艇のCSVがファイル名（`Location.csv`）由来で `id` が重複しうるため、`id` キーは使えない。
  → 補正範囲も**トラックオブジェクトのプロパティ**として保持し、保存もトラックに同梱する。
- 系列サンプルは `{ tMs, windFromDeg, ... }`（絶対epoch ms）。
- ダッシュボード風軸グラフの対象トラックは `state.tracks.find(t => t.visible)`（先頭可視艇）。

## 4. データモデル

各トラックに補正範囲配列を持たせる:

```
track.windAxisOverrides: Array<{ start: number, end: number }>  // 絶対epoch ms、start < end
```

- 未設定/旧データは `[]` 扱い。
- 範囲は正規化（start<end にそろえ、ソートし、重なり/隣接をマージ）してから使用・保存する。

## 5. コア：再推定とマージ（`src/windaxisoverride.js`）

純関数（DOM非依存・テスト可能）:

```
applyWindAxisOverrides(track, { marks = [], overrides = [] }) -> mergedSeries
```

手順:
1. `base = estimateWindAxisSeries(track, { marks })`（トラック全体の推定）。
2. `overrides` が空なら `base` をそのまま返す。
3. `overrides` を正規化（start<end、ソート、重なり/隣接をマージ）→ `ranges`。
4. 各 `range = {start, end}` について:
   - `subset = track.points.filter(p => p.t >= start && p.t <= end)`
   - `local = estimateWindAxisSeries({ ...track, points: subset }, { marks })`
     （**その範囲の点だけ**で推定＝全体の平滑化/外れ値除去から分離）
   - base のうち `tMs ∈ [start, end]` のサンプルを取り除き、`local` のサンプル
     （`tMs ∈ [start, end]`）を挿入する。
5. 全サンプルを `tMs` 昇順にソートして返す。

補足・エッジケース:
- `local` が空（範囲内にタック/ジャイブが検出されない）場合、その範囲のサンプルは
  **除去のみ**され補充されない＝系列にギャップができる。`windDirAt` は前後を補間で
  ブリッジする。UI 側で「その区間は推定できなかった」ことを控えめに示す。
- トラック時間範囲外の `override` は `subset` が空になり、実質 no-op（上記と同じ扱い）。
- `range` が `base` に一切重ならない場合でも、`local` 由来サンプルは `[start,end]` 内
  なので矛盾なく挿入される。

## 6. ダッシュボードUI（`src/dashboard.js` / `index.html` / `styles.css`）

対象: `#windaxis-chart`（Chart.js line, x=linear epoch ms, y=風向deg）。

- **範囲選択**: canvas 上で水平ドラッグ。ピクセル→ms は `chart.scales.x.getValueForPixel(px)`
  を用い、トラック時間範囲（`from`〜`to`）にクランプ。
- **描画**: Chart.js の `afterDraw` プラグインで
  (a) 既存の `windAxisOverrides` を薄い帯として塗る、
  (b) ドラッグ中の選択矩形を塗る。追加DOMは使わない。
- **確定**: mouseup で最小幅（例: 数px相当かつ数秒以上）を満たせば
  `track.windAxisOverrides` に範囲を追加→正規化→マージ系列で再描画。
- **クリア**:
  - 既存の帯をクリック→その範囲を削除（ms でヒットテスト）。
  - セクションヘッダに「風軸補正をクリア」ボタン→対象トラックの補正を全削除。
- **ヘルプ文言**: 「グラフをドラッグした区間だけで風軸を推定し直します」。
- 空推定になった範囲は帯の色/注記で区別（任意、控えめに）。

`renderWindAxis` は系列生成を `estimateWindAxisSeries` から
`applyWindAxisOverrides(analysisTrack, { marks, overrides: track.windAxisOverrides })`
に置き換える（crop 限定は従来どおり先に適用）。

## 7. 地図・VMGへの反映（`src/app.js` / `src/vmg.js`）

- `recomputeWindAxis`:
  ```
  windSeriesByTrack.set(tr,
    applyWindAxisOverrides(tr, { marks: state.marks, overrides: tr.windAxisOverrides }))
  ```
  → windUp 回転・風軸ストリップ・`minuteWinners`（VMGネオン）へ一経路で反映。
- `unifyWindAxis`（ダッシュボードVMGパネル経路, `app.js` 内）へ渡す `estimator` を
  オーバーライド適用版に差し替え:
  ```
  estimator: (t, o) => applyWindAxisOverrides(t, { ...o, overrides: t.windAxisOverrides })
  ```
  `unifyWindAxis` は `estimator(track, { marks })` を呼ぶため互換。
- **通知**: `createDashboard` に `onWindAxisChange` コールバックを追加。補正の追加/削除時に
  呼び出し、`app.js` 側で `recomputeWindAxis()` + `draw()` を実行（練習画面へ戻った際に反映済み）。

## 8. 永続化（`src/project.js`）

- `serializeProject`: 各トラックに `windAxisOverrides: t.windAxisOverrides ?? []` を追加。
- `deserializeProject`: 各トラックを `{ ...t, windAxisOverrides: arr(t.windAxisOverrides) }` に正規化。
- `PROJECT_VERSION` は**据え置き**（追加的かつ寛容な変更）。旧プロジェクトは `[]`。
- 保存は既存の 💾保存 に同梱（`state.tracks` 内に持つため自動的に含まれる）。

## 9. テスト

`applyWindAxisOverrides`（`test/windaxisoverride.test.js`, node --test）:
- overrides 空 → base と一致（no-op）。
- 範囲内サンプルが分離推定で置換され、範囲外は不変。
- 重なり/隣接範囲がマージされる。
- 範囲内にマニューバなし → その範囲はギャップ（除去のみ）、他は不変。
- トラック時間範囲外の override → no-op。

`project.js` ラウンドトリップ:
- `windAxisOverrides` が serialize→deserialize で保持される。
- 旧形式（フィールドなし）→ `[]`。

ダッシュボードのドラッグ操作/帯描画は手動確認（`renderChart` 同様 DOM 依存のため）。
既存の `parse-smoke` / `html-ids` テストで構造回帰をガード。

## 10. 影響ファイル一覧

- 新規: `src/windaxisoverride.js`, `test/windaxisoverride.test.js`
- 変更: `src/dashboard.js`, `src/app.js`, `src/vmg.js`（推定注入経路は既存・呼び出し側のみ）,
  `src/project.js`, `index.html`, `styles.css`
- 既存テスト追記: `project.js` ラウンドトリップ

## 11. 未決事項 / リスク

- 空推定範囲の視覚表現は控えめな注記に留める（過剰UIを避ける）。
- ダッシュボード対象は先頭可視艇のみ。他艇の補正が必要になった場合は将来拡張
  （範囲選択の場所拡張は別タスク）。
