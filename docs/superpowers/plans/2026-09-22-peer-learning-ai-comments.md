# ピア学習型AIコメント 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 進捗管理の未解決の目標/課題に対し、チーム内の解決履歴と似た目標/課題を持つ部員を根拠に、実名引用のAIコメントを生成する。

**Architecture:** 純ロジックモジュール `src/peerlearning.js` を新設。`summarize()` を再利用して解決済みアイテム+同一部員のその後の反省(解決の手がかり)から「履歴プール」を作り、既存 `aicomment.js` と同じ2段構え(スクリーニング→根拠付け)で Gemini に投げる。進捗画面の既存AIコメントボタンで参考文献系統と並走マージし、コメント保存/表示(`addComment`/🤖バッジ/出典)はそのまま流用。

**Tech Stack:** バニラ ES modules、Node.js `node:test`/`node:assert`、既存 `src/gemini.js`(サーバ経由 Gemini、APIキーはサーバ隠蔽)、`src/progressstore.js`。

**Spec:** `docs/superpowers/specs/2026-09-22-peer-learning-ai-comments-design.md`

## Global Constraints

- 言語: コメント本文・UI文言は日本語。コード内コメントも既存に倣い日本語。
- ビルドなし: ES modules をブラウザが直接読む。トランスパイル前提の構文を使わない。
- 純ロジックは API/DOM/fetch/localStorage を直接触らない。`geminiGenerate` は引数注入(テストでスタブ可能に)。
- 進捗オーバーレイの override フィールドは `st.text`(キー名は `text`。`textOverride` ではない)。
- 反省の主体は `people[0]`、日時は `practice.startMs ?? createdAt`(= `summarize` の `reflDateMs`)。
- コメント種別対象: ピア学習は **goal / issue のみ**(discovery は対象外)。
- テスト実行: `node --test`(全体)/ `node --test test/peerlearning.test.js`(個別)。
- コミット末尾に `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## File Structure

- **Create `src/peerlearning.js`** — 履歴プール構築 + プロンプト生成 + パーサ + 組み立て `generatePeerComments`。`aicomment.js` と対。
- **Create `test/peerlearning.test.js`** — 上記の純ロジックを LLM 無し(geminiGenerate スタブ)で検証。
- **Modify `src/progress.js`** — `wireAiControls()` の生成ハンドラで参考文献系統とピア系統を並走マージ。

---

### Task 1: 履歴プール構築 `buildHistoryPool`

**Files:**
- Create: `src/peerlearning.js`
- Test: `test/peerlearning.test.js`

**Interfaces:**
- Consumes: `summarize`, `windBinKey`（`src/progressstore.js`、既存)。
- Produces: `buildHistoryPool(reflections, progress, { maxEvidence = 5 } = {})` →
  `[{ poolId:'p0'..., member, field:'goal'|'issue', text, dateMs, windBin, evidence:[{dateMs, field, text}] }]`

- [ ] **Step 1: Write the failing test**

`test/peerlearning.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryPool } from '../src/peerlearning.js';

// 反省を1件作るヘルパ。dateMs は practice.startMs に入れる(summarize の reflDateMs 準拠)。
function refl(id, name, notes, { speed = null, dateMs = 0 } = {}) {
  return { id, people: [name], notes, wind: { speed }, practice: { startMs: dateMs } };
}

test('buildHistoryPool: 解決済み課題(stage2)と達成済み目標(done)だけを拾う', () => {
  const reflections = [
    refl('r1', '村瀬 礼', { issue: '走らない' }, { dateMs: 100 }),
    refl('r2', '村瀬 礼', { issue: '曲がらない' }, { dateMs: 200 }),
    refl('r3', '村瀬 礼', { goal: '一次予選突破' }, { dateMs: 300 }),
  ];
  const progress = {
    r1: { issueStage: 2 },   // 解決 → 入る
    r2: { issueStage: 1 },   // 取組中 → 入らない
    r3: { goalDone: true },  // 達成 → 入る
  };
  const pool = buildHistoryPool(reflections, progress);
  assert.equal(pool.length, 2);
  assert.deepEqual(pool.map((p) => [p.member, p.field, p.text]).sort(), [
    ['村瀬 礼', 'goal', '一次予選突破'],
    ['村瀬 礼', 'issue', '走らない'],
  ]);
  assert.ok(pool.every((p) => typeof p.poolId === 'string' && p.poolId.length));
});

