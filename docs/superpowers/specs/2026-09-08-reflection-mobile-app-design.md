# 反省入力モバイルアプリ（Flutter）設計書

- **日付**: 2026-09-08
- **対象**: roadmap.md 項目20（反省入力アプリ）を Flutter スマホアプリとして実装。項目21（録音・要約）は後フェーズ（拡張ポイントのみ設計に残す）。項目19（反省のAI文章整形）は本アプリの「AI目標補佐②」に内包。
- **成果物**: この設計書 ＋ 末尾の「別ディレクトリ実装用プロンプト」。実装は別リポジトリで行う。
- **前提リポジトリ**: sailviz（GPS軌跡ビューア＋反省アプリ、Node サーバ）。本アプリは sailviz バックエンド（`sailviz-sit.fly.dev` 等）に HTTP でアクセスする独立クライアント。

---

## 1. 目的とスコープ

### 目的
部員が各自スマホから、sailviz と**同一フォーマット**の反省（チューニング＋天候＋反省内容）を入力・蓄積し、自分のロードマップ／目標／課題／発見を編集する。特に**目標設定のAI補佐**を提供する。入力データは sailviz バックエンドに保存され、既存の Web ダッシュボード（項目22）・進捗画面（項目32）が横断集計で自動的に拾う。

### v1 に入る
- 本人選択（名簿から自分を選ぶ）＋ 書込時の共有パスワード unlock
- 反省入力（sailviz 項目16 と同一構成の折りたたみ3セクション）
  - ① 艇セッティング rig 12項目（数値・**前回値プリフィル**・North Sails ガイド参照チップ）
  - ② 天候（**アメダス辻堂から自動仮入力**・上書き可・波高手入力）
  - ③ 反省内容 notes 5項目（目標/課題/発見/遅かった要因/速かった要因）＋自由記述本文
- ロードマップ編集（自分の大目標＋マイルストーン：追加/改名/並替/達成トグル）
- AI目標補佐 4機能（次の目標提案／ドラフト添削・具体化／参考文献紐付け／マイルストーン提案）
- 時系列閲覧（ホームに前回の課題・発見を表示）

### v1 に入らない（拡張ポイントとして設計に残す）
- 項目21：反省中の録音→文字起こし→要約
- アプリ内での GPS トラック／動画閲覧
- 動画の Drive アップロードショートカット
- リアルタイム同期・多端末の厳密な衝突解決
- 個人アカウント（メール/パスワード）認証

### 非目標
- sailviz バックエンドの大規模改修（v1は**原則ゼロ改修**。唯一の任意改修は §7 の Authorization ヘッダ対応1行）

---

## 2. アーキテクチャ

```
Flutter アプリ (別repo)                         既存 sailviz サーバ (無改修)
┌──────────────────────────┐   HTTPS         ┌─────────────────────────┐
│ UI (screens/widgets)     │  (native http,  │  server/api.js          │
│   ↑ Riverpod providers    │   CORS 無関係)   │   /api/summaries        │
│ repositories             │ ──────────────► │   /api/projects/:name   │
│   reflection / roadmap   │                 │   /api/overlays/roadmap │
│   ai / reference / wind   │                 │   /api/unlock           │
│ api_client (dio+cookie)  │                 │   /api/ai-comment       │
│ pure logic (純関数)       │                 └─────────────────────────┘
│   normalize/prompt/prefil│                          │
└──────────────────────────┘                  data/projects/*.sailviz.json
   ↕ ローカル                                   data/roadmap.json
   secure_storage(token) / shared_prefs(名前・下書き)
```

### レイヤ
- **api_client**: dio + cookie_jar。`/api/unlock` の `Set-Cookie: sailviz_token` を保持し、以降の書込に自動付与。トークンは secure_storage にも複製（cookie が落ちる環境の Authorization フォールバック用）。
- **repository**: sailviz のデータ形（反省スキーマ・ロードマップ overlay）への変換を担う。純関数（正規化・プリフィル・プロンプト生成・レスポンス検証）を内部に持ち、fake api_client を注入して契約テスト可能。
- **provider/notifier**: Riverpod。DI 差し替えでテスト。
- **screen/widget**: 画面。

