# 設計書 — スマホ向け「振り返り議事録 入力」Webページ

- 日付: 2026-09-09
- 対象リポジトリ: sailviz(依存ゼロの Node 標準 http サーバー + バニラ Web フロント)
- 元プロンプト: `docs/2026-09-09-mobile-minutes-input-feature-prompt.md`
- ステータス: 設計確定(実装計画へ)

## 1. 目的とスコープ

チームの振り返り会議を、スマホのネイティブ音声入力(キーボードのマイク=ディクテーション)で
テキスト化し、AI(Gemini)で**部員別の構造化議事録**(目標/課題/発見)に整形、名簿照合して
各部員の反省(Reflection)として保存する、モバイル最適化 Web ページを追加する。

当初 iOS/Flutter アプリで検討したが配布コスト回避のため、既存 sailviz Web の静的配信ページとして実装する。

### In スコープ
- `/minutes.html`(モバイル最適化)＋ その画面ロジック `src/minutes-input.js`。
- Gemini 構造化呼び出し(既存 `/api/ai-comment` 経由)。
- 編集可能プレビュー＋手修正、練習日選択、保存。
- unlock 導線(既存フロー)。
- 保存用の新規サーバー endpoint `POST /api/minutes-imports/commit`。

### Out スコープ
- 音声アップロード / サーバー ASR(端末側ディクテーションに委ねる)。
- iOS/Flutter アプリ、既存デスクトップ議事録インポート UI(`src/app.js`)の作り替え。
- 風・リグの入力(YAGNI。反省では null/空のまま)。
- クライアント側 localStorage への反省キャッシュ(モバイルはサーバーへ直接 commit する)。

## 2. 再利用する既存資産(確認済み)

| モジュール | 使うもの | 純粋性 |
| --- | --- | --- |
| `src/minutes.js` | `parseMinutes`, `matchMember`, `parseMinutesDate` | 純・決定的 |
| `src/members.js` | `memberList`, `filterMembers`, `toHiragana` | 純 |
| `src/reflections.js` | `createReflection`(id/createdAt は呼び出し側採番) | 純 |
| `src/projectfs.js` | `projectFileName`, `uniqueProjectName`, `projectLabel` | 純 |
| `src/project.js` | `PROJECT_VERSION`, 保存オブジェクト形状, `deserializeProject` | 純 |
| `src/time.js` | `jstWallToMs`, `msToJstWall` | 純 |
| `src/gemini.js` | `geminiGenerate`(`/api/ai-comment` クライアント) | fetch |
| `src/api.js` | `apiAuthStatus`, `apiUnlock`, `apiLock` | fetch |
| `server/gemini.js` | `geminiGenerate`(サーバー側、既定 `gemini-3.6-flash`) | fetch |
| `server/storage.js` | `readProject`, `writeProject`, `listProjects`, `findReflectionByDate` | fs |
| `server/api.js` | `/api/ai-comment`, `/api/unlock`, `/api/auth`, `/api/projects`, ルーティング | http |
| `server/static.js` | リポジトリ直下ファイル配信(`/minutes.html` を配信) | fs |

## 3. アーキテクチャ

```
minutes.html ──▶ src/minutes-input.js  (DOM グルー: unlock, textarea, ボタン, プレビュー, commit)
                     │ import
                     ├─ src/minutes.js   純 ← 追加: parseAiMinutes(), buildMinutesSystemPrompt()
                     ├─ src/members.js   純 (memberList / filterMembers) — 変更なし
                     ├─ src/gemini.js    (既存 /api/ai-comment クライアント) — 変更なし
                     └─ src/api.js       ← 追加: apiCommitMinutes()

POST /api/minutes-imports/commit  (server/api.js)  ← 新規, unlock 必須
                     ├─ server/minutesimport.js  純 ← 新規 (merge + reflections 生成 + skeleton)
                     └─ server/storage.js         ← 追加: findProjectByPracticeDate()
```

設計原則: **純ロジック(AI応答JSON検証・部員マージ・反省生成・プロジェクト骨組み)を
DOM/HTTP から分離**し、`node --test` で単体テスト可能にする。直近で追加された
`/api/sensor-imports/commit`(endpoint + 純ヘルパー + テスト)と同じパターンに揃える。

