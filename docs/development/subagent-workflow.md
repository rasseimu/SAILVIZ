# subagent 開発フロー

GitHub Issue 対応を、計画・実装・レビュー・ブラウザ確認の4種の subagent に分けて進めるための手順書。共通ルールは [`CLAUDE.md`](../../CLAUDE.md) を参照。

## agent 一覧

| agent | 役割 | tools | ファイル変更 |
|-------|------|-------|--------------|
| `implementation-planner` | Issue から7項目の実装計画を作る | `Read, Grep, Glob` | しない |
| `implementation-engineer` | 承認済み計画に従って実装・テストする | `Read, Grep, Glob, Edit, Write, Bash` | **する(唯一)** |
| `code-reviewer` | 差分を P0〜P3 でレビューする | `Read, Grep, Glob` | しない |
| `web-verifier` | Claude in Chrome で UI を確認する | `Read` + Claude in Chrome の許可ツール | しない |

定義は `.claude/agents/*.md`。

## 標準フロー

1. メイン agent が GitHub Issue を読み取る。
2. `implementation-planner` が実装計画を作る。
3. **メイン agent が計画を確認・承認する。** 未確定事項があれば利用者へ確認する。
4. `implementation-engineer` が実装し、テストを実行する。
5. `code-reviewer` が差分をレビューする。
6. P0/P1 があれば engineer が修正し、再レビューする(最大2回)。
7. UI 変更がある場合、`web-verifier` が Chrome で確認する。
8. メイン agent が最終結果をまとめる。

commit・push・Issue 更新・デプロイは subagent に実行させない。利用者の指示を受けてメイン agent が行う。

## 引き継ぎ情報

subagent 同士は直接やり取りしない。**引き継ぎ情報の組み立て責任はメイン agent が持つ。** 各 subagent の出力で不足する情報(元 Issue、承認済み計画、実際の差分、起動コマンドなど)はメイン agent が補って次の subagent へ渡す。

### planner → engineer(工程3の承認後)

- 元 Issue(番号・本文・受け入れ条件)
- 承認済みの実装計画(planner 出力7項目と、承認時の決定事項)

### engineer → reviewer

- 元 Issue
- 承認済みの実装計画
- 実際の差分(メイン agent が `git diff` で取得。新規ファイルは `git status --porcelain` で確認して内容を添える)
- 実行したテストと結果
- 未確認事項
- 重点レビュー箇所

reviewer は Bash を持たないため、差分とテスト結果は必ずメイン agent が渡す。

### engineer → web-verifier

- ローカル URL(`http://localhost:8000/`)と、サーバーが起動済みであること
- 起動コマンドと必要な環境変数(値はダミー。`CLAUDE.md` のコマンドを使う)
- 使用するダミーテストデータ
- 操作手順と期待結果
- 確認する画面幅(デスクトップ 1280px / モバイル 390px)
- 操作してはいけない環境(本番 `sailviz-sit.fly.dev` など)

engineer は自分が知りうる項目(テスト結果、操作手順、期待結果、画面幅、テストデータ)を出力し、残り(サーバーの起動、URL、禁止環境)はメイン agent が補う。web-verifier は Bash を持たないため、サーバーの起動・停止はメイン agent が行う。

## 重要度

| 重要度 | 定義 | 扱い |
|--------|------|------|
| **P0** | データ消失・破損、認証回避、秘密情報・個人情報の漏えい、アプリが起動・読込できない | マージ不可 |
| **P1** | 受け入れ条件を満たさない、主要機能の誤動作、旧データを読み込めない、推定値を実測値として表示 | 修正必須 |
| **P2** | 境界値・例外系の不備、テスト不足、保守性の問題 | 修正推奨 |
| **P3** | 命名・コメント・軽微なスタイル | 任意 |

## レビュー → 修正ループ

- P0/P1 があれば engineer が修正し、reviewer が再レビューする。
- ループは**最大2回**。2回修正しても P0/P1 が残る場合は、メイン agent が判断する(必要なら利用者へ確認)。
- P2/P3 の扱いはメイン agent が決める(今回直すか、別 Issue にするか)。

