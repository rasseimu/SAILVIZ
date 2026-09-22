# ピア学習型AIコメント 設計書

作成日: 2026-09-22

## 1. 目的

練習進捗管理で、**未解決の目標/課題**に対し、AIが次を根拠にコメントとしてフィードバックする:

1. **どのように解決できたか** — 同一部員が過去に挙げた解決済み目標/課題と、その後に書いた反省(発見・目標/課題の変化)から解決プロセスを推定する。
2. **誰が類似した目標/課題を持っているか** — チーム内で似た目標/課題を過去に解決した部員を実名で示し、その解決法を引用する。

既存のAIコメント機能(参考文献PDFベース、`src/aicomment.js`)と**統合**し、進捗画面の同じ「AIコメント生成」ボタンで両系統を並走させる。

## 2. 前提と決定事項

ブレインストーミングで確定した事項:

- **解決プロセスの情報源** = 同一部員のその後の反省から自動推定(新規入力欄は設けない)。
- **類似の仲間の扱い** = 実名を挙げ、その人の解決法を引用する。本人の過去例を優先し、無ければ他部員。
- **対象と起動** = 未解決アイテムに履歴プールから助言(一括)+ 1件ずつ「AIに聞く」(既存のカード選択ロジックを流用)。既存AIコメントと統合(別ボタンにしない)。
- **モデル** = 既存の Gemini パイプライン(`src/gemini.js` → サーバ経由、APIキーはサーバ側に隠蔽)を再利用。
- **アプローチ** = ピア学習を「第2の情報源プロバイダ」として新設し、同じボタンで並走マージ(案A)。

### 既存資産(無改修で流用)

- 反省(真実源): `src/reflections.js` — `{ id, createdAt, people:[fullName], notes:{goal,issue,discovery}, wind, ... }`。
- 進捗オーバーレイ: `src/progressstore.js` — `progress[reflId] = { issueStage:0|1|2, goalDone, textOverride, deleted, comments:{goal,issue,discovery}[] }`。
- コメント保存/表示: `addComment(..., {ai:true, url, refs})`、UIは 🤖 バッジ + 出典(`refs:[{link,title}]`、link無しはテキスト表示)。`url` で二重挿入防止。
- 部員識別: `src/members.js` の `fullName`。主体は `people[0]`。

## 3. アーキテクチャとデータフロー

### モジュール

- **`src/peerlearning.js`**(新規・純ロジック) — 履歴プール構築 + プロンプト生成 + レスポンス検証 + 組み立て。API呼び出し(`geminiGenerate`)は注入。DOM/fetch/localStorage を知らない。`src/aicomment.js` と対の構成。
- **`test/peerlearning.test.js`**(新規) — プール構築・プロンプト・パーサを LLM 無しで検証。

### 依存の向き

```
progress.js ──呼ぶ──▶ peerlearning.js ──使う──▶ gemini.js(既存)
     │                      ▲
     └──既存──▶ aicomment.js ┘(参考文献ベース・無改修)
progressstore.js（comments構造・summarize）は無改修で流用
```

### データフロー(ボタン押下時)

1. `progress.js` が対象アイテム(未解決の課題/未達成の目標)を平坦化。既存の選択ロジック(選択カード優先→未AI付与→全て)を流用しつつ、ピア用は未解決に限定。
2. **並走**で2系統を呼ぶ:
   - 既存 `generateAiComments(...)`(参考文献PDF由来)
   - 新 `generatePeerComments({ items, reflections, progress, geminiGenerate })`(チーム履歴由来)
3. 両者の戻り値(同形 `{reflId, field, comment, url, refs}`)をマージ。
4. `url` で重複排除し、`addComment(..., {ai:true, url, refs})` で保存。既存UIが表示。

## 4. 履歴プールと「解決の手がかり」の構築

`buildHistoryPool(reflections, progress)`(純関数)。

### 解決済みアイテムの抽出

- 課題: `progress[reflId].issueStage === 2`。
- 目標: `progress[reflId].goalDone === true`。
- テキストは `textOverride` を優先(既存 `summarize` と同規則)。削除(ゴミ箱)済みは除外。

### 「どう解決したか」の手がかり(同一部員のその後の反省)

各解決アイテムについて、`people[0]` が同じ部員が **その反省日時(`createdAt`)以降** に書いた反省から証拠を添える:

- `discovery`(発見)テキスト — 主たる手がかり。
- 後続の `goal`/`issue` の変化 — 同テーマが解決へ向かった形跡。

上限は **直近 K=5 件**、**風速帯(windBin)が近いものを優先**。証拠ゼロの解決アイテムも「解決済みの事実」として残す(似た目標を持つ“誰か”の提示に使える)。

### プール要素の形

```js
{
  poolId: 'p0',                        // プール内一意ID(スクリーニングで参照)
  member: '村瀬 礼',
  field: 'issue' | 'goal',
  text: '課題/目標テキスト',
  dateMs: 解決アイテムの反省日時,
  windBin: 'lt3'|'mid'|'ge6'|'unknown',
  evidence: [{ dateMs, field:'discovery'|'goal'|'issue', text }]  // 最大K件
}
```

