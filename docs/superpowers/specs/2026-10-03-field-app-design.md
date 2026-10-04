# 現場向け軽量アプリ sailviz-field（Flutter）設計書

- **日付**: 2026-10-03
- **対象**: roadmap.md 項目56（現場向け軽量アプリ）を Flutter スマホアプリとして実装。項目20（反省入力）を本アプリに統合・吸収する。
- **成果物**: この設計書 ＋ 末尾の「別リポジトリ実装用プロンプト」。実装は別リポジトリ（新規 Flutter プロジェクト）で行う。
- **前提リポジトリ**: sailviz（GPS軌跡ビューア＋反省、Node サーバ）。本アプリは sailviz バックエンド（`https://sailviz-sit.fly.dev` 等、fly.io）に HTTP でアクセスする独立クライアント。
- **先行設計**: `docs/superpowers/specs/2026-09-08-reflection-mobile-app-design.md`（項目20・反省アプリ）。本書はそれを土台に、現場アプリとして GPS記録・半自動アップロード・簡易表示を加えた統合版。項目20の実体 `sailviz-reflect`（素ESM/PWA）は本アプリに置き換え・退役する。

---

## 1. 目的とスコープ

### 目的
既存サイト sailviz web を「**管理画面兼・復習用**（詳細解析・ダッシュボード）」と位置づけ、それと対になる **現場向けの軽量 Flutter アプリ**を用意する。アプリの役割は①**スマホ自体でGPSを記録**（専用ロガー不要）②記録したGPSを**着岸後に1タップで半自動アップロード**③サイトの**目標・課題を簡易表示**（読み取り中心）。項目20の反省入力も本アプリに統合する。

### 役割分担
- **サイト（sailviz web）**＝管理/復習：重い解析・ダッシュボード・反省の作り込み。
- **アプリ（sailviz-field）**＝現場の軽量版：GPS取得・アップロード・簡易表示・反省入力・ロードマップ編集。

### v1 に入る
1. **本人選択**（名簿から自分）＋ 書込時の共有パスワード unlock
2. **スマホGPS記録**（#56新規・コア）：バックグラウンド記録（画面オフ・他アプリ使用中も継続）。想定連続記録 **約10時間**。
3. **着岸後1タップの半自動アップロード**（#56新規）：メタ（本人・艦番号・練習日）を自動補完し、GPSを `/api/sensor-imports` へ。
4. **反省入力**（項目20移植）：rig 12項目（前回値プリフィル）／天候（**アメダス辻堂から自動仮入力**・編集可・波高手入力）／notes 5項目＋自由記述。
5. **ロードマップ編集**（項目20移植）：自分の大目標＋マイルストーン（追加/改名/並替/達成トグル）。
6. **目標/課題の簡易表示**（#56）：ホームで前回の課題・発見・現在の目標・ロードマップ現在地を読み取り表示。
7. **オフライン耐性**：記録・反省・編集はローカル永続し、オンライン復帰で同期。

### v1 に入らない（後フェーズ）
- **AI目標補佐 4機能**（次の目標提案／ドラフト添削／参考文献紐付け／マイルストーン提案）＝項目20設計 §6.3。
- **North Sails チューニングガイドの静的テーブル**（📖ガイドチップ）＝項目20設計 §5.6。
- **動画アップロード**：バックエンドに動画アップロードAPIが無い。動画は従来どおり Google Drive ローカル同期フォルダ運用（項目9/43・メモリ方針）。アプリからは「動画はPCの Drive フォルダへ」案内のみ。
- GPSのリアルタイム（海上）送信、アプリ内GPS/動画の閲覧・解析、個人アカウント（メール/パスワード）認証、厳密な多端末衝突解決。

### 非目標
- sailviz バックエンドの大規模改修。v1は**原則ゼロ改修**（唯一の任意改修は §8 の Authorization ヘッダ対応1行）。

---

## 2. アーキテクチャ