### 状態管理・技術スタック
Flutter + Riverpod + dio + cookie_jar + flutter_secure_storage + shared_preferences。テストは `flutter test`（純関数中心）。

### 設計原則（sailviz 準拠）
- 純ロジック（パース／正規化／プロンプト生成／プリフィル算出）を UI・HTTP から分離し単体テスト。
- 反省が真実源、ロードマップ／進捗はオーバーレイ。アプリもこの分離を尊重する。
- 失敗は握って手入力・手編集にフォールバック（ユーザー操作を止めない）。

---

## 3. sailviz API 契約（別repo から参照不要にするため転記）

ベースURL は環境変数で切替（例 `https://sailviz-sit.fly.dev`、ローカルは `http://localhost:8000`）。

### 認証
- **閲覧系（GET）**: 認証不要。
- **書込系（PUT/DELETE/AIコメント）**: `sailviz_token` Cookie が必要。
- `POST /api/unlock` body `{"password":"<共有パスワード>"}` → 200 `{unlocked:true}` ＋ `Set-Cookie: sailviz_token=<token>; HttpOnly; SameSite=Lax; Path=/`。失敗は 401。
- `GET /api/auth` → `{unlocked: bool}`（現在の cookie が有効か確認）。
- `POST /api/lock` → cookie 破棄。
- ※ ネイティブ HTTP クライアントは CORS 非対象。cookie_jar で Cookie を保持・再送すれば通る。

### プロジェクト（反省ファイル）
- `GET /api/projects` → `[{name, label}]`（`name` は `<...>.sailviz.json`）。
- `GET /api/summaries` → 各練習の軽量サマリ配列（大きな points に触れず一覧・前回課題/発見表示に使う）。
- `GET /api/projects/:name` → プロジェクト JSON 全体。
- `PUT /api/projects/:name`（要認証）body = プロジェクト JSON → `{ok:true}`。
- `DELETE /api/projects/:name`（要認証）。
- **ファイル名規則（重要）**: `^[A-Za-z0-9._-]+\.sailviz\.json$`。日本語不可。→ アプリは `sailviz-<YYYYMMDD-HHmm>-<自分slug>.sailviz.json`（slug は英数字。例: ローマ字イニシャルや member id `m0` を使用）。

### オーバーレイ
- `GET /api/overlays/roadmap` → `{ "<フルネーム>": { goal:"", milestones:[{id,title,done,doneAt}] }, ... }`。
- `PUT /api/overlays/roadmap`（要認証）body = 上記オブジェクト全体 → `{ok:true}`。
- （progress オーバーレイもあるが v1 アプリは書かない。読むのは任意。）

### AI プロキシ（Gemini・汎用）
- `POST /api/ai-comment`（要認証）body `{model, system, parts, temperature, maxOutputTokens, responseMimeType}` → `{text}`。
  - `parts`: `[{text:"..."}]` または `{inlineData:{mimeType, data(base64)}}` の配列。
  - `responseMimeType: "application/json"` で JSON 応答を促せる。
  - AIキーはサーバ環境変数（`GEMINI_API_KEY`）に隠蔽。未設定なら 503。
  - モデル既定は `gemini-3.6-flash`（sailviz と揃える）。

---

## 4. データモデル（sailviz と完全一致させる）

### 反省 1件（`createReflection` と同一スキーマ）
```jsonc
{
  "id": "refl<ts>_<自分slug>",          // 一意。ts=保存時epoch(ms)
  "createdAt": 1788129398048,           // epoch(ms)
  "text": "自由記述本文",
  "people": ["村瀬 礼"],                 // ★ people[0] = 自分のフルネーム（進捗/ロードマップの帰属キー）
  "videos": [],                          // v1は空
  "wind": {                              // アメダス取得 or 手入力。未設定は null
    "dir": "南西", "dirIdx": 10, "speed": 5,
    "source": "amedas",                 // "amedas" | "manual"
    "station": "辻堂", "obsMs": 1787877000000
  },
  "practice": {                          // 練習日時。date は "YYYY/MM/DD"
    "date": "2026/08/28", "startMs": 0, "endMs": 0
  },
  "rig": {                               // 12キー全て。空欄は null（0は保持）
    "boatNo": null, "gear": null, "prebend": null, "rake": null,
    "sideTension": null, "foreTension": null, "puller": null, "peakRope": null,
    "bridleHeight": null, "jibLeader": null, "jibPull": null, "vangPull": null
  },
  "waveHeight": null,                    // 数値 or null
  "notes": {                             // 5キー全て。未入力は ""
    "goal": "", "issue": "", "discovery": "", "slowFactor": "", "fastFactor": ""
  }
}
```

