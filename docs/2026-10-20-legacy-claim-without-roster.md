# 名簿なしで旧データ(`legacy_*`)を本人に付け替える方法(設計案 FZ3)

- 日付: 2026-10-20 / 種別: 設計案(コードなし。実装は FZ3-I、人の承認後)
- 正本: 設計書 v2(改訂5)§4.4・§5.1・§10.3・§11、移行計画 Phase 2、`server/rosterLink.js`、`server/repos/accountsRepo.js`
- **本書の API・表はすべて「案・要承認」**。設計書 v2 にまだ無い。承認までは決定として扱わない。

## 1. 目的と前提

- 2026-10-20 の利用者決定で、名簿の提出とメール照合、複数組織、メール変更などを凍結した。
  残す機能は、登録・ログイン・メール確認・パスワード再設定・アカウント削除・招待リンクによる参加・メンバー一覧・**旧氏名の付け替え**。
- これまで旧データ(部の Web で `projects/*.json` に溜まった反省・軌跡・ロードマップ)は、名簿の「旧名簿の氏名(`legacyName`)」と
  メール照合で本人に付いていた(設計書 §11)。名簿が凍結されると、この付け替えが動かなくなる。
- そこで、名簿なしに「このメンバー = 旧データの ◯◯」を人が一度だけ指定する操作を足す。名簿・メール照合には依存しない。

## 2. 既存の付け替え処理の調査

### 2.1 呼び出しの流れ(名簿経由)

| 入口 | 関数 | 付け替えの呼び方 |
|---|---|---|
| メール確認時 | `rosterLink.linkVerifiedUser` → `linkOne` | 名簿行ごとに `accounts.reattachLegacy({orgId, userId, legacyName: row.legacy_name})` |
| 名簿更新時 | `rosterLink.applyRoster` → `linkOne` | 同上。応答の `reattached` は件数 |

付け替えの本体は **`accountsRepo.reattachLegacy({ orgId, userId, legacyName })`** で、名簿・メールを一切参照しない。
名簿との接点は呼び出し側 `linkOne` だけである。

### 2.2 付け替える表と列(1 トランザクション。件数 `{reflections, sessions, roadmaps}` を返す)

| 対象 | 条件 | 書き換える列 | 備考 |
|---|---|---|---|
| `reflections`(反省) | `legacy_author_name = 氏名` かつ `author_user_id IS NULL` かつ 器(`practice_days.org_id`)がその組織 | `author_user_id` | |
| `rec_sessions`(軌跡) | `legacy_owner_name = 氏名` かつ `owner_user_id IS NULL` かつ 器がその組織 | `owner_user_id` | 旧データで所有者を判断できた軌跡だけ。判断できないものは `legacy_owner_name` が NULL で、組織所有のまま残る(§11) |
| `roadmaps` | `legacy_name = 氏名` かつ `org_id` がその組織 かつ `user_id IS NULL` かつ本人が未所有 | `user_id` | `user_id` が UNIQUE のため、本人が既にロードマップを持てば付け替えない(0 件) |

- 氏名は trim のみ(小文字化・正規化なし)。空は何もしない。
- 他組織の器・既に所有者のいる行は触らない(奪わない)。`legacy_*` 列は来歴として残す。冪等。
- `reflection_progress`・`reflection_comments` は付け替え対象外(進捗は反省 ID に付き、コメントの `author_user_id` は旧データでは NULL のまま)。
  反省が本人のものになれば、進捗は反省経由で本人のものとして見える。コメントの作者は付け替えない(現状どおり。要確認:§8-6)。
- `session_crew`(乗員)の `name` は付け替えない(自由記述の氏名)。現状の名簿経路と同じ。

### 2.3 使い回せるか

- **使い回せる(推奨)**。`reattachLegacy` はそのまま呼べる。新しく要るのは次の 4 つだけ。
  1. 呼び出し元(名簿照合ではなく、組織管理者の操作)。
  2. 候補の氏名の一覧(その組織の、まだ本人のいない `legacy_*` の氏名と件数)。
  3. 取り消し用の逆操作(`reattachLegacy` の逆。§5)。
  4. 実施記録(誰が誰に何を付けたか。取り消しの根拠にもなる)。
- 名簿経路(`linkVerifiedUser`・`applyRoster`)のコードは変更しない。凍結は Web の入口(FZ1)で行われ、サーバの処理は残るため、
  両経路は共存できる(§6)。

## 3. 提案する操作の流れ