```
Flutter sailviz-field (別repo・iOS+Android)          既存 sailviz サーバ (無改修)
┌───────────────────────────────────────┐
│ screens: Home / Record / Reflect /     │   HTTPS (native http, CORS 無関係)
│          Roadmap / Upload / History    │ ─────────►  GET  /api/summaries
│   ↑ Riverpod providers                  │             GET  /api/projects, /:name
│ repositories                            │             PUT  /api/projects/:name
│   reflection / roadmap / wind /         │             GET/PUT /api/overlays/roadmap
│   gpsSession / upload                    │             POST /api/unlock /auth /lock
│ ★ recorder service (前景サービス)        │             POST /api/sensor-imports
│   geolocator stream → point buffer       │             POST /api/sensor-imports/:id/commit
│ pure logic (純関数・flutter test)        │
│   buildSensorCsv / previousRig /         │   ローカル永続
│   amedas(url,parse) / mergeMyRoadmap /   │   SQLite(gps_session/gps_point, sync queue)
│   buildReflectionProject / memberSlug    │   secure_storage(token)
│ api_client (dio + cookie_jar)            │   shared_prefs(identity, 下書き)
└───────────────────────────────────────┘
```

### レイヤ（項目20設計を継承）
- **api_client**: dio + cookie_jar。`/api/unlock` の `Set-Cookie: sailviz_token` を保持し以降の書込に自動付与。トークンを secure_storage にも複製（cookie が落ちる環境の Authorization フォールバック用）。ネイティブ HTTP は CORS 非対象。
- **repository**: sailviz のデータ形への変換を担う。純関数（正規化・プリフィル・CSV生成・アメダス解析・roadmap マージ）を内部に持ち、fake api_client を注入して契約テスト可能。
- **recorder service**（#56新規）: §4 を参照。前景サービスで位置ストリームを購読し SQLite にバッファ。
- **provider/notifier**: Riverpod。DI 差し替えでテスト。
- **screen/widget**: 画面。

### 技術スタック
Flutter + Riverpod + dio + cookie_jar + flutter_secure_storage + shared_preferences
＋ **geolocator**（位置取得）＋ **flutter_foreground_task**（Android 前景サービス／常駐通知）＋ **sqflite**（点バッファ・同期キュー永続）。テストは `flutter test`（純関数中心）。

### 設計原則（sailviz 準拠）
- 純ロジック（パース／正規化／CSV生成／アメダスURL・解析／プロンプト生成／プリフィル算出）を UI・HTTP・プラットフォームAPIから分離し単体テスト。
- 反省が真実源、ロードマップ／進捗はオーバーレイ。アプリもこの分離を尊重する。
- 失敗は握って手入力・手編集・キュー滞留にフォールバック（ユーザー操作を止めない）。

---

## 3. sailviz API 契約（別repo から参照不要にするため転記）

ベースURL は環境変数で切替（例 `https://sailviz-sit.fly.dev`、ローカルは `http://localhost:8000`）。

### 認証
- **閲覧系（GET）**: 認証不要。
- **書込系（PUT/DELETE/POST）**: `sailviz_token` Cookie が必要。
- `POST /api/unlock` body `{"password":"<共有パスワード>"}` → 200 `{unlocked:true}` ＋ `Set-Cookie: sailviz_token=<token>; HttpOnly; SameSite=Lax; Path=/`。失敗は 401。
- `GET /api/auth` → `{unlocked: bool}`。`POST /api/lock` → cookie 破棄。
- ネイティブ HTTP は CORS 非対象。cookie_jar で Cookie を保持・再送すれば通る。

### プロジェクト（反省/練習ファイル）
- `GET /api/projects` → `[{name, label}]`（`name` は `<...>.sailviz.json`）。
- `GET /api/summaries` → 各練習の軽量サマリ配列（大きな points に触れず一覧・前回課題/発見表示に使う）。
- `GET /api/projects/:name` → プロジェクト JSON 全体。
- `PUT /api/projects/:name`（要認証）body = プロジェクト JSON → `{ok:true}`。
- `DELETE /api/projects/:name`（要認証）。
- **ファイル名規則（重要）**: `^[A-Za-z0-9._-]+\.sailviz\.json$`。日本語不可。アプリの反省ファイルは `sailviz-<YYYYMMDD-HHmm>-<自分slug>.sailviz.json`（slug は英数字。member id `m0..m19`）。

