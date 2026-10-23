# 組織の切り替えとアカウントでの書き込み 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アカウントでログインした組織メンバーが、表示中の組織を切り替えて、その組織の練習・反省・進捗・全体目標を旧 API 経由で読み書きできるようにする。練習は ID で見分け、名前の重複を許す。

**Architecture:**
- **主体:** `X-Sailviz-Org` ヘッダーから主体(`user`)に `activeOrgId` を持たせる。`policy.js` はメンバーなら書けるルールに変え、`compatAccess.js` は表示中の組織の外の項目を「読めない・書かない」として扱う。
- **リポジトリ:** DB 版は練習を `practice_days.id` で引き、ロードマップの同期を組織の中に限る。ファイル版は `id === 名前` で今の動きを保つ。
- **Web:** 表示中の組織を `localStorage` に覚え、全リクエストにヘッダーを付け、練習を ID で扱う。

**Tech Stack:** Node.js 24(`node:sqlite`)、依存なしの HTTP サーバー、バニラ JS のフロント、`node --test`。

**Spec:** `docs/superpowers/specs/2026-10-22-org-switch-account-write-design.md`(以下「設計書」。§番号はそれを指す)

## Global Constraints

- **テストの実行:**
  - Node ≥22.5 が必要(`node:sqlite`)。ローカルは `/Users/reimurase/Documents/sailviz/.superpowers/node24/bin/node --test` を使う(以下 `NODE24`)。
  - DB のテストは既存と同じく `skip`(Node が古ければ飛ばす)の流儀に合わせる。
- **ヘッダー名は `X-Sailviz-Org`**(Node では `req.headers['x-sailviz-org']`)。値は組織 ID。
- 所属していない組織のヘッダーは `403 { error: 'org_forbidden' }`。
- **ヘッダーが無いときの表示中の組織:** 所属組織の先頭。`accounts.listMembershipsOfUser` の順で、`/api/me` の `orgs[0]` と同じ。
- **共有ログインの主体(`kind: 'legacy'`)と、ファイル版(`STORAGE=file`):** 動きを変えない。共有ログインはヘッダーを無視する。
- **新しい反省・ロードマップの行の所有者は NULL のまま**(`reflections.author_user_id`・`roadmaps.user_id`)。公開範囲の既定は今の `decomposeProject` のまま(`org`)。
- **練習 ID の形:**
  - DB 版は `pd_` + 16 進 10 桁(`genId('pd')`)。
  - ファイル版はファイル名(`isValidProjectName` を満たすもの)。
- テストは合成データだけを使う。実名・実位置・資格情報は使わない(既存テストの冒頭の注意と同じ)。
- コメントは日本語で、既存の密度に合わせる。依存パッケージは足さない。

## Review Focus

実装後、レビューで特に確かめること(起きやすい順):

1. **共有ログインの全体目標と、アカウントの全体目標が同じ組織を指しているとき。** 書き込みトークンで `__team__` を保存したら、同じ組織のアカウントにも見える。他の組織の `__team__` は変わらない(Task 5 のテスト `roadmap: 2 組織の __team__ は別々に保存され、片方の PUT で他方が変わらない`)。
2. **反省 ID がファイル間で重複しているとき。** 進捗のキーが同じで、反省が 2 つの組織にまたがる場合、片方の組織のアカウントが進捗を PUT しても、もう片方の進捗は変わらない(Task 4 のテスト `mergeProgressWrite: 表示中の組織の外にも同じ反省 ID があれば書かない`)。
3. **表示中の組織を外された人。** 招待で入ったあと組織から外された人が古いヘッダーで呼ぶと 403。Web はこれを受けたら `/api/me` を読み直して組織を選び直す(Task 8 のテスト `403 org_forbidden で表示中の組織を消して me を読み直す`)。
4. **同じ名前の練習が 2 つの組織にあるとき。** それぞれを ID で開け、片方を保存・削除しても他方が変わらない(Task 7 のテスト `同名の練習が 2 組織にあっても ID で別々に読み書き・削除できる`)。
5. **書き戻し(`exportToFiles`)で名前が重なったとき。** 2 つの器が同じ `legacy_name` を持つと、ファイルが上書きされて片方が消える。2 つ目以降を別名で書く(Task 5 のテスト `exportToFiles: 同名の器は上書きせず別名で書き出す`)。

