# アプリ向け API（移行計画 Phase 4）の設計

作成: 2026-10-26。正本: 設計書 v2 §5.2・§5.5〜§5.8・§10.1・§10.3・§10.5・§10.6、移行計画 Phase 4。

## 1. なぜ作るか

フィールドアプリ（sailviz-field）で反省を送ると `ApiException(404, {error: no route})` で失敗する。
アプリは設計書 §10.5 どおり `PUT /api/me/reflections/:reflId` を呼んでいるが、サーバは Phase 3（記録セッション）までしか作られておらず、`server/api.js` のどのルートにも当たらない。
同じ理由で、ホームの「前回の反省」（`GET /api/me/reflections`）とロードマップ（`GET/PUT /api/me/roadmap`）も失敗している。

利用者の決定（2026-10-26）：反省だけでなく **Phase 4 の API をまとめて作る**。

**完了条件（移行計画 Phase 4 のまま）**：アプリから反省・ロードマップ・ホームの表示・履歴が動く。互換 API 経由の Web と新 API 経由のアプリで、同じ反省が同じ内容に見える。

## 2. 範囲

### 作るもの（sailviz サーバ）

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /api/me/reflections?limit=n` | 要 | 自分の反省（新しい順） |
| `PUT /api/me/reflections/:reflId` | 要 | 反省1件を upsert → `{practiceDayId}` |
| `DELETE /api/me/reflections/:reflId` | 要 | 自分の反省1件を削除 |
| `GET /api/me/roadmap` / `PUT /api/me/roadmap` | 要 | `{goal, milestones: [{id, title, done, doneAt}]}` |
| `GET /api/reflections/:id/progress` / `PUT` | 閲覧権限／作成者・組織メンバー | `{issueStage, goalDone, text}` |
| `GET /api/reflections/:id/comments` / `POST` | 閲覧権限 | `{field, text}`（書いた人を記録） |
| `GET /api/practice-days?scope=mine\|org\|public` | scope 次第 | 練習日の軽量サマリ一覧 |
| `GET /api/practice-days/:id` | 閲覧権限 | 器と、見てよいセッション・反省・注釈 |
| `PATCH /api/practice-days/:id` | 組織メンバー／本人 | `{webState}` |
| `GET /api/race-records?scope=mine\|public` | scope 次第 | レース記録の一覧 |
| `GET /api/race-records/:id` | 不要 | レース記録とセッション一覧 |

### 作るもの（sailviz-field アプリ）

- 反省画面を開くとき、前回の反省のリグ設定で入力欄を埋める。`ReflectionScreen.previousRigData` は今どこからも渡されていない（ホーム `lib/screens/home_screen.dart:89`・声の反省の結果 `lib/screens/voice_reflect_result_screen.dart:102`）。`previousRig()`（`lib/data/reflection.dart:103`）に自分の反省一覧を渡した結果を使う。

### 作らないもの

- `GET /api/orgs/:orgId/members`：既にある（`server/routes/orgs.js`）。
- 声の反省・議事録（Phase 5）、Web の新 API への切り替え（Phase 6）。
- アプリ側の、進捗・コメント・練習日・レース記録の画面（アプリはまだ呼んでいない。API だけ用意する）。
- エラー文の日本語化など、アプリの見た目の変更。

### してはいけないこと（アンチゴール）

- Web で今見えている反省・進捗・コメント・ロードマップが見えなくなる、変わる、消える。
- アプリから送った反省が、Web の古い画面からの保存で消える。
- 読めない（他人の `private` など）反省・セッションの存在が、新 API の応答や 404/403 の違いで分かる。

## 3. 共通の決まり

- 既存の `routes/sessions.js` と同じ書き方にする：エラーは `{ error: { code, message } }`（§10.1）、本文は 64KB まで、`ctx.getSubject()` で主体を得る、`subject.orgForbidden` は 403 `org_forbidden`、未ログインは 401 `unauthorized`、読めないものは 404 `not_found`。
- 認可は `server/domain/policy.js`（`canRead`・`canWrite`・`canReadReflectionExtras`・`canComment`・`canUpdateProgress`・`visibleDayItems`）だけで判断する。新しい規則を route に書かない。
- DB（STORAGE=db）でないときは、該当パスを 503 `unavailable` にする（sessions と同じ）。
- 組織は `X-Sailviz-Org`（`subject.activeOrgId`）で決める。
- 新しい列・索引が要るときは `server/db/migrations/007_*.sql` で足す（001〜006 は書き換えない）。

## 4. 反省（`/api/me/reflections`）

### 保存の形（既存のまま）

- `reflections` の1行が反省1件。`id` は器×索引の合成 ID（`<pdId>_r_<hex>`）で、利用者が知っている反省 ID（`refl…`）は `body`（反省オブジェクト全体の JSON）の `id` にある（`server/domain/projectRows.js:88`）。
- 互換 API は `body` をそのまま Web に返す。だから新 API でも **`body` に反省オブジェクト（設計書 §5.5 の形）をそのまま入れる**。これで Web とアプリで同じ内容に見える。
- 進捗・コメントは `body.id`（`refl…`）をキーに持つ。

### PUT `/api/me/reflections/:reflId`

1. 本文を検証：オブジェクトであること、`visibility` が `private|org|public`、`practice.date`（`YYYY/MM/DD` か `YYYY-MM-DD`）または `practice.startMs` から日付が出せること。不正は 422 `invalid_input`。
2. 保存する body は、受け取った本文に `id = :reflId`・`authorUserId = 自分` を上書きしたもの（`origin` が無ければ `app`）。
3. `body.id = :reflId` の行を探す。
   - 自分の行（`author_user_id = 自分`）があればそれを更新（`body`・`visibility`・`session_id`・`legacy_author_name`・`updated_at`）。日付が変わって器が変わるなら、その行を新しい器へ移す。
   - 他人の行・作者なし（旧データ）の行にしか無ければ 409 `conflict`（存在を明かさないよう、読めない行でも同じ 409 にする）。
   - 無ければ新しい行を入れる。
4. 器は sessionsRepo の `dayFor` と同じ規則：表示中の組織があれば「組織×日付」、無ければ「本人×日付」。無ければ作る（Web の練習一覧に出る名前・`practiceDate` を持たせる）。`dayFor` は sessionsRepo から共用できる形に切り出す。
5. `legacy_author_name` は `body.people[0]`（無ければ表示名）。
6. 器の `rev` を上げる。
7. 応答 `200 {practiceDayId}`。同じ本文の再送は同じ結果になる。

### GET `/api/me/reflections?limit=n`

- `author_user_id = 自分` の行を、`body.createdAt`（無ければ `created_at`）の新しい順に `limit` 件（既定 20、上限 100）。
- 返すのは body の配列。各要素に `visibility`（列の値）と `practiceDayId` を足す。
- 表示中の組織では絞らない（自分のデータ。`GET /api/sessions?scope=mine` と同じ）。
- 旧データのうち名簿照合で付け替え済み（`author_user_id` が入ったもの）も含む。

### DELETE `/api/me/reflections/:reflId`

- 自分の行だけを消す。無ければ 404。成功は 204。
- その反省 ID の進捗・コメントも消す。ただし同じ `body.id` を持つ別の行（旧データの重複）が残る場合は消さない。
- 器の `rev` を上げる。

### Web の古い画面からの保存で消さない

`dbRepo.writeProject` は、Web が送ってきた反省に無い「書ける反省」を消す（`syncManagedReflections`）。Web が開いた後にアプリが足した反省は、Web の送る一覧に無いので消えてしまう。

**規則（Claude の判断）**：互換 PUT は、`author_user_id` が入っていて `body.origin` が `app` または `voice` の反省を消さない（更新は今までどおり受ける）。ただし Web が `_rev` を送り、それが器の今の `rev` と一致するとき（最新を見たうえでの削除）は消してよい。Web が `_rev` を送らない間は、アプリの反省を Web から消せないことになる（アプリから消せる）。

## 5. ロードマップ（`/api/me/roadmap`）

- `roadmaps.user_id = 自分` の行（`user_id` は UNIQUE なので1行）。
- GET：無ければ `{goal: '', milestones: []}`。あれば `{goal, milestones}`。
- PUT：`goal` は文字列、`milestones` は `{id, title, done, doneAt}` の配列（id・title は文字列、done は真偽、doneAt は数値か null）。全体を置き換える。不正は 422。
  - 行が無ければ作る：`org_id` は表示中の組織、`legacy_name` はその組織での本人の旧氏名（`orgMemberEntries` の legacyName）か、無ければ表示名。これで Web のロードマップ画面にも出る。
  - 行があれば `goal`・`milestones`・`updated_at` だけを変え、`org_id`・`legacy_name`・`extra` は保つ。
- 応答：PUT は `200 {goal, milestones}`。

## 6. 進捗とコメント（`/api/reflections/:id/...`）

- `:id` は反省 ID（`body.id`）。対象の行を探し、policy の target（`kind: 'reflection'`、`visibility`、`ownerId = author_user_id`、`orgId = 器の org_id`）を作る。同じ ID の行が複数あれば、主体が読める最初の行を使う。読めなければ 404。
- GET progress：`canReadReflectionExtras`。`{issueStage, goalDone, text}`（行が無ければ `{issueStage: null, goalDone: false, text: null}`）。
- PUT progress：`canUpdateProgress`（読めるが書けないなら 403 `forbidden`）。渡されたキーだけを更新し、`extra` は保つ。
- GET comments：`canReadReflectionExtras`。`[{id, field, text, ts, authorUserId, authorName}]`（`ts` の古い順）。
- POST comments：`canComment`。`field` は空でない文字列、`text` は 1〜2000 字。行の id は互換 API と同じ `<reflId>#<field>#<n>`（n はその field の次の番号）にし、Web の進捗画面にも出るようにする。応答は作ったコメント。
- **Web の古い画面の保存で消さない**：互換の進捗保存（`writeOverlay('progress')`）は全消しして入れ直すので、Web が読んだ後に新 API で足したコメントは消えてしまう。互換の進捗保存は、新 API で足したコメント（目印 `via: 'api'`）のうち Web の送ったものに無いものを残す。
  - **改訂（2026-10-26 利用者決定）**：コメントは名前付きでも Web から消せる。互換の `GET /api/overlays/progress` は読んだサーバの時刻を `X-Sailviz-Read-At` で返し、Web は保存のときに送り返す。保存に無い新 API のコメントは、読んだ時刻より前からあれば消し、後に足されたものだけ残す。時刻を送らない（古い画面の）保存では今までどおり残す。
