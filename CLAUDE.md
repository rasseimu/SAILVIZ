# SailViz — Claude Code 共通ルール

## プロジェクト概要

セーリング練習の振り返り Web アプリ。GPS 軌跡・反省(振り返り)・動画・AI コメントを練習単位で結び付けて扱う。

- **GPS**: Sensor Logger 形式 CSV を読み込み、軌跡の再生・クロップ・重ね合わせ・風軸推定・VMG 比較を行う。
- **反省**: 練習ごとの振り返り・進捗・ロードマップ・議事録を記録する。
- **動画**: 各自のローカル / Google Drive 同期フォルダから選択して GPS と同期再生する。**動画はサーバーに置かない。**
- **AI コメント**: 反省ノートと参考文献(風速帯ノート・チーム履歴を含む)を Gemini で照合し、出典付きコメント案を生成する(キーはサーバー環境変数 `GEMINI_API_KEY` に隠す)。

構成:

- `src/` — フロントエンド(バニラ ESM、ビルドなし)。`index.html` / `minutes.html` から読み込む。
- `server/` — 依存ゼロの Node HTTP サーバー。`/api` と静的ファイル配信を兼ねる(`server/index.js`)。
- データは `DATA_DIR`(既定 `./data`)に JSON で保存する(`server/storage.js`)。
- `test/` — `node:test` による単体テスト。

### 認証の現状(README ではなく `server/index.js` / `server/api.js` の実装を正とする)

- **書込**: `SAILVIZ_WRITE_TOKEN` が未設定なら書込 API は禁止。
- **閲覧**: `SAILVIZ_VIEW_USER` / `SAILVIZ_VIEW_PASSWORD` が未設定でも、`server/index.js` 内の既定資格情報により**閲覧ゲートは有効**になる。README の「閲覧は誰でも可」は現状と一致しない(既定資格情報の廃止は #35 で扱う)。
- 既定資格情報の値をドキュメント・ログ・テストデータへ転記しない。ローカル起動時は必ず下記のダミー値で上書きする。

## 開発コマンド

```bash
npm test                          # 全テスト(= node --test)
node --test test/xxx.test.js      # 対象テストのみ
```

ローカル起動(資格情報はすべてダミー値。`DATA_DIR` はリポジトリ外の一時ディレクトリ):

bash:

```bash
SAILVIZ_WRITE_TOKEN=dummy-write SAILVIZ_VIEW_USER=dummy-user SAILVIZ_VIEW_PASSWORD=dummy-pass DATA_DIR="${TMPDIR:-/tmp}/sailviz-e2e" npm start
```

PowerShell:

```powershell
$env:SAILVIZ_WRITE_TOKEN='dummy-write'; $env:SAILVIZ_VIEW_USER='dummy-user'; $env:SAILVIZ_VIEW_PASSWORD='dummy-pass'; $env:DATA_DIR=(Join-Path $env:TEMP 'sailviz-e2e'); npm start
```

- URL は `http://localhost:8000/`(`PORT` で変更可)。起動ログに `view-gate=on` と表示される。
- `GEMINI_API_KEY` は設定しない(AI 機能はローカル確認の対象外)。
- PowerShell の `$env:` 設定はそのシェルに残るため、確認後はシェルを閉じるか変数を削除する。

## 実装ルール

- 後方互換性を維持する。旧形式のプロジェクト・反省・進捗データを読み込めなくしない。
- GPS から推定した値(風向・風軸など)を実測値として表示しない。推定であることが分かる表示にする。
- 既存のユーザー変更(未コミット変更・利用者の編集内容)を上書きしない。
- 依頼範囲と無関係なリファクタリングをしない。
- 新しいロジックには単体テストを追加する。
- 個人情報(氏名・位置情報の実データ・資格情報)をテストデータやログへ残さない。

## Git・subagent 運用ルール

- `git reset --hard`・force push をしない。未コミット変更を破棄しない。
- 利用者の指示なしに commit・push・デプロイ・Issue 更新をしない。subagent には自動実行させない。
- 本番環境(`sailviz-sit.fly.dev`)や実データへアクセスしない。
- **読み取り専用 agent**: `implementation-planner`・`code-reviewer`・`web-verifier` はファイルを変更しない。コードを変更できるのは `implementation-engineer` のみ。
- **worktree を使わない**。engineer は現在の feature ブランチの作業ツリーで直接作業する。
- `web-verifier` は UI 変更がある場合のみ使う。
- レビュー → 修正のループは最大2回。2回修正しても P0/P1 が残る場合はメイン agent が判断する(必要なら利用者へ確認)。

### subagent を使う / 使わない

- **使う**: GitHub Issue 対応など、計画・実装・レビューを分けた方が確実な変更。標準フローは「Issue 読取 → 計画 → メイン agent の承認 → 実装・テスト → レビュー → (UI 変更時)ブラウザ確認 → まとめ」。
- **使わない**: 誤字修正、1ファイル数行の自明な修正、質問への回答、調査のみの作業。
- **例外**: 明示的な subagent フロー検証、または利用者が subagent 実行を指定した場合は、小規模変更でも全工程を実行する。

詳細(引き継ぎ情報・重要度定義・読み取り専用性の確認手順)は [`docs/development/subagent-workflow.md`](docs/development/subagent-workflow.md) を参照。