---

### Task 1: `practice_days.legacy_name` の一意制約を外すマイグレーション

**Files:**
- Create: `server/db/migrations/005_practice_day_name_not_unique.sql`
- Test: `test/db-schema.test.js`(既存に追記)

**Interfaces:**
- Produces: `practice_days.legacy_name` に同じ値を複数入れられる。列と順番は `001_data.sql` と同じ。`legacy_name` に一意でない索引 `idx_practice_days_legacy_name` を付ける。

- [ ] **Step 1: 失敗するテストを書く**
  テスト名は `005: practice_days.legacy_name は重複できる・既存行と列は保たれる`。
  - 001〜004 を当てて 1 行入れ、005 を当てる。
  - 同じ `legacy_name` の 2 行目を INSERT できる。
  - 1 行目の全列が当てる前と一致する。
  - `PRAGMA index_list(practice_days)` に `idx_practice_days_legacy_name` があり、`unique` が 0。
- [ ] **Step 2:** `NODE24 --test test/db-schema.test.js` → FAIL(UNIQUE constraint failed)を確かめる。
- [ ] **Step 3: SQL を書く**
  - SQLite の手順で作り直す: `CREATE TABLE practice_days_new (...)` → `INSERT … SELECT` → `DROP` → `ALTER TABLE … RENAME` → 索引を作り直す。
  - `001_data.sql` の `practice_days` 定義を写し、`UNIQUE` だけ外す。他の表から `practice_days` への外部キー参照があれば、`001_data.sql` で確かめて壊さない。
- [ ] **Step 4:** 同じテストと `test/db-migrate*.test.js` を回して PASS を確かめる。
- [ ] **Step 5:** コミットする(`feat(db): practice_days.legacy_name の一意制約を外す`)。

### Task 2: `policy.js` — 表示中の組織と、メンバーなら書けるルール

**Files:**
- Modify: `server/domain/policy.js`
- Test: `test/policy.test.js`

**Interfaces:**
- Produces:
  - `user(userId, orgIds = [], activeOrgId = null)` → `{ kind: 'user', userId, orgIds, activeOrgId }`
  - `activeOrgOf(subject) -> string|null`
    - `user` なら `activeOrgId`。
    - 共有の `legacy` なら `orgId`。
    - それ以外は `null`。
  - `canWrite(subject, target)` の `user` 主体の規則(§5.4)
    - `session`・`reflection`: 作成者、または「組織メンバー かつ `canRead` かつ visibility が `private` でない」。
    - `roadmap`・`race`: 作成者、または組織メンバー。
    - `minutes`: 今のまま。
    - `voice`: 作成者だけ。
  - 共有ログインの分岐は変えない。

- [ ] **Step 1: 失敗するテストを書く**
  - `user 主体: 組織メンバーは作成者でない org・public の反省とセッションを書ける`
  - `user 主体: private は作成者だけが書ける`
  - `user 主体: roadmap はメンバーなら作成者なし(ownerId null)の行も書ける`
  - `user 主体: 他組織の public は読めても書けない`
  - `voice は作成者だけ(メンバーでも不可)`
  - `activeOrgOf: user / legacy / anonymous`
- [ ] **Step 2:** `NODE24 --test test/policy.test.js` → 新しいテストが FAIL することを確かめる。
- [ ] **Step 3:** 上の Interfaces どおりに実装する。既存のテストで変わるのは「user は作成者だけ」を期待しているものだけ。それらは設計書 §5.4 に合わせて期待値を直す(どれを直したかをコミットメッセージに書く)。
- [ ] **Step 4:** `test/policy.test.js` を回して PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 3: 主体に表示中の組織を入れる(`compatPrincipal.js`)

**Files:**
- Modify: `server/compatPrincipal.js`
- Test: `test/compat-principal.test.js`

**Interfaces:**
- Consumes: Task 2 の `user(userId, orgIds, activeOrgId)`
- Produces: `resolveSubject(req, opts)` の `user` 主体は次のどれか。
  - ヘッダーなし: `activeOrgId = orgIds[0] ?? null`
  - ヘッダーが所属組織: `activeOrgId = その ID`
  - ヘッダーが所属外: `{ ...user(userId, orgIds, null), orgForbidden: true }`
  - 共有ログイン(書き込みトークン・閲覧ゲート優先の分岐)はヘッダーを無視する(§5.8)。

