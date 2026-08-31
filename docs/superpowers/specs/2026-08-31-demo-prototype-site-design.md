# 使用感アンケート用ゼロ設定デモサイト 設計

- **日付**: 2026-08-31
- **状態**: 設計承認待ち
- **関連**: 項目17(ホーム) / 23(保存・読込) / 27(フォルダ選択一本化) / 9(動画フォルダ取込)

## 目的

使用感アンケートのために、**事前設定不要**で **1練習分のデータを読み込んだ状態**で
アクセスできる Web プロトタイプを、**限定共有の公開URL**（GitHub Pages 想定）で立ち上げる。

回答者は URL を開くだけで、フォルダ選択も CSV D&D もなしに、軌跡再生・風軸・VMG・
反省・ダッシュボード・進捗まで一通り触れる。反省などの記入・保存も本番同様に試せる。

## 確定した前提（ブレインストーミングでの決定）

1. **動画**: 短いサンプル動画 1〜2 本を同梱し自動リンク。残りの動画メタは扱わない。
2. **公開範囲**: 限定リンクで共有する公開URL。**匿名化・秘匿は不要**（そのままの実データで可）。
3. **見せる範囲**: ホーム含む全ビュー（ホーム / トラック / ダッシュボード / 進捗）フル。
4. **保存**: **localStorage 永続化**。フォルダ保存(File System Access API)は使わない
   ＝全ブラウザ・ゼロ設定で「記入→保存→リロードしても残る」体験を成立させる。

### この決定が解く緊張点
本番のフォルダ保存は File System Access API 依存で **Chrome/Edge 限定＋フォルダ選択必須**。
「ゼロ設定・公開URL・全ブラウザ」と両立しないため、保存先を localStorage に置換して解消する。

## 現状アーキテクチャ（変更対象の把握）

- 起動は `document.body.class="view-home"`。`renderHome()` が `projectDir`
  (`FileSystemDirectoryHandle`) を要求し、未選択ならカードは並ばない。
- データ読込: `ensureProjectDir()` → `listProjectFiles(dir)` / `readProject(dir,name)`
  （`src/projectfs.js`）。保存は `writeProject` / `writeProgress`。
- 動画は `.sailviz.json` にメタ(`{id,t,name,durationMs}`)のみ。実体は「📁動画フォルダ取込」
  (`src/folderimport.js`)が **名前一致**でローカルから再リンク。
- 反省は `saveReflections` で localStorage にミラー済み。進捗も `sailviz-progress.json` と
  localStorage の二重持ち。**保存の localStorage 化は既存構造の自然な延長**。
- File System Access API に触れるのは `chooseProjectDir`/`ensureProjectDir`/`saveDirHandle`
  (`src/dirhandle.js`)/`folderimport` の系統に限定。ここを demoモードで迂回すれば全ブラウザ可。

### 同梱候補データの実測
`demo-data/sailviz-20260825-1054.sailviz.json`(6.2M) 等は
**3トラック(各13,427点)・マーク10・動画メタ27・反省0件**。
→ Phase 0 で「反省0件のまま(回答者が自分で書く)」か「デモ映え用にシード反省を数件入れるか」、
　および「動画メタ27件を同梱1〜2本に間引くか」を確定する。

## 方式の選択

### 採用: ランタイム「demoモード」フラグ + 差し替え可能なデータ源
`?demo` クエリ or 公開ホスト名で `DEMO` を判定。データ源を、`projectfs` と**同じ形の関数**を
持つ「同梱データ源」に差し替える。フォルダ系UI/呼び出しは `DEMO` 時に無効化。

- ✅ コード1本のまま。ローカル開発は従来のフォルダ運用を維持
- ✅ ビルド不要。差分は「データ源の注入点」と「FS API 呼び出しのガード」に局所化

### 不採用: folderコードを剥がした別ブランチ/別ビルド
二重管理になり、以降の機能追加が両系統に分岐するため見送り。

## 設計詳細

### 1. データ源の抽象化（`src/datasource.js` 新規）
`projectfs.js` の read 系と同じインターフェースを持つ2実装を用意し、起動時に片方を選ぶ。

- `folderSource(dirHandle)`: 既存 `listProjectFiles`/`readProject`/`readProgress` を包む。
- `bundledSource(manifestUrl)`: 静的 `manifest.json`（練習ファイル名の一覧）を `fetch` し、
  各 `.sailviz.json` も `fetch`。`readProgress` は空 `{}` を返す（進捗は localStorage 側）。

`app.js` の `readProject`/`listProjectFiles`/`readProgress` 直呼びを、この source 経由に置換。