test('buildHistoryPool: 手がかりは同一部員の"以降"の発見/変化、最大K件・風速帯優先', () => {
  const reflections = [
    refl('r1', '村瀬 礼', { issue: '微風で走らない' }, { speed: 2, dateMs: 100 }),
    // 同一部員・以降の発見(微風=近い風速帯)→ 優先
    refl('r2', '村瀬 礼', { discovery: 'カニンガムを緩める' }, { speed: 2, dateMs: 150 }),
    // 同一部員・以降の発見(強風=遠い風速帯)
    refl('r3', '村瀬 礼', { discovery: 'ベンド最大' }, { speed: 8, dateMs: 160 }),
    // 別部員の発見 → 入らない
    refl('r4', '本間 由真', { discovery: '関係ない' }, { speed: 2, dateMs: 170 }),
    // 以前の発見 → 入らない
    refl('r0', '村瀬 礼', { discovery: '過去の発見' }, { speed: 2, dateMs: 50 }),
  ];
  const progress = { r1: { issueStage: 2 } };
  const pool = buildHistoryPool(reflections, progress, { maxEvidence: 5 });
  assert.equal(pool.length, 1);
  const texts = pool[0].evidence.map((e) => e.text);
  assert.ok(texts.includes('カニンガムを緩める'));
  assert.ok(texts.includes('ベンド最大'));
  assert.ok(!texts.includes('関係ない'));   // 別部員は除外
  assert.ok(!texts.includes('過去の発見'));  // 以前は除外
  // 風速帯が近い(微風)発見が先頭
  assert.equal(pool[0].evidence[0].text, 'カニンガムを緩める');
});

test('buildHistoryPool: maxEvidence で件数を制限する', () => {
  const reflections = [refl('r1', '村瀬 礼', { issue: 'x' }, { dateMs: 100 })];
  for (let i = 0; i < 8; i++) {
    reflections.push(refl(`d${i}`, '村瀬 礼', { discovery: `発見${i}` }, { dateMs: 200 + i }));
  }
  const pool = buildHistoryPool(reflections, { r1: { issueStage: 2 } }, { maxEvidence: 3 });
  assert.equal(pool[0].evidence.length, 3);
});

test('buildHistoryPool: 解決済みが無ければ空配列', () => {
  const pool = buildHistoryPool([refl('r1', '村瀬 礼', { issue: 'x' }, { dateMs: 1 })], { r1: { issueStage: 1 } });
  assert.deepEqual(pool, []);
});