- **誰が**: 組織管理者(`org_admins`)。本人による自己申告は提案しない(§8-1)。
- **どこで**: Web のメンバー一覧(組織画面)。メンバーの行に「旧データを紐付ける」ボタンを出す。
- **何回**: メンバー 1 人につき、旧氏名 1 つを 1 回指定する(1 組織内)。旧氏名が複数ある人は複数回(§8-3)。
- 手順:
  1. 管理者がメンバー一覧を開く。画面は `GET /api/orgs/:orgId/legacy-names` で、未付け替えの旧氏名と件数(反省 N・軌跡 M・ロードマップ 0/1)を取得する。
  2. 管理者が行の「旧データを紐付ける」を押し、旧氏名の一覧から選ぶ。画面に「反省 N 件・軌跡 M 件・ロードマップ あり を ◯◯さんに付けます」と確認文を出す。
  3. 確定すると `POST /api/orgs/:orgId/legacy-claims`。結果の件数を表示する。
  4. 付け替え済みの旧氏名は、一覧に「◯◯さんに付け替え済み」と出て、「取り消す」ボタンが付く。
- 旧氏名は組織管理者が見て判断する(部内の人間関係で分かる前提)。同姓同名の誤指定は取り消しで戻せる。

## 4. API の形(案・要承認)

認証はいずれもログイン必須・対象組織の組織管理者。メール確認済みを要する(既存の組織 API と同じ)。

### 4.1 `GET /api/orgs/:orgId/legacy-names`(案)

- 応答 200: `{ names: [ { legacyName, reflections, sessions, roadmaps, claimedBy: { userId, name, claimId } | null } ] }`
- `names` は、その組織の器に属する `legacy_author_name`・`legacy_owner_name`・`roadmaps.legacy_name` の氏名の和集合。
  件数は「`*_user_id IS NULL`(未付け替え)の行数」。有効な付け替え(§4.2)があれば `claimedBy` を付ける。
- 個人情報の扱い: 旧氏名は組織管理者にだけ返す。メンバー一般には返さない。

### 4.2 `POST /api/orgs/:orgId/legacy-claims`(案)

- 本文: `{ "userId": "u_…", "legacyName": "…" }`
- 処理: ①管理者であること ②`userId` がその組織のメンバーで退会していない ③`legacyName` を trim して空でない ④有効な付け替えが無いこと
  ⑤`reattachLegacy({orgId, userId, legacyName})` を呼ぶ ⑥実施記録を残す(§4.4)。⑤⑥は同一トランザクション。
- 応答 201: `{ claim: { id, orgId, userId, legacyName, counts: { reflections, sessions, roadmaps }, createdAt } }`
- エラー: 401／403(管理者でない・`email_not_verified`)／404(組織なし)／422 `invalid_input`(空の氏名・メンバーでない userId)／
  **409 `legacy_name_claimed`**(その旧氏名に有効な付け替えが既にある)／409 `legacy_nothing_to_claim`(該当データが 0 件。§5.2)。

### 4.3 `POST /api/orgs/:orgId/legacy-claims/:claimId/revoke`(案)

- 本文なし。応答 200: `{ ok: true, counts: { reflections, sessions, roadmaps } }`(戻した件数)。
- 既に取り消し済みなら冪等 200。他組織の claimId は 404(招待の revoke と同じ流儀)。

### 4.4 実施記録の表(案・要承認)

```sql
CREATE TABLE legacy_claims (
  id TEXT PRIMARY KEY,            -- lc_…
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,          -- 付け替え先
  legacy_name TEXT NOT NULL,      -- trim 済み
  claimed_by_user_id TEXT,        -- 実施した管理者(退会後も残すため NULL 可・FK なし)
  reflections INTEGER NOT NULL, sessions INTEGER NOT NULL, roadmaps INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER, revoked_by_user_id TEXT
);
-- 有効な付け替えは 1 氏名につき 1 件
CREATE UNIQUE INDEX legacy_claims_active ON legacy_claims(org_id, legacy_name) WHERE revoked_at IS NULL;
```

これが監査記録を兼ねる(別の監査表は作らない)。

### 4.5 設計書 §10.3 に足す文案

> | `GET /api/orgs/:orgId/legacy-names` | 組織管理者 | 未付け替えの旧氏名の一覧 `[{legacyName, reflections, sessions, roadmaps, claimedBy}]` |
> | `POST /api/orgs/:orgId/legacy-claims` | 組織管理者 | `{userId, legacyName}` → 201 `{claim}`。その組織の `legacy_*` のうち所有者が NULL の反省・軌跡・ロードマップを、組織メンバー `userId` に付け替える(§11)。409 `legacy_name_claimed`／`legacy_nothing_to_claim` |
> | `POST /api/orgs/:orgId/legacy-claims/:claimId/revoke` | 組織管理者 | → `{ok:true, counts}`。付け替えを元に戻す(冪等) |
>
> 名簿照合(§4.4)が使えない運用でも、旧データの付け替えは組織管理者が上記で行う。旧氏名は名簿の `legacyName` に依存しない。

