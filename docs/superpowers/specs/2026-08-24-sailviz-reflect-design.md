# 反省入力アプリ `sailviz-reflect` 設計（ロードマップ #20）

作成日: 2026-08-24
対象: 新規リポジトリ `sailviz-reflect`（＋既存 SailViz への小さな連携追加）
関連: ロードマップ #16（反省フォーマット）/ #17（ホーム画面）/ #9・#18（Drive/動画運用）

## 目的

各部員が **自分のスマホ** から反省フォーマットを入力し、クラウドに蓄積する。
自分の反省を **時系列で見返せる**、ホームに **前回の課題／発見** を表示する、
動画を Drive にアップロードする **導線** を用意する。将来的にアプリから
トラック（SailViz の分析）も見られるようにする布石を置く。

分析者向けの重い SailViz 本体（GPS CSV・動画・地図）とは **ユーザー・端末・配信・
スタックが別物** なので、**別リポジトリ** で開発する。両者を繋ぐ唯一の結合は
「反省フォーマットのスキーマ（#16）」だけであり、これは *コードの結合ではなく
データ形式の結合* なので共有スキーマ1本で吸収する。

## なぜ別リポジトリか（設計判断の根拠）

| 観点 | 現行 SailViz | sailviz-reflect（#20） |
|---|---|---|
| ユーザー | 分析者（1人・PC） | 各部員（多人数・スマホ） |
| 実行環境 | Chrome + FileSystem Access API | モバイルブラウザ / PWA |
| 配信 | ローカル静的配信（`serve.py`） | オンラインにホスティング |
| スタック | 素の ESM・ビルド無し | 素の ESM・ビルド無し・PWA・Supabase(CDN ESM) |
| データ | ローカル `.sailviz.json` | Supabase（クラウド） |

スマホ入力を自然にする必要が **FileSystem Access API を使えなくする**（iOS Safari 非対応）。
そのため「共有フォルダ経由・バックエンドなし」は成立せず、**極小のクラウド保存層
（Supabase）が実質必須**。この配信・スタックの差が、リポジトリ分割を自然にする。

## 非目標（YAGNI）

- 本物の認証（メール/パスワード、per-user 暗号化、厳密な個人分離）は行わない。
  → **名簿選択式の軽量 identity**（下記「identity」）。
- リアルタイム同期・コメント機能・通知は入れない。
- AI 文章整形／参考文献提案（#19）・録音要約（#21）はこのアプリに含めない。
- Drive への **API 直アップロードはしない**（大学アカウント制約）。導線（ディープリンク）のみ。
- SailViz 本体側の「クラウド反省取込」は **後続フェーズ**（本 spec では接点の定義まで）。
- モノレポ化／npm パッケージ publish はしない（共有スキーマはコピー＋契約テスト）。

## identity（本人確認）

**名簿選択式（軽量）**。SailViz の `members.js` と同じ名簿を `sailviz-reflect` にも持ち、
起動時に自分を選ぶ。任意で **部の共有合言葉** をゲートに置く（部外者を軽く弾く程度）。

- 厳密な個人分離は行わない。反省は部内で相互に見え得る（元々ペア／ポジションで
  一緒に反省するため許容）。
- `member_id` は名簿由来の安定ID（`members.js` の `memberList()` が付ける `id` と同一規則）。

### セキュリティの正直な注記
- 名簿 identity ＝ Supabase Auth を使わないため、クライアントには **anon key** が露出する。
  URL を知る第三者が読み書きし得る。小規模で信頼できる部内ツールとしては許容範囲。
- 緩和策は合言葉ゲート程度（本物の防御ではない）。将来、厳密分離が必要になったら
  Supabase Auth（メールマジックリンク）＋ RLS `auth.uid()` へ移行する余地を残す。

## アーキテクチャ全体

```
[部員のスマホ]  sailviz-reflect (Vite+Svelte PWA)
      │  ①名簿選択  ②反省入力  ③自分の履歴
      │  offline-first: localStorage キュー
      ▼ （オンライン時にフラッシュ）
[Supabase]  Postgres: members / practices / reflections
      ▲
      │ ④read-only fetch（後続フェーズ）
[分析PC]   SailViz 本体 → state.reflections に合流
```