### GPSセンサー取込（#56のコア経路・既存）
- `POST /api/sensor-imports`（要認証）body `{person: string, csv: string}` → 200 `{importId, practiceDate, points, bounds, matched}`。
  - `csv` は **GPS CSV**（§5 の列を持つテキスト）。サーバが `parseCsv`→`parseGpsPoints`→`rejectOutliers` でパース。GPSでない/点0件なら 422。
  - `matched` = その `person`・`practiceDate` に一致する既存反省プロジェクト（あれば）。
  - 取り込んだ raw CSV は `importId` 配下に `raw.csv` として保存される。
- `POST /api/sensor-imports/:importId/commit`（要認証）body `{name: string, boatNumber: string}` → 200 `{name}`。
  - 既存プロジェクト `name`（`isValidProjectName` 準拠）に、CSVから作った**トラックを追記**し `sensorLogs` にログを足して保存。`raw.csv` を `<boatNumber>_<JSTstamp>.csv` にリネーム。
  - `name` のプロジェクトが存在しないと 404。**→ アプリはアタッチ先が無ければ先に `PUT /api/projects/:name` で作る（§6.2）**。
- `GET /api/uploads/:importId/:file`（要閲覧）→ 取り込んだ CSV テキスト。

### オーバーレイ（ロードマップ）
- `GET /api/overlays/roadmap` → `{ "<フルネーム>": { goal:"", milestones:[{id,title,done,doneAt}] }, ... }`。
- `PUT /api/overlays/roadmap`（要認証）body = 上記オブジェクト全体 → `{ok:true}`。

### AI プロキシ（後フェーズ用・参考）
- `POST /api/ai-comment`（要認証）body `{model, system, parts, temperature, maxOutputTokens, responseMimeType}` → `{text}`。既定モデル `gemini-3.6-flash`。キーはサーバ環境変数（未設定なら 503）。v1 では使わない。

---

## 4. GPS記録サブシステム（#56新規・コア）

### 4.1 recorder service
- **Android**: `flutter_foreground_task` の前景サービスを起動（常駐通知「記録中 ●・経過時間・点数」）。サービス内で `geolocator.getPositionStream(locationSettings)` を購読。`AndroidSettings(foregroundNotificationConfig...)` 相当で OS の kill を回避。
- **iOS**: `Info.plist` に `UIBackgroundModes: [location]`、`geolocator` の `AppleSettings(allowBackgroundLocationUpdates: true, pauseLocationUpdatesAutomatically: false, showBackgroundLocationIndicator: true)`。
- **サンプリング**: `LocationSettings(accuracy: high, distanceFilter: 0)`＋時間間隔 1Hz 目安（Sensor Logger 相当）。実機で電池と精度を見て調整（間引き可）。
- **想定連続記録**: 約10時間（22h は非目標）。

### 4.2 point buffer（クラッシュ耐性）
- 受信点は**即 SQLite に追記**（メモリに溜めない）。
  - `gps_session(id TEXT PK, startedMs INTEGER, endedMs INTEGER NULL, status TEXT)` — status: `recording|stopped|uploaded`。
  - `gps_point(sessionId TEXT, t INTEGER, lat REAL, lon REAL, speed REAL NULL, accuracy REAL NULL)`。
- クラッシュ・電池切れ後の再起動で `status='recording'` のセッションを検出し「前回の記録が残っています。確定/破棄」を提示。

### 4.3 ライフサイクル
1. 記録開始 → 権限確認（§4.4）→ 前景サービス起動 → session 作成 → buffering。
2. 記録中: 常駐通知＋アプリ内に経過時間・点数・直近精度を表示。
3. 記録停止 → `endedMs` 記録・`status='stopped'` → §6 のアップロード導線へ。

### 4.4 権限
- **iOS**: 位置情報「常に許可（Always）」。初回は WhenInUse→Always 昇格の案内。
- **Android**: `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` + 通知権限（Android 13+）＋**バッテリー最適化除外**の誘導。
- 権限不足/拒否時は**前景のみ記録にフォールバック**し、画面オフで止まる旨を明示警告。

---

## 5. GPS CSV 生成（純関数 `buildSensorCsv`）

サーバの `parseGpsPoints` が読む列（ヘッダは**小文字一致**）：

