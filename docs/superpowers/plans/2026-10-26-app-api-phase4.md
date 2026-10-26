# アプリ向け API（Phase 4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** フィールドアプリが呼ぶ Phase 4 の API（反省・ロードマップ・進捗とコメント・練習日・レース記録）をサーバに作り、アプリの反省画面で前回のリグ設定を埋める。

**Architecture:** `routes/sessions.js` と同じ形の route モジュールを3つ（`me.js`・`reflectionExtras.js`・`practiceDays.js`）足し、DB 窓口を `repos/appRepo.js` に置く。認可は `domain/policy.js` だけで判断する。練習日の器を決める `dayFor` は sessionsRepo から `repos/practiceDayFor.js` に切り出して共用する。Web の互換保存がアプリの反省・新 API のコメントを消さないよう、`dbRepo.writeProject` と `compatAccess.mergeProgressWrite` に守りを足す。

**Tech Stack:** Node 24（`node:sqlite`・`node:test`、依存ゼロ）／Flutter + Riverpod（アプリ）

**Spec:** `docs/superpowers/specs/2026-10-26-app-api-phase4-design.md`

## Global Constraints

- エラーは `{ error: { code, message } }`。未ログイン 401 `unauthorized`、所属外の `X-Sailviz-Org` は 403 `org_forbidden`、読めないものは 404 `not_found`、入力不正は 422 `invalid_input`、本文 64KB 超は 413 `too_large`、DB でないとき 503 `unavailable`。
- 認可は `policy.js` の関数だけで判断する。route に新しい規則を書かない。
- 組織は `subject.activeOrgId`（`X-Sailviz-Org`）。
- 既存マイグレーション 001〜006 は書き換えない。足すなら `007_app_api.sql`。
- 互換 API（`/api/projects`・`/api/overlays`）の今の応答を変えない（守りの追加を除く）。
- テストデータは合成のみ（`@example.test`、実名・実位置なし）。
- サーバの CLAUDE.md：commit は利用者の指示があるときだけ。各タスクの Commit ステップは、利用者が commit を許可した場合に行う。
- ブランチ：サーバは `develop` から `feat/app-api-phase4`、アプリは `main` から `feat/reflection-prefill-previous-rig`。

## Review Focus

1. **日付の形の揺れ**：`practice.date` が `2026/10/03`・`2026-10-03`・`2026/1/3`、`startMs` だけ、どちらも無い — 前の3つは同じ JST 日の器に入り、最後は 422。（Task 2 にテスト）
2. **反省の再送で行が増える**：同じ `reflId` の PUT を2回 → 行は1つ、`created_at` は最初のまま。（Task 2）
3. **Web がアプリの反省を知ったうえで編集**：Web が読んでからアプリの反省の本文を直して保存 → 本文は直り、消えも二重にもならない。（Task 3）
4. **反省画面で先に打った値を後から上書き**：前回リグの取得が遅れ、その間に利用者が艇番を打った → 打った値を消さない。（Task 8）
5. **他人の private 反省 ID での探り**：progress/comments/practice-days に他人の private 反省・器を指定 → すべて 404 で、存在しない ID と同じ応答。（Task 5・6）

---

### Task 1: 共通の土台（dayFor の切り出し・JSON ヘルパ・テストの土台・007）

**Files:**
- Create: `server/repos/practiceDayFor.js`
- Modify: `server/repos/sessionsRepo.js`（`jstDate` と `dayFor` を practiceDayFor.js から使う。`jstDate` は再 export して既存の import を壊さない）
- Create: `server/routes/jsonApi.js`
- Create: `server/db/migrations/007_app_api.sql`
- Create: `test/helpers/apiHarness.js`
- Test: `test/practice-day-for.test.js`