### rig フィールド定義（順序・日本語ラベル）
```
boatNo=船番号  gear=ギア  prebend=プリベンド  rake=レーキ
sideTension=サイドテンション  foreTension=フォアテンション  puller=プラー
peakRope=ピークロープ  bridleHeight=ブライダル高  jibLeader=ジブリーダー
jibPull=ジブ引き量  vangPull=バング引き量
```
- 正規化 `toNum`: `""`/非数値 → null、それ以外 → number（0 は保持）。

### notes フィールド定義
```
goal=目標  issue=感じている課題  discovery=発見  slowFactor=遅かった要因  fastFactor=速かった要因
```

### 軽量プロジェクト（アプリが PUT する反省ファイル）
```jsonc
{
  "version": 1,
  "savedAt": <epoch ms>,
  "reflections": [ <反省1件> ],   // v1は自分の1件（同日再編集時は上書き）
  "practiceDate": <epoch ms>      // その練習日（ホームのカード日時・並び）
}
```
- tracks/videos/marks/pins 等は**含めない**（Web 側 deserialize は欠損キーを許容）。
- GPS を含む巨大な練習ファイルには**触れない**。

### ロードマップ overlay（自分キーのみ更新）
```jsonc
{ "村瀬 礼": { "goal": "大目標テキスト",
  "milestones": [ {"id":"ms<ts>", "title":"...", "done":false, "doneAt":null} ] } }
```
- 現在地 = 先頭からの「最初の未達」index（`roadmapProgress` 相当）。

### 部員名簿
- sailviz `src/members.js` の 20名（`fullName = "<family> <given>"`、半角スペース区切り）。
- アプリは名簿を**同梱**（v1）。将来サーバ配信化可。member id `m0..m19` を slug に使える。

---

## 5. 画面構成と受け入れ条件

### 5.1 本人選択 / ログイン
- 起動時、名簿から自分を選択 → secure_storage/shared_prefs に記憶（次回スキップ）。
- 書込操作の直前に未 unlock なら共有パスワード入力 → `/api/unlock`。
- **受け入れ**: 選択後アプリ再起動で本人が保持されている。誤選択は設定から変更可。

### 5.2 ホーム
- `GET /api/summaries` ＋ 自分の反省ファイル群から、自分の反省を時系列カード表示。
- 各カードに前回の**課題・発見**を要約表示（項目20要件）。
- 「新規反省 +」ボタン。
- **受け入れ**: 直近の自分の課題・発見が一覧で見える。オフライン時はローカルキャッシュを表示。

### 5.3 反省入力（コア）
折りたたみ3セクション（sailviz 項目16 と同一）:
- **① 艇セッティング**: rig 12欄（数値キーボード）。開いた時点で**前回値をプリフィル**（§6.1）。各欄に「📖ガイド」チップで North Sails 参考値（§5.6）。
- **② 天候**: 開くと practice 時刻を対象にアメダス辻堂から風向/風速を**自動仮入力**（§6.2）。取得値は編集可。波高は手入力。取得失敗は `source:"manual"` で手入力。
- **③ 反省内容**: notes 5欄（複数行）＋自由記述本文。目標欄に **AI補佐**ボタン（§6.3）。
- 保存 → 軽量プロジェクトを組立て `people:[自分フルネーム]` を必ず設定 → `PUT /api/projects/:name`。同日既存の自分ファイルがあれば上書き。
- **受け入れ**: 保存後、Web ダッシュボード（rig）と進捗（notes）に自分の反省が現れる。数値の空欄は null で保存される。

