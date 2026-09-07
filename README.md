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

## 起動・デプロイ

本番・開発環境は Node サーバー（`server/index.js`）で起動します。

### ローカル開発
```bash
SAILVIZ_WRITE_TOKEN=test npm start
# ブラウザで http://localhost:8000/
```

環境変数：
- `PORT`（デフォルト 8000）：バインドポート
- `DATA_DIR`（デフォルト `./data`）：プロジェクトデータ保存先
- `SAILVIZ_WRITE_TOKEN`：書き込み認証用パスワード（未設定で書き込み禁止）

### デプロイ
```bash
docker build -t sailviz .
docker run -it -p 8000:8000 \
  -e NODE_ENV=production \
  -e SAILVIZ_WRITE_TOKEN=<secret-password> \
  -v /persistent/data:/data \
  sailviz
```

- `NODE_ENV=production` を設定すると認証 Cookie に `Secure` 属性が付き、HTTPS 前提で安全になります
- 永続ボリュームを `/data` にマウント
- `SAILVIZ_WRITE_TOKEN` は秘密管理ツールで設定
- 本番環境は HTTPS 前提（リバースプロキシ経由）

### データ移行
既存のプロジェクトフォルダを新インスタンスに移行：
```bash
# 取込先データディレクトリは第2引数で指定（既定は ./data）
npm run import -- <既存フォルダ> ./data
# 永続ボリュームへ取り込む場合は第2引数にそのパスを渡す
npm run import -- <既存フォルダ> /persistent/data
```

注：`import` コマンドは `DATA_DIR` 環境変数を見ず、取込先は第2引数で決まります。

### 認証・動画
- **閲覧**：誰でも可（パスワード不要）
- **書き込み**：編集モード（ロードマップ編集など）時にパスワード入力
- **動画**：各自のローカル/Google Drive 同期フォルダを選択（サーバーには置かない）

## 設計資料
`docs/2026-08-14-gps-track-viewer-design.md`、`docs/ヨット練習最適化_ハッカソン提案.md`