**Interfaces:**
- Produces:
  - `jstDate(ms: number): string`（'YYYY-MM-DD'）
  - `dayFor(db, { orgId: string|null, ownerUserId: string, firstPointMs: number, now: number }): practice_days 行`（今の sessionsRepo の dayFor と同じ挙動）
  - `practiceDateToMs(practice: object|undefined): number|null` — `practice.startMs` が有限数ならそれ、無ければ `practice.date`（`YYYY/M/D` か `YYYY-MM-DD`、区切り `/` `-`）の JST 0:00 の ms、どちらも無理なら null
  - `jsonApi.js`: `err(res, status, code, message)`、`readJson(req, limit = 64*1024): Promise<object>`（空本文は `{}`、超過は `e.code='too_large'`、壊れた JSON は `e.code='bad_json'`）
  - `apiHarness.js`: `startApi(): Promise<{ base, db, accounts, repo, mkUser(), mkOrg(...members), call(method, path, tok, body?, headers?), close() }>` — `test/sessions-api.test.js` の before/after と mkUser/mkOrg/call をそのまま関数にしたもの（Task 2 以降で app repo も渡す）
  - `007_app_api.sql`: `CREATE INDEX idx_reflections_author ON reflections (author_user_id);` と `CREATE INDEX idx_reflections_day ON reflections (practice_day_id);`

- [ ] **Step 1: 失敗するテストを書く** — `test/practice-day-for.test.js`
  - `practiceDateToMs({ date: '2026/10/03' })`・`({ date: '2026-10-03' })`・`({ date: '2026/1/3' })` はそれぞれ `Date.UTC(2026,9,2,15)`・同じ・`Date.UTC(2026,0,2,15)`
  - `practiceDateToMs({ startMs: 123, date: '2026/10/03' }) === 123`
  - `practiceDateToMs({})`・`(undefined)`・`({ date: '10/03' })`・`({ date: '2026/13/40' })` は null
  - `dayFor` を同じ組織・同じ日で2回呼ぶと同じ id、組織 null なら `owner_user_id` が入る（:memory: DB に migrate して確認）
- [ ] **Step 2: 実行して失敗を確認** — `node --test test/practice-day-for.test.js` → FAIL（モジュールが無い）
- [ ] **Step 3: 実装** — `dayFor` は sessionsRepo の本体を移す（`emptyProject`・`uniqueProjectName`・`jstMidnightMs` を使う）。sessionsRepo は `dayFor(db, …)` を呼ぶ形に置き換える。
- [ ] **Step 4: 実行して通ることを確認** — `node --test test/practice-day-for.test.js test/sessions-api.test.js` → PASS
- [ ] **Step 5: Commit** — `refactor: 練習日の器を決める処理を共用にし、アプリ向け API の土台を足す`

### Task 2: 反省 API（`/api/me/reflections`）

**Files:**
- Create: `server/repos/appRepo.js`
- Create: `server/routes/me.js`
- Modify: `server/api.js`（`createApi` に `app` を受け、`sessionsRoute` の後に `meRoute` を試す）、`server/index.js`（`const app = db ? createAppRepo({ db }) : null;` を作って渡す）、`test/helpers/apiHarness.js`（app repo を渡す）
- Test: `test/me-reflections-api.test.js`

**Interfaces:**
- Consumes: Task 1 の `dayFor`・`practiceDateToMs`・`err`・`readJson`・`startApi`
- Produces（`createAppRepo({ db })` のメソッド）:
  - `findReflectionRows(reflId: string): row[]` — `json_extract(body,'$.id') = reflId` の行
  - `upsertMyReflection({ reflId, userId, orgId, body, visibility, legacyAuthorName, firstPointMs, now }): { ok: true, practiceDayId } | { ok: false, code: 'conflict' }`
  - `listMyReflections(userId, limit): Array<body & { visibility, practiceDayId }>`
  - `deleteMyReflection(reflId, userId, now): boolean`（消した行があれば true）
  - `reflectionTarget(row): { kind: 'reflection', visibility, ownerId, orgId }`（Task 5・6 も使う）
  - `reflectionJson(row)`: body に `visibility`・`practiceDayId` を足したもの（GET 一覧・Task 6 も使う）
- `createMeRoute({ app, accounts, now })` → `(req, res, ctx) => Promise<boolean>`。`app` が null のとき `/api/me/reflections*`・`/api/me/roadmap` は 503。それ以外の `/api/me*` は false を返す（authRoute の `/api/me` を邪魔しない）。

