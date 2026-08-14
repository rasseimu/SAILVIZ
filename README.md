# SailViz — GPS軌跡ビューア（モック）

セーリング練習のGPSログ（Sensor Logger形式CSV）を、ブラウザ上で
選択・時間クロップ・時系列再生し、別のGPS軌跡やタグを重ねて可視化する
完全クライアント側の静的モックサイト。実地図タイル・DBなし。

## 使い方
```bash
python3 -m http.server 8000
# ブラウザで http://localhost:8000/
```
`sample-data/` のCSVをステージにドラッグ&ドロップ。

- 再生: ▶ / 速度 1〜8x / タイムライン中央ドラッグでスクラブ
- クロップ: タイムライン左右ハンドル
- 重ね合わせ: 複数CSVを読み込む（色分け・表示切替・削除）
- 整列: 絶対時刻 / 経過時間
- タグ: `time,label[,lat,lon]`（点） or `start,end,label`（区間）のCSV

## CSV形式
- GPS: Sensor Logger 形式（`time`(ns), `latitude`, `longitude`, 任意 `speed,bearing,horizontalAccuracy`）
- 外れ値（>25 m/s）は自動除去。精度フィルタは任意（ヘッダーのチェック）。

## テスト
```bash
node --test
```
純粋ロジック（パース/投影/補間/時間軸）を単体テスト。描画/操作は手動確認。

## 設計資料
`docs/2026-08-14-gps-track-viewer-design.md`、`docs/ヨット練習最適化_ハッカソン提案.md`