test('buildHistoryPool: textOverride(st.text)を優先する', () => {
  const reflections = [refl('r1', '村瀬 礼', { issue: '元テキスト' }, { dateMs: 100 })];
  const progress = { r1: { issueStage: 2, text: { issue: '修正後テキスト' } } };
  const pool = buildHistoryPool(reflections, progress);
  assert.equal(pool[0].text, '修正後テキスト');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/peerlearning.test.js`
Expected: FAIL（`Cannot find module '../src/peerlearning.js'` もしくは `buildHistoryPool is not a function`)

- [ ] **Step 3: Write minimal implementation**

`src/peerlearning.js`:
```js
// 進捗の解決履歴(解決済み課題・達成済み目標)に、同一部員がその後に書いた反省
// (発見・目標/課題の変化)を「解決の手がかり」として添え、未解決アイテムへ実名引用の
// 助言コメントを Gemini で生成する。参考文献ベースの aicomment.js と対の、チーム内
// ピア学習ベースのコメント源。純ロジック(プール構築・プロンプト・検証)は API 呼び出しから
// 分離してテスト可能にする。
import { summarize, windBinKey } from './progressstore.js';

const FIELD_LABEL = { goal: '目標', issue: '課題', discovery: '発見' };

// 解決アイテムごとに、同一部員が"以降"に書いた発見・課題/目標の変化を最大 maxEvidence 件添える。
// reflections=全反省, progress=sailviz.progress。
export function buildHistoryPool(reflections, progress, { maxEvidence = 5 } = {}) {
  const sum = summarize(reflections, progress);
  const speedById = new Map();
  for (const r of reflections) if (r?.id != null) speedById.set(r.id, r.wind?.speed ?? null);

  const pool = [];
  let seq = 0;
  for (const [member, b] of Object.entries(sum.byMember)) {
    // その部員の発見(全風速ビンを平坦化)と、目標/課題テキストの時系列(手がかり候補)。
    const discoveries = Object.values(b.discoveriesByBin).flat().map((d) =>
      ({ dateMs: d.dateMs, field: 'discovery', text: d.text, windBin: windBinKey(d.speed) }));
    const changes = [
      ...b.issues.map((it) => ({ dateMs: it.dateMs, field: 'issue', text: it.text })),
      ...b.goals.map((g) => ({ dateMs: g.dateMs, field: 'goal', text: g.text })),
    ];
    const resolved = [
      ...b.issues.filter((it) => it.stage === 2)
        .map((it) => ({ reflId: it.reflId, field: 'issue', text: it.text, dateMs: it.dateMs })),
      ...b.goals.filter((g) => g.done)
        .map((g) => ({ reflId: g.reflId, field: 'goal', text: g.text, dateMs: g.dateMs })),
    ];
    for (const item of resolved) {
      const wb = windBinKey(speedById.get(item.reflId));
      // 手がかり = 解決日時"以降"の発見(主)+ 後続の課題/目標の変化。
      const cand = [
        ...discoveries.filter((d) => d.dateMs >= item.dateMs),
        ...changes.filter((c) => c.dateMs > item.dateMs),
      ];
      // 風速帯が近い発見を優先し、次に新しい順。最大 maxEvidence 件。
      cand.sort((a, c) => {
        const am = a.windBin && a.windBin === wb ? 0 : 1;
        const cm = c.windBin && c.windBin === wb ? 0 : 1;
        if (am !== cm) return am - cm;
        return c.dateMs - a.dateMs;
      });
      const evidence = cand.slice(0, maxEvidence)
        .map((e) => ({ dateMs: e.dateMs, field: e.field, text: e.text }));
      pool.push({ poolId: `p${seq++}`, member, field: item.field, text: item.text, dateMs: item.dateMs, windBin: wb, evidence });
    }
  }
  return pool;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/peerlearning.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add src/peerlearning.js test/peerlearning.test.js
git commit -m "feat(peer): 解決履歴プール buildHistoryPool を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: スクリーニング(プロンプト+検証)

**Files:**
- Modify: `src/peerlearning.js`
- Test: `test/peerlearning.test.js`

**Interfaces:**
- Consumes: `buildHistoryPool` の pool 要素形（Task 1）。
- Produces:
  - `buildPeerScreenPrompt(items, pool)` → `{ system, user }`（items: `[{reflId, field, text}]`）
  - `parsePeerScreen(rawText, pool)` → `[{reflId, field:'goal'|'issue', poolId}]`（実在 poolId・正しい field のみ)

- [ ] **Step 1: Write the failing test**

`test/peerlearning.test.js` に追記:
```js
import { buildPeerScreenPrompt, parsePeerScreen } from '../src/peerlearning.js';

const POOL = [
  { poolId: 'p0', member: '村瀬 礼', field: 'issue', text: '走らない', dateMs: 1, windBin: 'lt3', evidence: [] },
  { poolId: 'p1', member: '本間 由真', field: 'goal', text: '予選突破', dateMs: 2, windBin: 'mid', evidence: [] },
];

test('buildPeerScreenPrompt: poolId・部員・未解決アイテムが本文に載る', () => {
  const { system, user } = buildPeerScreenPrompt(
    [{ reflId: 'x1', field: 'issue', text: '走らない' }], POOL);
  assert.match(system, /コーチ/);
  assert.match(user, /poolId=p0/);
  assert.match(user, /村瀬 礼/);
  assert.match(user, /reflId=x1/);
});

test('parsePeerScreen: 未知poolId・不正field・非文字列reflIdを除去', () => {
  const raw = JSON.stringify([
    { reflId: 'x1', field: 'issue', poolId: 'p0' },   // OK
    { reflId: 'x2', field: 'discovery', poolId: 'p0' }, // field不正 → 除去
    { reflId: 'x3', field: 'goal', poolId: 'p9' },     // 未知poolId → 除去
    { reflId: 42, field: 'goal', poolId: 'p1' },       // reflId非文字列 → 除去
  ]);
  assert.deepEqual(parsePeerScreen(raw, POOL), [{ reflId: 'x1', field: 'issue', poolId: 'p0' }]);
});

test('parsePeerScreen: コードフェンス付き応答でも配列を取り出す', () => {
  const raw = '```json\n[{"reflId":"x1","field":"goal","poolId":"p1"}]\n```';
  assert.deepEqual(parsePeerScreen(raw, POOL), [{ reflId: 'x1', field: 'goal', poolId: 'p1' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/peerlearning.test.js`
Expected: FAIL（`buildPeerScreenPrompt is not a function`）

- [ ] **Step 3: Write minimal implementation**

`src/peerlearning.js` に追記（`FIELD_LABEL` の下あたり):
```js
const FIELDS = new Set(['goal', 'issue']);

// JSON配列をコードフェンス等を無視して取り出す。非配列/非JSONは例外。
function extractJsonArray(rawText) {
  const text = String(rawText).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('AI応答にJSON配列がありません');
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('AI応答が配列ではありません');
  return arr;
}

// --- (1) スクリーニング(プール要約のみ・evidence本文は渡さずトークン節約) ---

export function buildPeerScreenPrompt(items, pool) {
  const poolLines = pool.map((p) =>
    `- poolId=${p.poolId} | ${p.member} | ${FIELD_LABEL[p.field]} | ${JSON.stringify(p.text)}`).join('\n');
  const reflLines = items.map((it) =>
    `- reflId=${it.reflId} field=${it.field} text=${JSON.stringify(it.text)}`).join('\n');
  const system = [
    'あなたは経験豊富なセーリングコーチです。未解決の目標・課題それぞれに対し、過去に似た',
    '目標・課題を解決した事例(解決事例プール)から関連するものを選びます。同一人物の過去事例が',
    'あれば優先し、無ければ他部員の事例を選びます。関連が薄ければ選びません。憶測で紐付けないこと。',
  ].join('');
  const user = [
    '# 解決事例プール(poolId | 部員 | 種別 | テキスト)',
    poolLines,
    '',
    '# 未解決の目標・課題',
    reflLines,
    '',
    '# 出力形式',
    '関連するものだけを次のJSON配列で返す(前後に説明文を付けない):',
    '[{"reflId":"...","field":"goal|issue","poolId":"...(上のpoolIdから選ぶ)"}]',
    '関連が無ければ [] を返す。1つのアイテムに複数事例が関連するなら、関連度の高い順に',
    '最大3つまで別々の行として挙げてよい(reflId/fieldを同じにしてpoolIdだけ変える)。',
  ].join('\n');
  return { system, user };
}

// スクリーニング応答を検証。存在する poolId・正しい field のみ採用。
export function parsePeerScreen(rawText, pool) {
  const validIds = new Set(pool.map((p) => p.poolId));
  return extractJsonArray(rawText).filter((s) =>
    s && typeof s.reflId === 'string' && FIELDS.has(s.field) && validIds.has(s.poolId))
    .map((s) => ({ reflId: s.reflId, field: s.field, poolId: s.poolId }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/peerlearning.test.js`
Expected: PASS（Task 1 の 5 件 + 新規 3 件)