- [ ] **Step 1: 失敗するテストを書く** — `test/me-reflections-api.test.js`（`startApi()` を使う。反省の本文はアプリの `buildReflection` と同じ形の合成データ）
  - `PUT: 未ログインは 401`
  - `PUT → GET: 送った反省が新しい順に出て、visibility と practiceDayId が付く`（応答 `{practiceDayId}`、GET の要素の `notes.goal` が送った値、`authorUserId` が自分）
  - `PUT: 同じ reflId の再送は行が増えず created_at が変わらない`（`db` で行数 1）
  - `PUT: 日付の形の揺れは同じ器、日付が無ければ 422`（Review Focus 1）
  - `PUT: 日付を変えると別の器へ移る`
  - `PUT: X-Sailviz-Org の組織×日付の器に入り、組織が無ければ本人×日付`
  - `PUT: 他人の reflId は 409、作者なしの旧データの reflId も 409`
  - `PUT: visibility が不正なら 422、本文が配列なら 422`
  - `PUT: 互換 GET /api/projects/:id の reflections に同じ内容で出る`（`repo.readProject(practiceDayId).reflections` に body と deepEqual）
  - `GET: limit の既定は 20、上限は 100`
  - `DELETE: 自分の反省を消すと 204、GET から消え、進捗・コメントも消える。他人の反省は 404`（進捗は `db` に直接 `reflection_progress` 行を入れて確認）
  - `DELETE: 同じ body.id の別の行が残るときは進捗を消さない`
  - `DB でないとき（app 無し）は 503`
- [ ] **Step 2: 実行して失敗を確認** — `node --test test/me-reflections-api.test.js` → FAIL（404 no route）
- [ ] **Step 3: 実装** — PUT は設計書 §4 の順。保存する body は `{ ...受信, id: reflId, authorUserId: me.userId, origin: 受信.origin ?? 'app' }`。`legacyAuthorName` は `body.people?.[0]` か `displayNameFor(accounts.getUser(me.userId))`。並びは `COALESCE(json_extract(body,'$.createdAt'), created_at) DESC`。新しい行の id は `${pdId}_r_${randomBytes(4).toString('hex')}`、position は器の最大 + 1。書いた器（移動元・移動先とも）と、DELETE で消した行の器の `rev` を上げる。トランザクションで行う。
- [ ] **Step 4: 実行して通ることを確認** — `node --test test/me-reflections-api.test.js` → PASS、`npm test` → 全 PASS
- [ ] **Step 5: Commit** — `feat(reflections): アプリから反省を送る・前回の反省を取る API(/api/me/reflections)`

### Task 3: Web の古い画面からの保存でアプリの反省を消さない

**Files:**
- Modify: `server/repos/dbRepo.js`（`writeProject` で `incoming._rev` を消す前に取り、`syncManagedReflections` に渡す。冒頭コメントの「反省は incoming で置き換える」に守りの規則を書き足す）
- Test: `test/me-reflections-api.test.js` に追加

**Interfaces:**
- Consumes: Task 2 の PUT
- `syncManagedReflections(pdId, incomingRows, isManaged, { keepAppRows: boolean })` — `keepAppRows` が true のとき、incoming に無い managed 行のうち `author_user_id` が入っていて `body.origin` が `app` か `voice` の行は消さない。`keepAppRows = !(Number.isInteger(incoming._rev) && incoming._rev === existing.rev)`。
- managed でない経路（`opts.managedReflection` 無し）は policy が無いとき（アカウント無し）だけで、そのとき新 API は 503 なのでアプリの行は無い。変えない。

- [ ] **Step 1: 失敗するテストを書く**
  - `互換保存: Web が読んだ後にアプリが反省を足し、古い一覧で保存しても残る`（読む → PUT → `repo.writeProject(id, 古いproj, { managedReflection: () => true })` → `readProject` に残る）
  - `互換保存: Web がアプリの反省の本文を直して保存すると、本文が直り二重にならない`（Review Focus 3）
  - `互換保存: _rev が今の rev と一致すれば、Web はアプリの反省を消せる`
  - `互換保存: Web で作った反省（作者なし）は今までどおり消せる`
