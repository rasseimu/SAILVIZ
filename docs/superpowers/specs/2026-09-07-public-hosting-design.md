# SailViz 公開ホスティング化 設計書

- 日付: 2026-09-07
- ブランチ: deploy-website
- ステータス: 承認済み（実装計画の作成待ち）

## 1. 背景と目的

現在の SailViz は完全クライアント側の静的サイトである。

- 配信: `python3 serve.py 8000`（静的ファイル）
- 永続化:
  - 練習データ `.sailviz.json` → File System Access API でユーザー選択フォルダに保存（`projectfs.js` / `dirhandle.js`）
  - 進捗・ロードマップ・サマリ → `localStorage`（`sailviz.progress` / `sailviz.roadmap` / サマリキー）
  - 動画 → ローカルフォルダを File System Access API で走査（`folderimport.js` / `videometa.js`）

この構成は Chrome ローカルでのみ完結し、リモートの部員がブラウザからアクセスして同じデータを見ることができない。

**目的**: 部員が URL からアクセスできる公開 Web サイトにする。共有 JSON をバックエンドに集約し、書き込みを認証で限定する。動画配信は現状方式（各自ローカル / Drive 同期フォルダ）を維持する。

## 2. 確定した要件（ブレインストーミング結果）

| 項目 | 決定 |
|------|------|
| ゴール | 公開ホスティング（URL で部員がアクセス） |
| データ/権限 | 部で共有。閲覧はリンクを知る人、**書き込みは認証で限定** |
| 動画配信 | **ローカルのみ**（各自の File System Access。Drive はデスクトップ同期フォルダとして読む。OAuth/API は大学アカウント制約で不可） |
| 構成 | A案: Node/Express 1サーバー（静的配信＋JSON API＋ファイル保存） |
| ホスト | 移植性重視。永続ディスク付き PaaS/VPS 前提、具体サービスは後で選択 |

## 3. 全体構成

今の静的フロントの前に薄い Node/Express サーバーを1つ置き、「静的配信」と「JSON API」を兼ねる。ローカル開発と本番が同一構成になる。

```
ブラウザ
  ├─ 静的: index.html, styles.css, src/, vendor/      ── Express (static)
  └─ /api/... : 練習 / 進捗 / ロードマップ / サマリ    ── Express (JSON API) ── data/ (永続ディスク)
動画: 変更なし（各自ローカル / Drive 同期フォルダを File System Access API で読む）
```

- 保管形式は不変: `.sailviz.json`（`project.js` の `serializeProject` / `deserializeProject` を流用）。
- サーバー上の配置:
  - `data/projects/*.sailviz.json` — 練習ごと
  - `data/progress.json` / `data/roadmap.json` / `data/summary.json` — 共有オーバーレイ（単一ドキュメント）
- 動画はサーバーに置かない。動画URLは従来どおり一時 blob URL で、直列化から除外される（現状の挙動を維持）。

## 4. コンポーネントと境界

### サーバー側（新規 `server/`）
- `server/index.js` — Express 本体。静的配信、`/api` ルート結線、認証ミドルウェアの適用、環境変数（`PORT` / `SAILVIZ_WRITE_TOKEN` / `DATA_DIR`）の読み取り。
- `server/storage.js` — `data/` 配下のファイル CRUD。baseDir を引数注入し、`projectfs.js` と同様にフェイク/一時ディレクトリでテスト可能な純寄りロジックにする。
  - `listProjects()` / `readProject(id)` / `writeProject(id, obj)` / `deleteProject(id)`
  - `readOverlay(name)` / `writeOverlay(name, obj)`（name ∈ {progress, roadmap, summary}）
  - id/ファイル名の検証（パストラバーサル防止: `.sailviz.json` 拡張子と安全な文字のみ許可）。
- `server/auth.js` — 書き込みトークン検証ミドルウェア。`Authorization: Bearer <token>` またはセッション Cookie を検証。読込ルートには適用しない。

### フロント側
- `src/api.js`（新規）— fetch ラッパ。ブラウザAPI以外に依存しない薄い層。
  - `listProjects()` / `getProject(id)` / `saveProject(id, obj)` / `deleteProject(id)`
  - `getOverlay(name)` / `saveOverlay(name, obj)`
  - `unlock(password)` → トークン/Cookie 取得、`isUnlocked()`, `lock()`