- **Web のコメントには名前が要る（2026-10-26 利用者決定）**：Web のコメント欄で名前を名簿（議事録の取込と同じ `rosterForSubject`）から選ばせ、`author`（`fullName`）として保存する。互換の進捗保存は、新しく足したコメントの `author` が名簿に無ければ 400（議事録の「名簿外の fullName」と同じ）。前からある名前なしのコメントと AI コメント（`ai: true`）は問わない。新 API のコメントにも同じ形の名前（その組織での旧氏名、無ければ表示名）を付ける。

## 7. 練習日（`/api/practice-days`）

- 器の中身（セッション・反省）それぞれに policy の target を作り、`visibleDayItems` で絞る。見える中身が1つも無い器は「無い」扱い（一覧に出さない・GET は 404）。ただし器の組織のメンバーには、中身が空でも器を見せる（`isMemberOfOrg`）。
- GET 一覧：`[{id, date, name, orgId, sessionCount, reflectionCount}]`（数は見える分だけ、`date` の新しい順）。
  - `mine`：自分のセッション・自分が乗員のセッション・自分の反省のどれかがある器と、`owner_user_id = 自分` の器。
  - `org`：表示中の組織の器（表示中の組織が無ければ空配列）。
  - `public`：`public` の中身がある器。未ログインでも使える。