§11 の文案: 「旧データの付け替えは、名簿の旧氏名による自動付け替え、または組織管理者の指定(`legacy-claims`)のどちらでも行える。」

## 5. 取り消し・二重指定・衝突

### 5.1 取り消し

- `legacy_*` 列が来歴として残るため、逆操作は特定できる:
  - `reflections`: `author_user_id = 本人 AND legacy_author_name = 氏名` を NULL に戻す(器が当該組織)。
  - `rec_sessions`: `owner_user_id = 本人 AND legacy_owner_name = 氏名` を NULL に戻す。
  - `roadmaps`: `user_id = 本人 AND legacy_name = 氏名 AND org_id = 組織` を NULL に戻す。
- 新規に本人が作った行は `legacy_*` が NULL なので巻き込まない。付け替え後に本人が旧反省を編集した内容は、行ごと NULL 所有に戻るため**内容は残る**(所有だけ戻る)。
- 取り消しは `reattachLegacy` の逆として `accountsRepo` に新関数(例 `detachLegacy`)で実装する案。取り消し後は同じ氏名を別の人に指定できる。
- 付け替え後に本人が可視性を変えた軌跡・反省は、取り消しで所有者が NULL になる=組織所有に戻る(公開範囲は変えない)。

### 5.2 二重指定・衝突

| 場面 | 扱い |
|---|---|
| 同じ旧氏名を別の人にも指定 | 409 `legacy_name_claimed`(部分一意インデックスでも守る)。先に取り消してから |
| 同じ人に別の旧氏名を指定 | 許可を推奨(§8-3)。ただしロードマップは `user_id` UNIQUE のため 2 つ目以降は 0 件になり、応答の `counts.roadmaps` で分かる |
| 本人が既にロードマップを持つ | 反省・軌跡だけ付け替わり、ロードマップは 0 件(既存仕様)。画面で「ロードマップは付け替えられませんでした」と出す |
| 該当が 0 件(氏名の打ち間違い等) | 409 `legacy_nothing_to_claim`、記録は作らない。氏名は一覧から選ぶので通常は起きない |
| 既に所有者のいる行 | 触らない(奪わない)。既存仕様どおり |
| 名簿経路との競合 | 先に付いた方が勝つ。`reattachLegacy` は NULL の行だけ更新するので、後からの名簿照合は上書きしない。名簿経由で付いた分は `legacy_claims` に記録が無く、取り消し対象外(§8-5) |
| 付け替え先が退会 | 退会時の処理(§4.3)で本人データは匿名化・削除の方針に従う。`legacy_claims` の `user_id` は残してよいが、取り消しは可能(NULL に戻る) |
| 付け替え後にメンバーが組織から外れる | 所有は残る(「本人のデータは残る」§4.4)。取り消しは管理者が可能 |

## 6. 権限・監査

- 権限は組織管理者のみ。他組織の管理者は 404(組織を縛る。招待 revoke と同じ)。管理者でも、対象 `userId` は同組織のメンバーに限る。
- 管理者の不正指定(他人の反省を別人に付ける)は、旧データがもともと組織所有で、本人が「自分のもの」と主張する根拠が名簿にしか無かった点を考えると、
  信頼は組織管理者に置く設計になる。対策は ①取り消せる ②`legacy_claims` に実施者・日時が残る ③付け替え先の本人に通知(§8-4)。
- 監査: `legacy_claims` の行(実施者・日時・件数・取り消し)。ログに氏名を出さない(旧氏名は個人情報。ログには claim ID と件数だけ)。
- 回数制限: 管理者の誤操作・連打に備え、書込系は本人ごと 1 時間 60 回程度を推奨(組織作成と同じ仕組みを流用。数値は実装値として明記する)。

## 7. テスト方針

### 7.1 単体テスト(`test/`、Node 24 の DB テスト)

- `accountsRepo.detachLegacy`(新): 付け替えて戻す往復で元の状態と一致、本人が新規に作った行・他人の行・他組織の行は不変、冪等。
- `reattachLegacy`(既存)に、名簿なしの呼び出し(メール・`org_roster` 無し)でも動くテストを追加。
- ドメイン純関数(`server/domain/`): 旧氏名の候補の集計(件数・`claimedBy`)、入力検証(trim・空・長さ)。
- ルート: 管理者 201／非管理者 403／他組織 404／非メンバー userId 422／同一氏名の二重指定 409／0 件 409／revoke 冪等・他組織の claimId 404／
  ロードマップが既にある場合の件数 0／トランザクション(記録の挿入に失敗したら付け替えも戻る)。
- 回帰: `linkVerifiedUser`・`applyRoster` の既存テストが無変更で通る。互換 PUT と反省の upsert で軌跡を消さない既存テストが通る。

