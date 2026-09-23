# 風速帯別AIコメント高度化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 反省(目標・課題・発見・遅い/速い要因)を4段階の風速帯に結び付け、風速帯×課題×有効技術の相関を事前にAI分析してlocalStorageにキャッシュし、その該当帯セクションを既存2系統のAIコメント生成へ注入する。

**Architecture:** 単一の風速語彙 `windband.js`(4帯・語優先分類・帯フィルタ)を土台に、既存の3ビン `WIND_BINS` を4帯 `WIND_BANDS` へ置換する。相関ダイジェストは `windknowledge.js`(1回のGemini分析)が構築し `windknowledgestore.js`(localStorage)がキャッシュする。生成時は対象反省の帯を求め、該当帯の箇条書きのみを根拠付けプロンプトへ注入し、根拠候補を帯フィルタ(同帯優先・不足時は隣接帯へ拡大)で絞る。

**Tech Stack:** バニラ ES Modules(ビルドなし)、Node.js 組込みテストランナー(`node --test`)、Gemini(`/api/ai-comment` プロキシ経由)、localStorage。

**Spec:** `docs/superpowers/specs/2026-09-23-wind-band-ai-comments-design.md`

## Global Constraints

- 風速帯は4帯・キーと m/s 境界は固定: `bihuu`(微風, <3) / `chuu`(中風・順風, 3〜6) / `kyou`(強風, 6〜10) / `baku`(爆風, 10+)。境界は `< max`(排他)。分類不能は `'unknown'`。
- 風速表現語が数値に優先する。複数帯の語が同時出現したら最も強い帯(`WIND_BANDS` の後方)を採る。語彙の拡張は `WIND_BANDS[i].words` の1箇所のみ。
- ダイジェストは各帯 **最大8点**(ハード上限)。部員実名はダイジェストに含めない。
- 純ロジック(プロンプト生成・応答検証・集計)は API 呼び出しから分離し `node --test` で検証可能にする(既存 `aicomment.js`/`peerlearning.js` の作法)。
- Gemini 呼び出しはダイジェスト再構築時の1回のみ。コメント生成時は該当帯の箇条書き(≤8点)だけを送る。
- テストは `import { test } from 'node:test'; import assert from 'node:assert/strict';`。実行は `npm test`(= `node --test`)。
- コミットメッセージは Conventional Commits + 日本語要約(既存履歴に倣う)。

## Review Focus

- **ダイジェスト未構築でのコメント生成** — localStorage が空でも生成器は例外を出さず、帯注入を省いて従来動作に劣化する。→ Task 8/9 の「digest 不在」テストで固定。
- **`speed` が null かつ文中に風速語なし** — `classifyWindBand` は `'unknown'` を返し、下流の帯フィルタは同帯0件として隣接→全体へ拡大する(空落ちしない)。→ Task 1/2 のテストで固定。
- **AI ダイジェスト応答が不正/欠損帯/8点超** — `parseKnowledgeResponse` は不正JSONで例外、欠損帯は空配列、8点超は切り詰め、非文字列要素は除去。→ Task 6 のテストで固定。
- **境界値の風速**(2.9/3/6/10) — `< max` 排他で 3→`chuu`、6→`kyou`、10→`baku`。→ Task 1 のテストで固定。
- **参考文献にも反省にも根拠が無い帯** — `renderKnowledgeMd` は当該帯に `（データ不足）` を出し、憶測を書かない。→ Task 7 のテストで固定。

---

### Task 1: `windband.js` — 帯モデルと分類(語優先→数値)

**Files:**
- Create: `src/windband.js`
- Test: `test/windband.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `WIND_BANDS: Array<{key:string,label:string,max:number,words:string[]}>`(微風/中風/強風/爆風の順)
  - `detectBandWord(text: string): string | null` — 文中の風速語から最強帯キー、無ければ null
  - `classifyWindBand(text: string, speed: number|null|undefined): string` — 帯キー or `'unknown'`

- [ ] **Step 1: Write the failing test**

```javascript
// test/windband.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIND_BANDS, detectBandWord, classifyWindBand } from '../src/windband.js';

test('WIND_BANDS は4帯・キーと境界が固定', () => {
  assert.deepEqual(WIND_BANDS.map((b) => b.key), ['bihuu', 'chuu', 'kyou', 'baku']);
  assert.deepEqual(WIND_BANDS.map((b) => b.max), [3, 6, 10, Infinity]);
});

test('detectBandWord: 語を検出し、複数帯なら最強帯', () => {
  assert.equal(detectBandWord('微風で走らない'), 'bihuu');
  assert.equal(detectBandWord('無風でスタート'), 'bihuu');        // 同義語
  assert.equal(detectBandWord('順風のセーリング'), 'chuu');
  assert.equal(detectBandWord('中風から爆風まで'), 'baku');       // 複数→最強
  assert.equal(detectBandWord('特になし'), null);
});

test('classifyWindBand: 語が数値に優先', () => {
  assert.equal(classifyWindBand('爆風で走らない', 4), 'baku');   // 語=爆風 が speed4 より優先
});

test('classifyWindBand: 語なしは数値フォールバック(境界は排他)', () => {
  assert.equal(classifyWindBand('', 2.9), 'bihuu');
  assert.equal(classifyWindBand('', 3), 'chuu');
  assert.equal(classifyWindBand('', 6), 'kyou');
  assert.equal(classifyWindBand('', 10), 'baku');
  assert.equal(classifyWindBand('', 99), 'baku');
});