- GET 1件：`{practiceDay: {id, date, name, orgId, webState}, sessions: [...], reflections: [...]}`。sessions は sessions route の `toJson` と同じ形、reflections は §4 GET と同じ形。`webState` は web_state の JSON（注釈・表示設定）。
- PATCH：`{webState}`。器の組織のメンバー、または組織なしの器なら `owner_user_id` 本人だけ（それ以外は読めれば 403、読めなければ 404）。web_state を置き換えて `rev` を上げる。`webState` に `tracks`・`reflections` があれば無視する。

## 8. レース記録（`/api/race-records`）

- レースは常に全体公開（§5.4・policy の `race`）。
- GET 一覧：`[{id, ownerUserId, raceDate, title, venue, sessionCount}]`（`raceDate` の新しい順）。`mine` は `owner_user_id = 自分`（要ログイン）、`public` は全件。
- GET 1件：`{raceRecord: {...}, sessions: [...]}`。

## 9. テスト

`node:test`。既存の `test/server-*.test.js` と同じく、一時 DB でサーバを組み立てて HTTP で叩く。少なくとも：

- 反省：PUT → GET に出る、同じ本文の再送で行が増えない、日付を変えると器が移る、他人の ID は 409、DELETE 後に GET から消え進捗も消える、未ログイン 401、DB でないとき 503。
- **Web と同じに見える**：PUT した反省が互換 `GET /api/projects/:id` の reflections に同じ内容で出る。
- **消さない**：Web が読んだ後にアプリが反省を PUT し、Web が古い一覧で互換 PUT しても反省が残る。コメントも同じ。
- 公開範囲：`private` の反省は他人の progress/comments/practice-days で 404、`org` は同じ組織のメンバーだけ読める。
- ロードマップ：無い人は空、PUT → GET、作った行が互換 `GET /api/overlays/roadmap` に出る。
- 練習日：scope ごとの一覧、中身の絞り込み、PATCH の権限。
- レース記録：一覧と1件。

アプリ側は、プリフィルの配線に対するウィジェットテストを足す（前回の反省がある／無い）。

## 10. 配布

サーバはデプロイして初めてアプリから使える。デプロイ（`sailviz-sit.fly.dev`）は利用者が行う。アプリの変更はサーバのデプロイ前に入れてもよい（今と同じく失敗するだけ）。

## 11. 実装する人に任せること

- ファイルの分け方（例: `routes/me.js`・`routes/practiceDays.js`・`routes/raceRecords.js`・`repos/appRepo.js`）。
- 索引の追加（例: `reflections(author_user_id)`）の要否。
- `body.id` での探し方（`json_extract` か列の追加か）。列を足すなら 007 で既存行を埋める。

## 12. Claude の判断（利用者の確認待ち）

1. 互換 PUT はアプリ・声の反省を消さない（§4 の末尾）。
2. 互換の進捗保存は新 API のコメントを残す（§6）。
3. `GET /api/me/reflections` は表示中の組織で絞らない。
4. 反省の upsert で他人・旧データの ID と重なったら 409。
5. 練習日の器は、組織のメンバーには中身が空でも見せる。
6. ロードマップを新しく作るとき、`legacy_name` は旧氏名か表示名。