- [ ] **Step 5: Commit**

```bash
git add src/peerlearning.js test/peerlearning.test.js
git commit -m "feat(peer): ピア学習スクリーニングのプロンプトと検証を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 根拠付け(プロンプト+検証)

**Files:**
- Modify: `src/peerlearning.js`
- Test: `test/peerlearning.test.js`

**Interfaces:**
- Consumes: pool 要素（Task 1)。
- Produces:
  - `buildPeerGroundPrompt(item, matches)` → `{ system, user }`（item: `{field, text}`、matches: pool要素の配列)
  - `parsePeerGroundObject(rawText)` → `{ comment, usedPoolIds:[...] }` または `null`(comment空)

- [ ] **Step 1: Write the failing test**

`test/peerlearning.test.js` に追記:
```js
import { buildPeerGroundPrompt, parsePeerGroundObject } from '../src/peerlearning.js';

test('buildPeerGroundPrompt: 実名・手がかりが本文に載り、実名引用を指示する', () => {
  const matches = [{
    poolId: 'p0', member: '村瀬 礼', field: 'issue', text: '微風で走らない', dateMs: 1,
    windBin: 'lt3', evidence: [{ dateMs: 2, field: 'discovery', text: 'カニンガムを緩める' }],
  }];
  const { system, user } = buildPeerGroundPrompt({ field: 'issue', text: '微風で遅い' }, matches);
  assert.match(system, /実名/);
  assert.match(user, /村瀬 礼/);
  assert.match(user, /カニンガムを緩める/);
  assert.match(user, /poolId=p0/);
});