### 5.4 ロードマップ編集
- `GET /api/overlays/roadmap` → 自分キー（フルネーム）を編集: 大目標、マイルストーン 追加/改名/並替(↑↓)/達成トグル(doneAt 記録)。
- 保存は **PUT 直前に必ず re-read → 自分キーのみマージ**（他部員キーのクロバー防止）。
- **受け入れ**: 他部員のロードマップを壊さず自分のだけ更新される。現在地（最初の未達）が表示される。

### 5.5 時系列閲覧
- 自分の過去反省を日付降順で閲覧。課題の推移が追える簡易表示（詳細な推移グラフは Web に委ねる）。

### 5.6 参考ガイド（North Sails チューニングガイド）
- North Sails 470 チューニングガイド（下記PDF）の数値を rig 入力の参考として閲覧・チップ表示。
  - `https://www.northsails.co.jp/wp/wp-content/uploads/2019/03/qtt_n9l5_j.pdf`
  - `https://www.northsails.co.jp/wp/wp-content/uploads/2019/03/qtt_n12-l9b-_j.pdf`
- v1 実装: ガイドの主要数値を**アプリ内の静的テーブル**（風速帯 × 各セッティング）として同梱し、rig 欄の「📖ガイド」チップで該当値を表示。原典 PDF へのリンクも置く。
- （AI補佐③の参考文献紐付けとは別。§6.3③はサーバ `references/` の PDF を Gemini に直送する既存機構。）

---

## 6. コアロジック詳細

### 6.1 前回チューニングのプリフィル
- `GET /api/summaries` → 自分（people[0]==自分）を含む反省を持つファイルを新しい順に特定。
- 直近ファイルを `GET /api/projects/:name` → その `reflections` から自分の最新反省の `rig` を採用（`previousRig` 相当・純関数）。
- 新規反省フォームへ数値をプリフィル。天候は引き継がない（日ごとに変わる）。
- **純関数**: `previousRig(reflectionsOfMe) -> rig`（sailviz と同ロジック）。

### 6.2 天候アメダス仮入力（`wind.js` を Dart 移植）
- 純関数: `amedasUrl(ms, point='46141')`, `parseWind(json, targetMs)`, `windDirName(idx)`。
- `fetchWind(targetMs)`（http 注入可）→ `{dir, dirIdx, speed, source:'amedas', station:'辻堂', obsMs}` or null。
- 非公式 API（`jma.go.jp/bosai/amedas/...`）は**直近1〜2日のみ**。古い日/失敗は null → 手入力。
- **純関数を単体テスト**（URL 組立・最近傍サンプル選択・方位名変換）。

### 6.3 AI目標補佐（4機能・全て `/api/ai-comment` 経由）
共通: プロンプト生成／レスポンス検証（JSON抽出・フィールド検証）は**純関数**でテスト。AI出力は**必ずユーザー承認後に挿入**。認証必須（未 unlock ならパスワードへ誘導）。失敗はトースト表示し手入力継続。

**① 次の目標を提案**
- 文脈: 自分の未解決の課題・最近の発見・ロードマップ現在地。
- system: 「あなたは経験豊富なセーリングコーチ。未解決の課題・最近の発見・ロードマップの現在地から、次の練習で狙う具体的な目標を提案する。憶測で断定しない。」
- 期待JSON: `[{"goal":"...","why":"狙い1行","measure":"測定可能な達成条件"}]`
- タップで反省の目標欄へ挿入。

**② 目標ドラフトを添削・具体化**（項目19の整形を内包）
- 入力: 自分が書いた目標文。
- system: 「曖昧な目標を、行動・数値・条件を含む測定可能な形へ整形する。意味は変えない。」
- 期待JSON: `{"refined":"...","notes":"変更点の要約"}`
- 挿入で目標欄を置換。