- [ ] **Step 2: 失敗を確認** — `node --test test/me-reflections-api.test.js` → 1件目が FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通ることを確認** — `npm test` → 全 PASS
- [ ] **Step 5: Commit** — `fix(compat): Web の古い画面からの保存で、アプリから送った反省を消さない`

### Task 4: ロードマップ API（`/api/me/roadmap`）

**Files:**
- Modify: `server/repos/appRepo.js`、`server/routes/me.js`
- Test: `test/me-roadmap-api.test.js`

**Interfaces:**
- Produces:
  - `getMyRoadmap(userId): { goal: string, milestones: object[] }`（無ければ `{goal:'', milestones:[]}`）
  - `putMyRoadmap({ userId, orgId, legacyName, goal, milestones, now }): { goal, milestones }` — 行があれば goal・milestones・updated_at だけ更新、無ければ `id = rm_<hex>` で作る
  - `legacyName` は route で `orgMemberEntries(accounts, orgId).find(e => e.userId === me.userId)?.legacyName ?? displayNameFor(user)`（組織が無ければ表示名）
- 検証：`goal` は文字列（2000 字まで）、`milestones` は 200 件までの配列で各要素 `{id: 空でない文字列, title: 文字列, done: 真偽, doneAt: 有限数|null}`。

- [ ] **Step 1: 失敗するテストを書く**
  - `GET: ロードマップの無い人は {goal:'', milestones:[]}`
  - `PUT → GET: 置き換えた内容が返る`
  - `PUT: 作った行は表示中の組織の互換 GET /api/overlays/roadmap（repo.readOverlay('roadmap', {orgId})）に表示名で出る`
  - `PUT: 旧データを付け替え済みの行は legacy_name・org_id を保って goal だけ変わる`（`db` に user_id 付きの行を入れて確認）
  - `PUT: milestones の形が違えば 422、未ログイン 401`
- [ ] **Step 2: 失敗を確認** — `node --test test/me-roadmap-api.test.js` → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通ることを確認** — `npm test` → 全 PASS
- [ ] **Step 5: Commit** — `feat(roadmap): 自分のロードマップの API(/api/me/roadmap)`

### Task 5: 進捗とコメント（`/api/reflections/:id/progress`・`/comments`）

**Files:**
- Create: `server/routes/reflectionExtras.js`
- Modify: `server/repos/appRepo.js`、`server/api.js`、`server/domain/compatAccess.js`（`mergeProgressWrite` で新 API のコメントを残す）
- Test: `test/reflection-extras-api.test.js`、`test/compat-access.test.js`（既存があれば追記、無ければ作る）

**Interfaces:**
- Consumes: `findReflectionRows`・`reflectionTarget`（Task 2）
- Produces:
  - `readableReflection(subject, reflId): { row, target } | null` — 行のうち `canRead` が通る最初のもの（route で共用）
  - `getProgress(reflId): { issueStage: number|null, goalDone: boolean, text: any }`
  - `putProgress(reflId, patch: { issueStage?, goalDone?, text? }, now)` — 渡したキーだけ更新、`extra` は保つ
  - `listComments(reflId): [{ id, field, text, ts, authorUserId }]`（ts の古い順。route で `authorName` を足す）
  - `addComment({ reflId, field, text, authorUserId, ts }): comment` — id は `${reflId}#${field}#${n}`（n はその field の既存件数）、`extra` は `JSON.stringify({ authorUserId })`（`decomposeProgress` と往復させるため）。進捗行が無ければ空の進捗行も作る（`assembleProgress` は進捗行がある反省のコメントしか返さない）
  - `keepNewApiComments(existingEntry, incomingEntry): incomingEntry` を `compatAccess.js` に足し、`mergeProgressWrite` の「既存あり・incoming あり・canCom」のところで使う：既存のコメントのうち `authorUserId` があり、incoming の同じ field に `ts` と `text` が同じものが無いものを、incoming の field の末尾に足す