## 読み取り専用性の確認

読み取り専用は次の二重で担保する。

1. **静的検査** — `test/agents-config.test.js` が各 agent の frontmatter を検査する(`npm test` に含まれる)。
   - `tools` が許可リストと完全一致すること
   - 読み取り専用 agent に `hooks`・`isolation` がないこと、engineer に `isolation` がないこと
2. **実行時検査** — メイン agent が planner / reviewer / web-verifier の実行前後で作業ツリーを比較する。

   ```bash
   git status --porcelain > "${TMPDIR:-/tmp}/sv-before-status.txt"
   git diff > "${TMPDIR:-/tmp}/sv-before-diff.txt"
   # subagent を実行
   git status --porcelain | diff "${TMPDIR:-/tmp}/sv-before-status.txt" -
   git diff | diff "${TMPDIR:-/tmp}/sv-before-diff.txt" -
   ```

   差分が出たら FAIL として扱い、変更内容を利用者へ報告する(勝手に巻き戻さない)。

**静的検査の限界:** テストは定義ファイルの記述を検査するだけで、実行時に Claude Code がその制限どおりに動くことや、MCP ツール自体の副作用(ブラウザ操作によるサーバー側データの変更など)は検出できない。そのため実行時検査を省略しない。web-verifier の不可逆操作は agent 定義の制約とダミー `DATA_DIR` で防ぐ。

## subagent を使う / 使わない

- **使う**: GitHub Issue 対応など、計画・実装・レビューを分けた方が確実な変更。
- **使わない**: 誤字修正、1ファイル数行の自明な修正、質問への回答、調査のみの作業。メイン agent が直接対応する。
- **例外**: 明示的な subagent フロー検証、または利用者が subagent 実行を指定した場合は、小規模変更でも全工程を実行する。

## web-verifier を使う条件

- planner の「ブラウザ確認項目」で UI 変更ありと判定された場合(`index.html`・`minutes.html`・`styles.css`・DOM を操作する `src/` のコードを変更する場合)。
- UI 変更がない場合は使わない(planner は「UI 変更なし: web-verifier 不要」と出す)。
- 前提: 現在の Claude Code セッションで Claude in Chrome のツールが使えること。Chrome 連携が既定で有効なら通常の `claude` 起動で使え、VS Code 版は拡張機能が入っていれば追加フラグ不要。別シェルの `claude mcp list` に表示されないことは未接続の根拠にしない。
- Chrome ツールが見えない場合に限り、`/chrome` で接続状態を確認・再設定するか、Chrome 連携が未有効の CLI セッションでは `claude --chrome` で有効化する。それでも接続できない場合はブラウザ確認を「未実施」として報告し、完了扱いにしない。
- 許可ツールと除外理由は `docs/superpowers/plans/2026-09-26-subagent-workflow.md` の「Task 0 の確認結果」を参照。

## worktree を使わない

フローは逐次実行で並列編集がないため、engineer は現在の feature ブランチの作業ツリーで直接作業する。`isolation: worktree` は既定で `.claude/worktrees/` に作られ、基点が既定ブランチ(`main`)になるため、feature ブランチの途中成果を含まない状態で起動しうる。

将来 worktree を使う場合は、次の3点を同時に整備する。

- `.gitignore` に `.claude/worktrees/` を追加する(ignore 済みの `.worktrees/` とは別)。
- `worktree.baseRef: head` を設定するか、現在の HEAD を基点にする手順を明示する。
- worktree 上の変更を feature ブランチへ戻す手順を定める。

## agent を追加・変更したとき

- 通常の agent 追加・編集(既存の `.claude/agents/` 内)は自動検出される。再起動は、セッション開始時に `.claude/agents/` ディレクトリ自体が存在しなかった場合や `--add-dir` 経由の場合など、認識されないときに限る。
- 認識の確認は `/agents` ではなく(現行の `/agents` は agent ファイルの編集を案内するコマンドで、一覧確認には使えない)、その agent を実際に呼び出して起動することで行う。
- `tools` を変更したら `test/agents-config.test.js` の許可リストも更新し、`npm test` を実行する。