## 4. ユーザーフローとデータフロー

1. スマホで `/minutes.html` を開く。`GET /api/auth` で状態確認。locked ならパスワード入力欄を
   出し `POST /api/unlock`(cookie `sailviz_token`)。
2. 大きな `<textarea>` に、端末キーボードの音声入力または貼り付けで会議テキストを入れる。
3. **「AI整形」**:`src/gemini.js` → `POST /api/ai-comment`。
   - `responseMimeType: 'application/json'`
   - `system = buildMinutesSystemPrompt(roster)`(roster の fullName 一覧、
     「名簿外の名前は出すな」、配列スキーマの指示)
   - `parts: [{ text: rawText }]`
   - 応答 → `parseAiMinutes(text, roster)` → 行配列
     `[{ fullName|null, goal, issue, discovery, raw }]`
   **「AIなしで整形」**(フォールバック / AI エラー / GEMINI_API_KEY 未設定時):
   `parseMinutes` + `matchMember` → 同じ行形状。
4. 編集可能プレビュー(モバイル最適化):各行 = 取込チェック + 部員 `<select>`(全 `memberList()`)
   + goal/issue/discovery 要約。`fullName === null` は既定で取込オフ。AI 経路でも `matchMember` を
   保険のフォールバック照合に使う。
5. 練習日入力(`<input type="date">`):`parseMinutesDate` でプリフィル(取れなければ今日 JST)。
   選択値 `YYYY-MM-DD` を `jstWallToMs(value + 'T00:00')` で **JST 0 時 ms** に変換。
6. **「取込」**:取込済みかつ部員割当済みの行のみを `{ fullName, goal, issue, discovery, raw }` に
   マップし、`apiCommitMinutes({ practiceDate, rows })` で送信。成功トーストを表示。

## 5. 新規 API — `POST /api/minutes-imports/commit`

unlock 必須(`isAuthorized`)、未認証は 401。

```jsonc
// request
{
  "practiceDate": 1757343600000,   // JST 0 時 ms
  "rows": [
    { "fullName": "本間 由真", "goal": "…", "issue": "…", "discovery": "…", "raw": "…" }
  ]
}
// response 200
{ "name": "sailviz-20260909-0000.sailviz.json", "added": 3, "created": true }
```

サーバー処理(純ヘルパー + storage):
1. バリデーション:`practiceDate` が有限数、`rows` が非空配列、各 `fullName ∈ memberList()`
   のフルネーム集合。違反は 400。
2. `mergeRowsByMember(rows)`:同一 fullName の複数行 → goal/issue/discovery を区切り連結 + raw 連結。
   **この commit バッチ内のみ**マージ。
3. `findProjectByPracticeDate(dataDir, practiceDate)`:
   - 見つかれば read して **append**(既存の他フィールドは保持)。
   - 無ければ `emptyProject(practiceDate, savedAt)` 骨組み(`version:1`, 各配列空, `basemap:null`)を
     `uniqueProjectName(practiceDate, existing)` で命名 → `sailviz-YYYYMMDD-0000.sailviz.json`。
4. マージ済み各部員 → `createReflection({ id: 'refl'+practiceDate+'_'+i, createdAt: now,
   people:[fullName], notes:{goal,issue,discovery}, text:raw, wind:null, practice:null })`。
   `id` / `now` は注入し、生成ヘルパーをテスト決定的に保つ。
5. `writeProject`。`{ name, added, created }` を返す。

備考:
- 風・リグは空のまま(YAGNI)。`practice` も null(モバイルでは開始/終了時刻を持たない)。
- マージは**バッチ内のみ**。同一部員が過去の保存で既に反省を持つ場合は、その反省を編集せず
  新しい反省を append する(予測可能、暗黙編集を避ける)。
- AI 整形はクライアント側(`/api/ai-comment`)で行うため、この commit endpoint は Gemini を呼ばない。

## 6. モジュール別の追加内容

### `src/minutes.js`(純・追加)
- `buildMinutesSystemPrompt(roster = memberList())`:Gemini への system 指示文を返す。roster の
  fullName を列挙し、出力は `[{fullName, goal, issue, discovery, raw}]` の JSON 配列、
  名簿外の名前は `fullName: null`、と明示。