- 検証：`issueStage` は整数か null、`goalDone` は真偽、`field` は 1〜50 字、`text` は 1〜2000 字。読めるが書けない PUT/POST は 403 `forbidden`。

- [ ] **Step 1: 失敗するテストを書く**
  - `progress: 本人は読み書きでき、同じ組織のメンバーは org の反省を読み書きできる`
  - `progress: 他人の private 反省は GET/PUT とも 404 で、存在しない ID と同じ応答`（Review Focus 5）
  - `progress: public の反省は組織外のログインユーザーが読めるが PUT は 403`
  - `comments: POST すると書いた人と名前が付いて GET に出る`
  - `comments: POST したコメントが互換 readOverlay('progress') に field の配列として出る`
  - `comments: text が空・2000 字超は 422、未ログイン POST は 401`
  - `keepNewApiComments: Web の古い進捗にないアプリのコメントを残し、Web で消した作者なしのコメントは残さない`（純関数のテスト）
- [ ] **Step 2: 失敗を確認** — `node --test test/reflection-extras-api.test.js` → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通ることを確認** — `npm test` → 全 PASS
- [ ] **Step 5: Commit** — `feat(reflections): 反省の進捗とコメントの API`

### Task 6: 練習日（`/api/practice-days`）

**Files:**
- Create: `server/routes/practiceDays.js`
- Modify: `server/repos/appRepo.js`、`server/routes/sessions.js`（`toJson` と `target` を `sessionJson(sessions, s)`・`sessionTarget(sessions, s)` として export し、route 内でも使う）、`server/api.js`
- Test: `test/practice-days-api.test.js`

**Interfaces:**
- Consumes: `reflectionTarget`・`reflectionJson`（Task 2）、`sessionJson`・`sessionTarget`、`policy.visibleDayItems`・`isMemberOfOrg`・`canRead`
- Produces:
  - `listDays({ scope, userId, orgId }): practice_days 行[]` — 候補だけ返す（mine：自分のセッション・乗員・反省がある器と `owner_user_id = userId`、org：`org_id = orgId`、public：public の中身がある器）。見える中身の絞り込みは route
  - `dayParts(pdId): { day, sessions: rec_sessions 行[], reflections: reflections 行[] }`
  - `patchDayWebState(pdId, webState, now)` — `tracks`・`reflections` キーを除いて web_state を置き換え、rev を上げる
- 器を見せる条件：`visibleDayItems(subject, 中身の target) が1つ以上` または `isMemberOfOrg(subject, day.org_id)` または（組織なしの器で）`owner_user_id === me.userId`。
- 一覧の要素：`{ id, date, name: legacy_name, orgId, sessionCount, reflectionCount }`（数は見える分、`date` の新しい順）。1件：`{ practiceDay: { id, date, name, orgId, webState }, sessions, reflections }`。
- `scope=mine` と `org` は要ログイン（401）、`public` は未ログイン可。`org` で表示中の組織が無ければ `[]`。不明な scope は 422。PATCH の権限は設計書 §7。

- [ ] **Step 1: 失敗するテストを書く**
  - `一覧 mine: 自分の反省だけがある器、自分が乗員の器が出る`
  - `一覧 org: 表示中の組織の器が出て、他人の private の反省は数に入らない`
  - `一覧 public: 未ログインでも public の中身がある器だけが出る`
  - `1件: 他人の private の反省しか無い組織外の器は 404 で、存在しない ID と同じ応答`（Review Focus 5）
  - `1件: 組織のメンバーには空の器も見え、見えない反省は reflections に入らない`
  - `PATCH: 組織のメンバーは webState を変えられ rev が上がり、tracks を送っても軌跡は変わらない`
  - `PATCH: 読めるが組織外の人は 403`
- [ ] **Step 2: 失敗を確認** — `node --test test/practice-days-api.test.js` → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通ることを確認** — `npm test` → 全 PASS（sessions-api も含む）
- [ ] **Step 5: Commit** — `feat(practice-days): 練習日の一覧・1件・注釈の API`