- 既存改修（**保存先の差し替えのみ**。集計・計算の純関数は不変）:
  - `progressstore.js` / `roadmapstore.js` — `loadX`/`saveX` の内部を `localStorage` から `src/api.js` 経由に変更（インターフェースは可能な限り維持し、非同期化する）。
  - `summary.js` — サマリの読み書きを API 経由に変更。
  - `app.js` — 起動時に `src/api.js` からデータ取得。保存フロー（練習保存/反省編集/進捗トグル）を API 呼び出しへ。編集モードのロック状態に応じて書き込みUIを出し分け。

### 維持（無改修）
- `folderimport.js` / `videometa.js` / 動画関連の `dirhandle.js` 利用 — 動画のローカル走査は現状維持。
- `project.js`（直列化）、GPS/投影/補間/時間軸などの純ロジックとそのテスト。

## 5. データの流れ

- 読込: `GET /api/projects` → 一覧 → 選択 → `GET /api/projects/:id` → 既存 `deserializeProject` で描画（state の形は不変）。
- 保存（要認証）: 編集 → `PUT /api/projects/:id`（直列化 JSON）→ サーバーがファイル書き込み。
- オーバーレイ: 起動時 `GET /api/overlays/:name`、トグル時 `PUT /api/overlays/:name`（要認証）。
- 進捗・ロードマップ・サマリは端末バラバラの localStorage からサーバー共有へ移動（部で同じ状態を見るため必須）。

## 6. 認証（書き込み限定）

- 共有パスワード 1 つ（名前付きアカウントは作らない = YAGNI）。
- フロー: 「編集モード」でパスワード入力 → `unlock(password)` → サーバーが `SAILVIZ_WRITE_TOKEN` と照合 → セッション Cookie（HttpOnly）またはトークンを発行 → 書き込みボタン解禁。
- 未認証は完全に閲覧専用（書き込みUIを非表示 or 無効化。サーバー側でも 401 で拒否 = 二重防御）。
- 読込は誰でも可（リンクを知る人）。

## 7. エラー処理

- ステータス: 未認証の書き込み → 401、存在しない id → 404、不正な id/本文 → 400。
- 上書きガード（任意・軽量）: リクエストに既知 `savedAt` を含め、サーバー側の `savedAt` と食い違えば 409。競合時はクライアントで再取得を促す。基本方針は last-write-wins。
- フロント: API 失敗はトースト表示し、書き込み系は閲覧専用へフォールバック。
- パストラバーサル/不正ファイル名はストレージ層で拒否。

## 8. 既存データの移行

現在ローカル（localStorage と選択フォルダ）にある既存データをサーバーに載せる一度きりの取込を用意する。

- `.sailviz.json`（練習）: `data/projects/` に配置する CLI スクリプト（`server/import.js` 等、フォルダを指定してコピー・検証）。
- 進捗/ロードマップ/サマリ: 現行サイトから localStorage の値を書き出し（エクスポートボタン or 手動）→ `data/{progress,roadmap,summary}.json` に配置、または認証付きインポート画面から投入。
- 移行は開発者が一度実行する運用手順としてドキュメント化する。

## 9. デプロイ / ローカル開発

- 起動: `node server/index.js`。環境変数:
  - `PORT`（既定 8000）
  - `SAILVIZ_WRITE_TOKEN`（書き込みパスワード/トークン。未設定なら書き込み禁止 or 起動時警告）
  - `DATA_DIR`（既定 `./data`。本番は永続ディスクをマウント）
- `package.json` の `serve` を python から node サーバーに変更（dev = prod）。
- `Dockerfile` を添え、Render / Fly / Railway / VPS のいずれにも載せられる移植性を確保。
- `.gitignore` に `data/` を追加（運用データをコミットしない）。

## 10. テスト

- `node --test` を継続。
- 新規: `server/storage.js`（一時ディレクトリ注入で CRUD・id 検証・パストラバーサル拒否）、`server/auth.js`（トークン一致/不一致）。
- `src/api.js` は fetch モックで基本経路をテスト。
- 既存の純ロジックテスト（パース/投影/補間/時間軸/VMG/風軸等）は無改修で維持。

## 11. スコープ外（YAGNI）

- 名前付きアカウント / 役割別権限
- 動画のサーバー配信・アップロード
- リアルタイム同時編集（CRDT/WebSocket）
- オフライン書き込みキューと同期
- 監査ログ / 変更履歴

## 12. リスクと留意点

- 永続ディスクが無いホスト（純静的/一部サーバーレス）ではファイル保存が消える。デプロイ時に永続ボリュームの確認が必須。
- 共有パスワード 1 つのため、漏れると誰でも書ける。HTTPS 必須・トークンは env 管理・必要なら定期ローテーション。
- File System Access API は Chrome 系限定。動画機能は従来どおりブラウザ依存が残る（本件では変更しない）。