## フロントエンド構成（`sailviz-reflect`）

**素の ESM・ビルド無し、PWA（インストール可・オフラインファースト）** を採用。
SailViz と同じ「手書き ESM ＋ `node --test` ＋ DI で純ロジックをテスト」流儀を踏襲し、
ツールチェーンを増やさない。Supabase は CDN の ESM (`@supabase/supabase-js`) を
`import` し、ルーティングは小さなハッシュルーターを自作、PWA は手書き Service Worker。
重い #16 フォームは手書きになるが、SailViz の反省エディタ（`app.js`）と同じ流儀で書ける。

- `src/schema.js`（共有スキーマ・下記。DOM 非依存・テスト対象）
- `src/supabase.js`（Supabase クライアント初期化・anon key は `config.js` 経由）
- `src/syncQueue.js`（オフラインキュー・純ロジック・DI 可能・テスト対象）
- `src/identity.js`（名簿選択・合言葉・localStorage 保持・純ロジック・テスト対象）
- `src/router.js`（ハッシュルーター・純ロジック・テスト対象）
- `src/views/`（home.js / newReflection.js / history.js / detail.js — DOM 描画）
- `index.html` / `styles.css` / `sw.js`（Service Worker）/ `manifest.webmanifest`

## 共有スキーマ（両リポの唯一の結合点）

SailViz `src/reflections.js` の純ロジックのうち、**形を規定する部分**を1ファイルに切り出す:
`RIG_FIELDS` / `NOTE_FIELDS` / `toNum` / `normalizeRig` / `normalizeNotes` /
`previousRig` / `createReflection`。

- 方式: **両リポにコピー ＋ ゴールデン JSON フィクスチャの契約テスト** で形の一致を保証。
  - `test/schema-contract.test.js`: 代表入力 →`createReflection`→ 既知の期待 JSON と一致。
  - 同一フィクスチャを SailViz 側 `test/` にも置き、`deserializeProject` が受理することを確認。
- 代替: `sailviz-schema` を git submodule 化して両リポで参照（採用しないが将来の逃げ道）。

## データモデル（Supabase / Postgres）

`reflections` は **#16 の反省オブジェクトの形をそのままミラー** する（SailViz が変換なしで
`state.reflections` に流し込めるように）。

```sql
-- 名簿（members.js からシードして同期。読み取り中心）
create table members (
  id           text primary key,      -- memberList() の安定IDと同一規則
  family       text not null,
  given        text not null,
  kana         text
);

-- 練習セッション（1練習=1行。日付で SailViz の練習と対応づけ）
create table practices (
  id           uuid primary key default gen_random_uuid(),
  date         date not null,         -- 練習日（SailViz プロジェクトの日付と突合）
  title        text,
  created_at   timestamptz not null default now()
);

-- 反省（#16 の反省オブジェクトをミラー）
create table reflections (
  id           uuid primary key default gen_random_uuid(),
  member_id    text not null references members(id),
  practice_id  uuid references practices(id),
  practice_date date not null,        -- practice 未作成でも日付で紐付け可能に
  created_at   timestamptz not null default now(),
  text         text not null default '',
  rig          jsonb not null default '{}',   -- RIG_FIELDS（数値/null）
  wave_height  numeric,
  notes        jsonb not null default '{}',   -- NOTE_FIELDS（文字列）
  wind         jsonb,                          -- { dir, speed, source, station, obsMs }
  people       jsonb not null default '[]',    -- @メンション（構造化）
  videos       jsonb not null default '[]'     -- [{ name, tMs }]
);

create index on reflections (member_id, practice_date desc);
```

### RLS（Row Level Security）
名簿 identity（認証なし・anon key）前提のため、厳密な行分離はできない。
`select`/`insert` を許可、`update`/`delete` は自分の `member_id` 行のみ許可する
ソフトポリシーを置く（クライアントが `member_id` を偽れる点は上記注記の通り許容）。

