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

### デプロイ（Fly.io）

本番は [Fly.io](https://fly.io/) にデプロイします。設定は `fly.toml`（app `sailviz-sit`、東京リージョン `nrt`）に定義済み。Dockerfile からイメージがビルドされます。

#### 1. Fly 実行環境の構築（初回のみ）

`fly deploy` は Fly CLI（`flyctl`）とログイン済みアカウント、そして対象 app・ボリューム・Secret が揃っていないとエラーになります。初回は以下を順に実行します。

```bash
# (1) Fly CLI (flyctl) をインストール
#   macOS (Homebrew)
brew install flyctl
#   macOS/Linux (スクリプト)
#   curl -L https://fly.io/install.sh | sh
#   Windows (PowerShell)
#   pwsh -Command "iwr https://fly.io/install.sh -useb | iex"

# (2) バージョン確認（コマンドが通ることの確認）
fly version

# (3) ログイン（ブラウザが開く。無ければ表示URLを開く）
fly auth login

# (4) app の用意
#   このリポジトリの fly.toml には app = "sailviz-sit" が定義済み。
#   自分のアカウントに同名 app が無い場合は作成する（既にあれば不要）。
fly apps list                 # sailviz-sit があるか確認
fly apps create sailviz-sit   # 無ければ作成（app 名は全 Fly で一意。使用済みなら fly.toml も変更）

# (5) 練習JSON/オーバーレイ用の永続ボリューム（fly.toml の [mounts] source と一致させる）
fly volumes create sailviz_data --region nrt --size 1 --app sailviz-sit

# (6) 書き込み認証パスワードを Secret として登録（イメージには焼き込まない）
fly secrets set SAILVIZ_WRITE_TOKEN=<secret-password> --app sailviz-sit
```

#### 2. デプロイ

環境が整ったらリポジトリ直下で：
```bash
fly deploy
```
デプロイ状況は https://fly.io/apps/sailviz-sit/monitoring で確認できます。公開URLは https://sailviz-sit.fly.dev/ 。

初回にエラーが出る主な原因：
- `flyctl` 未インストール／未ログイン（→ 手順1の(1)(3)）
- app が存在しない、または app 名が他ユーザーと重複（→ (4)。重複時は `fly.toml` の `app` を変更）
- ボリューム `sailviz_data` 未作成（`[mounts]` があるとマシン起動に必須。→ (5)）

補足：
- `NODE_ENV=production`・`PORT`・`DATA_DIR` は `fly.toml` の `[env]` で設定済み。認証 Cookie に `Secure` 属性が付き、HTTPS 前提で安全になります
- HTTPS は `force_https = true` で強制。TLS は Fly が終端します
- 永続データは `[mounts]` により `/data`（ボリューム `sailviz_data`）にマウント。1台構成で単一書き込み・last-write-wins
- アクセスが無ければマシンを休止（`auto_stop_machines`）し、次アクセスで自動起動してコスト削減
- `SAILVIZ_WRITE_TOKEN` は `fly secrets` で管理（未設定だと書き込み禁止）

### データ移行
既存のプロジェクトフォルダを Fly のボリュームへ移行する場合は、`fly ssh console` でマシンに入り `/data` を取込先に指定します：
```bash
# ローカルで取込先を ./data とする場合（開発環境）
# 取込先データディレクトリは第2引数で指定（既定は ./data）
npm run import -- <既存フォルダ> ./data

# Fly 上のボリューム(/data)へ取り込む例：
#   fly ssh console でマシンに入り、対象フォルダを転送してから
npm run import -- <既存フォルダ> /data
```

注：`import` コマンドは `DATA_DIR` 環境変数を見ず、取込先は第2引数で決まります。

### 認証・動画
- **閲覧**：誰でも可（パスワード不要）
- **書き込み**：編集モード（ロードマップ編集など）時にパスワード入力
- **動画**：各自のローカル/Google Drive 同期フォルダを選択（サーバーには置かない）

## 設計資料
`docs/2026-08-14-gps-track-viewer-design.md`、`docs/ヨット練習最適化_ハッカソン提案.md`
