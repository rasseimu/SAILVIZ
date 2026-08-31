# 練習進捗管理画面 設計書

- **日付**: 2026-08-28
- **ステータス**: 設計確定 → 実装プランへ
- **スコープ**: 議事録一括インポート ＋ 部員別進捗画面（横タブ）＋ 3段階の課題進捗トグル ＋ 風速別の発見まとめ ＋ 解決量の推移グラフ
- **非スコープ(据え置き)**: 生文字起こし(未整形会話文)のAIパース、練習ファイルへの書き戻しUI以外での編集、進捗のクラウド同期

---

## 1. 目的

保存済み練習の反省を**部員ごとに横断で追跡**する画面を作る。加えて、練習の振り返り議事録
(構造化テキスト)を**添付するだけで各部員に自動で振り分けて反省を保存**する新しいアップロード方式を
採用する。画面では、目標の変化・課題の解決進捗(3段階)・風速別の発見・解決量の推移グラフを見る。

既存の反省インフラ(`src/reflections.js` の `createReflection` / 練習ファイル保存)を**単一の真実源**として
再利用し、インポートは「読込中の練習」に各部員1件の反省を生成する。進捗の段階状態だけを
軽量オーバーレイに分離して持つ。

## 2. 前提・方針(ブレストで確定した決定事項)

- **入力は常に構造化議事録**。`## 見出し` ＋ `- **ラベル**：本文` の形。AIパースは不要・完全ローカル・決定的。
- **日付・風は「現在の練習に紐づける」**。インポートは読込中GPS練習が前提で、`practice.date` は
  その練習日、`wind` は既存の `fetchWind`→CSVフォールバックで練習1回分を取得して全行に適用。
- **解決は手動チェック＋3段階**(未着手 / 取組中 / 解決)。グラフは段階の推移。
- **名簿照合は決定的**。括弧内フルネーム→姓一致→kana一致→given一致の順。未一致行だけ保存前に手修正。

## 3. データ源・データモデル

### 3.1 反省(既存・真実源)
- インポートは部員1名につき `createReflection({ text, people:[fullName], notes:{goal,issue,discovery}, wind, practice })`
  を1件生成し、`state.reflections` に追加 → 通常の保存フロー(`saveReflections` ＋ 練習ファイル)で永続化。
- `notes` は既存 `NOTE_FIELDS` の `goal`/`issue`/`discovery` を使う(`slowFactor`/`fastFactor` は空)。
- `text` は元議事録ブロックの整形本文(監査・全文表示用)。`people` は照合できた部員のフルネーム1件。
- 進捗画面は**保存フォルダの全 `*.sailviz.json` を読み**(ダッシュボードの `loadEntries` と同一手法)、
  全反省を `people`(部員)で束ね、`practice.date` で時系列化する。

### 3.2 進捗オーバーレイ(新規・別ストア)
- `localStorage` キー `sailviz.progress`。形: `{ [reflId]: { issueStage: 0|1|2, goalDone: boolean } }`。
  - `issueStage`: 0=未着手, 1=取組中, 2=解決。既定 0。
  - `goalDone`: 目標達成チェック。既定 false。
- キーは反省の `id`(反省1件=部員×練習の1課題/1目標)。反省を消せばオーバーレイは孤児化するが
  描画時に現存反省とだけ突き合わせるので無害(定期的な掃除は将来課題)。
- **練習ファイルを書き戻さない**ため、進捗トグルは軽量かつ全ファイル再保存不要。

## 4. パーサ `src/minutes.js`(純ロジック・TDD)

```
parseMinutes(text) -> [{ headerName, fullNameHint, goal, issue, discovery, raw }]
matchMember(headerName, fullNameHint, roster) -> { member|null, how }
```

- **ブロック分割**: `^##\s*(.+)$` で見出し分割。見出しから `（…）`/`(...)` を剥がし、括弧内を
  `fullNameHint`、括弧前を `headerName`(ニックネーム)に。
- **ラベル抽出**: 各ブロック内の `- **ラベル**：本文`(全角/半角コロン両対応)を拾う。
  次の箇条書き/見出しまでの複数行・改行継続を本文に連結。