## データフロー

1. **起動**: PWA を開く → 名簿から自分を選択 → （任意で合言葉）→ `identity` に保存。
2. **ホーム**: 自分の **前回練習の「課題（issue）／発見（discovery）」** を表示
   （Supabase から自分の最新 `reflections` を取得、オフライン時はローカルキャッシュ）。
   「新規 +」と自分の履歴サマリカードを並べる（#17 と思想を合わせる）。
3. **新規反省**: #16 レイアウトのフォーム。リグは `previousRig(自分の履歴)` で
   **前回値プリフィル**（微調整だけで済む）。天候は引き継がない（#16 メモ準拠）。
4. **保存**: まず **localStorage キューに即書き**（オフライン対応・保存が消えない）→
   `syncQueue` がオンライン時に Supabase へ upsert。各件に同期ステータス（pending/synced）。
5. **履歴**: 自分の反省を時系列リストで表示 → タップで詳細展開。
6. **Drive 動画アップ導線**: 「動画を Drive にアップ」ボタン →
   Drive アプリ／共有フォルダのディープリンクを開く（手動アップロード。API は使わない）。

## オフラインファースト（"自然な UX" への回答）

海辺は電波が悪いことがあるため、保存が消えないことを最優先にする。

- 保存は同期的に localStorage キューへ（`syncQueue.enqueue(reflection)`）。
- `online` イベント／起動時に `syncQueue.flush(supabase)` で pending を送信。
- 送信成功で `synced` に更新、失敗は pending のまま次回再試行（べき等 upsert）。
- 純ロジック（enqueue/flush/状態遷移）は **フェイク storage ＋ フェイク supabase を注入**して
  単体テスト（既存 `reflections.js`/`projectfs.js` の DI 流儀に合わせる）。

## SailViz 連携（既存リポ・後続フェーズ）

本 spec では **接点の定義まで**。実装は別チケット。

- SailViz に「☁ クラウド反省取込」アクションを追加:
  現在の練習日（`practice_date`）で Supabase から反省を read-only fetch →
  共有スキーマで形を検証 → 既存 `state.reflections` に合流 → 既存の反省描画を再利用。
- 追加は小さい（新規 `src/reflectionsCloud.js` ＋ ボタン結線）。既存の反省 UI は変更なし。

## テスト

`sailviz-reflect` 側:
- `test/schema-contract.test.js`: 共有スキーマの `createReflection` 出力がゴールデン JSON と一致。
- `test/syncQueue.test.js`: enqueue→flush で pending→synced、オフライン時保持、失敗時再試行、
  upsert のべき等性（フェイク storage / フェイク supabase を注入）。
- `test/identity.test.js`: 名簿選択・合言葉ゲート・localStorage 保持の純ロジック。
- `test/prefill.test.js`: `previousRig(自分の履歴)` が最新反省のリグを返す／空履歴で空リグ。

SailViz 側（本 spec 範囲では契約のみ）:
- `test/schema-contract.test.js`（同一フィクスチャ）で `deserializeProject`／反省描画が
  クラウド反省の形を受理することを確認。

## 実装順序（概略）

1. 共有スキーマ切り出し（SailViz `reflections.js` から）＋契約テスト（両リポ）。
2. `sailviz-reflect` リポ初期化（素 ESM ＋ PWA 雛形：index.html/sw.js/manifest）、Supabase プロジェクト作成・DDL 適用。
3. `identity.js`（名簿選択・合言葉）＋テスト。
4. `syncQueue.js`（オフラインキュー）＋テスト。
5. 新規反省フォーム（#16 レイアウト・リグ前回値プリフィル）。
6. ホーム（前回課題/発見）・履歴（時系列）・詳細。
7. Drive アップ導線（ディープリンクボタン）。
8. デプロイ（ホスティング）・実機スマホで手動確認（オフライン保存→復帰同期）。
9. （後続）SailViz 側「クラウド反省取込」。