### 7.2 ハブ e2e(`scripts/e2e-sailviz.mjs`)

- 一時データに、`people[0]` が旧氏名(架空名)の反省を持つ旧形式プロジェクトを用意し、旧データの取込み(旧形式プロジェクトの PUT)で `legacy_author_name` を作る。
  (要確認:現在の e2e がこの種の旧データを作れるか。作れなければシナリオ側で旧 API の PUT を足す)
- 流れ: 管理者と一般メンバーを登録・確認 → 招待で一般メンバーが参加 → 管理者が `legacy-names` を取得(件数あり)→ `legacy-claims` で付け替え(201・件数)
  → 本人の `GET /api/practice-days` 等で自分の反省として見える → 二重指定 409 → revoke → 元に戻る → 再度別のメンバーに付け替えられる。
- 画面(1280px・390px): メンバー一覧に「旧データを紐付ける」が出ること。変更前の版では FAIL、変更後で PASS になるように書く(FZ3-I で実施)。

## 8. 人に決めてほしい点

| # | 論点 | 選択肢 | 推奨 | 理由 |
|---|---|---|---|---|
| 1 | 誰が指定するか | A 組織管理者のみ / B 本人が自己申告(旧氏名を選ぶ) / C 両方 | **A** | 利用者の例が管理者指定。B は他人の旧データを名乗れてしまい、名簿という根拠が無い今は危険。部が小さければ A で足りる |
| 2 | 新しい表 `legacy_claims` と上記 API 3 本を設計書 §10.3・§5.1 に足してよいか | 可 / 表なし(記録なし。取り消しは `legacy_*` 列だけから実施) | **可** | 取り消しと監査と二重指定の防止を、記録 1 表で一度に満たせる。表なしだと「誰が付けたか」が残らない |
| 3 | 1 人が複数の旧氏名を持てるか | 可 / 1 人 1 氏名 | **可** | 表記ゆれ(旧データで氏名の綴りが複数)がありうる。ロードマップは 1 件しか付かないが害は無い |
| 4 | 付け替え先の本人への通知 | なし / 画面の通知だけ / メール | **画面の通知だけ(メンバー側のホームに「旧データが N 件付きました」)、無くてもよい** | メール送信の追加は依存・運用負担が増える。凍結方針(必要最低限)にも合わせる |
| 5 | 名簿経由で付いた過去分も取り消せるか | 取り消し対象外 / 付け替えを遡って記録 | **対象外** | 名簿経由は凍結の対象で、新規発生しない。遡及は旧データのどれを名簿が付けたか特定できない(`legacy_*` は残るが誰が付けたかは不明) |
| 6 | コメントの作者(`reflection_comments.author_user_id`)と乗員 `session_crew.name` も付け替えるか | しない(現状どおり) / する | **しない** | 現状の名簿経路も付けていない。旧データのコメントは作者を持たない(NULL)ため付け替え先が定義できない |
| 7 | 組織管理者が付け替え先 `userId` を選べる範囲 | 同組織のメンバーのみ / 全ユーザー | **同組織のメンバーのみ** | 他人の個人情報(登録の有無)を探る入口にしない |
| 8 | 管理者操作の回数制限 | なし / 1 時間 60 回 | **1 時間 60 回(実装値として明記)** | 誤操作・連打の歯止め。既存の仕組みを流用できる |

## 9. 未確認事項

- 現在の e2e が旧形式データ(`people[0]` を持つ反省)を作れるか。不明。FZ3-I で確認する。
- 旧データの氏名に表記ゆれ(全角・半角スペース、旧字体)がどれだけあるか。本番データは見ていない(見られない)。
  trim のみの完全一致で足りるかは、人が実データの氏名の一覧を確認して判断する。足りなければ候補表示で正規化の補助を出す案もあるが、本書では提案しない。
- 退会時の匿名化が `legacy_claims.user_id` をどう扱うか(§4.3 の削除処理との整合)は、FZ3-I で `server/` の退会処理を読んで決める。
- FZ1 の凍結(Web の入口)で、メンバー一覧の画面が組織管理者に残るかどうかは未確認。残らないなら、画面の置き場所を決める必要がある。

## 10. 実装の順序案(FZ3-I)

1. `legacy_claims` のマイグレーションと `accountsRepo`(`listLegacyNames`・`createClaim`・`detachLegacy`・`revokeClaim`)。純関数と単体テスト。
2. ルート 3 本と権限・エラー。設計書 §10.3 の追記(conductor/人が設計書側に反映)。
3. Web のメンバー一覧の UI。
4. ハブ e2e のシナリオ(変更前 FAIL・変更後 PASS)とスモーク。