- [ ] **Step 1: 失敗するテストを書く**
  - `ヘッダーなしの user は所属の先頭が activeOrgId`
  - `所属組織のヘッダーで activeOrgId がその組織になる`
  - `所属外のヘッダーは orgForbidden: true`
  - `所属ゼロの user はヘッダーなしで activeOrgId null`
  - `書込トークン・閲覧 Cookie 優先の主体はヘッダーを無視する`
- [ ] **Step 2:** `NODE24 --test test/compat-principal.test.js` → FAIL を確かめる。
- [ ] **Step 3:** 実装する。ヘッダーの値は前後の空白を落とし、空文字は「ヘッダーなし」として扱う。
- [ ] **Step 4:** 同じテストを回して PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 4: `compatAccess.js` — 表示中の組織の中だけを読み書きする

**Files:**
- Modify: `server/domain/compatAccess.js`
- Test: `test/compat-access.test.js`

**Interfaces:**
- Consumes: Task 2 の `activeOrgOf`
- Produces:
  - `isCompatWriter(s)`: 今の共有ログインの条件、または `s.kind === 'user' && s.activeOrgId != null && !s.orgForbidden`。
  - `inScope(subject, orgId) -> boolean`
    - `user` なら `orgId === subject.activeOrgId`。
    - `legacy` なら常に `true`(今の動きを保つ)。
  - 次の関数は、`inScope` が偽の項目を「読めない」として扱う。読み取りでは出さず、書き込みでは既存のまま残す。
    - `canSeeProject`・`filterProject`・`canPutDay`・`canDeleteDay`
    - `filterProgressRead`・`mergeProgressWrite`
    - `filterRoadmapRead`・`mergeRoadmapWrite`
    - `managedReflectionPredicate`
  - これらの関数の引数(型)は変えない。

- [ ] **Step 1: 失敗するテストを書く**
  - `isCompatWriter: activeOrgId のある user は書き手、orgForbidden は書き手でない`
  - `canSeeProject: user は表示中でない組織の器を(public でも)見ない`
  - `canPutDay / canDeleteDay: user は表示中の組織の器だけ`
  - `mergeProgressWrite: 表示中の組織の外にも同じ反省 ID があれば書かない`(Review Focus 2)
  - `mergeProgressWrite: 表示中の組織の反省の進捗は作成者でなくても書ける`
  - `filterRoadmapRead / mergeRoadmapWrite: user は表示中の組織の行だけ読み書きし、新しい名前は書き手として作れる`
  - `legacy 主体の結果は今と同じ`(既存テストがそのまま通ることで確かめる)
- [ ] **Step 2:** `NODE24 --test test/compat-access.test.js` → FAIL を確かめる。
- [ ] **Step 3:** 実装する。目標の組み立て(`sessionTarget`・`reflectionTarget`・`roadmapTarget`)が `orgId` を持っているので、そこで `inScope` を見る。
- [ ] **Step 4:** `test/compat-access.test.js`・`test/policy.test.js` を回して PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 5: DB 版 repo — 練習を ID で引く・ロードマップを組織の中で同期する

**Files:**
- Modify: `server/repos/dbRepo.js`、`server/db/roadmapSync.js`、`server/db/exportToFiles.js`
- Test: `test/db-repo.test.js`、`test/roadmap-keep-relinked.test.js`、`test/db-export.test.js`