### 2. 起動フロー（`app.js`）
- `const DEMO = new URLSearchParams(location.search).has('demo') || /github\.io$/.test(location.hostname)`
  （最終判定条件は Phase 6 で確定）
- `DEMO` の場合:
  - `dataSource = bundledSource('demo/manifest.json')`
  - `renderHome()` は `projectDir` 不在でも同梱練習をカード表示（フォルダ選択ボタン非表示）
  - `ensureProjectDir()`/`showDashboard`/`showProgress` のフォルダ要求ガードを **通過**させる
    （demoモードでは常に true 相当）

### 3. 同梱データ（`demo/` 配下、リポジトリにコミット）
- `demo/manifest.json`: `["sailviz-YYYYMMDD-HHMM.sailviz.json"]`
- `demo/<練習>.sailviz.json`: 選定した1練習（Phase 0 で動画メタを間引き / 任意でシード反省追加）
- `demo/videos/<name>`: 同梱サンプル動画 1〜2 本

### 4. 動画の自動リンク（`app.js` / `folderimport.js` 再利用）
`DEMO` 時、ホームからトラックを開いた後に `demo/videos/` の各ファイルを `fetch`→`blob`→
`URL.createObjectURL` し、既存の**名前一致リンク処理**へ流し込む（フォルダ取込のデータ源だけ差替）。
同梱動画名は選定 JSON の動画メタ名と一致させる。

### 5. 保存の localStorage 化
- `saveProject()`: `DEMO` 時は `writeProject`(フォルダ) の代わりに
  練習JSON全体を localStorage キー（例 `sailviz.demo.project.<name>`）へ保存。
- 読込優先順位: **同梱JSON=初期シード**、localStorage に上書きがあればそれを優先。
  `loadPractice(name)` で「localStorage にあればそれ、無ければ bundledSource」を読む。
- 進捗(`progressstore`)は既存の localStorage ミラーをそのまま使用（フォルダ書込は no-op）。
- フォルダ保存/📁動画フォルダ取込/フォルダ選択ボタンは `DEMO` 時に非表示 or 無効化。
- 「デモをリセット」操作で該当 localStorage キーを消し初期シードへ戻す。

### 6. 非対応ブラウザ対策
`showDirectoryPicker` 等 FS API を触る全経路を `DEMO` ガードで迂回。
Safari/Firefox/スマホでもコア体験が動くことを実機/実URLで確認。スマホは最低限
「PC推奨」の告知 or 簡易レイアウト確認（Phase 4 で判断）。

### 7. アンケート導線
初回オーバーレイ（「これはデモです／◯◯を試してください」＋アンケートフォームへのリンク）。
localStorage フラグで再表示抑制。誘導タスク文言は Phase 5 で確定。

### 8. デプロイ（GitHub Pages）
- 全アセット参照を**相対パス**化（Pages は `/<repo>/` 配下配信）。`fetch('demo/...')` も相対。
- `docs/` 公開 or `gh-pages` ブランチ or Actions のいずれか（Phase 6 で確定）。
- サイズ: 練習JSON ~6M + 動画1〜2本。Pages 制限（100MB/ファイル）内。

## フェーズ別ロードマップ

- **Phase 0** データ確定＆整形: 同梱1練習を選定。動画メタを同梱分へ間引き。シード反省の要否判断。
- **Phase 1** demoモード＋データ源抽象化: フォルダ未選択でも同梱練習を自動ロードしホーム表示。
- **Phase 2** 動画自動リンク: サンプル1〜2本を同梱・名前一致で自動リンク。
- **Phase 3** 保存の localStorage 化＋読込優先順位＋フォルダUIの demoガード＋リセット。
- **Phase 4** 非対応ブラウザ/操作毀損チェック（Safari/Firefox/スマホ）。
- **Phase 5** アンケート導線（初回オーバーレイ＋フォームリンク）。
- **Phase 6** GitHub Pages デプロイ（相対パス化・公開方式確定・実URL確認）。
- **Phase 7** 検証（主要3ブラウザ スモーク＋各誘導タスク通し＋`node --test`）。

## テスト方針
- `bundledSource` / 読込優先順位（localStorage 上書き）/ demo判定 は純ロジックとして `node --test`。
- 動画自動リンク・FS APIガード・描画は実URLで手動確認（既存方針踏襲）。

## 未確定事項（実装計画で詰める）
- Phase 0: シード反省の要否と件数、動画メタ間引き後の残数。
- demoモード判定の最終条件（`?demo` のみ / ホスト名併用）。
- 公開方式（`docs/` / `gh-pages` / Actions）。
- スマホ対応の深さ（告知のみ / 簡易レスポンシブ）。
- アンケートフォームのURL・誘導タスク文言。
