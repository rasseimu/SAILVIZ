# Phase 0 現状調査レポート — sailviz サーバ移行

- **日付**: 2026-10-04
- **対象**: `server/`、`fly.toml`、`Dockerfile`、実データ（`data/`）、Web の保存処理
- **親計画**: `2026-10-04-sailviz-server-migration-plan.md` Phase 0 の「現状調査レポート」

## 0. 要約（計画に効く発見）

調査で、計画が前提にしているデータ形がいくつか**実データと食い違う**ことが分かった。移行の変換ルール（親計画 §4）に直接効くので先に挙げる。

| # | 発見 | 計画への影響 |
|---|---|---|
| F1 | **`practiceDate` が大半のファイルに無い**（7件中5件が `undefined`） | 「器（組織×日付）」の日付をファイル名 `sailviz-YYYYMMDD-HHMM` から導出する処理が必須。`findProjectByPracticeDate` は date 付きファイルしか拾えない |
| F2 | **`tracks[]` に `source` が無い／`sensorLogs[]` は全件 0** | §4 の「`tracks[].source.importId` で取込対応」「`sensorLogs[] → rec_sessions.source`」は既存データには当てはまらない。`imp_…` 規則は**新規 sensor-import のみ**。既存トラックは raw CSV（`uploads/<importId>`）を持たない → セッション ID を合成し、CSV 無しを許容する変換が必要 |
| F3 | **反省の 34/98 が `people` 空** | Phase 2 の名簿照合で、35% は `legacy_author_name` が付かず組織所有になる。計画の「反省は `people[0]` が作者」は 2/3 にしか成立しない |
| F4 | **同一日付の複数ファイルが現存**（`20260903-0000` と `20260903-0844`） | 決定 #3（同日複数ファイル）は仮定でなく現実。片方は `practiceDate` 有り、片方は無し |
| F5 | **Web は `_rev` を一切扱わない**（`src/api.js` の `apiPutProject` はクライアント状態の obj をそのまま PUT） | 親計画 §5 の懸念は確定。楽観ロックは Web 改修なしでは成立しない → 「`_rev` の無い PUT ではトラックを削除しない」ガードが当面の正。Phase 0 でこのガードを入れておくのが安全 |
| F6 | `progress.json` の 20 キー中 1 件が孤児（対応する反省 ID が無い） | 取込 `--dry-run` の警告対象が実在。1 件分の処理方針が要る |
| F7 | **デモデータと実データが混在**（反省 98 件中 demo-id 30・refl-id 68） | 往復テストの正本は**本番 `/data`**。ローカル `data/` は混在のため正本に使わない |

## 1. ランタイムと依存

- ローカル Node: **v22.2.0**。既存テスト **695 件すべて pass**（`npm test`）。
- `Dockerfile`: **`node:20-alpine`** 固定 → 親計画どおり 24 LTS へ。Node 20 は 2026-04-30 EOL。
- 依存: フレームワーク・DB なし、Node 標準のみ。`package.json` は `type: module`、テストは `node --test`。
- Gemini のモデル既定は `gemini-3.6-flash`（`server/gemini.js`）。リトライ（429/5xx, 指数バックオフ）実装済み。

## 2. ルーティング（`server/api.js` 一枚、約 325 行）

分割対象のエンドポイント:

| パス | メソッド | 認可 | 備考 |
|---|---|---|---|
| `/api/health` | GET | なし | |
| `/api/basemap/pale/:z/:x/:y.png` | GET | なし | 地理院タイルプロキシ |
| `/api/ai-comment` | POST | write | Gemini プロキシ |
| `/api/auth` | GET | なし | トークン状態 |
| `/api/session` | GET | なし | 閲覧ゲート状態 |
| `/api/login` `/api/logout` | POST | なし | 閲覧ログイン Cookie |
| `/api/unlock` `/api/lock` | POST | なし | 書き込みトークン Cookie |
| `/api/sensor-imports` | POST | write | CSV → importId・raw.csv 保存 |
| `/api/sensor-imports/:id/commit` | POST | write | track 構築・project へ追記 |
| `/api/minutes-imports/commit` | POST | write | 反省一括作成 |
| `/api/uploads/:id/:file` | GET | viewer | CSV ダウンロード |
| `/api/projects` | GET | viewer | 一覧 |
| `/api/summaries` | GET | viewer | 集計 |
| `/api/projects/:name` | GET/PUT/DELETE | viewer/write | 本体 CRUD |
| `/api/overlays/:name` | GET/PUT | viewer/write | progress・roadmap |

## 3. 認証・認可（`server/auth.js` + `api.js` クロージャ）