| 列名（ヘッダ） | 値 | geolocator 由来 |
|---|---|---|
| `time` | ISO8601 文字列 or epoch ms | `Position.timestamp`（`parseTime` が ISO8601/epoch 両対応） |
| `latitude` | 緯度 | `Position.latitude` |
| `longitude` | 経度 | `Position.longitude` |
| `speed` | 速度 m/s | `Position.speed`（m/s。サーバも m/s 想定・外れ値上限25m/s） |
| `horizontalaccuracy` | 水平精度 m | `Position.accuracy`（m。サーバ精度フィルタ #10 が >50m を既定除外） |

- 列順は任意（名前で引く）。必須は `time/latitude/longitude`。`speed/horizontalaccuracy` は欠損可（null→空セル）。
- `practiceDate` はサーバ側が `points[0].t` の JST 深夜で算出するため、アプリは**時刻を正しく出すだけ**でよい。
- `buildSensorCsv(points) -> String` を単体テスト（ヘッダ・時刻整形・m/s・空値・列名小文字）。

---

## 6. アップロード同期層（#56新規・着岸後1タップ）

### 6.1 統合 sync queue
- SQLite に永続・**べき等**。ジョブ種別: `reflectionPut` / `roadmapMerge` / `gpsImport`。各ジョブは `pending|synced|failed` と再試行回数を持つ。
- オンライン復帰・手動リトライで送信。401 は unlock 画面へ誘導してから再試行。

### 6.2 GPSアップロード手順（1タップ）
停止済みセッションに対し「アップロード」1タップで：
1. **メタ自動補完**: `person`=identity フルネーム、`boatNumber`=前回値プリフィル（手入力で上書き可）、`practiceDate`=セッション日。
2. セッションの点から `buildSensorCsv` → CSV。
3. `POST /api/sensor-imports {person, csv}` → `{importId, practiceDate, matched}`。
4. **アタッチ先プロジェクト解決**:
   - `matched`（同日・自分の反省プロジェクト）があれば `name = matched`。
   - 無ければ**軽量プロジェクトを先に作成**: `PUT /api/projects/<sailvizファイル名>`（§7.3 の軽量プロジェクト形。`reflections:[]` 可、`practiceDate` を設定）→ その `name`。
5. `POST /api/sensor-imports/:importId/commit {name, boatNumber}` → トラック追加完了。`gps_session.status='uploaded'`。
- いずれかで失敗 → キューに `failed` で残しリトライ提示。手順は importId 単位でべき等（commit 再実行は同一 importId を再利用）。

### 6.3 動画（v1はアップロードしない）
- バックエンドに動画アップロードAPIが無いため、動画は従来どおり Google Drive ローカル同期フォルダ運用（項目9/43・メモリ方針）。アプリは「動画は PC の Drive フォルダへ」の案内導線のみ。

---

## 7. 反省・ロードマップ・アメダス（項目20移植・v1範囲）

### 7.1 データモデル（sailviz と完全一致）
反省1件（`createReflection` と同一スキーマ）:
```jsonc
{
  "id": "refl<ts>_<自分slug>", "createdAt": <epoch ms>, "text": "自由記述",
  "people": ["村瀬 礼"],                 // ★ people[0] = 自分フルネーム（進捗/ロードマップ帰属キー）
  "videos": [],
  "wind": { "dir":"南西", "dirIdx":10, "speed":5,
            "source":"amedas"|"manual", "station":"辻堂", "obsMs":<ms> } | null,
  "practice": { "date":"YYYY/MM/DD", "startMs":0, "endMs":0 },
  "rig": { "boatNo":null, "gear":null, "prebend":null, "rake":null,
           "sideTension":null, "foreTension":null, "puller":null, "peakRope":null,
           "bridleHeight":null, "jibLeader":null, "jibPull":null, "vangPull":null },
  "waveHeight": null,
  "notes": { "goal":"", "issue":"", "discovery":"", "slowFactor":"", "fastFactor":"" }
}
```
- rig ラベル: 船番号/ギア/プリベンド/レーキ/サイドテンション/フォアテンション/プラー/ピークロープ/ブライダル高/ジブリーダー/ジブ引き量/バング引き量。
- notes ラベル: 目標/感じている課題/発見/遅かった要因/速かった要因。
- 正規化 `toNum`: `""`/非数値 → null、それ以外 → number（0 は保持）。