### Task 7: レース記録（`/api/race-records`）

**Files:**
- Modify: `server/routes/practiceDays.js`（同じ route に置く）、`server/repos/appRepo.js`
- Test: `test/race-records-api.test.js`

**Interfaces:**
- Consumes: `sessionJson`（Task 6）
- Produces: `listRaceRecords({ ownerUserId?: string }): [{ id, ownerUserId, raceDate, title, venue, sessionCount }]`（`race_date` の新しい順）、`raceRecordWithSessions(id): { raceRecord, sessions: rec_sessions 行[] } | null`
- `scope=mine` は要ログイン、`public`（既定）は未ログイン可。1件は誰でも読める。無ければ 404。

- [ ] **Step 1: 失敗するテストを書く**
  - `一覧 mine: 自分のレースだけ、未ログインは 401`（レースは `recordFull(me, { kind: 'race' })` 相当を apiHarness に足して作る）
  - `一覧 public: 未ログインでも全員のレースが新しい順に出る`
  - `1件: レース記録とセッションが返り、無い ID は 404`
- [ ] **Step 2: 失敗を確認** — `node --test test/race-records-api.test.js` → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通ることを確認** — `npm test` → 全 PASS
- [ ] **Step 5: Commit** — `feat(race-records): レース記録の一覧と1件の API`

### Task 8: アプリ — 反省画面で前回のリグ設定を埋める（sailviz-field）

**Files:**
- Modify: `lib/providers/reflection_providers.dart`（`previousRigProvider` を足す）、`lib/screens/reflection_screen.dart:82-87`（`previousRigData` が無いときに provider から取る）
- Test: `test/reflection_screen_prefill_test.dart`

**Interfaces:**
- Produces: `final previousRigProvider = FutureProvider.autoDispose<Map<String, dynamic>?>` — `reflectionRepositoryProvider.getMyReflections(limit: 1)` の結果を `ReflectionSummary(id: m['id'] as String, rig: normalizeRig(Map<String, dynamic>.from(m['rig'] as Map? ?? {})))` にして `previousRig()` に渡す
- `ReflectionScreen` は `previousRigData` が渡されたら今のまま。渡されないときは `ref.read(previousRigProvider.future)` を待ち、取れたら `notifier.prefillFromPreviousRig` と `_syncControllersFromPreviousRig` を呼ぶ。ただし **その時点でリグの入力欄のどれかに文字が入っていれば何もしない**（`initialSession` の艇番もこれで守られる）。取得の失敗（オフライン・404）は黙って無視する。`mounted` を確認する。

- [ ] **Step 1: 失敗するテストを書く** — `test/reflection_screen_prefill_test.dart`（`reflectionRepositoryProvider` を偽物で上書き。アメダスは既存テストと同じやり方で止める。`test/` 内の既存の ReflectionScreen テストのやり方に合わせる）
  - `前回の反省があればプリベンドとレーキが入力欄に入る`（偽の一覧 `[{id: 'refl1', rig: {prebend: 30, rake: 7.1}}]` → 欄に `30`・`7.1`）
  - `前回の反省が無ければ空のまま`
  - `取得に失敗しても画面が出て空のまま`
  - `取得が終わる前に艇番を打ったら、打った値を消さない`（Completer で取得を止め、`enterText` の後に complete）
- [ ] **Step 2: 失敗を確認** — `flutter test test/reflection_screen_prefill_test.dart` → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通ることを確認** — `flutter test` → 全 PASS、`flutter analyze` → No issues
- [ ] **Step 5: Commit** — `feat: 反省を書くとき、前回の反省のリグ設定を入力欄に入れる`

---

## 終わったら

- サーバ：`npm test` 全 PASS。ローカル起動（CLAUDE.md のダミー値。`STORAGE=db`）で、アプリを `--dart-define=SAILVIZ_BASE_URL=http://<Mac の IP>:8000` にして反省の保存 → ホームの「前回の反省」に出る → Web の練習に反省が出る、を手で確かめる。
- デプロイ（`sailviz-sit.fly.dev`）は利用者が行う。