test('parsePeerGroundObject: comment と usedPoolIds を取り出す', () => {
  const raw = '{"comment":"村瀬さんの発見が使えます。","usedPoolIds":["p0","x"]}';
  assert.deepEqual(parsePeerGroundObject(raw), { comment: '村瀬さんの発見が使えます。', usedPoolIds: ['p0', 'x'] });
});

test('parsePeerGroundObject: comment空はnull', () => {
  assert.equal(parsePeerGroundObject('{"comment":"  ","usedPoolIds":[]}'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/peerlearning.test.js`
Expected: FAIL（`buildPeerGroundPrompt is not a function`）

- [ ] **Step 3: Write minimal implementation**

`src/peerlearning.js` に追記:
```js
// --- (2) 根拠付け(選ばれた解決事例を本文で渡し、実名引用のコメントを生成) ---

export function buildPeerGroundPrompt(item, matches) {
  const blocks = matches.map((m) => {
    const ev = m.evidence.length
      ? m.evidence.map((e) => `    - ${FIELD_LABEL[e.field] || e.field}: ${JSON.stringify(e.text)}`).join('\n')
      : '    - (その後の記録なし)';
    return `- poolId=${m.poolId} | ${m.member} | ${FIELD_LABEL[m.field]} | ${JSON.stringify(m.text)}\n`
      + `  その後の記録(解決の手がかり):\n${ev}`;
  }).join('\n');
  const system = [
    'あなたは経験豊富なセーリングコーチです。以下のチーム内の解決事例だけを根拠に、対象の',
    '未解決の目標/課題へ具体的で実践的な助言を日本語3〜5文で書きます。誰(実名)が似た目標/課題を',
    'どう解決したかを引用します(例「村瀬さんも同様の課題を『カニンガムを緩める』という発見で',
    '解決しています」)。対象本人自身の過去事例なら「自分の△△の時の発見が使えます」と促します。',
    '事例に無い内容は憶測で書かないこと。',
  ].join('');
  const user = [
    '# 対象の未解決アイテム',
    `field=${item.field} text=${JSON.stringify(item.text)}`,
    '',
    '# チーム内の解決事例(poolId | 部員 | 種別 | テキスト と その後の記録)',
    blocks,
    '',
    '# 出力形式(JSONオブジェクト、前後に説明文を付けない)',
    '{"comment":"...(3〜5文の助言。実名を引用)","usedPoolIds":["実際に根拠にしたpoolId",...]}',
    '根拠にできる事例が無ければ {"comment":"","usedPoolIds":[]} を返す。',
  ].join('\n');
  return { system, user };
}

// 根拠付け応答(単一オブジェクト)を検証。comment 非空でなければ null。
export function parsePeerGroundObject(rawText) {
  const text = String(rawText).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('AI応答にJSONオブジェクトがありません');
  const obj = JSON.parse(text.slice(start, end + 1));
  const comment = typeof obj.comment === 'string' ? obj.comment.trim() : '';
  if (!comment) return null;
  const usedPoolIds = Array.isArray(obj.usedPoolIds)
    ? obj.usedPoolIds.filter((x) => typeof x === 'string') : [];
  return { comment, usedPoolIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/peerlearning.test.js`
Expected: PASS（累計 11 件)

- [ ] **Step 5: Commit**

```bash
git add src/peerlearning.js test/peerlearning.test.js
git commit -m "feat(peer): ピア学習 根拠付けのプロンプトと検証を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 組み立て `generatePeerComments`

**Files:**
- Modify: `src/peerlearning.js`
- Test: `test/peerlearning.test.js`

**Interfaces:**
- Consumes: `buildHistoryPool` / `buildPeerScreenPrompt` / `parsePeerScreen` / `buildPeerGroundPrompt` / `parsePeerGroundObject`（Task 1-3)、`geminiGenerate`(注入)。
- Produces:
  `generatePeerComments({ items, reflections, progress, geminiGenerate, model?, maxMatchesPerItem?, maxEvidence? })`
  → `Promise<[{ reflId, field, comment, url, refs:[{link:null, title}] }]>`
  （`url` = `peer:${reflId}:${field}:${usedPoolIds.sort().join(',')}`)

- [ ] **Step 1: Write the failing test**

`test/peerlearning.test.js` に追記:
```js
import { generatePeerComments } from '../src/peerlearning.js';

// 2回呼ばれる geminiGenerate をスタブ: 1回目=スクリーニング応答, 2回目以降=根拠付け応答。
function stubGemini(responses) {
  let i = 0;
  return async () => responses[i++];
}

test('generatePeerComments: 空itemsは即[]', async () => {
  const out = await generatePeerComments({ items: [], reflections: [], progress: {}, geminiGenerate: stubGemini([]) });
  assert.deepEqual(out, []);
});

test('generatePeerComments: 解決履歴が空なら即[](geminiは呼ばれない)', async () => {
  let called = 0;
  const gg = async () => { called++; return '[]'; };
  const out = await generatePeerComments({
    items: [{ reflId: 'x1', field: 'issue', text: 'a' }],
    reflections: [], progress: {}, geminiGenerate: gg,
  });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test('generatePeerComments: スクリーニング→根拠付けを組み立て、url/refsを付ける', async () => {
  // 履歴: 村瀬の解決済み課題 r1 + 以降の発見 d1
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  // 対象(未解決): 本間の課題 x1。スクリーニングが p0 を関連付け、根拠付けが p0 を使用。
  const items = [{ reflId: 'x1', field: 'issue', text: '微風で遅い' }];
  const gg = stubGemini([
    JSON.stringify([{ reflId: 'x1', field: 'issue', poolId: 'p0' }]),
    JSON.stringify({ comment: '村瀬さんはカニンガムを緩めて解決しました。', usedPoolIds: ['p0'] }),
  ]);
  const out = await generatePeerComments({ items, reflections, progress, geminiGenerate: gg });
  assert.equal(out.length, 1);
  assert.equal(out[0].reflId, 'x1');
  assert.equal(out[0].field, 'issue');
  assert.match(out[0].comment, /村瀬/);
  assert.equal(out[0].url, 'peer:x1:issue:p0');
  assert.equal(out[0].refs.length, 1);
  assert.equal(out[0].refs[0].link, null);
  assert.match(out[0].refs[0].title, /村瀬 礼/);
});

test('generatePeerComments: スクリーニングが空なら根拠付けを呼ばず[]', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: 'a' }, wind: { speed: 2 }, practice: { startMs: 100 } },
  ];
  const gg = stubGemini(['[]']);
  const out = await generatePeerComments({
    items: [{ reflId: 'x1', field: 'issue', text: 'b' }],
    reflections, progress: { r1: { issueStage: 2 } }, geminiGenerate: gg,
  });
  assert.deepEqual(out, []);
});

test('generatePeerComments: 根拠付けが例外でも他アイテムを止めない', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: 'a' }, wind: { speed: 2 }, practice: { startMs: 100 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  const items = [
    { reflId: 'x1', field: 'issue', text: 'b' },
    { reflId: 'x2', field: 'issue', text: 'c' },
  ];
  let call = 0;
  const gg = async () => {
    call++;
    if (call === 1) return JSON.stringify([
      { reflId: 'x1', field: 'issue', poolId: 'p0' },
      { reflId: 'x2', field: 'issue', poolId: 'p0' },
    ]);
    if (call === 2) throw new Error('根拠付け失敗'); // x1 は失敗
    return JSON.stringify({ comment: 'x2の助言', usedPoolIds: ['p0'] }); // x2 は成功
  };
  const out = await generatePeerComments({ items, reflections, progress, geminiGenerate: gg });
  assert.equal(out.length, 1);
  assert.equal(out[0].reflId, 'x2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/peerlearning.test.js`
Expected: FAIL（`generatePeerComments is not a function`）

- [ ] **Step 3: Write minimal implementation**

`src/peerlearning.js` に追記。冒頭の import 行を次に差し替え(fmtDay 用):
```js
import { summarize, windBinKey } from './progressstore.js';
```
はそのまま。ファイル末尾に追記:
```js
// 出典表示用の短い日付(JST, YYYY-MM-DD)。
function fmtDay(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

// items:[{reflId, field, text}] は未解決の goal/issue。reflections/progress から履歴プールを作り、
// スクリーニング→根拠付けの2段で実名引用コメントを生成する。戻り値は addComment 互換の候補。
export async function generatePeerComments({
  items, reflections, progress, geminiGenerate,
  model = 'gemini-3.6-flash', maxMatchesPerItem = 3, maxEvidence = 5,
}) {
  if (!items || items.length === 0) return [];
  const pool = buildHistoryPool(reflections, progress, { maxEvidence });
  if (pool.length === 0) return [];
  const byId = new Map(pool.map((p) => [p.poolId, p]));

  // (1) スクリーニング: 各未解決アイテムに関連する解決事例(複数可)を選ぶ。
  const sc = buildPeerScreenPrompt(items, pool);
  const screenText = await geminiGenerate({
    model, system: sc.system, parts: [{ text: sc.user }], responseMimeType: 'application/json',
  });
  const matches = parsePeerScreen(screenText, pool);
  if (matches.length === 0) return [];

  // アイテム(reflId×field)ごとに事例をまとめる(最大 maxMatchesPerItem)。
  const textOf = new Map(items.map((it) => [`${it.reflId} ${it.field}`, it.text]));
  const groups = new Map();
  for (const m of matches) {
    const key = `${m.reflId} ${m.field}`;
    const text = textOf.get(key);
    if (text == null) continue;
    if (!groups.has(key)) groups.set(key, { reflId: m.reflId, field: m.field, text, ids: [] });
    const g = groups.get(key);
    if (!g.ids.includes(m.poolId) && g.ids.length < maxMatchesPerItem) g.ids.push(m.poolId);
  }

  // (2) 根拠付け: アイテムごとに、選ばれた事例をまとめて渡す。
  const out = [];
  for (const g of groups.values()) {
    const matched = g.ids.map((id) => byId.get(id)).filter(Boolean);
    if (matched.length === 0) continue;
    const gp = buildPeerGroundPrompt({ field: g.field, text: g.text }, matched);
    let res;
    try {
      const text = await geminiGenerate({
        model, system: gp.system, parts: [{ text: gp.user }], responseMimeType: 'application/json',
      });
      res = parsePeerGroundObject(text);
    } catch { continue; } // 1アイテムの失敗で全体を止めない
    if (!res) continue;

    // 実際に使われた事例(なければ渡した全事例)を出典にする。
    const provided = new Set(matched.map((m) => m.poolId));
    let usedIds = res.usedPoolIds.filter((id) => provided.has(id));
    if (usedIds.length === 0) usedIds = [...provided];
    const refs = usedIds.map((id) => {
      const p = byId.get(id);
      return { link: null, title: `${p.member}・${FIELD_LABEL[p.field]}(${fmtDay(p.dateMs)})` };
    });
    const url = `peer:${g.reflId}:${g.field}:${[...usedIds].sort().join(',')}`;
    out.push({ reflId: g.reflId, field: g.field, comment: res.comment, url, refs });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/peerlearning.test.js`
Expected: PASS（累計 16 件)

- [ ] **Step 5: Commit**

```bash
git add src/peerlearning.js test/peerlearning.test.js
git commit -m "feat(peer): generatePeerComments で2段生成を組み立て

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: progress.js への統合(既存ボタンで並走マージ)

**Files:**
- Modify: `src/progress.js`（import 追加、`wireAiControls()` の生成ハンドラ)

**Interfaces:**
- Consumes: `generatePeerComments`（Task 4)、`geminiGenerate`(`src/gemini.js`)、既存 `generateAiComments`/`SOURCES`/`hasAiComment`/`addComment`。

このタスクはブラウザ実挙動の統合で、既存ハンドラを差し替える。純ロジックは Task 1-4 で検証済みのため、ここは目視確認(サーバ起動＋進捗画面)で受け入れる。

- [ ] **Step 1: import を追加**

`src/progress.js` の import 群に追記:
```js
import { generatePeerComments } from './peerlearning.js';
import { geminiGenerate } from './gemini.js';
```

- [ ] **Step 2: 生成ハンドラを並走マージへ差し替え**

`wireAiControls()` 内、`btn.addEventListener('click', async () => { ... })` の
`btn.disabled = true;` 以降(現状の `try { const suggestions = await generateAiComments(...) ... }` ブロック)を次で置き換える。`items` 決定までの既存コードはそのまま残す:
```js
      // ピア学習の対象は未解決の goal/issue のみ。既存の対象集合(items)と同じカードに限定する。
      const targetKeys = new Set(items.map((x) => `${x.reflId}:${x.field}`));
      const peerItems = [];
      for (const [, b] of buckets) {
        for (const g of b.goals) {
          if (!g.done && targetKeys.has(`${g.reflId}:goal`)) peerItems.push({ reflId: g.reflId, field: 'goal', text: g.text });
        }
        for (const it of b.issues) {
          if (it.stage !== 2 && targetKeys.has(`${it.reflId}:issue`)) peerItems.push({ reflId: it.reflId, field: 'issue', text: it.text });
        }
      }

      btn.disabled = true;
      status.textContent = '生成中…(参考文献とチームの解決事例を照合します)';
      try {
        // 参考文献系統(PDF)とピア学習系統(チーム履歴)を並走。片方の失敗はもう片方を止めない。
        const [refSug, peerSug] = await Promise.all([
          generateAiComments({ items, sources: SOURCES, loadFileBase64 })
            .catch((e) => { console.error('参考文献コメント生成に失敗', e); return []; }),
          generatePeerComments({ items: peerItems, reflections, progress, geminiGenerate })
            .catch((e) => { console.error('ピアコメント生成に失敗', e); return []; }),
        ]);
        const suggestions = [...refSug, ...peerSug];
        let added = 0;
        const now = Date.now();
        for (const s of suggestions) {
          if (hasAiComment(progress, s.reflId, s.field, s.url)) continue;
          progress = addComment(progress, s.reflId, s.field, s.comment, now,
            { ai: true, url: s.url, refs: s.refs });
          added += 1;
        }
        if (added) persist();
        status.textContent = `${added}件のコメントを追加しました`;
        renderBody();
      } catch (e) {
        console.error('AIコメント生成に失敗', e);
        status.textContent = '生成に失敗しました(キーや通信を確認)';
      } finally {
        btn.disabled = false;
      }
```

- [ ] **Step 3: 全テストが緑のままか確認(退行なし)**

Run: `node --test`
Expected: PASS（既存 + peerlearning。progress.js は import 追加のみで既存テストに影響しない)

- [ ] **Step 4: 目視確認(サーバ起動)**

```bash
npm start
```
ブラウザで進捗管理画面 → 部員を選択 → 「AIコメント生成」ボタン。
確認: (a) 未解決の課題/目標に、実名でチームの解決事例を引用したコメント(🤖 + 出典「◯◯・課題(日付)」)が付く。(b) 参考文献ベースのコメントも従来どおり付く。(c) 再実行で同じ url のコメントが二重に増えない。
※ 生成には編集モード(認証)が必要。解決済み履歴が無い場合はピアコメントは付かない(参考文献のみ)。

- [ ] **Step 5: Commit**

```bash
git add src/progress.js
git commit -m "feat(progress): AIコメント生成に参考文献とピア学習を並走マージ

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- §1 目的(解決プロセス推定・類似仲間の実名引用) → Task 1(手がかり集約)+ Task 3(実名引用プロンプト)+ Task 4(refs 実名)。
- §3 モジュール/依存/データフロー → Task 1-4(peerlearning.js)+ Task 5(並走マージ)。
- §4 履歴プール(stage2/done・override・delete除外・K件・風速帯優先) → Task 1(summarize 再利用で override/delete/date、evidence 選択)。
- §5 プロンプト2段+検証+戻り値形+url/refs → Task 2/3/4。
- §6 progress.js 統合(未解決限定・失敗分離・重複排除・文言) → Task 5。
- §7 エラーハンドリング(非JSON・空プール・空スクリーニング・1件失敗・認証) → Task 4 テスト + Task 5。
- §8 テスト方針 → Task 1-4 の各テスト。
- §9 非対象(手入力欄/埋め込み/単一融合) → 実装せず。

**2. Placeholder scan:** TBD/TODO 無し。全コード実体あり。

**3. Type consistency:**
- pool 要素 `{poolId, member, field, text, dateMs, windBin, evidence:[{dateMs,field,text}]}` は Task 1 定義、Task 2/3/4 で同形参照。
- `parsePeerScreen` → `{reflId, field, poolId}`、`generatePeerComments` が `poolId` で参照 — 一致。
- `parsePeerGroundObject` → `{comment, usedPoolIds}`、Task 4 が `usedPoolIds` 参照 — 一致。
- 戻り値 `{reflId, field, comment, url, refs}` は既存 `addComment(..., {ai,url,refs})` と整合(Task 5)。
- `st.text`(override)は Task 1 実装が `summarize` 経由で参照(直接触らない) — Global Constraints と整合。
