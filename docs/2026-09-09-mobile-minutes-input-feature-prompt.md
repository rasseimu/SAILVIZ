# 実装キックオフ・プロンプト — スマホ向け「議事録（振り返り）入力」Webページ

> このファイルはそのまま Claude Code へのプロンプトとして貼り付けて使えます。
> 対象リポジトリ: **sailviz**（`/Users/reimurase/Documents/sailviz`、依存ゼロの Node 標準 http サーバー + バニラ Web フロント）。

---

## プロンプト本文（ここから貼り付け）

sailviz に新機能を1つ追加したい。**スマホのブラウザで使う「振り返り議事録 入力ページ」**を作る。
チームの振り返り会議を、スマホのネイティブ音声入力（キーボードのマイク＝ディクテーション）で
テキスト化し、そのテキストを AI（Gemini）で**部員別の構造化議事録**（目標／課題／発見）に整形、
名簿照合して各部員の反省(Reflection)として保存する。

### なぜ Web か
当初 iOS/Flutter アプリで検討したが、アプリ配布にコスト（Apple Developer 等）がかかるため、
**既存の sailviz Web（静的配信・PWA的に使えるモバイルWebページ）**として実装する。
sailviz にはサーバー側の部品がすでに揃っており、追加はモバイル入力ページが中心になる。

### 再利用できる既存資産（新規実装を最小化すること）
- `server/gemini.js` … Gemini 呼び出し。クライアントは **`POST /api/ai-comment`**
  （body: `{model, system, parts:[{text}], responseMimeType}`）経由。API キーはサーバ環境変数に隠蔽。
  **編集モード（unlock）必須**。既定モデル `gemini-3.6-flash`。
- `src/minutes.js` … `parseMinutes(text)`（`## 名前（フルネーム）` + `- **目標/課題/発見**：本文`
  形式 → 部員ブロック配列）、`matchMember(headerName, fullNameHint, roster)`、`parseMinutesDate(text)`。
  **決定的・AI不要**。ブラウザから ES モジュールとして import 可能。
- `src/members.js` … `memberList()`（`{id, fullName, family, given, kana}`）、`filterMembers()`、`toHiragana()`。
- `server/api.js` / `server/storage.js` … `GET/PUT /api/projects/<name>.sailviz.json`（PUTは要unlock）、
  `POST /api/unlock`（パスワード→cookie `sailviz_token`）、`GET /api/auth`。
  プロジェクト JSON は `{version, savedAt, ..., reflections:[...], practiceDate}`。
- `server/static.js` … リポジトリ直下の任意ファイルを配信（例: 新規 `minutes.html` は `/minutes.html` で配信）。
- Web 版には既にデスクトップ向けの「議事録一括インポートUI」が `src/app.js` にある
  （`parseMinutes`＋名簿照合＋プレビュー＋手修正）。**このロジックをモバイル向けに再構成**する。

### ユーザーフロー（モバイルWeb）
1. スマホで `/minutes.html` を開く（初回は unlock: パスワード入力→cookie）。
2. 大きな `<textarea>` に、端末キーボードの音声入力（ディクテーション）または貼り付けで
   会議の会話テキストを入れる。
3. 「AI整形」ボタン → `POST /api/ai-comment` に Gemini テキスト呼び出し。
   生テキスト＋名簿(fullName一覧)を渡し、**JSON配列**で
   `[{fullName(名簿のいずれか|null), goal, issue, discovery, raw}]` を返させる
   （`responseMimeType: application/json`、名簿外の名前は出さない）。
4. 編集可能プレビュー（モバイル最適化）：各行に「取込」チェック＋部員選択（全 `memberList()`）＋
   目標/課題/発見の要約。未割当(null)は既定オフ。AI が外した割当は手で修正できる。
   `matchMember` を保険のフォールバック照合に使ってよい。
5. 練習日を選択（既定=今日、JST）。
6. 「取込」→ 採用かつ部員割当済みの各行を Reflection 化して保存。

### 決定済みの設計判断（ブレインストーミング済み・踏襲すること）
- **文字起こしは端末側（ブラウザのキーボード音声入力）に委ねる**。アプリ/サーバーで音声は扱わない
  （音声ファイルのアップロードや Whisper 等の ASR はスコープ外）。任意で Web Speech API
  （`webkitSpeechRecognition`）のマイクボタンを足してもよいが、iOS Safari は制約があるため
  **`<textarea>` + キーボード音声入力**を基本とする。
- **構造化は Gemini（既存 `/api/ai-comment`）**。決定的 `parseMinutes` は「AIを使わない手動整形」経路や
  フォールバックとして温存（二重処理は避け、主経路は AI）。
- **出力は部員別の構造化議事録**（目標/課題/発見）→ 反省に取込。自由要約や逐語全文の保存はしない。
- **想定シーンはチームの振り返り会議（複数人）**。名簿照合して各人に振り分ける。
- 反省の各フィールド: `people:[fullName]`, `notes:{goal,issue,discovery}`, `text:raw`,
  `practiceDate`(JST0時ms)。wind/rig は空でよい（YAGNI）。
- 認証: Gemini 呼び出しも保存も **unlock 必須**（既存フロー）。

### 要決定（この機能のブレスト/設計で詰める）
- **保存単位**: Web 版の既存インポートは「開いているプロジェクトの `reflections[]` に push → その
  プロジェクトファイルを PUT」。モバイル入力ページは“開いているプロジェクト”を持たないため、
  (a) 練習日ベースの1プロジェクトに全員分の反省をまとめて作成/追記するか、
  (b) 部員別に別ファイルを作るか（Flutter版で検討した案）を決める。**(a) 推奨**
  （Web の既存モデル＝1プロジェクトに複数反省、に自然に一致）。プロジェクト名の採番規則を決める
  （例: `sailviz-YYYYMMDD-HHMM.sailviz.json`、練習日一致なら既存を read→追記）。
- 同一部員が複数ブロックになった場合の扱い（1反省にマージ推奨）。
- 練習日抽出: `parseMinutesDate` で本文から日付を拾ってプリフィル（既存挙動）。

### スコープ
- **In**: `/minutes.html`（モバイル最適化）＋その JS（`src/` に ES モジュールで追加、`minutes.js`/
  `members.js` を import）＋ Gemini 構造化呼び出し＋プレビュー/手修正＋保存。unlock 導線。
- **Out**: 音声アップロード/サーバーASR、iOS/Flutter アプリ、既存デスクトップ UI の作り替え、
  新規サーバーendpoint（既存 `/api/ai-comment`・`/api/projects`・`/api/unlock` で足りるはず。
  もし保存の都合で必要になったら最小限で追加）。

### 成果物とテスト
- 新規: `minutes.html`、`src/minutes-input.js`（画面ロジック）、必要なら `styles` 追記。
- 既存 `src/minutes.js`/`src/members.js` は極力そのまま再利用。
- テストは既存の `node --test` 流儀（`test/minutes.test.js` が既にある）。
  追加ロジック（AI応答JSONの検証、保存ペイロード生成、日付/名簿照合）を純関数化してテスト。
  Gemini 実呼び出しは fetch をモック。

### 進め方
まず **brainstorming** で上記「要決定」を詰め、`docs/` に設計書（spec）を書いてから
**writing-plans** で実装計画に落とし、TDD で実装する。iOS/Flutter アプリ側には手を入れない。

（参考: Flutter 版で作りかけた設計 `SailViz-app/docs/superpowers/specs/2026-09-09-minutes-import-design.md`
は本 Web 方針により置き換え。設計判断の中身はそのまま流用してよい。）

## プロンプト本文（ここまで）
