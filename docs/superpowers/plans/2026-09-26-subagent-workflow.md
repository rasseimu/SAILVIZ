# Claude Code subagent 開発フロー整備 Implementation Plan

**Goal:** GitHub Issue 対応を「計画 → 実装・テスト → レビュー → ブラウザ確認」に分業する4種の subagent と、共通ルール(`CLAUDE.md`)・引き継ぎ手順書を整備し、サンプル Issue で一連のフローを検証する。

**Epic:** #38(子Issue: #39〜#45)

**Branch:** `feature/38-subagent-dev-flow`(Issue #38 に紐付け済み)

## 成果物

- `CLAUDE.md`
- `.claude/agents/implementation-planner.md`
- `.claude/agents/implementation-engineer.md`
- `.claude/agents/code-reviewer.md`
- `.claude/agents/web-verifier.md`
- `docs/development/subagent-workflow.md`
- `test/agents-config.test.js`(提案・未決定)

## 現状(2026-09-26 時点)

- `CLAUDE.md`、`.claude/agents/`、`docs/development/` はいずれも未作成。
- 構成: バニラ ESM(`src/`、ビルドなし)+ 依存ゼロ Node サーバー(`server/index.js`)。
- テスト: `npm test`(= `node --test`)で 584 件すべて pass。
- ローカル起動: `SAILVIZ_WRITE_TOKEN=test npm start` → `http://localhost:8000/`。閲覧ゲート・Gemini は環境変数で切替。
- `server/index.js` に閲覧用パスワードの既定値が直書きされている(#35 の対象)。`CLAUDE.md` 等へその値を転記しない。

## Global Constraints

- planner・reviewer・web-verifier はファイルを変更しない。コードを変更できるのは implementation-engineer のみ。
- commit・push・Issue 更新・デプロイは subagent に自動実行させない。
- 本番環境(`sailviz-sit.fly.dev`)や実データへアクセスしない。
- 認証情報を画面・ログ・スクリーンショット・ドキュメントへ残さない。
- レビュー → 修正のループは最大2回。2回修正しても P0/P1 が残る場合はメイン agent へ判断を返す。
- コミットは子 Issue ごとに1つ。Conventional Commits + 日本語要約(既存履歴に倣う)。

## Tasks

### Task 1: #39 CLAUDE.md(共通ルール)

- [ ] プロジェクト概要: GPS・反省・動画・AI コメントの関係、`src/`(フロント)と `server/`(API・静的配信)の構成、`DATA_DIR` への JSON 保存、動画はローカル選択でサーバーに置かないこと。
- [ ] 開発コマンド: 全テスト `npm test`、対象テスト `node --test test/xxx.test.js`、起動方法(bash と PowerShell の両方)、開発用認証情報はダミー値を env で渡す旨のみ記載。
- [ ] 実装ルール: 後方互換性の維持、GPS 推定値を実測値として表示しない、既存のユーザー変更を上書きしない、無関係なリファクタリングをしない、新ロジックに単体テストを追加する、個人情報をテストデータやログへ残さない。
- [ ] Git・subagent 運用ルール: `git reset --hard`・force push 禁止、未コミット変更を破棄しない、指示なしの commit・push・デプロイ禁止、読み取り専用 agent の明記、web-verifier は UI 変更時のみ、ループ上限2回、小さな1ファイル修正では subagent を使わない。
- [ ] subagent を使う/使わない条件を要約し、詳細は `docs/development/subagent-workflow.md` へリンクする。
- [ ] 記載したコマンドを実際に実行して動作を確認する。

### Task 2: #40 implementation-planner

- [ ] `tools: Read, Grep, Glob`(読み取り専用)。
- [ ] 出力7項目を固定: 要求の理解 / 現状調査 / 実装方針 / 変更予定ファイル / テスト計画 / ブラウザ確認項目 / リスク・未確定事項。
- [ ] 不明な仕様は推測で確定せず「未確定事項」へ出す。既存実装との重複確認と UI 変更有無の判定を必須とする。

### Task 3: #41 implementation-engineer

- [ ] `tools: Read, Grep, Glob, Edit, Write, Bash`。
- [ ] 入力は planner の7項目。出力5項目: 実装内容 / 変更ファイル / 実行したテストと結果 / 未確認事項 / reviewer への注意点。UI 変更時は「web-verifier 向け確認項目」を追加。
- [ ] 禁止事項を明記: 無関係なリファクタ、テストを通すためのハードコード、理由のない既存テスト削除、未コミット変更の破棄、`reset --hard`・force push、指示なしの commit・push・デプロイ、本番データ変更、認証情報の埋め込み。
- [ ] `isolation: worktree` は常時付与せず、メイン agent が必要時に指定する(`.gitignore` に `.worktrees/` あり)。

### Task 4: #42 code-reviewer

- [ ] 重要度 P0〜P3 の定義と確認観点(受け入れ条件との照合、境界値・空データ・GPS 欠損、旧プロジェクト読込、反省・進捗データの互換性、認証回避・個人情報ログ、秘密情報の埋め込み、テストの十分性)。
- [ ] 各指摘に 重要度 / 要約 / ファイルと行 / 発生条件 / 利用者への影響 / 修正方針 を含める。問題なしの場合も確認範囲と未確認事項を報告。
- [ ] 権限(未決定・推奨案): `tools: Read, Grep, Glob, Bash` とし、frontmatter の PreToolUse フックで `git diff` / `git log` / `git show` / `git status` / `node --test` 以外の Bash を拒否する。代替案は Bash なし(差分は engineer から受け取る)。

### Task 5: #43 web-verifier

- [ ] tools は Read と Claude in Chrome の MCP ツールのみ(Edit・Write・Bash なし)。
- [ ] 手順ごとに 期待結果 / 実際の結果 / PASS・FAIL を報告。デスクトップ幅とモバイル幅、コンソールエラーを確認。
- [ ] 制約: localhost のみ(明示時を除く)、削除・送信など不可逆操作をしない、パスワードや個人情報を画像・ログに残さない。
- [ ] MCP サーバー名・ツール名は Chrome 連携済みのローカルセッションで `/mcp` を実行して確定する。

### Task 6: #44 docs/development/subagent-workflow.md

- [ ] 標準フロー7段階。
- [ ] 引き継ぎテンプレート3種: planner→engineer、engineer→reviewer、engineer→web-verifier。
- [ ] 重要度の統一定義(P0〜P3)、ループ上限、subagent を使わない条件、web-verifier を使う条件。
- [ ] `CLAUDE.md` からリンクする。

### Task 7: 設定検証テスト(提案・未決定)

- [ ] `test/agents-config.test.js` で `.claude/agents/*.md` の frontmatter を検査する。
  - 4 agent が存在し、`name`・`description` を持つ。
  - planner / reviewer / web-verifier の `tools` に Edit・Write が含まれない。
- [ ] Epic 完了条件「reviewer と web-verifier がファイルを変更しない」を `npm test` で継続的に担保する。

### Task 8: #45 E2E 検証

- [ ] サンプル課題(推奨): 入力エラー表示へ `aria-live` を追加する。
- [ ] planner → engineer → reviewer → web-verifier を実際に実行し、#45 の確認項目を記録する。
- [ ] web-verifier の工程は Chrome 連携のあるローカル環境で実施する。
- [ ] 発見した改善点を `docs/development/subagent-workflow.md` へ反映する。

## 未決定事項

1. code-reviewer の Bash 権限: フックで許可コマンドを限定する(推奨)か、Bash なしにするか。
2. Task 7 の設定検証テストを追加するか。

## Review Focus

- **読み取り専用 agent の権限漏れ** — planner / reviewer / web-verifier の `tools` に Edit・Write が含まれていないか。
- **認証情報の転記** — `CLAUDE.md` や workflow 文書に実パスワード・トークンが書かれていないか。
- **コマンドの実在性** — `CLAUDE.md` の起動・テストコマンドが Windows(PowerShell)と bash の両方で動くか。
- **引き継ぎ項目の整合** — planner の出力項目と engineer の入力、engineer の出力と reviewer / web-verifier の入力が一致しているか。