**Interfaces:**
- Consumes: Task 1(名前の重複可)
- Produces(以降、引数 `id` は `practice_days.id`):
  - `listProjects() -> [{ id, name, label }]`(並びは今と同じく `legacy_name` の降順。同名なら `id` 順)
  - `readProject(id)`・`getProjectAccess(id)`・`readProjectWithAccess(id)`・`deleteProject(id)`
  - `writeProject(id, obj, opts)`: 既存の器だけを更新する。無ければ `Error`(`code: 'not_found'`)。
  - `createProject(obj, { name, orgId, managedReflection }) -> { id, name }`(新しい器を作る)
  - `findProjectsByPracticeDate`・`findProjectByPracticeDate`・`findReflectionByDate`・`findReflectionsByDate`: 要素は `{ id, name, label }`。
  - `readOverlay('roadmap', { orgId } = {})`: `orgId` を渡すと `roadmaps.org_id = orgId` の行だけ。渡さなければ今と同じ。
  - `writeOverlay('roadmap', obj, { orgId, scopeOrgId })`: `scopeOrgId` を渡すと、突き合わせ・削除の対象を `org_id = scopeOrgId` の行に限る。新しい行は `orgId` に入る。
  - `listRoadmapAccess({ orgId } = {})`: 同じ絞り込み。
  - `syncRoadmaps(db, rows, { orgId = null, scopeOrgId } = {})`: `scopeOrgId` が `undefined` なら今と同じ(取込みが使う)。
  - progress の `readOverlay`・`writeOverlay` は変えない(絞り込みは Task 4 の merge が担う)。

- [ ] **Step 1: 失敗するテストを書く**
  - `listProjects は id・name・label を返す`
  - `同じ名前の器を 2 つ作れて、ID で別々に読める`
  - `writeProject は無い ID で not_found を投げる`
  - `createProject は orgId の器を作り id を返す`
  - `findProjectsByPracticeDate は id を返す`
  - `roadmap: 2 組織の __team__ は別々に保存され、片方の PUT で他方が変わらない`(Review Focus 1。`writeOverlay(..., { orgId: A, scopeOrgId: A })` を 2 組織で行い、`readOverlay('roadmap', { orgId: B })` が不変)
  - `syncRoadmaps: scopeOrgId なしは今と同じ`(既存の `roadmap-keep-relinked` が通ること)
  - `exportToFiles: 同名の器は上書きせず別名で書き出す`(Review Focus 5。2 つ目は `<名前から .sailviz.json を除いたもの>-<id>.sailviz.json`)
- [ ] **Step 2:** 3 つのテストファイルを回して FAIL を確かめる。
- [ ] **Step 3:** 実装する。
  - `getPd` を `WHERE id = ?` にする。
  - `writeProject` の新規作成の分岐を `createProject` に移す。
  - 取込み(`importFromFiles`)は `legacy_name` での突き合わせを続けるので、変えない。
- [ ] **Step 4:** `NODE24 --test test/db-*.test.js test/roadmap-*.test.js` を回して PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 6: ファイル版 repo — `id === 名前`

**Files:**
- Modify: `server/repos/fileRepo.js`
- Test: `test/server-filerepo.test.js`

**Interfaces:**
- Produces: Task 5 と同じ名前と形の関数。
  - `id` はファイル名。
  - `createProject(obj, { name }) -> { id: name, name }`。すでにファイルがあれば `Error`(`code: 'exists'`)。
  - `writeProject(id, obj)`: 無いファイルなら `not_found`。
  - `readOverlay`・`writeOverlay` は `{ orgId, scopeOrgId }` を受けても無視する。

- [ ] **Step 1: 失敗するテストを書く**
  - `listProjects の id は name と同じ`
  - `createProject は既存名で exists`
  - `writeProject は無い名前で not_found`
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** `NODE24 --test test/server-filerepo.test.js test/open-repo.test.js` を回して PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 7: 旧 API のルート — ID・表示中の組織・アカウントでの書き込み

**Files:**
- Modify: `server/routes/compat.js`、`server/storage.js`(ID の検査)
- Test: Create `test/server-org-switch.test.js`。Modify `test/server-compat-policy.test.js`・`test/server-api.test.js`・`test/server-api-db.test.js`(名前で PUT して作っていた種まきを `POST` に直す)

