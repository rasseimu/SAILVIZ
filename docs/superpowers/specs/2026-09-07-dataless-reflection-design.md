# データなしでも反省を書ける 設計

作成日: 2026-09-07
対象: SailViz（クライアント側GPS軌跡ビューア）
ロードマップ: 項目24「データなしでも反省を書ける」

## 目的

GPS軌跡や動画を読み込んでいなくても、反省ノートを作成・保存できるようにする。
データが揃わない日・その場でメモだけ残したい日でも反省を蓄積でき、後日その練習に
GPS/動画を紐付けられるようにする（1練習=1カード。データは後から足せる）。

練習の「日時」は専用の入力ボタンを設けず、**反省追加ダイアログ**と
**議事録一括取込ダイアログ**の中で取得・入力する。最初に入った日時を、その練習
（ページ）の日時として採用する。

## 非目標（YAGNI）

- 専用の「練習日入力」ボタン／サイドバー欄は作らない（ダイアログ内で取得する）。
- 練習に安定UUID等の内部IDは導入しない。アイデンティティは従来どおりファイル名。
- 議事録の高度な自然言語日付解釈（AI）は行わない。決定的な正規表現抽出のみ。
- 反省入力アプリ（項目20）との統合は今回のスコープ外。

## 中核概念: `state.practiceDate`

ページ（練習）の練習日時を表す **絶対ms（number）または null** の状態。

- 各ダイアログ（反省追加・議事録取込）で日時が入力/抽出されたとき、
  `state.practiceDate` が未設定なら設定する。以後のダイアログはこの値をプリフィルする。
- プリフィル済みの値をユーザーが明示的に変えて保存したら **上書き**する
  （プリフィルされているので誤操作は起きにくい前提）。
- `startNewPractice` / `resetState` で null にクリア。`loadPractice` で保存値を復元。

### 練習日時の解決優先順位

ファイル名・カードラベルに使う「練習日時」は次の順で決める:

1. `state.practiceDate`（ダイアログで入力/抽出された値。sticky）
2. `earliestContentMs(project)`（トラックGPS開始／動画配置の最小。既存ロジック）
3. `Date.now()`（保存時刻フォールバック）

→ 通常のGPS練習（ダイアログで日時を入れない）は `practiceDate=null` のままなので、
2 にフォールバックし **現状のファイル名/ラベル挙動を維持**する（後方互換）。

## 変更点

### 1. スキーマ（`src/project.js`）

`serializeProject` / `deserializeProject` に `practiceDate`（絶対ms, null可）を追加。

- 直列化: `practiceDate: state.practiceDate ?? null`
- 復元: `practiceDate: typeof obj.practiceDate === 'number' ? obj.practiceDate : null`
- `PROJECT_VERSION` は **1 のまま**。旧ファイルは `practiceDate` 欠落→null で読める。

### 2. 反省追加ダイアログ（`index.html` / `src/app.js`）

- 反省エディタ（`#reflection-editor`）に日時入力 `#refl-date`（`<input type="datetime-local">`）を追加。
- `openReflectionEditor` 時のプリフィル:
  - `state.practiceDate` があればそれ。
  - 無ければGPS練習日時（`practiceInfo()` 由来）があればそれ。
  - どちらも無ければ空。
- `saveReflection` 時:
  - `#refl-date` に値があれば msToJst 変換して `practice` を組み立てる。
  - `state.practiceDate` が未設定、または値が変更されていれば `state.practiceDate` を更新。

### 3. 議事録一括取込ダイアログ（`index.html` / `src/minutes.js` / `src/app.js`）

- **GPS必須ガードを撤去**: `openImportModal` 冒頭の
  `if (!firstVisibleTrack()) { … return; }` を削除し、データなしでも開けるようにする。
- 日時入力 `#import-date`（`datetime-local`）をモーダルに追加。
- `src/minutes.js` に純関数 `parseMinutesDate(text, { defaultYear })` を追加:
  - 議事録本文から日時を抽出する決定的パーサ。
  - 対応パターン（例）: `2026/9/7`, `2026-09-07`, `2026年9月7日`, `9月7日`,
    `日付：2026/9/7`, 併記された時刻 `13:30` / `13時30分`。
  - 返り値: `{ y, mo, d, h, mi }`（時刻が無ければ h=0, mi=0）または null。
  - 最初に見つかった妥当な日付を採用。
  - **年の補完**: 年が無い形式（`9月7日` 等）は `defaultYear`（投稿年＝現在のJST年）で
    補う。投稿年でほぼ間違いないという運用前提。`defaultYear` は呼び出し側から注入し
    （純関数の決定性を保つ）、テストは固定年を渡す。呼び出し側は現在のJST年を渡す。