### 7.2 反省入力
- **① 艇セッティング**: rig 12欄（数値キーボード）。開いた時点で**前回値プリフィル**（`previousRig`）。
- **② 天候**: 開くと practice 時刻対象でアメダス辻堂から風向/風速を**自動仮入力**（§7.4）。取得値は編集可。波高は手入力。失敗は `source:"manual"` で手入力。
- **③ 反省内容**: notes 5欄（複数行）＋自由記述本文。
- 保存 → 軽量プロジェクト組立て `people:[自分フルネーム]` を必ず設定 → `PUT /api/projects/:name`。同日既存の自分ファイルは上書き。

### 7.3 軽量プロジェクト（アプリが PUT する形）
```jsonc
{ "version":1, "savedAt":<epoch ms>, "reflections":[ <反省1件> ], "practiceDate":<epoch ms> }
```
- tracks/videos/marks/pins は含めない（Web 側 deserialize は欠損キー許容）。GPS 巨大ファイルには触れない。
- §6.2 で GPS アタッチ先を新規作成する場合は `reflections:[]` でも可。

### 7.4 アメダス（`src/wind.js` を Dart 移植・純関数）
- `amedasUrl(ms, point='46141')` = `https://www.jma.go.jp/bosai/amedas/data/point/{point}/{yyyyMMdd}_{HH}.json`（HH=3時間ブロック開始 00,03,…,21、JST）。
- `parseWind(json, targetMs)` = 最近傍で `wind[0]`/`windDirection[0]` が有効なサンプル。`windDirName(idx)`: 0=静穏, 1..16 を 22.5°刻み（16=北）。
- 非公式 API は直近1〜2日のみ。古い日/失敗は null → 手入力フォールバック。純関数を単体テスト。

### 7.5 ロードマップ編集
- `GET /api/overlays/roadmap` → 自分キー（フルネーム）を編集: 大目標、マイルストーン 追加/改名/並替(↑↓)/達成トグル(doneAt 記録)。
- 保存は **PUT 直前に必ず re-read → `mergeMyRoadmapKey(overlay, name, entry)` で自分キーのみマージ**（他部員キーのクロバー防止）。
- 現在地 = 先頭からの「最初の未達」index（`roadmapProgress` 相当）。

### 7.6 部員名簿
- sailviz `src/members.js` の 20名（`fullName="<family> <given>"` 半角スペース区切り）。アプリに同梱。member id `m0..m19` を slug に使う。

---

## 8. 画面構成と受け入れ条件

1. **本人選択/ログイン**: 名簿から自分を選び記憶（再起動で保持・設定から変更可）。書込前に未 unlock なら共有PW入力→`/api/unlock`。
2. **ホーム（簡易表示）**: `GET /api/summaries` + 自分の反省から、**前回の課題・発見・現在の目標・ロードマップ現在地**をカード表示。オフライン時はローカルキャッシュ。「新規反省 +」「記録開始」。
3. **記録（Record）**: 開始/停止。記録中は経過・点数・直近精度＋常駐通知。停止で「アップロード」導線。
   - 受け入れ: 画面オフ・他アプリ使用中もおよそ10時間記録が継続する（権限許可時）。クラッシュ後に未確定セッションを復元できる。
4. **アップロード（Upload）**: 停止済みセッションを1タップ送信。メタ自動補完・艦番号編集可。
   - 受け入れ: 送信後、Web でその練習プロジェクトにトラックが増える。同日に自分の反省があればそれに紐付く。オフラインはキュー滞留しオンラインで送信。
5. **反省入力**: 折りたたみ3セクション（§7.2）。保存で Web のダッシュボード(rig)・進捗(notes)に自分の反省が出る。空欄は null。
6. **ロードマップ編集**: 自分キーのみ編集（§7.5）。他部員を壊さず自分だけ更新される。
7. **履歴**: 自分の過去反省を日付降順で閲覧（詳細な推移グラフは Web に委ねる）。

---

## 9. エラー処理・オフライン・セキュリティ