- 閲覧ゲート: `viewUser`/`viewPassword` 両方設定時のみ有効。起動時に `randomBytes(24)` の `viewSecret` を生成し Cookie 照合 → **再起動で全員失効**（親計画の懸念どおり、Fly 休止で都度ログアウト）。
- **既定値がコード埋め込み**: `server/index.js` に `芝浦工業大学体育会ヨット部` / `6235`。Phase 0 で env 必須化して外す対象。
- `extractToken` は `Authorization: Bearer` 対応済み（アプリ Bearer の土台）。
- `isViewer` は `viewSecret` 未設定なら誰でも true（ゲート無効時）。

## 4. 保存（`server/storage.js`）

- `dataDir` 注入でテスト可能。`PROJECT_RE`／パストラバーサル検証あり。
- `listProjects`／`readProject`／`writeProject`／`deleteProject`、overlay（progress/roadmap）、uploads（CSV）。
- `writeProject` は **last-write-wins**（丸ごと上書き、マージなし）→ F5 と合わせ、古い PUT が新トラックを消す事故の温床。

## 5. 取込（`sensorimport.js` / `minutesimport.js`）

- `sensorimport.js`: `parseSensorCsv`（既存 `src/csv.js`・`detect.js`・`gps.js` を利用、外れ値除去つき）、`buildTrack`、JST ヘルパ（`jstMidnightMs`・`jstStamp`）。純関数で移植しやすい。
- `minutesimport.js`: `validateCommitRows`（名簿照合）・`mergeRowsByMember`・`reflectionsFromRows`・`emptyProject`。反省 ID は `refl<now>_<i>` 決定的採番。
- `import.js`: ローカル → `data/` の一度きり CLI。

## 6. 実データの形（`data/projects/`、7 ファイル）

- トップレベルキー: `version,savedAt,mode,accuracyFilter,crop,tracks,events,marks,pins,videos,reflections`（+ 一部に `practiceDate`）。
- トラック: `id,name,color,visible,points,bounds,tRange`（`source` **無し**）。points は `{t,lat,lon,speed,bearing,accuracy}`。
- 反省: `id,createdAt,text,people,videos,wind,practice,rig,waveHeight,notes`。
- `progress.json`: 反省 ID → `{issueStage,goalDone,text,comments}`。`roadmap.json`: 人名キー → `{goal,milestones[]}`。

## 7. Web 保存処理（`src/api.js`）

- `apiListProjects`／`apiGetProject`／`apiPutProject`／`apiDeleteProject`／`apiListSummaries`。
- `apiPutProject(name, obj)` は **obj をそのまま PUT**（`_rev` 等のメタを付けない・保持しない）→ F5。

## 8. テスト資産（移行の土台になるもの）

`server-api` / `server-auth` / `server-storage` / `server-viewgate` / `server-sensorimport` / `server-minutesimport` / `server-gemini` / `server-import` / `sensorstorage` / `api-client` ほか。リポジトリ層・認可判定・変換は同じ注入パターンで書ける。

## 9. 計画への反映提案（要判断）

1. **F1/F2/F4**: §4 の変換表を「ファイル名から日付導出」「`source` 無しトラックの合成セッション ID・CSV 無し許容」「同日複数ファイルは別の器のまま」に明記。
2. **F3**: §Phase2 名簿照合に「`people` 空の反省は組織所有・作者未確定」の分岐を追加。
3. **F5**: §Phase0 に「`_rev` 無し PUT でトラックを削除しないガード」を**先に入れる**ことを明記（Web 改修は後回しで安全側）。
4. **F6**: 取込 `--dry-run` の孤児 progress キーの扱い（保持 or 破棄）を決める。
5. **F7**: 往復テストの正本を本番 `/data` と明記（ローカル `data/` はデモ混在で不可）。

## 10. Phase 0 の残作業と担当

| 作業 | 実施者 | 状態 |
|---|---|---|
| Dockerfile Node 20→24、テスト緑維持 | Claude（TDD） | 未 |
| 閲覧ゲート既定値の除去・env 必須化 | Claude（TDD） | 未 |
| `api.js` → `routes/` 分割（挙動不変） | Claude（TDD） | 未 |
| `storage.js` 呼び出しをリポジトリ層経由へ（中身ファイルのまま） | Claude（TDD） | 未 |
| `_rev` 無し PUT のトラック削除ガード | Claude（TDD） | 未（F5） |
| **ステージング Fly アプリ作成（本番 `/data` コピー）** | **ユーザー**（Fly 権限） | 未 |
| **本番 `/data` バックアップ・スナップショット保持確認・1台構成確認** | **ユーザー**（Fly 権限） | 未 |