**③ 参考文献を紐付け**（既存 `aicomment.js` の2段流用）
- (1) 章要約スクリーニング（`buildScreenPrompt`/`parseScreen` 相当）→ 関連ソース選択。
- (2) 該当PDFを inline 直送（`buildGroundPrompt`/`parseGroundObject` 相当）→ 出典リンク付きコメント。
- 対象は目標/課題。ソースはサーバ `src/references/`（東大ヨット部ブログ21章）＋ **North Sails ガイドを追加**すれば候補に入る（§8 サーバ側1回の追加作業）。
- PDF の base64 直送が必要 → アプリはサーバ経由で PDF を取得する手段が要る（後述の制約参照）。
  - **v1 簡易案**: ③はまず「章要約スクリーニングのみ」でテキスト助言＋出典リンクを返し、PDF 直送根拠付けは Web 側に委ねる（モバイルの PDF 直送は帯域負荷大）。完全版は後フェーズ。

**④ マイルストーンを提案**
- 入力: 大目標。
- system: 「大目標を達成順の中間マイルストーン4〜6個に分解する。各1行・達成可否が判定できる粒度。」
- 期待JSON: `[{"title":"..."}]`
- 採用でロードマップに `addMilestone` 相当追加。

---

## 7. エラー処理・オフライン・セキュリティ

- **401**: 「パスワードが必要/失効」→ unlock 画面。cookie が cross-site で落ちる環境向けに、api_client はトークンを secure_storage にも保持し `Authorization: Bearer <token>` フォールバック送信。
  - ※ これを使う場合のみサーバ `server/auth.js` の `isAuthorized` に Authorization ヘッダ判定を1行追加（任意改修）。cookie で通れば不要。
- **保存競合**: ロードマップは PUT 直前に必ず re-read→自分キーのみマージ。反省は自分ファイル単位なので競合最小。
- **ネットワーク失敗**: 反省・ロードマップ編集は**下書きをローカル保存**（shared_prefs）。次回起動でリトライ提示。
- **アメダス/AI 失敗**: null/例外を握って手入力・手編集にフォールバック。
- **バリデーション**: rig は数値のみ（`toNum` 空欄→null）。不正入力は保存前に弾く。
- **プライバシー**: AI補佐は反省本文を Google(Gemini) に送信する旨をボタン付近に明示（sailviz 項目35 と整合）。

---

## 8. sailviz 本体側で必要な一度きりの作業（アプリ外）

1. **North Sails ガイド PDF を `src/references/` に追加**し、`src/references/` のインデックス（`todaiyacht.js` と同型の新ファイル or 既存へ追記）に章要約・タイトル・link を登録。→ AI補佐③の候補ソースに入る。
2. （任意）Authorization ヘッダ認証を使うなら `server/auth.js` に1行追加。
3. デプロイ環境に `GEMINI_API_KEY` 設定済みであること（AI 機能の前提）。

---

## 9. テスト方針（sailviz 準拠＝純ロジックを単体テスト）

`flutter test` で純関数を網羅:
- `buildReflectionProject(refl) -> 軽量プロジェクト JSON`
- `normalizeRig` / `normalizeNotes` / `toNum`
- `previousRig(reflectionsOfMe) -> rig`
- `amedasUrl` / `parseWind` / `windDirName`
- AI 各モード `buildPrompt*` / `parseResponse*`（JSON 抽出・検証）
- `mergeMyRoadmapKey(overlay, name, entry)`（他キー不変を検証）
- `memberSlug(member) -> 英数字 slug`（ファイル名規則適合）

リポジトリは fake api_client 注入で契約テスト。UI/実機は手動確認。

---

## 10. 未解決・リスク

- **AI補佐③の PDF 直送**: モバイル帯域負荷のため v1 は「スクリーニング＋出典リンク」に留める案。完全な根拠付けコメントは後フェーズ or Web 委譲。
- **ホームのカード重複**: 同日に Web(GPS ファイル) と アプリ(反省ファイル) の2枚が Web ホームに出る。集計は反省id基準で無害だが、将来 Web 側で同日マージ表示を検討。
- **ロードマップ同時編集**: re-read マージで緩和。厳密な楽観ロックは後フェーズ。
- **North Sails ガイドの数値テーブル化**: PDF から手動で主要数値を抽出して同梱（§5.6）。抽出の正確性は実装時に要確認。

---

## 付録: 別ディレクトリ実装用プロンプト