- **401**: 「パスワードが必要/失効」→ unlock 画面。cookie が落ちる環境向けに token を secure_storage にも保持し `Authorization: Bearer <token>` フォールバック（サーバ側対応時のみ有効＝§10 の任意1行）。
- **保存競合**: ロードマップは PUT 直前 re-read→自分キーのみマージ。反省は自分ファイル単位で競合最小。GPS は importId 単位でべき等。
- **ネットワーク失敗**: 記録・反省・編集・アップロードは SQLite/shared_prefs に永続。オンライン復帰・手動でリトライ。
- **アメダス失敗**: null/例外を握って手入力フォールバック。
- **バリデーション**: rig は数値のみ（`toNum` 空欄→null）。GPS CSV は必須列/点数をサーバが 422 で弾く＝アプリは事前に点0件を警告。
- **プライバシー**: 位置情報の常時取得と用途（練習軌跡の記録・共有）を初回に明示（sailviz 項目33/35 と整合）。GPSは公開可・個人データは内部（#33/#55 分離方針）。

---

## 10. sailviz 本体側で必要な作業（アプリ外）

1. **原則ゼロ改修**。sensor-imports / projects / overlays / summaries / unlock は既存のまま使う。
2. （任意）cookie が落ちる環境向けに `server/auth.js` の `isAuthorized` に Authorization ヘッダ判定を1行追加。cookie_jar で通れば不要。
3. デプロイ環境は fly.io（`sailviz-sit.fly.dev` 等）。GPS機能は認証(unlock)のみ依存で、AIキー等は v1 不要。

---

## 11. テスト方針（sailviz 準拠＝純ロジックを単体テスト）

`flutter test` で純関数を網羅:
- `buildSensorCsv(points) -> csv`（列名小文字・時刻整形・m/s・精度・空値）
- `buildReflectionProject(refl) -> 軽量プロジェクト JSON`
- `normalizeRig` / `normalizeNotes` / `toNum`
- `previousRig(reflectionsOfMe) -> rig`
- `amedasUrl` / `parseWind` / `windDirName`
- `mergeMyRoadmapKey(overlay, name, entry)`（他キー不変を検証）
- `memberSlug(member) -> 英数字 slug`（ファイル名規則適合）
- sync queue のべき等性（同一ジョブ二重送信で重複しない）
- アップロード手順の契約テスト（fake api_client: sensor-imports→（matched無→PUT作成）→commit の順序と引数）

recorder service / 権限 / 実機バックグラウンド継続は手動確認（実機 iOS + Android）。

---

## 12. 未解決・リスク