- 取込フロー:
  - テキスト入力/ファイル読込時に `parseMinutesDate` を試し、取れれば `#import-date` を
    プリフィル（ユーザーが上書き可）。取れなければ空のままユーザーが入力。
  - `runImport`: `#import-date` の値があり `state.practiceDate` 未設定なら設定。
    風取得の `target` はこの日時（無ければ従来どおり `nowAbsolute()`／`Date.now()`）。
    各反省の `practice` は `practiceInfo()` 経由で統一。

### 4. 練習アイデンティティ & 保存（`src/app.js`）

- `state.currentFileName`（新規, 既定 null）を導入。
  - `resetState` / `startNewPractice`: `null` にクリア（次回保存で新規採番）。
  - `loadPractice`: 読み込んだファイル名を `state.currentFileName` にセット。
- `saveProject` の変更:
  - `state.currentFileName` があれば **その名前に上書き**（再導出しない）。
  - 無ければ「練習日時の解決優先順位」で得た ms から `projectFileName` を生成し、
    **保存フォルダ内で衝突していれば分単位でずらして一意化**、確定名を
    `state.currentFileName` に保存。
- → メモ練習を開いて後からGPS/動画を取込→保存しても **同一ファイルを上書き**する
  （ファイルが増えない＝後付け紐付けが成立）。

### 5. `practiceInfo()`（`src/app.js`）

現状はトラックGPS範囲が無いと null を返す。次のように拡張:

1. トラック範囲があれば従来どおり `{ date, startMs, endMs }`。
2. 無くても `state.practiceDate` があれば `{ date, startMs: practiceDate, endMs: practiceDate }`
   （`date` はJST表示文字列）。
3. どちらも無ければ null。

→ メモだけの反省にも日付が表示される（`renderReflectionList` の `r.practice?.date`）。

### 6. カード表示（`src/summary.js`）

`practiceSummary` のラベル/並び用時刻で `project.practiceDate` を最優先にする:

- `label`: `practiceDate ?? earliestContentMs` を JST 整形。両方無ければ従来フォールバック。
- `trackedAt`: 同上（ホームの並び順キー）。

## タイムゾーン変換（要注意）

`datetime-local` の入力値は「YYYY-MM-DDTHH:mm」形式のローカル壁時計。アプリ全体が
Asia/Tokyo 固定表示のため、入力値を **JSTの壁時計として解釈して絶対msへ変換**する
純関数を用意し、単体テストする（マシンのTZに依存しないこと）。

- `jstWallToMs('2026-09-07T13:30') → 絶対ms`
- `msToJstWall(ms) → '2026-09-07T13:30'`（プリフィル用）

実装は `Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', … })` で分解し、
JSTオフセット（+09:00固定）で `Date.UTC` からms化する方針（既存の JST 整形と揃える）。
配置先は `src/time.js` など既存の時刻ユーティリティを想定。

## ファイル名の一意化（純ロジック）

衝突時のずらしはテスト可能な純関数に切り出す:

```
uniqueProjectName(baseMs, existingNames) -> string
```

- `projectFileName(new Date(baseMs))` を起点に、既存集合に含まれる間 **+1分** して再生成。
- 実用上の上限（例: 60回）を超えたら最後の候補を返す（現実にはまず衝突しない）。

## エッジケース

- **同日同時刻のメモを2件**: `uniqueProjectName` が分をずらして別ファイルにする。
- **メモ練習にGPSを後付け**: `currentFileName` があるので上書き。`practiceDate` は
  ユーザー指定が sticky（GPS時刻で上書きしない）。
- **既存の保存データ（practiceDate 無し）をロード→再保存**: `currentFileName` があるので
  同名上書き。ファイルは増えない（後方互換）。
- **議事録に日付が無い／未対応形式**: 抽出失敗→ユーザーがダイアログで入力。空のまま
  取込した場合は `practiceInfo()` が null になり得るが取込自体は成功する。

## テスト（node --test）

- `minutes.test.js`: `parseMinutesDate` の各対応パターン、時刻あり/なし、年補完
  （`defaultYear` 適用）、抽出失敗（日付なし）。
- `project.test.js`: `practiceDate` の直列化往復、旧ファイル（欠落）→null。
- `summary.test.js`: `practiceDate` 優先のラベル／並びキー、フォールバック。
- 一意化: `uniqueProjectName(baseMs, existing)` の衝突ずらし。
- JST変換: `jstWallToMs` / `msToJstWall` の往復とTZ非依存。
- `html-ids.test.js`: `#refl-date`, `#import-date` の追加。
- 既存346テストを維持（回帰なし）。

## 影響ファイル一覧

- `src/project.js`（スキーマ）
- `src/minutes.js`（`parseMinutesDate`）
- `src/summary.js`（ラベル/並び）
- `src/time.js`（JST変換・想定）
- `src/app.js`（`state.practiceDate` / `currentFileName`、両ダイアログ、`saveProject`、
  `practiceInfo`、`openImportModal` ガード撤去、`uniqueProjectName` 利用）
- `index.html`（`#refl-date`, `#import-date`）
- `docs/roadmap.md`（項目24 を完了に更新）
- 対応するテスト各種