- `parseAiMinutes(jsonText, roster = memberList())`:AI 応答 JSON をパースし検証済み行配列を返す。
  - JSON parse 失敗 → `[]`(throw しない。呼び出し側でフォールバック導線)。
  - 各要素:`fullName` が roster に無ければ `null`。goal/issue/discovery/raw は文字列強制(欠落→'')。
  - 配列でない/要素が object でない場合は該当要素をスキップ。

### `src/api.js`(fetch・追加)
- `apiCommitMinutes({ practiceDate, rows })`:`POST /api/minutes-imports/commit`,
  `credentials:'same-origin'`。成功 → `{name, added, created}`、非 2xx → throw(メッセージは `error`)。

### `src/minutes-input.js`(DOM グルー・新規)
- 画面初期化、unlock ゲート、textarea、AI/AIなし整形、プレビュー描画・編集、練習日、commit。
- 純ロジックは持たず、`src/minutes.js` / `src/members.js` / `src/time.js` / `src/gemini.js` /
  `src/api.js` を組み合わせるだけの薄い層。
- 行→commit ペイロード変換ヘルパー `toCommitRows(rows)` はこのファイル内に置くが、DOM 非依存の
  純関数として export し `test/` から個別に検証可能にする(取込オフ/未割当を除外)。

### `minutes.html`(新規)
- `<meta name="viewport" content="width=device-width, initial-scale=1">`。
- 大 textarea、AI整形 / AIなし整形 ボタン、プレビューリスト、date 入力、取込ボタン、
  unlock ダイアログ、トースト。`<script type="module" src="src/minutes-input.js">`。
- スタイルは `styles.css` にモバイル向けクラスを追記(既存 `.im-*` 命名に倣う)。

### `server/minutesimport.js`(純・新規)
- `mergeRowsByMember(rows)` → fullName ごとに 1 行へマージ(順序は初出順)。
- `reflectionsFromRows({ rows, practiceDate, now })` → `createReflection` を用いた反省配列
  (決定的 id、フィールドマッピング、wind/rig null)。
- `emptyProject(practiceDate, savedAt)` → `deserializeProject` を通る骨組みオブジェクト。
- `validateCommitRows(rows, roster)` → 不正時に理由文字列を返す(または null)。

### `server/storage.js`(fs・追加)
- `findProjectByPracticeDate(dataDir, practiceDate)`:`findReflectionByDate` と同型。
  `practiceDate` が一致する最初のプロジェクト `{name, label}` を返す(無ければ null)。

### `server/api.js`(http・追加)
- `POST /api/minutes-imports/commit` ルート。unlock チェック → バリデーション → merge →
  find-or-create → append → write。

## 7. テスト計画(TDD, `node --test`)

- `test/minutes.test.js`(既存に追加):
  - `parseAiMinutes`:正常配列、名簿外 fullName → null、壊れた JSON → `[]`(throw しない)、
    文字列強制、非配列/非 object 要素のスキップ。
  - `buildMinutesSystemPrompt`:全 roster の fullName を含む。
- `test/minutesimport.test.js`(新規):
  - `mergeRowsByMember`:連結、初出順、単一行はそのまま。
  - `reflectionsFromRows`:決定的 id、people/notes/text マッピング、wind/rig null。
  - `emptyProject`:`deserializeProject` を throw せず通る形状。
  - `validateCommitRows`:未知 fullName / 空 rows / 非数 practiceDate を検出。
- サーバー endpoint テスト(一時 `dataDir` + `createApi`、sensor-import テストに倣う):
  - 新規作成 vs 既存(practiceDate 一致)への append。
  - locked 時 401、未知 fullName で 400。
  - AI 経路はクライアント側のため Gemini モック不要。AI 応答検証は `parseAiMinutes` の単体テストで、
    fetch はそちらでスタブ。

## 8. 未解決事項

なし(要決定はブレストで確定:保存単位=案(a) 練習日1プロジェクト、同一部員=1反省にマージ、
AIなし整形=フォールバックボタンあり、保存ロジック=新規サーバー endpoint)。