- **Android メーカー別の省電力 kill**: 前景サービス＋通知＋バッテリー最適化除外の誘導で緩和。機種により追加設定案内が要る可能性。
- **iOS バックグラウンド継続**: Always 権限＋`location` background mode＋非一時停止設定で対応。長時間の電池消費は実機で要計測（10h目安）。
- **GPS精度**: スマホGPSは専用ロガーに劣る。サーバ精度フィルタ(#10, >50m除外・既定ON)前提。速度(`speed`)が null の端末では解析が劣化（メモリ wind-axis-speed-classification 参照）。
- **ホームのカード重複**: 同日に反省ファイルと（新規作成した）GPSプロジェクトが2枚出る可能性。§6.2 で matched 優先により緩和するが、将来 Web 側で同日マージ表示を検討。
- **動画**: v1はアップロードしない（API無し）。将来、動画アップロードAPI新設 or Drive連携強化は別項目。

---

## 付録: 別リポジトリ実装用プロンプト

> 新規 Flutter プロジェクトでそのまま実装開始プロンプトとして使う。sailviz repo を参照しなくても実装できるよう、契約・スキーマ・CSV形式を自己完結で含める。

```
# タスク: セーリング現場向け軽量アプリ sailviz-field（Flutter）v1 の実装

## 背景
「sailviz」という既存 Node バックエンド（fly.io。セーリング練習の GPS/反省ビューア）の
現場向けクライアントを Flutter で新規実装する。役割は ①スマホでGPSをバックグラウンド記録
②着岸後に1タップで半自動アップロード ③サイトの目標/課題を簡易表示 ④反省入力・ロードマップ編集。
バックエンドは無改修で使う（唯一の任意改修は Authorization ヘッダ対応1行）。iOS + Android 両対応。

## 技術スタック
Flutter + Riverpod + dio + cookie_jar + flutter_secure_storage + shared_preferences
+ geolocator（位置取得）+ flutter_foreground_task（Android前景サービス/常駐通知）+ sqflite（点バッファ・同期キュー）。
純ロジック（CSV生成/正規化/プリフィル/アメダスURL・パース/roadmapマージ）は UI・HTTP・プラットフォームAPIから分離し flutter test で TDD。
リポジトリは fake api_client を注入して契約テスト。recorder/権限/実機バックグラウンドは手動確認。

## バックエンド API 契約（ベースURLは環境変数。例 https://sailviz-sit.fly.dev / http://localhost:8000）
- 認証: GET は不要。書込(PUT/DELETE/POST)は sailviz_token Cookie が必要。
  - POST /api/unlock body {"password":"<共有PW>"} → 200 {unlocked:true} + Set-Cookie: sailviz_token
  - GET /api/auth → {unlocked:bool} / POST /api/lock → cookie 破棄
  - ネイティブ http は CORS 非対象。cookie_jar で Cookie 保持・再送。cookie が落ちる環境用に token を
    secure_storage にも保持し Authorization: Bearer フォールバック（サーバ側対応時のみ有効）。
- GET /api/projects → [{name,label}]（name は <...>.sailviz.json）
- GET /api/summaries → 各練習の軽量サマリ配列
- GET /api/projects/:name / PUT /api/projects/:name（要認証）body=プロジェクトJSON → {ok:true}
- GET/PUT /api/overlays/roadmap（PUT要認証）
- ★GPS: POST /api/sensor-imports（要認証）body {person, csv} → {importId, practiceDate, points, bounds, matched}
   csv は GPS CSV（下記列）。GPSでない/点0件は 422。matched=同person・同practiceDateの既存反省プロジェクト名(あれば)。
- ★GPS: POST /api/sensor-imports/:importId/commit（要認証）body {name, boatNumber} → {name}
   既存プロジェクト name にトラックを追記。name が無ければ 404 → 事前に PUT /api/projects/:name で軽量プロジェクトを作る。
- プロジェクトのファイル名規則: ^[A-Za-z0-9._-]+\.sailviz\.json$（日本語不可）。
  反省ファイルは sailviz-<YYYYMMDD-HHmm>-<自分slug>.sailviz.json（slug は英数字。member id m0.. 可）。

## GPS CSV 形式（サーバが parseGpsPoints で読む。ヘッダは小文字一致で引く）
列: time, latitude, longitude, speed, horizontalaccuracy（必須=time/latitude/longitude。列順任意）
- time: ISO8601文字列 or epoch ms（サーバ parseTime が両対応）= Position.timestamp
- latitude/longitude = Position.latitude/longitude
- speed = Position.speed（m/s。サーバ外れ値上限25m/s）
- horizontalaccuracy = Position.accuracy（m。サーバが >50m を既定除外）
- buildSensorCsv(points)->String を純関数でテスト（列名/時刻/空値/m/s）。

## GPS記録（コア・バックグラウンド必須・想定10時間連続）
- Android: flutter_foreground_task の前景サービス（常駐通知「記録中●・経過・点数」）内で
  geolocator.getPositionStream(LocationSettings(accuracy:high, distanceFilter:0, 1Hz目安))。
- iOS: Info.plist UIBackgroundModes:[location] + AppleSettings(allowBackgroundLocationUpdates:true,
  pauseLocationUpdatesAutomatically:false, showBackgroundLocationIndicator:true)。
- 権限: iOS Always / Android ACCESS_BACKGROUND_LOCATION + 通知 + バッテリー最適化除外の誘導。
  不足時は前景のみにフォールバックし警告。
- 点は即 SQLite に追記（メモリに溜めない）: gps_session(id,startedMs,endedMs,status) / gps_point(sessionId,t,lat,lon,speed,accuracy)。
  クラッシュ後、status='recording' のセッションを復元（確定/破棄）。

## アップロード（着岸後1タップ・半自動・べき等）
停止済みセッションに対し:
1. メタ自動補完: person=自分フルネーム, boatNumber=前回値(編集可), practiceDate=セッション日
2. buildSensorCsv → csv
3. POST /api/sensor-imports {person, csv} → {importId, matched}
4. アタッチ先: matched があれば name=matched。無ければ PUT /api/projects/<name> で軽量プロジェクト作成(reflections:[], practiceDate)
5. POST /api/sensor-imports/:importId/commit {name, boatNumber}
失敗はキューに残しリトライ。401→unlock誘導。手順は importId 単位でべき等。
動画は v1 アップロードしない（API無し。Drive ローカル同期運用の案内のみ）。

## 反省スキーマ（sailviz と完全一致）
反省1件:
{ id:"refl<ts>_<slug>", createdAt:<ms>, text:"自由記述", people:["<自分フルネーム>"], videos:[],
  wind:{dir,dirIdx,speed,source:"amedas"|"manual",station:"辻堂",obsMs}|null,
  practice:{date:"YYYY/MM/DD", startMs, endMs},
  rig:{boatNo,gear,prebend,rake,sideTension,foreTension,puller,peakRope,bridleHeight,jibLeader,jibPull,vangPull}, // 全キー。空欄=null(0保持)
  waveHeight:<number>|null,
  notes:{goal,issue,discovery,slowFactor,fastFactor} } // 全キー。未入力=""
rig ラベル: 船番号/ギア/プリベンド/レーキ/サイドテンション/フォアテンション/プラー/ピークロープ/ブライダル高/ジブリーダー/ジブ引き量/バング引き量
notes ラベル: 目標/感じている課題/発見/遅かった要因/速かった要因
軽量プロジェクト(アプリが PUT): {version:1, savedAt:<ms>, reflections:[<反省1件>], practiceDate:<ms>} // tracks/videos/marks/pins は含めない
ロードマップ overlay: { "<フルネーム>": {goal:"", milestones:[{id,title,done,doneAt}]} }
部員名簿: 20名を同梱。fullName="<family> <given>"（半角スペース区切り）。member id m0..m19。
  [村瀬 礼, 高田 咲, 木下 佳穂, 本間 由真, 高原 直翔, 小川 勇希, 西本 亜美, 風間 大煕,
   伊藤 理々子, 佐藤 妙, 大澤 希, 押尾 明汰, 上島 滉起, 吉田 悠翔, 宮田 櫂澄, 引池 匠,
   緒方 菜那子, 田巻 隆雅, 原田 修有, 星川 桃香]

## 反省・ロードマップ・アメダス（v1範囲）
- rig は previousRig(自分の反省群) でプリフィル（天候は引き継がない）。
- 天候アメダス自動（純関数 Dart 移植・テスト）:
  amedasUrl(ms,point='46141') = https://www.jma.go.jp/bosai/amedas/data/point/{point}/{yyyyMMdd}_{HH}.json
  （HH=3時間ブロック開始 00,03,..,21、JST）。parseWind(json,targetMs)=最近傍で wind[0]/windDirection[0] 有効サンプル。
  windDirName: 0=静穏, 1..16 を 22.5°刻み(16=北)。非公式APIは直近1-2日のみ→失敗は手入力。
- ロードマップ: overlays/roadmap の自分キーのみ編集（大目標＋マイルストーン 追加/改名/並替/達成）。
  PUT 直前に re-read→自分キーのみマージ mergeMyRoadmapKey（他部員を壊さない）。
- 簡易表示（ホーム）: /api/summaries + 自分の反省から 前回の課題・発見・現在の目標・ロードマップ現在地を読み取り表示。

## 画面
1. 本人選択/ログイン 2. ホーム(簡易表示+記録開始+新規反省) 3. 記録(開始/停止・常駐通知・復元)
4. アップロード(1タップ・メタ自動) 5. 反省入力(rig/天候/notes 3セクション) 6. ロードマップ編集 7. 履歴

## エラー処理
401→unlock。ネット失敗→SQLite/shared_prefs に永続しリトライ。アメダス失敗→手入力。
rig 数値バリデーション(空欄→null)。位置情報の用途を初回明示。

## スコープ外(v1・後フェーズ)
AI目標補佐4機能 / North Sailsガイド静的テーブル / 動画アップロード / GPSリアルタイム送信 /
アプリ内GPS・動画閲覧 / 個人アカウント認証。
```