- **ラベル正規化(別名表)**:
  - `目標`/`今日の目標` → `goal`
  - `課題` → `issue`
  - `発見` → `discovery`
  - `今後`/`取り組み`/`今後の取り組み`/`取組` → `discovery` に寄せる(発見枠に集約)
  - 未知ラベルは無視(将来 `text` 全文には残るので消失はしない)。
- **matchMember**: `roster = memberList()`。優先順:
  1. `fullNameHint` が `fullName`(空白無視)に一致 → その部員
  2. `headerName`/`fullNameHint` が `family` に前方/完全一致
  3. `toHiragana(headerName)` が `kana` に一致
  4. `headerName` が `given` に一致
  - どれも無ければ `member=null`(未一致 → UIで手修正)。
- 添付議事録の8名(ゆま/ももか/あみ/だいき/ゆうと/しゅゆ/かいと/れい)が全て正しく解決することをテストで固定。

## 5. インポートUI(新しいアップロード方式)

- 導線: **反省エリア**(サイドバー)に「📋 議事録から一括取込」ボタン。ファイル選択 or 貼り付け入力。
- **前提チェック**: 読込中の練習(可視トラック)が無ければ「先に練習を読み込んでください」と誘導し中断。
- **プレビュー＆手修正モーダル**:
  - パース結果を**部員ごとの行**で一覧(照合先の部員名 / goal・issue・discovery のプレビュー)。
  - 未一致行は**名簿ドロップダウン**で割当、不要行は**除外**チェック。
  - 風は取込時に1回 `fetchWind(practice時刻)` → 失敗時 `fetchWindFromCsv`。取得結果をヘッダに表示。
- 「取込」押下 → 各採用行を `createReflection` 化して `state.reflections` に追加 → `persistReflections()`
  → `renderReflectionList()`。ステータスに「N名の反省を取込」。以後は通常の反省として保存対象。

## 6. 進捗画面 `src/progress.js` ＋ `#progress-screen`

既存 `createDashboard` のビュー切替・全ファイル読込パターンを踏襲(別ビュー・別モジュール)。

### 6.1 ルーティング
- `index.html` に **`#progress-screen`** セクション新設。body クラス **`view-progress`** を追加。
- **ホームバー**(`#home-bar`)に「📈 練習進捗管理」リンク → `showProgress()`。
- 画面ヘッダに「← ホーム」。`showProgress()`/`backToHomeFromProgress()` は dashboard と対称
  (body クラス付け替えのみ、トラック画面 canvas には触れない)。`projectDir` 未設定なら `ensureProjectDir()`。

### 6.2 横タブ・レイアウト
```
 ┌──────────── #progress-screen ────────────┐
 │ [← ホーム]  練習進捗管理                    │
 │ [全て][村瀬 礼][高田 咲][…名簿…]  ← 横タブ  │
 │                                           │
 │  ■ 目標の変化 (練習日順タイムライン/達成☑)  │
 │  ■ 課題の進捗 (課題カード×3段階トグル)      │
 │  ■ 風速別の発見 (〜3 / 3〜6 / 6〜 m/s)       │
 │  ■ 解決量の推移グラフ (Chart.js)            │
 └───────────────────────────────────────────┘
```
- **横タブ**: `全て` ＋ `memberList()` 全員。ダッシュボードのナビCSS(`.dashboard-nav-item`)を流用。
  タブ切替で下段を再描画。
- **目標の変化**: 選択部員の反省を `practice.date` 昇順に並べ、各 `goal` をタイムライン表示。
  各行に「達成」チェック(`goalDone`)。
- **課題の進捗**: `issue` 1件=1カード。**未着手/取組中/解決**の3段階トグル(`issueStage`)。
  トグルで `progressstore` に保存し、グラフ・集計を即更新。
- **風速別の発見**: `discovery` を各反省の `wind.speed` で**ビン分類**して列挙。
  ビン境界は定数(既定 `<3` / `3–6` / `≥6` m/s、`wind.speed==null` は「風速不明」)。