**Interfaces:**
- Consumes: Task 3〜6
- Produces(HTTP):
  - **一覧:** `GET /api/projects` → `[{ id, name, label }]`。`GET /api/summaries` → 要素に `id` を足す。
  - **1 件:** `GET/PUT/DELETE /api/projects/:id`
    - `:id` は `isValidProjectId(id)` を満たすこと: `isValidProjectName(id) || /^pd_[0-9a-f]{10}$/.test(id)`。`storage.js` に置く。
    - PUT は既存の器だけ。無ければ 404。
  - **新規:** `POST /api/projects`、本文 `{ name, project }` → `201 { id, name }`
    - `name` は `isValidProjectName` を満たすこと。
    - 器の組織は `activeOrgOf(writer)`。
    - ファイル版で同名があれば `409 { error: 'exists' }`。
  - **主体の検査:** `orgForbidden` の主体は、旧 API のどの読み書きでも `403 { error: 'org_forbidden' }`。
  - **ロードマップ:** `GET/PUT /api/overlays/roadmap` は、`readOverlay`・`listRoadmapAccess`・`writeOverlay` に `{ orgId: activeOrgOf(s), scopeOrgId: activeOrgOf(s) }` を渡す(共有ログインでも同じ。`MIGRATION_ORG_ID` の組織になる)。
  - **取込み:**
    - `POST /api/minutes-imports/commit` の応答を `{ id, name, added, created }` にする。新規は `createProject` を使う。
    - `POST /api/sensor-imports` の `matched` の要素に `id` を足す。
    - `POST /api/sensor-imports/:importId/commit` の本文は `{ id, boatNumber }` にする(`name` は受けない)。

- [ ] **Step 1: 失敗するテストを `test/server-org-switch.test.js` に書く**
  準備: 2 組織 A・B に入ったユーザー X、A だけのユーザー Y、書き込みトークン(`migrationOrgId: A`)。
  - `X はヘッダー B で B の練習だけが一覧に出る(A の public も出ない)`
  - `X はヘッダーなしで所属の先頭の組織の一覧になる`
  - `X は作成者でない A の練習・反省を PUT でき、B の器への PUT は 403`
  - `X が POST した練習はヘッダーの組織に入る`
  - `同名の練習が 2 組織にあっても ID で別々に読み書き・削除できる`(Review Focus 4)
  - `X が A と B の __team__ をそれぞれ保存でき、互いに変わらない`
  - `所属外のヘッダーは GET・PUT とも 403 org_forbidden`
  - `書き込みトークンは今までどおり A を読み書きし、ヘッダーを無視する`
  - `進捗 PUT は表示中の組織の反省だけを変える`
- [ ] **Step 2:** `NODE24 --test test/server-org-switch.test.js` → FAIL を確かめる。
- [ ] **Step 3:** 実装する。
  - `gateRead`・`gateWrite` の先頭で `orgForbidden` を 403 にする。
  - `putProject` の組織を `activeOrgOf(s)` にする。
  - 旧テストのうち「ログインユーザーの PUT は 403」(`server-compat-policy.test.js` の `(1) ログインユーザーの互換 PUT・DELETE・オーバーレイ PUT は 403`)は、設計で動きが変わる。「表示中の組織の器なら書ける・他組織は 403」に書き換える。
- [ ] **Step 4:** `NODE24 --test` で全テストを回し、PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 8: Web — 練習を ID で扱い、ヘッダーを付ける

**Files:**
- Create: `src/activeorg.js`
- Modify: `src/api.js`、`src/store.js`、`src/app.js`
- Test: `test/api-client.test.js`、Create `test/activeorg.test.js`

**Interfaces:**
- Consumes: Task 7 の HTTP
- Produces:
  - `src/activeorg.js`
    - `getActiveOrgId() -> string|null`(`localStorage` キー `sailviz.activeOrg.v1`。読み書きは try/catch で囲む)
    - `setActiveOrgId(id|null)`
    - `resolveActiveOrg(orgs) -> string|null`: 覚えている ID が `orgs` にあればそれ、無ければ `orgs[0]?.id ?? null`。結果を保存し直す。
  - `src/api.js`
    - すべての `fetch` に、`getActiveOrgId()` があれば `X-Sailviz-Org` を付ける。
    - 403 で本文が `org_forbidden` のときは `setActiveOrgId(null)` してから投げる。
    - 新規作成は `apiCreateProject(name, obj) -> { id, name }`(`POST /api/projects`)。
    - `apiGetProject`・`apiPutProject`・`apiDeleteProject` は引数を `id` にする。
  - `src/store.js`: `createProject(name, obj)` を足す。`readProject`・`writeProject`・`deleteProject` は `id` を取る。
  - `src/app.js`
    - `state.currentFileName` を `state.currentProjectId`(と表示用の `state.currentProjectName`)に分ける。
    - 新規の保存は `createProject` を使う。採番(`uniqueProjectName`)は一覧の名前を使うまま。
    - 一覧のカード(開く・削除・日のサマリ)は `it.id` を使う。
    - `loadProjectEntries` は `{ id, name, project }` を返す。