> 以下を、別リポジトリ（新規 Flutter プロジェクト）でそのまま実装開始プロンプトとして使う。sailviz repo を参照しなくても実装できるよう、契約・スキーマを自己完結で含める。

```
# タスク: セーリング反省入力モバイルアプリ（Flutter）v1 の実装

## 背景
「sailviz」という既存の Node バックエンド（セーリング練習の GPS/反省ビューア）に、
スマホから反省を入力・蓄積し、自分のロードマップ/目標/課題/発見を編集し、
目標設定を AI が補佐する Flutter アプリを新規実装する。バックエンドは無改修で使う。

## 技術スタック
Flutter + Riverpod + dio + cookie_jar + flutter_secure_storage + shared_preferences。
純ロジック（正規化/プロンプト生成/レスポンス検証/プリフィル/アメダス URL・パース）は
UI・HTTP から分離し、flutter test で TDD。リポジトリは fake api_client を注入して契約テスト。UI は手動確認。

## バックエンド API 契約（ベースURLは環境変数。例 https://sailviz-sit.fly.dev / http://localhost:8000）
- 認証: 閲覧系(GET)は不要。書込系(PUT/DELETE/AIコメント)は sailviz_token Cookie が必要。
  - POST /api/unlock  body {"password":"<共有PW>"} → 200 {unlocked:true} + Set-Cookie: sailviz_token
  - GET  /api/auth → {unlocked:bool}
  - POST /api/lock → cookie 破棄
  - ネイティブ http は CORS 非対象。cookie_jar で Cookie 保持・再送。cookie が落ちる環境用に
    トークンを secure_storage にも保持し Authorization: Bearer フォールバック（サーバ側対応時のみ有効）。
- GET  /api/projects → [{name,label}]（name は <...>.sailviz.json）
- GET  /api/summaries → 各練習の軽量サマリ配列
- GET  /api/projects/:name → プロジェクト JSON 全体
- PUT  /api/projects/:name（要認証）body=プロジェクト JSON → {ok:true}
- GET/PUT /api/overlays/roadmap（PUT要認証）
- POST /api/ai-comment（要認証）body {model,system,parts,temperature,maxOutputTokens,responseMimeType} → {text}
  parts=[{text}] or {inlineData:{mimeType,data(base64)}}。responseMimeType:"application/json" 可。
  既定モデル gemini-3.6-flash。キーはサーバ側環境変数（未設定なら 503）。
- プロジェクトのファイル名規則: ^[A-Za-z0-9._-]+\.sailviz\.json$（日本語不可）。
  アプリは sailviz-<YYYYMMDD-HHmm>-<自分slug>.sailviz.json で保存（slug は英数字。member id m0.. 可）。

## データスキーマ（sailviz と完全一致させること）
反省1件:
{
  id: "refl<ts>_<slug>", createdAt: <epoch ms>, text: "自由記述",
  people: ["<自分フルネーム>"],   // ★ people[0]=自分。進捗/ロードマップの帰属キー
  videos: [],
  wind: {dir,dirIdx,speed,source:"amedas"|"manual",station:"辻堂",obsMs} | null,
  practice: {date:"YYYY/MM/DD", startMs, endMs},
  rig: {boatNo,gear,prebend,rake,sideTension,foreTension,puller,peakRope,
        bridleHeight,jibLeader,jibPull,vangPull},  // 全キー。空欄=null（0保持）
  waveHeight: <number>|null,
  notes: {goal,issue,discovery,slowFactor,fastFactor}  // 全キー。未入力=""
}
rig ラベル: 船番号/ギア/プリベンド/レーキ/サイドテンション/フォアテンション/プラー/
           ピークロープ/ブライダル高/ジブリーダー/ジブ引き量/バング引き量
notes ラベル: 目標/感じている課題/発見/遅かった要因/速かった要因
軽量プロジェクト(アプリが PUT): {version:1, savedAt:<ms>, reflections:[<反省1件>], practiceDate:<ms>}
  （tracks/videos/marks/pins は含めない。GPS 巨大ファイルには触れない）
ロードマップ overlay: { "<フルネーム>": {goal:"", milestones:[{id,title,done,doneAt}]} }
部員名簿: 20名を同梱。fullName="<family> <given>"（半角スペース区切り）。member id m0..m19。
  [村瀬 礼, 高田 咲, 木下 佳穂, 本間 由真, 高原 直翔, 小川 勇希, 西本 亜美, 風間 大煕,
   伊藤 理々子, 佐藤 妙, 大澤 希, 押尾 明汰, 上島 滉起, 吉田 悠翔, 宮田 櫂澄, 引池 匠,
   緒方 菜那子, 田巻 隆雅, 原田 修有, 星川 桃香]

## 画面と受け入れ条件
1. 本人選択/ログイン: 名簿から自分を選び記憶。書込前に未unlockならPW入力→/api/unlock。
2. ホーム: /api/summaries + 自分の反省から時系列カード。前回の課題・発見を表示。「新規反省 +」。
3. 反省入力（コア・折りたたみ3セクション）:
   ① rig 12欄（数値・前回値プリフィル・North Sails ガイド参照チップ）
   ② 天候（アメダス辻堂 46141 から自動仮入力・編集可・波高手入力）
   ③ notes 5欄＋自由記述＋目標欄に AI補佐ボタン
   保存: people[0]=自分フルネームを必ず設定→PUT。同日既存の自分ファイルは上書き。
   受け入れ: 保存後 Web のダッシュボード(rig)・進捗(notes)に自分の反省が出る。空欄は null。
4. ロードマップ編集: overlays/roadmap の自分キーのみ編集（大目標＋マイルストーン 追加/改名/並替/達成）。
   PUT 直前に re-read→自分キーのみマージ（他部員を壊さない）。
5. 参考ガイド: North Sails 470 チューニングガイドの主要数値を静的テーブルで同梱＋PDFリンク。
   PDF: https://www.northsails.co.jp/wp/wp-content/uploads/2019/03/qtt_n9l5_j.pdf
        https://www.northsails.co.jp/wp/wp-content/uploads/2019/03/qtt_n12-l9b-_j.pdf

## コアロジック
- previousRig(自分の反省群)->rig をプリフィル（天候は引き継がない）。
- アメダス（純関数を Dart 移植・テスト）:
  amedasUrl(ms,point='46141') = https://www.jma.go.jp/bosai/amedas/data/point/{point}/{yyyyMMdd}_{HH}.json
  （HH=3時間ブロック開始 00,03,..,21、JST）。parseWind(json,targetMs)=最近傍で wind[0]/windDirection[0]
  が有効なサンプル。windDirName: 0=静穏,1..16 を22.5°刻み(16=北)。非公式APIは直近1-2日のみ→失敗は手入力。
- AI目標補佐 4機能（全て /api/ai-comment 経由・出力はユーザー承認後に挿入・失敗はトースト）:
  ① 次の目標提案: 未解決課題+最近の発見+ロードマップ現在地 → [{goal,why,measure}]
  ② 目標ドラフト添削・具体化: 目標文 → {refined,notes}（測定可能な形へ・意味は変えない）
  ③ 参考文献紐付け: 章要約スクリーニング→関連ソース→出典リンク付き助言（v1はスクリーニング+リンクまで）
  ④ マイルストーン提案: 大目標 → [{title}]（達成順4-6個）
  プロンプト生成・JSON 抽出/検証は純関数でテスト。

## エラー処理
401→unlock 誘導。ネット失敗→下書きをローカル保存しリトライ提示。アメダス/AI 失敗→手入力/手編集フォールバック。
rig 数値バリデーション（空欄→null）。AI 送信は Gemini(Google) に送る旨を明示。

## テスト（TDD 対象の純関数）
buildReflectionProject / normalizeRig / normalizeNotes / toNum / previousRig /
amedasUrl / parseWind / windDirName / AI 各 buildPrompt・parseResponse /
mergeMyRoadmapKey（他キー不変）/ memberSlug（ファイル名規則適合）。
リポジトリは fake api_client で契約テスト。UI は手動確認。

## スコープ外（v1）
録音・要約（項目21）/ アプリ内 GPS・動画閲覧 / Drive アップロード / リアルタイム同期 / 個人アカウント認証。
```