### 対象(未解決)アイテムの抽出

- 課題 `stage !== 2`、目標 `done !== true`。
- 本人優先はプロンプト側の指示で表現(プールは全部員分を渡す)。

## 5. LLMプロンプト(2段構え)とレスポンス検証

既存 `aicomment.js` と同じ「スクリーニング → 根拠付け」を踏襲。

### (1) スクリーニング `buildPeerScreenPrompt(items, pool)`

- 入力: 未解決アイテム一覧(`reflId, field, text`)+ 履歴プールの軽量サマリ(`poolId, member, field, text`。evidence 本文はまだ渡さずトークン節約)。
- system: 「経験豊富なセーリングコーチ。各“未解決”の目標/課題に対し、似た目標/課題を過去に解決した事例をプールから選ぶ。憶測で紐付けない。同一人物の過去事例があれば優先、無ければ他部員。」
- 出力JSON: `[{"reflId","field","poolId"}]`(1アイテムにつき関連度順に最大3件、無ければ `[]`)。
- 検証 `parsePeerScreen(rawText, pool)`: 実在 `poolId`・正しい `field`・既知 `reflId` のみ採用(既存 `parseScreen` と同型)。

### (2) 根拠付け `buildPeerGroundPrompt(item, matches)`

- 入力: 対象アイテム(`field, text`)+ 選ばれた解決事例(`member, text, dateMs, evidence[]` を本文込み)。
- system: 「添付のチーム内の解決事例だけを根拠に、実践的な助言を日本語3〜5文で。誰(実名)が似た目標/課題をどう解決したかを具体的に引用する(例『村瀬さんも同様の課題を〇〇という発見で解決しています』)。事例に無い内容は憶測で書かない。本人自身の過去例なら『自分の△△の時の発見が使えます』と促す。」
- 出力JSON: `{"comment":"...","usedPoolIds":[...]}`。comment 空なら不採用。
- 検証 `parsePeerGroundObject(rawText)`: 既存 `parseGroundObject` と同型。

### 組み立て `generatePeerComments({ items, reflections, progress, geminiGenerate, model, maxMatchesPerItem=3 })`

- `buildHistoryPool` → スクリーニング1回 → アイテム毎に事例をまとめ(最大 `maxMatchesPerItem`)→ 根拠付けをアイテム毎に呼ぶ。
- 戻り値: `{reflId, field, comment, url, refs}`。
  - `refs` = 使用 `usedPoolIds` から `[{link:null, title:'村瀬 礼・課題(2026-08-15)'}]`。
  - `url` = `peer:${reflId}:${field}:${[...usedPoolIds].sort().join(',')}`。
- PDF inline 添付は不要(すべてテキスト)→ `filePart` 不使用。

## 6. progress.js への統合

`wireAiControls()` 内の生成ハンドラを拡張:

- 対象決定後、`generateAiComments`(既存・PDF)と `generatePeerComments`(新・履歴)を両方 await(順次または `Promise.all`)。ピア側の `items` は未解決に絞る。
- 片系統の失敗はもう一方を止めない(各々 try/catch)。
- 得たコメント候補を結合し、既存同様 `hasAiComment(progress, reflId, field, url)` で重複を弾いて `addComment`。
- ステータス表示は合算件数。文言を「参考文献＋チームの解決事例を照合中…」に更新。

UI(HTML/CSS)・コメント保存構造・出典表示は改修不要。

## 7. エラーハンドリング

- LLM応答が非JSON/形式不正: パーサが例外 → その呼び出しは握りつぶし空扱い(既存方針)。
- スクリーニングが空: `generatePeerComments` は `[]` を返す。
- 履歴プールが空(解決済みが皆無): 早期 `return []`。
- 1アイテムの根拠付け失敗: `continue` で他アイテムに影響させない。
- 認証(編集モード)必須は既存ボタンの前提を踏襲。

## 8. テスト方針(`test/peerlearning.test.js`)

`geminiGenerate` はスタブ注入し、ネットワーク非依存で検証。

- `buildHistoryPool`: stage2/done の抽出、textOverride 優先、削除除外、証拠が「同一部員・以降・最大K・風速帯優先」で選ばれること、証拠ゼロでも要素が残ること。
- `buildPeerScreenPrompt` / `parsePeerScreen`: 未知poolId・不正field・未知reflId の除去、最大3件。
- `buildPeerGroundPrompt` / `parsePeerGroundObject`: comment空→null、usedPoolIds のフィルタ。
- `generatePeerComments`: スタブ応答から `{reflId, field, comment, url, refs}` を組み立て、`url`/`refs` の形、空プール・空スクリーニングの早期return、1件失敗の分離。

## 9. 非対象(YAGNI)

- 解決プロセスを人が手入力する欄の新設(案②)は作らない。
- 埋め込み/ローカル類似度計算(案C)は導入しない。
- 参考文献PDFと履歴を1プロンプトに融合する単一パイプライン(案B)は採らない。
- 部員間の通知/マッチング機能などコメント以外の連携は範囲外。
