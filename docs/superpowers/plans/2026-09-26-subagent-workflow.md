# Claude Code subagent 開発フロー整備 Implementation Plan

**Goal:** GitHub Issue 対応を「計画 → 承認 → 実装・テスト → レビュー → ブラウザ確認」に分業する4種の subagent と、共通ルール(`CLAUDE.md`)・引き継ぎ手順書を整備し、サンプル Issue で一連のフローを検証する。

**Epic:** #38(子Issue: #39〜#45)

**Branch:** `feature/38-subagent-dev-flow`(Issue #38 に紐付け済み)

## 成果物

- `CLAUDE.md`
- `.claude/agents/implementation-planner.md`
- `.claude/agents/implementation-engineer.md`
- `.claude/agents/code-reviewer.md`
- `.claude/agents/web-verifier.md`
- `docs/development/subagent-workflow.md`
- `test/agents-config.test.js`

## 現状(2026-09-26 時点)

- 構成: バニラ ESM(`src/`、ビルドなし)+ 依存ゼロ Node サーバー(`server/index.js`)。
- Task 0〜7: **実装済み**(成果物はすべてコミット済み。作業ツリーは clean)。
  - `CLAUDE.md`(#39)・4 agent(#40〜#43)・workflow 文書(#44)・`test/agents-config.test.js`(Refs #38)。
  - テスト: `npm test`(= `node --test`)で 600 件すべて pass(着手前の 584 件 + 設定検証 16 件)。
  - ダミー資格情報での起動、`http://localhost:8000/` の HTTP 200、`/api/session` が閲覧ゲート有効・未ログイン状態を返すことを確認済み。
- **実行時確認待ち:** 各 agent が実際に起動し、定義どおりのツールで動作すること(特に web-verifier の Chrome ツール個別列挙)は Task 8 で確認する。
- 認証の実装上の現状(README ではなくコードを正とする):
  - 書込は `SAILVIZ_WRITE_TOKEN` 未設定なら禁止。
  - 閲覧ゲートは `SAILVIZ_VIEW_USER` / `SAILVIZ_VIEW_PASSWORD` が未設定でも、`server/index.js` 内の既定資格情報で**有効**になる(README の「閲覧は誰でも可」は現状と不一致。既定資格情報の廃止は #35 の対象)。
  - `CLAUDE.md` や workflow 文書へ既定資格情報の値を転記しない。
- Claude in Chrome: 別の PowerShell で実行した `claude mcp list` には表示されないが、これは普段使っている Claude Code セッションが未接続であることを意味しない(Chrome 連携は起動中のセッションに動的に構成される)。接続状態とツール名は Task 0 で、現在利用しているセッションから確定する。
- 親子関係: GitHub ネイティブの sub-issue 関係は未設定。#38 のチェックリストと各子 Issue のコメントによる論理的な親子関係のみ(実装の阻害要因ではない)。

## Global Constraints

- planner・reviewer・web-verifier はファイルを変更しない。コードを変更できるのは implementation-engineer のみ。
  - **bootstrap 例外:** Task 1〜7(CLAUDE.md・agent 定義・workflow 文書・設定検証テストの作成)は、engineer 自体がまだ存在しないため、メイン agent が直接作成・編集する。Task 8 以降は上記ルールに従う。
- commit・push・Issue 更新・デプロイは subagent に自動実行させない。
- 本番環境(`sailviz-sit.fly.dev`)や実データへアクセスしない。
- 認証情報を画面・ログ・スクリーンショット・ドキュメントへ残さない。ローカル起動時は書込・閲覧の資格情報をすべてダミー値で上書きする。
- レビュー → 修正のループは最大2回。2回修正しても P0/P1 が残る場合はメイン agent へ判断を返す。
- **worktree は使わない。** フローは逐次実行で、engineer は現在の feature ブランチの作業ツリーで直接作業する(理由は「設計判断」参照)。
- コミットは原則、子 Issue 単位(#39〜#44 の初回実装はそれぞれ別コミット)。後続の修正で複数 Issue の成果物をまとめて直す場合は、1コミットに `Refs` を列挙してよい。Task 7 の設定検証テストは Epic 単位(`Refs #38`)。Conventional Commits + 日本語要約(既存履歴に倣う)。
- Chrome 前提(Task 0 または Task 8 のゲート)を満たせない場合は Task 8 を停止し、#45 と Epic #38 を「未完了・前提条件待ち」として報告する。Chrome 確認を未実施のまま完了扱いにしない。

## 設計判断

### D1: worktree を使わない

Claude Code の `isolation: worktree` は既定で `.claude/worktrees/` に作成され、基点はリポジトリの既定ブランチ(`main`)になる。このため、engineer が現在の feature ブランチの途中成果や新しい agent 定義を含まない状態で起動しうる。また `.claude/worktrees/` は現在 `.gitignore` 対象外(ignore 済みの `.worktrees/` とは別)。

本フローは planner → engineer → reviewer を逐次実行し並列編集がないため、worktree の利点が小さい。engineer の frontmatter に `isolation` を付けず、CLAUDE.md と workflow 文書にも「worktree を使わない」と明記する。

将来使う場合は、次の3点を同時に整備することを workflow 文書に記録しておく:
- `.gitignore` に `.claude/worktrees/` を追加する。
- `worktree.baseRef: head` を設定するか、現在 HEAD を基点にする手順を明示する。
- worktree 上の変更を feature ブランチへ戻す手順を定める。

### D2: code-reviewer に Bash を与えない

Bash を与えると、フックでの制限にはクロスプラットフォームのコマンド検査スクリプトとそのテストが必要になり、成果物と保守対象が増える。reviewer は `tools: Read, Grep, Glob` とし、差分(`git diff` の出力)とテスト結果はメイン agent が取得して引き継ぎ情報として渡す。

### D3: 読み取り専用は「静的検査 + 実行前後の差分検査」の二重で担保する

- 静的検査: `test/agents-config.test.js`(Task 7)で frontmatter の `tools`・`hooks`・MCP ツール指定を検査する。
- 実行時検査: メイン agent が planner / reviewer / web-verifier の実行前後に `git status --porcelain` と `git diff` を取得して比較し、変化があれば FAIL として扱う。

### D4: 引き継ぎ情報の組み立て責任はメイン agent が持つ

subagent 同士は直接やり取りしない。各 subagent の出力で不足する情報(元 Issue、承認済み計画、実際の差分、起動コマンドなど)は、メイン agent が補って次の subagent へ渡す。

## 標準フロー(親 Issue #38 に合わせた正規フロー)

1. メイン agent が GitHub Issue を読み取る。
2. implementation-planner が実装計画を作る。
3. **メイン agent が計画を確認・承認する**(未確定事項があれば利用者へ確認する)。
4. implementation-engineer が実装し、テストを実行する。
5. code-reviewer が差分をレビューする。
6. P0/P1 があれば engineer が修正し、再レビューする(最大2回)。
7. UI 変更がある場合、web-verifier が Chrome で確認する。
8. メイン agent が最終結果をまとめる。

子 Issue #44 の7段階は、このフローの工程3(承認)を含む形に合わせて文書化する。

## 引き継ぎ情報(メイン agent が組み立てて渡す)

### planner → engineer(工程3の承認後)

- 元 Issue(番号・本文・受け入れ条件)
- 承認済みの実装計画(planner 出力7項目と、承認時の決定事項)

### engineer → reviewer

- 元 Issue
- 承認済みの実装計画
- 実際の差分(メイン agent が `git diff` で取得)
- 実行したテストと結果
- 未確認事項
- 重点レビュー箇所

### engineer → web-verifier

- ローカル URL(`http://localhost:8000/`)
- 起動コマンドと必要な環境変数(値はダミー)
- 使用するダミーテストデータ
- 操作手順と期待結果
- 確認する画面幅(デスクトップ・モバイル)
- 操作してはいけない環境(本番 URL など)

engineer は自分が知りうる項目(テスト結果、確認手順、期待結果)を出力し、残りはメイン agent が補う。

## ローカル起動(ダミー資格情報)

bash:

```bash
SAILVIZ_WRITE_TOKEN=dummy-write SAILVIZ_VIEW_USER=dummy-user SAILVIZ_VIEW_PASSWORD=dummy-pass DATA_DIR="${TMPDIR:-/tmp}/sailviz-e2e" npm start
```

PowerShell:

```powershell
$env:SAILVIZ_WRITE_TOKEN='dummy-write'; $env:SAILVIZ_VIEW_USER='dummy-user'; $env:SAILVIZ_VIEW_PASSWORD='dummy-pass'; $env:DATA_DIR=(Join-Path $env:TEMP 'sailviz-e2e'); npm start
```

- `DATA_DIR` はリポジトリ外の OS 一時ディレクトリ(`sailviz-e2e`)に固定する。既存の `./data` を汚さず、`.gitignore` の変更も不要。ディレクトリはサーバーが必要時に作成する(`server/storage.js` の `ensureDir`)。
- `GEMINI_API_KEY` は設定しない(AI 機能は E2E の対象外)。

## Tasks

### Task 0: Chrome 事前確認(利用者のローカル環境で実施)

Task 5・Task 7 で web-verifier のツールを確定するため、最初に実施する。

- [x] 現在利用している Claude Code セッション(CLI・VS Code 版のいずれも可)で、`/mcp` に Claude in Chrome のサーバーが connected と表示され、Chrome ツールが使えることを確認する。
  - Chrome 連携が既定で有効なら通常の `claude` 起動で使える。VS Code 版は拡張機能が入っていれば追加フラグ不要。
  - 別シェルの `claude mcp list` に表示されないことは、未接続の根拠にしない。
- [x] `/mcp` で Chrome の MCP サーバー名とツール名を記録し、この計画書の「Task 0 の確認結果」へ追記する。
- [ ] **フォールバック(Chrome ツールが見えない場合のみ):** `/chrome` で接続状態を確認・再設定するか、Chrome 連携が未有効の CLI セッションでは `claude --chrome` で明示的に有効化する。
- [ ] それでも確認できない場合は Task 5 以降に進まず、#43・#45・Epic #38 を「前提条件待ち」として報告する(Task 1〜4 は先行してよい)。

#### Task 0 の確認結果

- 確認日: 2026-09-26(利用者のローカル環境、`/mcp` の表示で確認)
- MCP サーバー名: `claude-in-chrome`(Status: connected、Config: Dynamically configured、22 tools)
- 公開ツール(22): `javascript_tool` / `read_page` / `find` / `form_input` / `computer` / `browser_batch` / `navigate` / `resize_window` / `gif_creator` / `upload_image` / `get_page_text` / `tabs_context` / `tabs_create` / `tabs_close` / `read_console_messages` / `read_network_requests` / `shortcuts_list` / `shortcuts_execute` / `file_upload` / `switch_browser` / `list_connected_browsers` / `select_browser`
- web-verifier に許可するツール(10): `tabs_context` / `tabs_create` / `navigate` / `computer` / `read_page` / `find` / `get_page_text` / `form_input` / `resize_window` / `read_console_messages`
- 除外したツールと理由:
  - `javascript_tool` — 任意の JS でページ状態や保存データを変更できるため。
  - `browser_batch` — 複数ツールをまとめて呼ぶため、除外ツールの迂回口になりうる。
  - `gif_creator` / `upload_image` / `file_upload` — ファイルの生成・送信を伴うため。
  - `read_network_requests` — 認証ヘッダ等の資格情報が出力に残るおそれがあるため。
  - `shortcuts_list` / `shortcuts_execute` — 拡張のショートカットによる任意操作のため。
  - `tabs_close` / `switch_browser` / `list_connected_browsers` / `select_browser` — 利用者のタブ・別ブラウザを操作しうるため、検証に不要。
- web-verifier の `tools` 指定方式: **ツール名の個別列挙**(`mcp__claude-in-chrome__<ツール名>`)。サーバー単位の `mcp__claude-in-chrome__*` は除外ツールまで許可してしまうため使わない。実機での動作確認は Task 8-2 で web-verifier を実際に呼び出して行い、失敗した場合はこの節を更新する。

### Task 1: #39 CLAUDE.md(共通ルール)

- [x] プロジェクト概要: GPS・反省・動画・AI コメントの関係、`src/`(フロント)と `server/`(API・静的配信)の構成、`DATA_DIR` への JSON 保存、動画はローカル選択でサーバーに置かないこと。
- [x] 認証の現状は README ではなく `server/index.js` の実装を正として書く(閲覧ゲートは既定で有効)。既定資格情報の値は書かない。
- [x] 開発コマンド: 全テスト `npm test`、対象テスト `node --test test/xxx.test.js`、上記「ローカル起動」のコマンド(bash と PowerShell)。
- [x] 実装ルール: 後方互換性の維持、GPS 推定値を実測値として表示しない、既存のユーザー変更を上書きしない、無関係なリファクタリングをしない、新ロジックに単体テストを追加する、個人情報をテストデータやログへ残さない。
- [x] Git・subagent 運用ルール: `git reset --hard`・force push 禁止、未コミット変更を破棄しない、指示なしの commit・push・デプロイ禁止、読み取り専用 agent の明記、worktree を使わない、web-verifier は UI 変更時のみ、ループ上限2回。
- [x] subagent を使う/使わない条件を要約し、例外(明示的なフロー検証時・利用者の指定時は全工程を実行)も記載する。詳細は `docs/development/subagent-workflow.md` へリンクする。
- [x] 記載したコマンドを実際に実行して動作を確認する。

### Task 2: #40 implementation-planner

- [x] `tools: Read, Grep, Glob`(読み取り専用)。
- [x] 出力7項目を固定: 要求の理解 / 現状調査 / 実装方針 / 変更予定ファイル / テスト計画 / ブラウザ確認項目 / リスク・未確定事項。
- [x] 不明な仕様は推測で確定せず「未確定事項」へ出す。既存実装との重複確認と UI 変更有無の判定を必須とする。
- [x] 出力はメイン agent の承認(工程3)を前提とし、承認前に実装へ進む指示を含めない。

### Task 3: #41 implementation-engineer

- [x] `tools: Read, Grep, Glob, Edit, Write, Bash`。`isolation` は付けない(D1)。
- [x] 入力は元 Issue と承認済み計画。
- [x] 出力: 実装内容 / 変更ファイル / 実行したテストと結果 / 未確認事項 / 重点レビュー箇所。UI 変更時は web-verifier 向けに 操作手順と期待結果・画面幅・必要なテストデータ を追加する。
- [x] 禁止事項を明記: 無関係なリファクタ、テストを通すためのハードコード、理由のない既存テスト削除、未コミット変更の破棄、`reset --hard`・force push、指示なしの commit・push・デプロイ、本番データ変更、認証情報の埋め込み。

### Task 4: #42 code-reviewer

- [x] `tools: Read, Grep, Glob`(Bash なし、D2)。差分とテスト結果はメイン agent から受け取る。
- [x] 重要度 P0〜P3 の定義と確認観点(受け入れ条件との照合、境界値・空データ・GPS 欠損、旧プロジェクト読込、反省・進捗データの互換性、認証回避・個人情報ログ、秘密情報の埋め込み、テストの十分性)。
- [x] 各指摘に 重要度 / 要約 / ファイルと行 / 発生条件 / 利用者への影響 / 修正方針 を含める。問題なしの場合も確認範囲と未確認事項を報告。

### Task 5: #43 web-verifier

- [x] tools は Read と Claude in Chrome の MCP ツールのみ(Edit・Write・Bash なし)。MCP ツールは Task 0 の確認結果に記録したサーバー名・ツール名・指定方式で指定する。
- [x] 手順ごとに 期待結果 / 実際の結果 / PASS・FAIL を報告。デスクトップ幅とモバイル幅、コンソールエラーを確認。
- [x] 制約: localhost のみ(明示時を除く)、削除・送信など不可逆操作をしない、パスワードや個人情報を画像・ログに残さない。
- [x] スクリーンショットはリポジトリ内へ保存しない(保存する場合はリポジトリ外のパスに限定する)。

### Task 6: #44 docs/development/subagent-workflow.md

- [x] 標準フロー8工程(上記「標準フロー」)。
- [x] 引き継ぎ情報3種(上記「引き継ぎ情報」)と、組み立て責任がメイン agent にあること(D4)。
- [x] 重要度の統一定義(P0〜P3)、ループ上限。
- [x] 読み取り専用 agent の実行前後に `git status --porcelain` / `git diff` を比較する手順(D3)。
- [x] subagent を使わない条件と、その例外: 「明示的な subagent フロー検証、または利用者が subagent 実行を指定した場合は、小規模変更でも全工程を実行する」。
- [x] web-verifier を使う条件。
- [x] worktree を使わない方針と、将来使う場合に必要な整備(D1)。
- [x] agent の追加・編集は通常自動検出され、認識されない場合に限り再起動すること。
- [x] `CLAUDE.md` からリンクする。

### Task 7: 設定の静的検査(`test/agents-config.test.js`)

- [x] 4 agent の定義ファイルが存在し、frontmatter に `name`・`description`・`tools` を持つ。
- [x] `tools` を許可リストと完全一致で検査する:
  - planner: `Read, Grep, Glob`
  - engineer: `Read, Grep, Glob, Edit, Write, Bash`
  - reviewer: `Read, Grep, Glob`
  - web-verifier: `Read` + Task 0 で確定した Claude in Chrome の MCP ツール指定のみ(Edit・Write・Bash・NotebookEdit を含まない)
- [x] 読み取り専用 agent に `hooks`・`isolation` がない。engineer に `isolation` がない。
- [x] 実行時の読み取り専用性は D3 の差分比較で担保し、テストの限界を workflow 文書に記す。

### Task 8: #45 E2E 検証

#### 8-0. 新規セッションのゲート(Task 1〜7 完了後)

- [x] 子 Issue 単位のコミット(#39〜#44)と、Task 7 のコミットをすべて完了する。
- [ ] 現在の Claude Code セッションを終了し、通常どおり `claude`(または VS Code 版)で新規セッションを開始する。今回は Task 1 の時点でセッション開始時に `.claude/agents/` ディレクトリが存在しなかったため、一度だけ再起動する(Chrome を有効化するためではない。通常の agent 追加・編集では再起動不要)。
- [ ] agent の認識は `/agents` では確認しない(現行の `/agents` は一覧ではなく agent ファイルの編集を案内するコマンドのため)。代わりに実際の呼び出しで確認する:
  - 新規セッションで最初に `implementation-planner` を明示的に呼び出し、起動することを確認する(8-2 の工程2を兼ねる)。
  - `implementation-engineer`・`code-reviewer`・`web-verifier` は、8-2 での実際の呼び出し成功をもって確認とする。
  - どれか1つでも起動できなければゲート FAIL とする。
- [ ] Chrome ツールは web-verifier の呼び出し時に使えることを確認する(ツール名は Task 0 で確定済みのため再調査しない)。見えない場合に限り、`/chrome` または `claude --chrome` をフォールバックとして使う。
- [ ] 以降の 8-1〜8-3 は、この新規セッションで実施する。
- [ ] ゲート FAIL の場合は Task 8 を停止し、#45 と Epic #38 を「未完了・前提条件待ち」として報告する。

#### 8-1. サンプル Issue の作成

- [ ] #45 とは別に、検証用のサンプル Issue を作成する(作成は利用者の承認後)。
- [ ] 対象: `index.html` の `#viewLoginError`(閲覧ログインのエラー表示。`src/app.js` の閲覧ログイン処理で表示が切り替わる)。
- [ ] 変更内容: エラー表示にスクリーンリーダー向けのライブリージョン属性(`aria-live`)を追加する。属性値・`role` の要否は planner の計画で決め、工程3で承認する。
- [ ] テスト: `index.html` を読む静的テスト(`test/html-ids.test.js` の作法)で、`#viewLoginError` に属性があることを検証する。
- [ ] ブラウザ確認:
  - ダミー資格情報で起動し、`http://localhost:8000/` を開く。
  - 誤ったパスワードでログインし、エラー文言が表示されること、要素に属性が付いていることを確認する。
  - 正しいダミー資格情報でログインでき、エラー表示が消えることを確認する。
  - デスクトップ幅(1280px)とモバイル幅(390px)で確認する。
  - コンソールエラーがないことを確認する。
- [ ] #45 の本文に、このサンプル Issue への参照と上記の確認内容を追記する(利用者の承認後)。

#### 8-2. フローの実行

- [ ] 標準フロー8工程をすべて実行する(小規模変更だが、明示的なフロー検証のため例外規定により全工程を実行する)。
- [ ] 読み取り専用 agent の実行前後で差分比較を行う(D3)。
- [ ] #45 の確認項目(planner / engineer / reviewer / web-verifier)を記録する。

#### 8-3. 振り返り

- [ ] 引き継ぎ情報の欠落や改善点を `docs/development/subagent-workflow.md` へ反映する。

## Review Focus

- **読み取り専用 agent の権限漏れ** — planner / reviewer / web-verifier の `tools` に Edit・Write・Bash が含まれていないか。実行前後の差分比較が手順化されているか。
- **認証情報の転記** — `CLAUDE.md` や workflow 文書に既定資格情報・実パスワード・トークンが書かれていないか。起動例がすべてダミー値か。
- **README との不一致** — 閲覧ゲートの説明が `server/index.js` の実装と一致しているか。
- **コマンドの実在性** — 起動・テストコマンドが Windows(PowerShell)と bash の両方で動くか。
- **フローの整合** — 親 Issue #38 の承認工程が標準フローに含まれ、#44 の文書と矛盾しないか。
- **引き継ぎ項目の整合** — 各 subagent の入力が、前工程の出力とメイン agent の補完で揃うか。