test('classifyWindBand: 語なし・数値なしは unknown', () => {
  assert.equal(classifyWindBand('', null), 'unknown');
  assert.equal(classifyWindBand('', undefined), 'unknown');
  assert.equal(classifyWindBand('', NaN), 'unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windband.test.js`
Expected: FAIL(`Cannot find module '../src/windband.js'`)

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/windband.js
// 風速帯の単一語彙。語優先→数値フォールバックで反省を4帯に分類する。純ロジック。
export const WIND_BANDS = [
  { key: 'bihuu', label: '微風 (〜3 m/s)',      max: 3,        words: ['微風', '無風'] },
  { key: 'chuu',  label: '中風・順風 (3〜6 m/s)', max: 6,        words: ['中風', '順風'] },
  { key: 'kyou',  label: '強風 (6〜10 m/s)',     max: 10,       words: ['強風'] },
  { key: 'baku',  label: '爆風 (10 m/s〜)',      max: Infinity, words: ['爆風'] },
];

// 文中の風速語を走査。複数帯の語があれば最も強い帯(配列後方)を返す。無ければ null。
export function detectBandWord(text) {
  const s = String(text ?? '');
  let found = null;
  for (let i = 0; i < WIND_BANDS.length; i++) {
    if (WIND_BANDS[i].words.some((w) => s.includes(w))) found = WIND_BANDS[i].key;
  }
  return found;
}

// 語優先→数値フォールバック。分類不能は 'unknown'。境界は max 未満(排他)。
export function classifyWindBand(text, speed) {
  const w = detectBandWord(text);
  if (w) return w;
  const n = Number(speed);
  if (speed == null || !Number.isFinite(n)) return 'unknown';
  for (const b of WIND_BANDS) if (n < b.max) return b.key;
  return WIND_BANDS[WIND_BANDS.length - 1].key;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windband.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/windband.js test/windband.test.js
git commit -m "feat(windband): 風速帯4分類と語優先の帯判定を追加"
```

---

### Task 2: `windband.js` — 帯フィルタ・隣接・ダイジェスト取り出し

**Files:**
- Modify: `src/windband.js`
- Test: `test/windband.test.js`

**Interfaces:**
- Consumes: `WIND_BANDS`, `classifyWindBand`(Task 1)
- Produces:
  - `adjacentBands(key: string): string[]` — 配列上の前後の帯キー(`unknown` は `[]`)
  - `bandLabel(key: string): string` — 表示ラベル(未知キーはそのまま返す)
  - `filterByBand(candidates: T[], targetBand: string, opts: {min?:number, getBand:(c:T)=>string}): T[]` — 同帯優先→不足で隣接→なお不足で全帯。`getBand` が `'general'` を返す候補は常に含める。元の順序を保つ。
  - `bandSectionFromDigest(bandBullets: object|null, bandKey: string): string[]` — 指定帯の箇条書き配列(欠損は `[]`)

- [ ] **Step 1: Write the failing test**

```javascript
// test/windband.test.js に追記
import {
  adjacentBands, bandLabel, filterByBand, bandSectionFromDigest,
} from '../src/windband.js';

test('adjacentBands: 配列上の前後の帯', () => {
  assert.deepEqual(adjacentBands('bihuu'), ['chuu']);
  assert.deepEqual(adjacentBands('chuu').sort(), ['bihuu', 'kyou']);
  assert.deepEqual(adjacentBands('baku'), ['kyou']);
  assert.deepEqual(adjacentBands('unknown'), []);
});

test('bandLabel: キー→ラベル、未知はそのまま', () => {
  assert.equal(bandLabel('kyou'), '強風 (6〜10 m/s)');
  assert.equal(bandLabel('nope'), 'nope');
});

const C = (id, band) => ({ id, band });
const getBand = (c) => c.band;

test('filterByBand: 同帯が min 以上なら同帯のみ(+general)', () => {
  const cands = [C('a', 'kyou'), C('b', 'kyou'), C('c', 'bihuu'), C('g', 'general')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  assert.deepEqual(out.map((c) => c.id), ['a', 'b', 'g']);
});

test('filterByBand: 同帯不足なら隣接帯へ拡大', () => {
  const cands = [C('a', 'kyou'), C('c', 'chuu'), C('d', 'bihuu')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  // kyou(1件)<min → 隣接(chuu)を追加。bihuu は非隣接で除外。
  assert.deepEqual(out.map((c) => c.id).sort(), ['a', 'c']);
});

test('filterByBand: 隣接でも不足なら全帯へ', () => {
  const cands = [C('a', 'kyou'), C('d', 'bihuu')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  assert.deepEqual(out.map((c) => c.id).sort(), ['a', 'd']);
});

test('filterByBand: general は常に含まれる', () => {
  const cands = [C('a', 'bihuu'), C('g', 'general')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  assert.ok(out.some((c) => c.id === 'g'));
});

test('bandSectionFromDigest: 指定帯の配列/欠損は空', () => {
  const bullets = { kyou: ['x', 'y'], bihuu: [] };
  assert.deepEqual(bandSectionFromDigest(bullets, 'kyou'), ['x', 'y']);
  assert.deepEqual(bandSectionFromDigest(bullets, 'baku'), []);
  assert.deepEqual(bandSectionFromDigest(null, 'kyou'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windband.test.js`
Expected: FAIL(`adjacentBands is not a function` ほか)

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/windband.js に追記
const KEYS = WIND_BANDS.map((b) => b.key);

export function adjacentBands(key) {
  const i = KEYS.indexOf(key);
  if (i === -1) return [];
  const out = [];
  if (i - 1 >= 0) out.push(KEYS[i - 1]);
  if (i + 1 < KEYS.length) out.push(KEYS[i + 1]);
  return out;
}

export function bandLabel(key) {
  return WIND_BANDS.find((b) => b.key === key)?.label ?? key;
}

// 同帯優先→不足で隣接→なお不足で全帯。general は常に対象。元の順序を保つ。
export function filterByBand(candidates, targetBand, { min = 2, getBand } = {}) {
  const general = candidates.filter((c) => getBand(c) === 'general');
  const banded = candidates.filter((c) => getBand(c) !== 'general');
  let pick = banded.filter((c) => getBand(c) === targetBand);
  if (pick.length < min) {
    const adj = new Set(adjacentBands(targetBand));
    pick = banded.filter((c) => getBand(c) === targetBand || adj.has(getBand(c)));
  }
  if (pick.length < min) pick = banded;
  const keep = new Set([...general, ...pick]);
  return candidates.filter((c) => keep.has(c));
}

export function bandSectionFromDigest(bandBullets, bandKey) {
  const arr = bandBullets && bandBullets[bandKey];
  return Array.isArray(arr) ? arr : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windband.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/windband.js test/windband.test.js
git commit -m "feat(windband): 帯フィルタ(fallback)・隣接・ダイジェスト取り出しを追加"
```

---

### Task 3: 3ビン→4帯へ移行(`progressstore.js` / `peerlearning.js` / `progress.js`)

既存の `WIND_BINS`/`windBinKey` を廃し、`windband.js` の4帯へ全面移行する。1つの語彙に統一するまでが1タスク(移行途中はテストが割れるため)。

**Files:**
- Modify: `src/progressstore.js:6-18`(`WIND_BINS`/`windBinKey` を削除), `src/progressstore.js:145-151`(`summarize` の発見帯付け)
- Modify: `src/peerlearning.js:6`(import), `src/peerlearning.js:34-35,47`(帯判定)
- Modify: `src/progress.js:7`(import), `src/progress.js:213`(`binOrder`)
- Test: `test/progressstore.test.js:3-7,91,129,159-179`(import と参照を更新)

**Interfaces:**
- Consumes: `WIND_BANDS`, `classifyWindBand`(Task 1)
- Produces: `summarize` の `discoveriesByBin` キーが帯キー(`bihuu`/`chuu`/`kyou`/`baku`/`unknown`)になる。`peerlearning` のプール `windBin` も帯キーになる。

- [ ] **Step 1: Update the migrated tests to the new vocabulary (they will fail first)**

`test/progressstore.test.js` の冒頭 import を変更:

```javascript
import {
  STORAGE_KEY, loadProgress, saveProgress,
  setIssueStage, setGoalDone, setTextOverride, summarize,
  addComment, hasAiComment, setCardDeleted,
} from '../src/progressstore.js';
import { WIND_BANDS } from '../src/windband.js';
```

`windBinKey` を使う既存テスト(159-163行の `windBinKey は境界とnullを正しく分類`)を削除する(同等のテストは Task 1 の `classifyWindBand` に存在)。`WIND_BINS[0].key` などの参照を `WIND_BANDS[0].key`(=`bihuu`)へ機械的に置換する(91・129・178・179行)。178-179行は次のまま整合する: speed2 → `WIND_BANDS[0].key`(bihuu, <3)、speed7 → `WIND_BANDS[2].key`(kyou, 6〜10)。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/progressstore.test.js`
Expected: FAIL(`WIND_BANDS` 未 export / `windBinKey` 削除前のため import 崩れ、または summarize が旧キーを返す)

- [ ] **Step 3: Migrate `progressstore.js`**

先頭の `WIND_BINS` 定数と `windBinKey` 関数(6-18行)を削除し、import を追加:

```javascript
import { classifyWindBand } from './windband.js';
```

`summarize` の `bins = WIND_BINS` デフォルト引数を削除(未使用化):

```javascript
export function summarize(reflections, progress) {
```

発見の帯付け(旧145-151行)を、テキストも渡す形に変更:

```javascript
    if (notes.discovery) {
      const speed = r.wind?.speed ?? null;
      const dtext = ov.discovery ?? notes.discovery;
      if (del.discovery) trash.push({ name, field: 'discovery', reflId: r.id, text: dtext, dateMs, speed });
      else {
        const bk = classifyWindBand(dtext, speed);
        (bucket.discoveriesByBin[bk] ||= []).push({ reflId: r.id, text: dtext, dateMs, speed, comments: cm.discovery || [] });
      }
    }
```

- [ ] **Step 4: Migrate `peerlearning.js`**

6行目の import を変更:

```javascript
import { summarize } from './progressstore.js';
import { classifyWindBand } from './windband.js';
```

34-35行の発見の帯判定(テキストを渡す):

```javascript
    const discoveries = Object.values(b.discoveriesByBin).flat().map((d) =>
      ({ dateMs: d.dateMs, field: 'discovery', text: d.text, windBin: classifyWindBand(d.text, d.speed) }));
```

47行の解決アイテムの帯判定(テキストを渡す。`item.text` を使用):

```javascript
      const wb = classifyWindBand(item.text, speedById.get(item.reflId));
```

- [ ] **Step 5: Migrate `progress.js` display**

7行目の import から `WIND_BINS` を除き、`windband.js` から `WIND_BANDS` を import:

```javascript
import {
  addComment, removeComment, hasAiComment, summarize, setCardDeleted,
} from './progressstore.js';
```

ファイル冒頭の import 群(15行目付近)に追加:

```javascript
import { WIND_BANDS } from './windband.js';
```

213行の `binOrder` を `WIND_BANDS` 基準へ:

```javascript
    const binOrder = [...WIND_BANDS, { key: 'unknown', label: '風速不明' }];
```

- [ ] **Step 6: Run the whole suite to verify green**

Run: `npm test`
Expected: PASS(`progressstore.test.js` / `peerlearning.test.js` / `windband.test.js` すべて緑。発見グリッドが4帯化)

- [ ] **Step 7: Commit**

```bash
git add src/progressstore.js src/peerlearning.js src/progress.js test/progressstore.test.js
git commit -m "refactor(wind): 3ビンWIND_BINSを4帯WIND_BANDSへ全面移行"
```

---

### Task 4: `windknowledgestore.js` — localStorage キャッシュ

**Files:**
- Create: `src/windknowledgestore.js`
- Test: `test/windknowledgestore.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `STORAGE_KEY = 'sailviz.windknowledge'`
  - `loadWindKnowledge(storage?): object | null`
  - `saveWindKnowledge(data: object, storage?): void`
  - `clearWindKnowledge(storage?): void`
  - 保存形: `{ md:string, builtAt:number, bandBullets:{bihuu:string[],chuu:string[],kyou:string[],baku:string[]}, stats:object }`

- [ ] **Step 1: Write the failing test**

```javascript
// test/windknowledgestore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, loadWindKnowledge, saveWindKnowledge, clearWindKnowledge,
} from '../src/windknowledgestore.js';

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('save→load ラウンドトリップ', () => {
  const s = memStorage();
  const data = { md: '# x', builtAt: 123, bandBullets: { bihuu: ['a'], chuu: [], kyou: [], baku: [] }, stats: {} };
  saveWindKnowledge(data, s);
  assert.deepEqual(loadWindKnowledge(s), data);
});

test('未保存なら null', () => {
  assert.equal(loadWindKnowledge(memStorage()), null);
});

test('破損JSONは null 扱い', () => {
  assert.equal(loadWindKnowledge(memStorage({ [STORAGE_KEY]: '{壊れ' })), null);
});

test('clear で消える', () => {
  const s = memStorage();
  saveWindKnowledge({ md: '', builtAt: 1, bandBullets: {}, stats: {} }, s);
  clearWindKnowledge(s);
  assert.equal(loadWindKnowledge(s), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windknowledgestore.test.js`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/windknowledgestore.js
// 風速帯相関ダイジェストの localStorage キャッシュ。progressstore.js の作法に倣う。
export const STORAGE_KEY = 'sailviz.windknowledge';

export function loadWindKnowledge(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export function saveWindKnowledge(data, storage = globalThis.localStorage) {
  storage?.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clearWindKnowledge(storage = globalThis.localStorage) {
  storage?.removeItem(STORAGE_KEY);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windknowledgestore.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/windknowledgestore.js test/windknowledgestore.test.js
git commit -m "feat(windknowledge): 相関ダイジェストのlocalStorageキャッシュを追加"
```

---

### Task 5: `windknowledge.js` — 分析入力の組み立て(チーム+参考文献の帯付け)

**Files:**
- Create: `src/windknowledge.js`
- Test: `test/windknowledge.test.js`

**Interfaces:**
- Consumes: `buildHistoryPool`(`src/peerlearning.js`), `classifyWindBand`/`detectBandWord`(`src/windband.js`)
- Produces:
  - `buildKnowledgeInput(reflections, progress, sources): { teamByBand, refsByBand }`
    - `teamByBand[bandKey] = { resolved: [{field, text, evidence:[{field,text}]}], notes: [{field, text}] }`(4帯のみ。`unknown` は除外。実名なし)
    - `refsByBand[bandKey|'general'] = [{title, summary}]`

反省ヘルパの想定形: `{ id, people:[name], notes:{goal,issue,discovery,slowFactor,fastFactor}, wind:{speed}, practice:{startMs} }`。`sources` 要素: `{ id, title, summary, ... }`。

- [ ] **Step 1: Write the failing test**

```javascript
// test/windknowledge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeInput } from '../src/windknowledge.js';

function refl(id, name, notes, { speed = null, dateMs = 0 } = {}) {
  return { id, people: [name], notes, wind: { speed }, practice: { startMs: dateMs } };
}

test('buildKnowledgeInput: 解決済み課題+以降の発見を帯別にまとめ、実名を含めない', () => {
  const reflections = [
    refl('r1', '村瀬 礼', { issue: '微風で走らない' }, { speed: 2, dateMs: 100 }),
    refl('d1', '村瀬 礼', { discovery: 'カニンガムを緩める' }, { speed: 2, dateMs: 150 }),
  ];
  const progress = { r1: { issueStage: 2 } };
  const { teamByBand } = buildKnowledgeInput(reflections, progress, []);
  const bihuu = teamByBand.bihuu;
  assert.equal(bihuu.resolved.length, 1);
  assert.equal(bihuu.resolved[0].text, '微風で走らない');
  assert.ok(bihuu.resolved[0].evidence.some((e) => e.text === 'カニンガムを緩める'));
  // 実名がどこにも載らない
  assert.ok(!JSON.stringify(teamByBand).includes('村瀬'));
});

test('buildKnowledgeInput: slowFactor/fastFactor も notes として帯別に拾う', () => {
  const reflections = [
    refl('r2', '本間 由真', { slowFactor: '強風でヒールしすぎ', fastFactor: '微風で艇を立てた' }, { speed: 4, dateMs: 10 }),
  ];
  const { teamByBand } = buildKnowledgeInput(reflections, {}, []);
  // slowFactor は語「強風」で kyou、fastFactor は語「微風」で bihuu(語優先)
  assert.ok(teamByBand.kyou.notes.some((n) => n.field === 'slowFactor'));
  assert.ok(teamByBand.bihuu.notes.some((n) => n.field === 'fastFactor'));
});

test('buildKnowledgeInput: unknown帯のデータは出力に含めない', () => {
  const reflections = [refl('r3', 'A', { discovery: '風速も語もなし' }, { speed: null })];
  const { teamByBand } = buildKnowledgeInput(reflections, {}, []);
  assert.ok(!Object.keys(teamByBand).includes('unknown'));
});

test('buildKnowledgeInput: 参考文献をタイトル/要約の語で帯タグ、語なしは general', () => {
  const sources = [
    { id: 'ch11', title: '微風のランニング', summary: '微風風下' },
    { id: 'ch21', title: '強風のクローズのコツ', summary: '強風クローズ' },
    { id: 'ch1', title: 'ラダーの働き', summary: '舵の基礎' }, // 語なし → general
  ];
  const { refsByBand } = buildKnowledgeInput([], {}, sources);
  assert.ok(refsByBand.bihuu.some((r) => r.title === '微風のランニング'));
  assert.ok(refsByBand.kyou.some((r) => r.title === '強風のクローズのコツ'));
  assert.ok(refsByBand.general.some((r) => r.title === 'ラダーの働き'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windknowledge.test.js`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/windknowledge.js
// 風速帯×課題×有効技術の相関ダイジェストを1回のGemini分析で構築する。
// 入力A: チームの解決履歴+気づき(実名を除去)。入力B: 参考文献の要約(帯タグ付け)。
// 純ロジック(入力組み立て・プロンプト・応答検証・レンダリング)をAPI呼び出しから分離。
import { buildHistoryPool } from './peerlearning.js';
import { WIND_BANDS, detectBandWord, classifyWindBand } from './windband.js';

const NOTE_FIELDS = ['goal', 'issue', 'discovery', 'slowFactor', 'fastFactor'];
const BAND_KEYS = WIND_BANDS.map((b) => b.key); // ['bihuu','chuu','kyou','baku']

function emptyTeam() {
  const t = {};
  for (const k of BAND_KEYS) t[k] = { resolved: [], notes: [] };
  return t;
}

export function buildKnowledgeInput(reflections, progress, sources) {
  const teamByBand = emptyTeam();

  // 入力A-1: 解決履歴(既存プールを再利用。実名 member は捨てる)。
  const pool = buildHistoryPool(reflections, progress);
  for (const p of pool) {
    if (!BAND_KEYS.includes(p.windBin)) continue; // unknown は除外
    teamByBand[p.windBin].resolved.push({
      field: p.field, text: p.text,
      evidence: (p.evidence || []).map((e) => ({ field: e.field, text: e.text })),
    });
  }

  // 入力A-2: 単独の気づき(5フィールド)。フィールド文で帯付け。
  for (const r of reflections) {
    const notes = r.notes || {};
    const speed = r.wind?.speed ?? null;
    for (const f of NOTE_FIELDS) {
      const text = notes[f];
      if (!text) continue;
      const band = classifyWindBand(text, speed);
      if (!BAND_KEYS.includes(band)) continue;
      teamByBand[band].notes.push({ field: f, text });
    }
  }

  // 入力B: 参考文献要約の帯タグ付け(語なしは general)。
  const refsByBand = { general: [] };
  for (const k of BAND_KEYS) refsByBand[k] = [];
  for (const s of sources || []) {
    const band = detectBandWord(`${s.title || ''} ${s.summary || ''}`) || 'general';
    refsByBand[band].push({ title: s.title, summary: s.summary });
  }

  return { teamByBand, refsByBand };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windknowledge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/windknowledge.js test/windknowledge.test.js
git commit -m "feat(windknowledge): チーム履歴+参考文献の帯別入力組み立てを追加"
```

---

### Task 6: `windknowledge.js` — プロンプト生成と応答検証

**Files:**
- Modify: `src/windknowledge.js`
- Test: `test/windknowledge.test.js`

**Interfaces:**
- Consumes: `buildKnowledgeInput` の戻り(Task 5), `WIND_BANDS`/`bandLabel`
- Produces:
  - `buildKnowledgePrompt(input): { system, user }`
  - `parseKnowledgeResponse(rawText): { bihuu:string[], chuu:string[], kyou:string[], baku:string[] }`(各帯 ≤8、非文字列除去、欠損帯は `[]`)

- [ ] **Step 1: Write the failing test**

```javascript
// test/windknowledge.test.js に追記
import { buildKnowledgePrompt, parseKnowledgeResponse } from '../src/windknowledge.js';

test('buildKnowledgePrompt: 帯ラベル・両入力・8点上限指示・出力形式を含む', () => {
  const input = {
    teamByBand: {
      bihuu: { resolved: [{ field: 'issue', text: '微風で走らない', evidence: [{ field: 'discovery', text: 'カニンガムを緩める' }] }], notes: [] },
      chuu: { resolved: [], notes: [] }, kyou: { resolved: [], notes: [] }, baku: { resolved: [], notes: [] },
    },
    refsByBand: { general: [{ title: 'ラダーの働き', summary: '舵' }], bihuu: [{ title: '微風のランニング', summary: '微風' }], chuu: [], kyou: [], baku: [] },
  };
  const { system, user } = buildKnowledgePrompt(input);
  assert.match(system, /コーチ/);
  assert.match(system, /憶測/);           // 憶測禁止
  assert.match(user, /微風/);
  assert.match(user, /カニンガムを緩める/); // チーム証拠
  assert.match(user, /微風のランニング/);   // 参考文献
  assert.match(user, /最大8/);             // 8点上限
  assert.match(user, /bihuu/);             // 帯キーでのJSON出力形式
});

test('parseKnowledgeResponse: 帯別配列を取り出し8点で切る', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `点${i}`);
  const raw = JSON.stringify({ bihuu: nine, chuu: ['a'], kyou: [], baku: ['x'] });
  const out = parseKnowledgeResponse(raw);
  assert.equal(out.bihuu.length, 8);   // 9→8
  assert.deepEqual(out.chuu, ['a']);
  assert.deepEqual(out.kyou, []);
  assert.deepEqual(out.baku, ['x']);
});

test('parseKnowledgeResponse: 欠損帯は空、非文字列は除去', () => {
  const raw = JSON.stringify({ bihuu: ['ok', 42, null, 'ok2'] }); // chuu/kyou/baku 欠損
  const out = parseKnowledgeResponse(raw);
  assert.deepEqual(out.bihuu, ['ok', 'ok2']);
  assert.deepEqual(out.chuu, []);
  assert.deepEqual(out.kyou, []);
  assert.deepEqual(out.baku, []);
});

test('parseKnowledgeResponse: 非JSONは例外', () => {
  assert.throws(() => parseKnowledgeResponse('ぜんぜんJSONじゃない'));
});

test('parseKnowledgeResponse: コードフェンス付きでも解釈', () => {
  const raw = '```json\n{"bihuu":["a"]}\n```';
  assert.deepEqual(parseKnowledgeResponse(raw).bihuu, ['a']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windknowledge.test.js`
Expected: FAIL(`buildKnowledgePrompt is not a function`)

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/windknowledge.js に追記
import { bandLabel } from './windband.js';

const FIELD_LABEL = { goal: '目標', issue: '課題', discovery: '発見', slowFactor: '遅い要因', fastFactor: '速い要因' };
const MAX_BULLETS = 8;

function renderTeamBand(b) {
  const lines = [];
  for (const r of b.resolved) {
    const ev = r.evidence.map((e) => `${FIELD_LABEL[e.field] || e.field}:${e.text}`).join(' / ') || '(手がかりなし)';
    lines.push(`  - 解決した${FIELD_LABEL[r.field] || r.field}「${r.text}」← ${ev}`);
  }
  for (const n of b.notes) lines.push(`  - ${FIELD_LABEL[n.field] || n.field}:「${n.text}」`);
  return lines.length ? lines.join('\n') : '  - (部内データなし)';
}

function renderRefs(list) {
  return list.length ? list.map((r) => `  - ${r.title}: ${r.summary}`).join('\n') : '  - (なし)';
}

export function buildKnowledgePrompt(input) {
  const { teamByBand, refsByBand } = input;
  const system = [
    'あなたは経験豊富なセーリングコーチです。以下はチームの解決済み課題・それを解決した',
    '発見・単独の気づきを風速帯別にまとめたものと、参考文献の要約です。各帯について、繰り返し',
    '現れる「課題→有効な技術」の相関を簡潔な箇条書きで書きます。同義の言い回しは1点に',
    'クラスタします。部内実績を優先し、データが少ない帯は参考文献で補完・裏付けします。',
    `各帯 最大${MAX_BULLETS}点。データ・資料にない内容は憶測で書かないこと。`,
  ].join('');
  const bandBlocks = WIND_BANDS.map((band) => {
    const k = band.key;
    return [
      `## ${bandLabel(k)}  [key=${k}]`,
      '### 部内データ',
      renderTeamBand(teamByBand[k]),
      '### 参考文献(この帯 + 汎用)',
      renderRefs([...(refsByBand[k] || []), ...(refsByBand.general || [])]),
    ].join('\n');
  }).join('\n\n');
  const user = [
    '# 風速帯別の素材',
    bandBlocks,
    '',
    '# 出力形式(JSONオブジェクトのみ。前後に説明文を付けない)',
    '各帯キーに箇条書き文字列の配列を返す。各要素の末尾に出典タグを付ける',
    '(部内実績由来は 〔部内実績〕、参考文献由来は 〔参考: タイトル〕)。',
    '{"bihuu":["..."],"chuu":["..."],"kyou":["..."],"baku":["..."]}',
    `各帯 最大${MAX_BULLETS}点。素材が無い帯は [] を返す。`,
  ].join('\n');
  return { system, user };
}

export function parseKnowledgeResponse(rawText) {
  const text = String(rawText).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('AI応答にJSONオブジェクトがありません');
  const obj = JSON.parse(text.slice(start, end + 1));
  const out = {};
  for (const k of BAND_KEYS) {
    const arr = Array.isArray(obj[k]) ? obj[k] : [];
    out[k] = arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, MAX_BULLETS);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windknowledge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/windknowledge.js test/windknowledge.test.js
git commit -m "feat(windknowledge): 分析プロンプトと応答検証(8点上限)を追加"
```

---

### Task 7: `windknowledge.js` — Markdownレンダリングとオーケストレータ

**Files:**
- Modify: `src/windknowledge.js`
- Test: `test/windknowledge.test.js`

**Interfaces:**
- Consumes: `buildKnowledgeInput`/`buildKnowledgePrompt`/`parseKnowledgeResponse`(Task 5-6)
- Produces:
  - `renderKnowledgeMd(bandBullets, builtAtMs): string`(空帯は `（データ不足）`)
  - `generateWindKnowledge({ reflections, progress, sources, geminiGenerate, nowMs, model? }): Promise<{ md, builtAt, bandBullets, stats }>`

- [ ] **Step 1: Write the failing test**

```javascript
// test/windknowledge.test.js に追記
import { renderKnowledgeMd, generateWindKnowledge } from '../src/windknowledge.js';

test('renderKnowledgeMd: 帯見出しと箇条書き、空帯はデータ不足', () => {
  const md = renderKnowledgeMd({ bihuu: ['微風のコツ 〔部内実績〕'], chuu: [], kyou: [], baku: [] }, Date.UTC(2026, 8, 23));
  assert.match(md, /# 風速帯別/);
  assert.match(md, /## 微風/);
  assert.match(md, /微風のコツ/);
  assert.match(md, /## 中風・順風[\s\S]*（データ不足）/);
});

test('generateWindKnowledge: 入力→Gemini1回→md/bandBullets/statsを返す', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  let calls = 0;
  const geminiGenerate = async () => { calls++; return JSON.stringify({ bihuu: ['微風は緩める 〔部内実績〕'], chuu: [], kyou: [], baku: [] }); };
  const res = await generateWindKnowledge({ reflections, progress, sources: [], geminiGenerate, nowMs: 999 });
  assert.equal(calls, 1);
  assert.equal(res.builtAt, 999);
  assert.deepEqual(res.bandBullets.bihuu, ['微風は緩める 〔部内実績〕']);
  assert.match(res.md, /微風は緩める/);
  assert.equal(res.stats.reflections, 2);
  assert.equal(res.stats.perBand.bihuu, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windknowledge.test.js`
Expected: FAIL(`renderKnowledgeMd is not a function`)

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/windknowledge.js に追記
function fmtDay(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

export function renderKnowledgeMd(bandBullets, builtAtMs) {
  const head = `# 風速帯別 課題×有効技術 相関ノート  (更新: ${fmtDay(builtAtMs)})`;
  const sections = WIND_BANDS.map((band) => {
    const bullets = bandBullets[band.key] || [];
    const body = bullets.length ? bullets.map((b) => `- ${b}`).join('\n') : '（データ不足）';
    return `## ${band.label}\n${body}`;
  });
  return [head, '', ...sections.flatMap((s) => [s, ''])].join('\n').trim() + '\n';
}

export async function generateWindKnowledge({
  reflections, progress, sources, geminiGenerate, nowMs, model = 'gemini-3.6-flash',
}) {
  const input = buildKnowledgeInput(reflections, progress, sources);
  const { system, user } = buildKnowledgePrompt(input);
  const raw = await geminiGenerate({
    model, system, parts: [{ text: user }], responseMimeType: 'application/json',
  });
  const bandBullets = parseKnowledgeResponse(raw);
  const md = renderKnowledgeMd(bandBullets, nowMs);
  const perBand = {};
  for (const k of BAND_KEYS) perBand[k] = bandBullets[k].length;
  const resolved = input && Object.values(input.teamByBand).reduce((n, b) => n + b.resolved.length, 0);
  const stats = { reflections: reflections.length, resolved, perBand };
  return { md, builtAt: nowMs, bandBullets, stats };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windknowledge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/windknowledge.js test/windknowledge.test.js
git commit -m "feat(windknowledge): md生成と再構築オーケストレータを追加"
```

---

### Task 8: `aicomment.js` — 帯フィルタと帯ダイジェスト注入

参考文献系統に、対象反省の帯に応じたソース絞り込み(fallback付き)と、根拠付けプロンプトへの帯ノート注入を加える。既存呼び出しとの後方互換を保つ。

**Files:**
- Modify: `src/aicomment.js:57-77`(`buildGroundPrompt`), `src/aicomment.js:95-158`(`generateAiComments`)
- Test: `test/aicomment.test.js`

**Interfaces:**
- Consumes: `filterByBand`, `detectBandWord`(`src/windband.js`)
- Produces:
  - `buildGroundPrompt(item, sources, bandBullets?)` — `bandBullets`(string[])が非空なら技術ノートブロックを追加
  - `generateAiComments({ items, sources, loadFileBase64, digest?, ... })` — `items[i].band`(帯キー)と `digest`(bandBullets オブジェクト)を受け取り、根拠グループ組み立て時に `filterByBand` を適用、該当帯ノートを注入。`digest`/`band` 不在時は従来動作。

- [ ] **Step 1: Write the failing tests**

```javascript
// test/aicomment.test.js に追記
import { filterByBand } from '../src/windband.js'; // 参照確認用(未使用でも可)

test('buildGroundPrompt: bandBullets があれば技術ノートを本文に含める', () => {
  const { user } = buildGroundPrompt(
    { field: 'issue', text: '微風で遅い' },
    [{ id: 'ch11', title: '微風のランニング' }],
    ['微風はカニンガムを緩める 〔部内実績〕'],
  );
  assert.match(user, /風速帯の技術ノート/);
  assert.match(user, /カニンガムを緩める/);
});

test('buildGroundPrompt: bandBullets 空なら技術ノートを付けない(後方互換)', () => {
  const { user } = buildGroundPrompt({ field: 'issue', text: 'x' }, [{ id: 'ch1', title: 'a' }], []);
  assert.doesNotMatch(user, /風速帯の技術ノート/);
});

test('generateAiComments: 対象帯のソースへ絞り、帯ノートを注入する', async () => {
  const sources = [
    { id: 'ch11', title: '微風のランニング', summary: '微風', file: 'p/11.pdf', mime: 'application/pdf' },
    { id: 'ch21', title: '強風のクローズ', summary: '強風', file: 'p/21.pdf', mime: 'application/pdf' },
  ];
  // 対象は微風(bihuu)。スクリーニングが両ソースを拾っても、帯フィルタで ch11 側に寄せる。
  let groundUser = '';
  const responses = [
    JSON.stringify([{ reflId: 'r1', field: 'issue', sourceId: 'ch11' }, { reflId: 'r1', field: 'issue', sourceId: 'ch21' }]),
    JSON.stringify({ comment: '微風の助言。', usedSourceIds: ['ch11'] }),
  ];
  let i = 0;
  const fetchStub = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (i === 1) groundUser = body.parts.map((p) => p.text || '').join('');
    const text = responses[i++];
    return { ok: true, json: async () => ({ text }) };
  };
  const out = await generateAiComments({
    items: [{ reflId: 'r1', field: 'issue', text: '微風で遅い', band: 'bihuu' }],
    sources, loadFileBase64: async () => 'BASE64',
    digest: { bihuu: ['微風はカニンガムを緩める 〔部内実績〕'], chuu: [], kyou: [], baku: [] },
    fetchImpl: fetchStub,
  });
  assert.equal(out.length, 1);
  assert.match(groundUser, /風速帯の技術ノート/);
  assert.match(groundUser, /カニンガムを緩める/);
});

test('generateAiComments: digest/band 不在でも従来通り動く(回帰)', async () => {
  const sources = [{ id: 'ch11', title: '微風のランニング', summary: '微風', file: 'p/11.pdf', mime: 'application/pdf' }];
  const responses = [
    JSON.stringify([{ reflId: 'r1', field: 'issue', sourceId: 'ch11' }]),
    JSON.stringify({ comment: '助言。', usedSourceIds: ['ch11'] }),
  ];
  let i = 0;
  const fetchStub = async () => ({ ok: true, json: async () => ({ text: responses[i++] }) });
  const out = await generateAiComments({
    items: [{ reflId: 'r1', field: 'issue', text: 'x' }], // band なし
    sources, loadFileBase64: async () => 'B', fetchImpl: fetchStub, // digest なし
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].comment, '助言。');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/aicomment.test.js`
Expected: FAIL(`buildGroundPrompt` が第3引数を無視、`digest` 未対応で注入されない)

- [ ] **Step 3: Implement in `aicomment.js`**

冒頭に import を追加:

```javascript
import { filterByBand, detectBandWord, bandSectionFromDigest } from './windband.js';
```

`buildGroundPrompt` を第3引数対応に:

```javascript
export function buildGroundPrompt(item, sources, bandBullets = []) {
  const srcLines = sources.map((s) => `- id=${s.id} | ${s.title}`).join('\n');
  const noteBlock = (bandBullets && bandBullets.length)
    ? ['', '# 風速帯の技術ノート(該当すれば引用してよい。憶測はしない)', ...bandBullets.map((b) => `- ${b}`)].join('\n')
    : '';
  const system = [
    'あなたは経験豊富なセーリングコーチです。添付した参考文献(PDF・テキスト)の内容だけを根拠に、',
    '対象の反省へ具体的で実践的な助言コメントを日本語で書きます。資料内の要点・数値・コツを',
    '引用しながら3〜5文で詳しく述べ、複数の資料にまたがって引用してもかまいません。',
    '資料に根拠が無い内容は憶測で書かないこと。',
  ].join('');
  const user = [
    '# 対象の反省',
    `field=${item.field} text=${JSON.stringify(item.text)}`,
    noteBlock,
    '',
    '# 添付資料のソース(id | タイトル) — 添付した順に対応',
    srcLines,
    '',
    '# 出力形式(JSONオブジェクト、前後に説明文を付けない)',
    '{"comment":"...(3〜5文の詳しい助言)","usedSourceIds":["実際に根拠にしたid",...]}',
    '根拠にできる資料が無ければ {"comment":"","usedSourceIds":[]} を返す。',
  ].join('\n');
  return { system, user };
}
```

`generateAiComments` のシグネチャに `digest = null` を追加し、ソースに帯タグを付け、グループ組み立て時に `filterByBand` を適用、根拠付けに帯ノートを渡す。95行の関数定義と本体を次の通り更新:

```javascript
export async function generateAiComments({
  items, sources, loadFileBase64, digest = null,
  model = 'gemini-3.6-flash', fetchImpl = globalThis.fetch, maxSourcesPerItem = 3,
}) {
  if (!items || items.length === 0) return [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  // ソースの帯タグ(タイトル+要約の語。語なしは general)。
  const bandOf = new Map(sources.map((s) => [s.id, detectBandWord(`${s.title || ''} ${s.summary || ''}`) || 'general']));

  const sc = buildScreenPrompt(items, sources);
  const screenText = await geminiGenerate({
    model, system: sc.system, parts: [{ text: sc.user }],
    responseMimeType: 'application/json', fetchImpl,
  });
  const matches = parseScreen(screenText, sources);
  if (matches.length === 0) return [];

  const textOf = new Map(items.map((it) => [`${it.reflId} ${it.field}`, it.text]));
  const bandOfItem = new Map(items.map((it) => [`${it.reflId} ${it.field}`, it.band || 'unknown']));
  const groups = new Map();
  for (const m of matches) {
    const key = `${m.reflId} ${m.field}`;
    const text = textOf.get(key);
    if (text == null) continue;
    if (!groups.has(key)) groups.set(key, { reflId: m.reflId, field: m.field, text, band: bandOfItem.get(key), ids: [] });
    groups.get(key).ids.push(m.sourceId);
  }

  const out = [];
  for (const g of groups.values()) {
    // 対象帯へソースを絞る(fallback付き)。general は常に対象。最大 maxSourcesPerItem。
    const filtered = filterByBand(g.ids, g.band, { min: 1, getBand: (id) => bandOf.get(id) || 'general' });
    const ids = [];
    for (const id of filtered) { if (!ids.includes(id) && ids.length < maxSourcesPerItem) ids.push(id); }

    const loaded = [];
    for (const id of ids) {
      const source = byId.get(id);
      if (!source) continue;
      try { loaded.push({ source, base64: await loadFileBase64(source.file) }); } catch { /* skip */ }
    }
    if (loaded.length === 0) continue;
    const bandBullets = bandSectionFromDigest(digest, g.band);
    const gp = buildGroundPrompt(g, loaded.map((x) => ({ id: x.source.id, title: x.source.title })), bandBullets);
    let res;
    try {
      const text = await geminiGenerate({
        model, system: gp.system,
        parts: [{ text: gp.user }, ...loaded.map((x) => filePart(x.base64, x.source.mime))],
        responseMimeType: 'application/json', fetchImpl,
      });
      res = parseGroundObject(text);
    } catch { continue; }
    if (!res) continue;

    const provided = new Set(loaded.map((x) => x.source.id));
    let usedIds = res.usedSourceIds.filter((id) => provided.has(id));
    if (usedIds.length === 0) usedIds = [...provided];
    const refs = usedIds.map((id) => {
      const s = byId.get(id);
      return { link: s.link || null, title: s.title };
    });
    const url = `ai:${g.reflId}:${g.field}:${[...usedIds].sort().join(',')}`;
    out.push({ reflId: g.reflId, field: g.field, comment: res.comment, url, refs });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/aicomment.test.js`
Expected: PASS(新規4件 + 既存すべて緑)

- [ ] **Step 5: Commit**

```bash
git add src/aicomment.js test/aicomment.test.js
git commit -m "feat(aicomment): 帯フィルタと風速帯ノート注入を追加"
```

---

### Task 9: `peerlearning.js` — 帯フィルタと帯ダイジェスト注入

ピア学習系統に、対象アイテムの帯に応じた事例絞り込み(fallback付き)と、根拠付けプロンプトへの帯ノート注入を加える。

**Files:**
- Modify: `src/peerlearning.js:106-133`(`buildPeerGroundPrompt`), `src/peerlearning.js:158-214`(`generatePeerComments`)
- Test: `test/peerlearning.test.js`

**Interfaces:**
- Consumes: `filterByBand`, `bandSectionFromDigest`, `classifyWindBand`(`src/windband.js`)
- Produces:
  - `buildPeerGroundPrompt(item, matches, bandBullets?)` — `bandBullets` 非空なら技術ノートを追加
  - `generatePeerComments({ items, reflections, progress, geminiGenerate, digest?, ... })` — 各 `items[i]`(未解決 goal/issue)の帯を `classifyWindBand(text, speed)` で求め(speed は反省から)、根拠グループ組み立て時に `filterByBand` を適用、該当帯ノートを注入。`digest` 不在時は従来動作。

- [ ] **Step 1: Write the failing tests**

```javascript
// test/peerlearning.test.js に追記
test('buildPeerGroundPrompt: bandBullets があれば技術ノートを本文に含める', () => {
  const matches = [{ poolId: 'p0', member: '村瀬 礼', field: 'issue', text: '微風で走らない', evidence: [] }];
  const { user } = buildPeerGroundPrompt({ field: 'issue', text: '微風で遅い' }, matches, ['微風は緩める 〔部内実績〕']);
  assert.match(user, /風速帯の技術ノート/);
  assert.match(user, /微風は緩める/);
});

test('buildPeerGroundPrompt: bandBullets 空なら技術ノートを付けない(後方互換)', () => {
  const { user } = buildPeerGroundPrompt({ field: 'issue', text: 'x' }, [], []);
  assert.doesNotMatch(user, /風速帯の技術ノート/);
});

test('generatePeerComments: digest 注入(該当帯ノートが根拠付けに載る)', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  const items = [{ reflId: 'x1', field: 'issue', text: '微風で遅い' }];
  let groundUser = '';
  let call = 0;
  const gg = async ({ parts }) => {
    call++;
    if (call === 1) return JSON.stringify([{ reflId: 'x1', field: 'issue', poolId: 'p0' }]);
    groundUser = parts.map((p) => p.text || '').join('');
    return JSON.stringify({ comment: '村瀬さんが緩めて解決。', usedPoolIds: ['p0'] });
  };
  const out = await generatePeerComments({
    items, reflections, progress, geminiGenerate: gg,
    digest: { bihuu: ['微風は緩める 〔部内実績〕'], chuu: [], kyou: [], baku: [] },
  });
  assert.equal(out.length, 1);
  assert.match(groundUser, /風速帯の技術ノート/);
  assert.match(groundUser, /微風は緩める/);
});

test('generatePeerComments: digest 不在でも従来通り(回帰)', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const gg = stubGemini([
    JSON.stringify([{ reflId: 'x1', field: 'issue', poolId: 'p0' }]),
    JSON.stringify({ comment: '助言。', usedPoolIds: ['p0'] }),
  ]);
  const out = await generatePeerComments({
    items: [{ reflId: 'x1', field: 'issue', text: '微風で遅い' }],
    reflections, progress: { r1: { issueStage: 2 } }, geminiGenerate: gg, // digest なし
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].comment, '助言。');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/peerlearning.test.js`
Expected: FAIL(第3引数無視 / `digest` 未注入)

- [ ] **Step 3: Implement in `peerlearning.js`**

冒頭 import に追加:

```javascript
import { filterByBand, bandSectionFromDigest, classifyWindBand } from './windband.js';
```

`buildPeerGroundPrompt` を第3引数対応に(user 本文へノートブロック挿入):

```javascript
export function buildPeerGroundPrompt(item, matches, bandBullets = []) {
  const blocks = matches.map((m) => {
    const ev = (m.evidence || []).length
      ? (m.evidence || []).map((e) => `    - ${FIELD_LABEL[e.field] || e.field}: ${JSON.stringify(e.text)}`).join('\n')
      : '    - (その後の記録なし)';
    return `- poolId=${m.poolId} | ${m.member} | ${FIELD_LABEL[m.field]} | ${JSON.stringify(m.text)}\n`
      + `  その後の記録(解決の手がかり):\n${ev}`;
  }).join('\n');
  const noteBlock = (bandBullets && bandBullets.length)
    ? ['', '# 風速帯の技術ノート(該当すれば引用してよい。憶測はしない)', ...bandBullets.map((b) => `- ${b}`)].join('\n')
    : '';
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
    noteBlock,
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
```

`generatePeerComments` に `digest = null` を追加し、各アイテムの帯を求め、グループ組み立てで `filterByBand`、根拠付けに帯ノート注入。158行の定義と本体を更新:

```javascript
export async function generatePeerComments({
  items, reflections, progress, geminiGenerate, digest = null,
  model = 'gemini-3.6-flash', maxMatchesPerItem = 3, maxEvidence = 5,
}) {
  if (!items || items.length === 0) return [];
  const pool = buildHistoryPool(reflections, progress, { maxEvidence });
  if (pool.length === 0) return [];
  const byId = new Map(pool.map((p) => [p.poolId, p]));

  // 各アイテムの帯(テキスト語優先→反省speed)。speed は reflId から引く。
  const speedById = new Map();
  for (const r of reflections) if (r?.id != null) speedById.set(r.id, r.wind?.speed ?? null);
  const bandOfItem = new Map(items.map((it) => [`${it.reflId} ${it.field}`, classifyWindBand(it.text, speedById.get(it.reflId))]));

  const sc = buildPeerScreenPrompt(items, pool);
  const screenText = await geminiGenerate({
    model, system: sc.system, parts: [{ text: sc.user }], responseMimeType: 'application/json',
  });
  const matches = parsePeerScreen(screenText, pool);
  if (matches.length === 0) return [];

  const textOf = new Map(items.map((it) => [`${it.reflId} ${it.field}`, it.text]));
  const groups = new Map();
  for (const m of matches) {
    const key = `${m.reflId} ${m.field}`;
    const text = textOf.get(key);
    if (text == null) continue;
    if (!groups.has(key)) groups.set(key, { reflId: m.reflId, field: m.field, text, band: bandOfItem.get(key), ids: [] });
    groups.get(key).ids.push(m.poolId);
  }

  const out = [];
  for (const g of groups.values()) {
    // 対象帯の事例へ絞る(fallback付き)。プール事例は general を持たない。最大 maxMatchesPerItem。
    const filtered = filterByBand(g.ids, g.band, { min: 1, getBand: (id) => byId.get(id)?.windBin || 'unknown' });
    const ids = [];
    for (const id of filtered) { if (!ids.includes(id) && ids.length < maxMatchesPerItem) ids.push(id); }
    const matched = ids.map((id) => byId.get(id)).filter(Boolean);
    if (matched.length === 0) continue;

    const bandBullets = bandSectionFromDigest(digest, g.band);
    const gp = buildPeerGroundPrompt({ field: g.field, text: g.text }, matched, bandBullets);
    let res;
    try {
      const text = await geminiGenerate({
        model, system: gp.system, parts: [{ text: gp.user }], responseMimeType: 'application/json',
      });
      res = parsePeerGroundObject(text);
    } catch { continue; }
    if (!res) continue;

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/peerlearning.test.js`
Expected: PASS(新規4件 + 既存すべて緑)

- [ ] **Step 5: Commit**

```bash
git add src/peerlearning.js test/peerlearning.test.js
git commit -m "feat(peer): 帯フィルタと風速帯ノート注入を追加"
```

---

### Task 10: `progress.js` — 生成時の帯計算とダイジェスト受け渡し

コメント生成ハンドラで、各対象アイテムの帯を計算し、キャッシュ済みダイジェストを両系統へ渡す。

**Files:**
- Modify: `src/progress.js`(冒頭 import 群), `src/progress.js:458-523`(`wireAiControls` のハンドラ)
- Test: `test/progress-band-wiring.test.js`(新規・純関数を切り出して検証)

**Interfaces:**
- Consumes: `classifyWindBand`(windband), `loadWindKnowledge`(windknowledgestore), `generateAiComments`/`generatePeerComments` の新 `digest`/`band` 対応(Task 8-9)
- Produces: `annotateItemsWithBand(items, reflections): items[]`(各 item に `band` を付与するヘルパ。progress.js から export)

- [ ] **Step 1: Write the failing test**

```javascript
// test/progress-band-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateItemsWithBand } from '../src/progress.js';

test('annotateItemsWithBand: item.text の語優先→反省speedで帯付け', () => {
  const reflections = [
    { id: 'r1', wind: { speed: 8 }, notes: {} },   // speed8 → kyou
    { id: 'r2', wind: { speed: 2 }, notes: {} },
  ];
  const items = [
    { reflId: 'r1', field: 'issue', text: '走らない' },            // 語なし→speed8→kyou
    { reflId: 'r2', field: 'issue', text: '爆風で怖い' },          // 語=爆風→baku(speed2を上書き)
  ];
  const out = annotateItemsWithBand(items, reflections);
  assert.equal(out[0].band, 'kyou');
  assert.equal(out[1].band, 'baku');
});

test('annotateItemsWithBand: 反省が見つからず語も無ければ unknown', () => {
  const out = annotateItemsWithBand([{ reflId: 'zzz', field: 'goal', text: 'x' }], []);
  assert.equal(out[0].band, 'unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/progress-band-wiring.test.js`
Expected: FAIL(`annotateItemsWithBand` 未 export)

- [ ] **Step 3: Add the helper and wire the handler**

`src/progress.js` 冒頭 import に追加:

```javascript
import { WIND_BANDS, classifyWindBand } from './windband.js';
import { generateWindKnowledge } from './windknowledge.js';
import { loadWindKnowledge, saveWindKnowledge } from './windknowledgestore.js';
```

(Task 3 で追加済みの `WIND_BANDS` import と統合し重複させないこと。)

モジュール内(関数外・export 可能な位置)にヘルパを追加:

```javascript
// 各 item に風速帯を付与する。text の語を優先し、無ければ反省の実測風速で判定。
export function annotateItemsWithBand(items, reflections) {
  const speedById = new Map();
  for (const r of reflections) if (r?.id != null) speedById.set(r.id, r.wind?.speed ?? null);
  return items.map((it) => ({ ...it, band: classifyWindBand(it.text, speedById.get(it.reflId)) }));
}
```

`wireAiControls` のハンドラ(`items`/`peerItems` 確定後、`Promise.all` の直前)で帯付けとダイジェスト読込を行い、両系統へ渡す:

```javascript
      const bandItems = annotateItemsWithBand(items, reflections);
      const cached = loadWindKnowledge();
      const digest = cached?.bandBullets || null;
      // ...
      const [refSug, peerSug] = await Promise.all([
        generateAiComments({ items: bandItems, sources: SOURCES, loadFileBase64, digest })
          .catch((e) => { console.error('参考文献コメント生成に失敗', e); return []; }),
        generatePeerComments({ items: peerItems, reflections, progress, geminiGenerate, digest })
          .catch((e) => { console.error('ピアコメント生成に失敗', e); return []; }),
      ]);
```

(`peerItems` は `generatePeerComments` 内で帯を再計算するため `band` 付与は不要。)

- [ ] **Step 4: Run the suite to verify green**

Run: `npm test`
Expected: PASS(`progress-band-wiring.test.js` 緑、既存も緑)

- [ ] **Step 5: Commit**

```bash
git add src/progress.js test/progress-band-wiring.test.js
git commit -m "feat(progress): 生成時の帯計算とダイジェスト受け渡しを配線"
```

---

### Task 11: UI — 再構築ボタンと表示・ダウンロード

風速帯ノートの手動再構築ボタンと、md 表示・.md ダウンロードを追加する。

**Files:**
- Modify: `index.html:240-245`(progress-bar に要素追加), `index.html`(表示用モーダル要素追加)
- Modify: `src/progress.js`(`wireKnowledgeControls` 追加と `render` からの呼び出し)
- Test: `test/html-ids.test.js`(新 id の存在を確認)

**Interfaces:**
- Consumes: `generateWindKnowledge`, `saveWindKnowledge`, `loadWindKnowledge`(Task 4/7), `SOURCES`, `reflections`/`progress`(モジュール状態)
- Produces: DOM 要素 `progress-kb-rebuild` / `progress-kb-status` / `progress-kb-view` / `kb-modal` / `kb-modal-body` / `kb-modal-download` / `kb-modal-close`

- [ ] **Step 1: Write the failing test**

```javascript
// test/html-ids.test.js に追記
test('index.html に風速帯ノートのUI要素が存在する', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  for (const id of ['progress-kb-rebuild', 'progress-kb-status', 'progress-kb-view', 'kb-modal', 'kb-modal-body', 'kb-modal-download', 'kb-modal-close']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `${id} が無い`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/html-ids.test.js`
Expected: FAIL(`progress-kb-rebuild が無い`)

- [ ] **Step 3: Add markup to `index.html`**

progress-bar(240-245行)へボタン2つ + ステータスを追加:

```html
    <header id="progress-bar">
      <strong id="progress-title">練習進捗管理</strong>
      <label id="progress-hide-comments-label"><input type="checkbox" id="progress-hide-comments" />コメント非表示</label>
      <button type="button" id="progress-ai-generate" class="writes-json">🤖 AIコメント生成</button>
      <span id="progress-ai-status" class="progress-ai-status"></span>
      <button type="button" id="progress-kb-rebuild" class="writes-json">🌬 風速帯ノートを再構築</button>
      <button type="button" id="progress-kb-view">ノートを表示</button>
      <span id="progress-kb-status" class="progress-ai-status"></span>
    </header>
```

`progress-screen` セクションの末尾付近(`progress-trash` の後)に表示モーダルを追加:

```html
  <div id="kb-modal" class="kb-modal" hidden>
    <div class="kb-modal-inner">
      <div class="kb-modal-head">
        <strong>風速帯 相関ノート</strong>
        <a id="kb-modal-download" download="wind-knowledge.md" href="#">.md をダウンロード</a>
        <button type="button" id="kb-modal-close">閉じる</button>
      </div>
      <pre id="kb-modal-body" class="kb-modal-body"></pre>
    </div>
  </div>
```

- [ ] **Step 4: Wire the controls in `progress.js`**

`wireAiControls` に倣い、`render` の 2nd pass(`wireAiControls();` の隣)で呼ぶ `wireKnowledgeControls` を追加:

```javascript
  let kbWired = false;
  function wireKnowledgeControls() {
    if (kbWired) return;
    const rebuildBtn = $('progress-kb-rebuild');
    const viewBtn = $('progress-kb-view');
    const status = $('progress-kb-status');
    const modal = $('kb-modal');
    const body = $('kb-modal-body');
    const dl = $('kb-modal-download');
    if (!rebuildBtn) return;
    kbWired = true;

    rebuildBtn.addEventListener('click', async () => {
      rebuildBtn.disabled = true;
      status.textContent = '風速帯ノートを分析中…';
      try {
        const res = await generateWindKnowledge({
          reflections, progress, sources: SOURCES, geminiGenerate, nowMs: Date.now(),
        });
        saveWindKnowledge(res);
        const p = res.stats.perBand;
        status.textContent = `更新しました(微風${p.bihuu}・中風${p.chuu}・強風${p.kyou}・爆風${p.baku} 件)`;
      } catch (e) {
        console.error('風速帯ノートの再構築に失敗', e);
        status.textContent = '再構築に失敗しました(通信を確認)';
      } finally {
        rebuildBtn.disabled = false;
      }
    });

    viewBtn.addEventListener('click', () => {
      const cached = loadWindKnowledge();
      if (!cached) { status.textContent = 'まだノートがありません。先に再構築してください'; return; }
      body.textContent = cached.md;
      dl.href = URL.createObjectURL(new Blob([cached.md], { type: 'text/markdown' }));
      modal.hidden = false;
    });
    $('kb-modal-close').addEventListener('click', () => { modal.hidden = true; });
  }
```

`render` 内 `wireAiControls();` の直後に `wireKnowledgeControls();` を追加。

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS(`html-ids.test.js` 緑・重複idなし、全体緑)

- [ ] **Step 6: Commit**

```bash
git add index.html src/progress.js test/html-ids.test.js
git commit -m "feat(progress): 風速帯ノートの再構築ボタンと表示/DLを追加"
```

---

## Self-Review

**1. Spec coverage:**
- 4帯モデル・語優先 → Task 1。境界・unknown → Task 1。
- 帯フィルタ(fallback)・ダイジェスト取り出し → Task 2。
- 3ビン→4帯移行(progressstore/peerlearning/progress 表示) → Task 3。
- localStorage キャッシュ → Task 4。
- チーム+参考文献の帯別入力(実名除去・slow/fastFactor 含む・参考文献 general 分類) → Task 5。
- フルAI分析プロンプト・8点上限・応答検証 → Task 6。
- md レンダリング(データ不足表示)・再構築オーケストレータ・stats → Task 7。
- aicomment 帯フィルタ+帯ノート注入+後方互換 → Task 8。
- peerlearning 帯フィルタ+帯ノート注入+後方互換 → Task 9。
- 生成時の帯計算・ダイジェスト受け渡し・digest不在で従来動作 → Task 10。
- 再構築ボタン・表示/DL・認証(既存 `/api/ai-comment` の閲覧ログイン必須を流用) → Task 11。
- 出典タグ(部内実績/参考) → Task 6 プロンプト + Task 7 レンダリングで担保。

**2. Placeholder scan:** すべてのステップに実コード/実コマンド/期待結果を記載。TODO・「適宜」等なし。

**3. Type consistency:**
- `classifyWindBand(text, speed)` の引数順を全タスクで統一(Task 1/3/5/9/10)。
- 帯キーは `bihuu/chuu/kyou/baku`(+`unknown`)で全タスク一致。
- `digest` は `bandBullets` オブジェクト(`{bihuu:[],chuu:[],kyou:[],baku:[]}`)。`bandSectionFromDigest(digest, band)` が該当帯配列を返す(Task 2/8/9)。
- `generateWindKnowledge` の戻り `{ md, builtAt, bandBullets, stats }` が Task 7 定義=Task 11 消費で一致。
- `filterByBand(candidates, targetBand, {min, getBand})` の使用が Task 2 定義=Task 8/9 呼び出しで一致。
- `windknowledgestore` の保存形が Task 4 定義=Task 7 生成=Task 11 消費で一致。

**4. Review Focus:** 5項目それぞれにテスト所有タスクを割当済み(digest不在=Task 8/9、null speed=Task 1/2、AI応答不正=Task 6、境界値=Task 1、空帯=Task 7)。