- **解決量の推移グラフ**: 既存 `renderChart`(Chart.js) を流用。x=練習日、y=集計値。
  - `全て` タブ = 全部員合算。部員タブ = その部員のみ。
  - y軸の定義: **練習日ごとの「解決(stage=2)に到達した課題の累計数」**(単調増加で"解決量の推移"が直感的)。
    実装プランで「累計 / その日新規解決数」を最終確定(既定は累計)。

## 7. 進捗ストア `src/progressstore.js`(純ロジック・TDD)

```
loadProgress(storage) -> obj
saveProgress(obj, storage)
setIssueStage(obj, reflId, stage) / setGoalDone(obj, reflId, done)   // 新objを返す(不変更新)
summarize(reflections, progress, { bins }) -> {
  byMember: { [fullName]: { goals:[…], issues:[…{reflId,text,stage,dateMs}], discoveriesByBin:{…} } },
  resolutionSeries: { all:[{dateMs,value}], [fullName]:[{dateMs,value}] }   // グラフ用
}
```
- `sailviz.reflections` とは別キー。localStorage 注入可(テスト決定性、`reflections.js` と同様)。
- `summarize` はUIに依存しない純関数。ビン境界・y軸集計もここで確定させ、テストで固定。

## 8. モジュール分割

| ファイル | 役割 | 依存 | テスト |
|---|---|---|---|
| `src/minutes.js` | 議事録テキスト→部員別ブロック抽出＋名簿照合。ラベル別名正規化。 | `members.js` | ○ 単体 |
| `src/progressstore.js` | `sailviz.progress` の load/save/不変更新 ＋ 反省×オーバーレイの集計(`summarize`)。 | なし(純) | ○ 単体 |
| `src/progress.js` | 横タブ・全ファイル読込・4セクション描画・グラフ配線。 | 上記＋chartview/projectfs | 手動 |
| `src/app.js` | 配線のみ(インポートボタン・`showProgress`・body クラス)。重いロジックは持ち込まない。 | — | 手動 |

## 9. スタイル(styles.css)

- `#progress-screen`(全面・home/dashboard と同様の表示切替)、横タブ(既存 `.dashboard-nav-item` 流用)、
  課題カード、3段階トグル(セグメント/ラジオ風)、風速ビンの見出し、グラフ枠を追加。既存トーンに合わせる。

## 10. テスト方針(TDD)

純モジュールを先にテスト:
- **`test/minutes.test.js`**: 添付議事録全8名のブロック抽出 / 括弧付き・括弧無し見出しの名簿照合 /
  ラベル別名(`今日の目標`/`今後`/`取り組み`)正規化 / 未知ラベル無視 / 全角半角コロン / 未一致→null。
- **`test/progressstore.test.js`**: load/save 往復 / 不変更新 / `summarize` の部員別集計 /
  風速ビン分類(境界・null) / 解決量シリーズ(全員 vs 部員 / 昇順 / 累計定義)。
- UI描画・モーダル・タブ切替・グラフ配線は手動確認(既存方針と同一)。

## 11. 段階(実装プランで詳細化)

1. `minutes.js`(パース＋照合) + テスト
2. `progressstore.js`(ストア＋`summarize`) + テスト
3. `index.html`/`styles.css`: `#progress-screen` 枠・ホームのリンク・横タブ
4. `progress.js`: タブ＋4セクション描画(静的域) + グラフ
5. インポートUI(プレビュー＆手修正モーダル)＋ `createReflection` 生成配線
6. `app.js` 配線(`showProgress`/リンク/インポートボタン)・手動確認

---

## 付録: 対象議事録フォーマット例(パースの受け入れ基準)

```
## ゆま（本間ゆま）
- **今日の目標**：ジャイブ。加えて…
- **課題**：強風クローズで…
- **発見**：北に強く吹いた時の…

## だいき（風間）
- **今日の目標**：…
- **課題**：…
- **発見**：特になし。

## しゅゆ
- **今日の目標**：追風のクルーワーク…
- **課題**：…
- **取り組み**：午前・午後とも艇におらず…
```
- 括弧無し見出し(`しゅゆ`/`かいと`/`れい`)は kana 照合で解決すること。
- `取り組み`/`今後` ラベルは `discovery` に集約されること。