- [ ] **Step 1: 失敗するテストを書く**
  - `activeorg: resolveActiveOrg は所属に無い ID を捨てて先頭にする`
  - `activeorg: localStorage が投げても null で動く`
  - `api: 表示中の組織があれば X-Sailviz-Org を付ける`
  - `api: apiCreateProject は POST /api/projects に { name, project } を送り { id, name } を返す`
  - `403 org_forbidden で表示中の組織を消して me を読み直す`(Review Focus 3。消すのは `api.js`。me の読み直しは起動時の `resolveActiveOrg` が担う、とテストで確かめる)
- [ ] **Step 2:** `NODE24 --test test/api-client.test.js test/activeorg.test.js` → FAIL を確かめる。
- [ ] **Step 3:** 実装する。
  - 起動時(`app.js` の起動処理)に `GET /api/me` を読む。成功したら `resolveActiveOrg(me.orgs)` を呼ぶ。失敗(401・503)なら何もしない(共有ログイン・ファイル版)。
  - `app.js` の名前の参照は `grep -n "currentFileName\|\.name)" src/app.js` で洗い出す。
- [ ] **Step 4:** `NODE24 --test` で全テスト(`dom-smoke`・`html-ids` を含む)を回し、PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 9: 組織管理の画面に切り替えボタンを出す

**Files:**
- Modify: `src/account/main.js`、`src/account/logic.js`、`src/account/account.css`
- Test: `test/account-web.test.js`

**Interfaces:**
- Consumes: Task 8 の `getActiveOrgId`・`setActiveOrgId`・`resolveActiveOrg`
- Produces:
  - `logic.js` に `orgSwitchItems(orgs, activeId) -> [{ id, name, active }]` を足す。所属が 1 つ以下なら `[]`。
  - `main.js` の組織の画面(`renderOrgHome`)の先頭に、ボタン群を出す。
    - 群の id は `ac-org-switch`。各ボタンは `data-org-id` を持つ。表示中のものは `aria-pressed="true"`。
    - 押すと `setActiveOrgId` し、その組織で組織の画面を描き直す。
    - 画面の `me.org` は、表示中の組織で置き換えて描く。

- [ ] **Step 1: 失敗するテストを書く**
  - `orgSwitchItems: 所属 1 つなら空`
  - `orgSwitchItems: 表示中に active`
  - `組織の画面: 2 組織ならボタンが 2 つ出て、押すと表示中が変わる`(既存の `account-web.test.js` の DOM テストの組み方に合わせる)
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** `NODE24 --test test/account-*.test.js` を回して PASS を確かめる。
- [ ] **Step 5:** コミットする。

### Task 10: staging で確かめる(手作業)

**Files:** なし

- [ ] **Step 1: ブランチ全体を回す**
  - `NODE24 --test` で全テストを回し、PASS の件数を記録する。
  - `node -c` 相当の起動確認として、`STORAGE=db DATA_DIR=<一時> NODE24 server/index.js` が起動ログを出す。
- [ ] **Step 2: staging へデプロイする**(利用者の確認を取ってから)
  - deploy 用の worktree(`/Users/reimurase/Documents/sailviz-deploy` のやり方)から `fly deploy -a sailviz-sit-staging` する。
  - 起動時に migration 005 が当たる。
  - 先に `/data/sailviz.db` を `VACUUM INTO` でバックアップする。
- [ ] **Step 3: 設計書 §7 の完了条件を staging で確かめる**
  - rei(2 組織)で切り替えると、全体目標と練習一覧が変わる。
  - 「芝浦工業大学体育会ヨット部」の全体目標を保存しても、sityacht 側は変わらない。
  - 1 組織だけのアカウント(本間さん)にはボタンが出ず、保存できる。
  - 書き込みトークンでの保存が今までどおり動く。
