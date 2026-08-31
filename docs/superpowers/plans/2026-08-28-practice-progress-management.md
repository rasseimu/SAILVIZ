# 練習進捗管理画面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 振り返り議事録を添付すると各部員に自動振り分けして反省を保存し、部員別の横タブで目標変化・課題進捗(3段階)・風速別の発見・解決量推移グラフを見られる進捗管理画面を作る。

**Architecture:** 決定的パーサ `minutes.js` が構造化議事録を部員ブロックへ分解し名簿照合。インポートは読込中練習に各部員の反省を既存 `createReflection` で生成(単一の真実源)。進捗の3段階状態だけを別ストア `sailviz.progress` に分離し、集計純関数 `summarize` がグラフ・風速まとめを作る。画面 `progress.js` は全練習ファイルを読み、横タブで4セクションを Chart.js 込みで描画する。

**Tech Stack:** バニラJS (ES modules, no build)、`node --test` + `node:assert/strict`、Chart.js 4.4.6 (同梱 `vendor/chart.esm.js`、`src/chartview.js` 経由)、File System Access API、localStorage。

**Spec:** `docs/superpowers/specs/2026-08-28-practice-progress-management-design.md`

## Global Constraints

- **no-build 制約**: ビルドツール/CDN禁止。新規依存を足さない(Chart.js は既存同梱 `vendor/chart.esm.js` を `src/chartview.js` 経由でのみ使用)。
- **純ロジックとDOMを分離**: パース/集計/ストアは副作用なしの純モジュールにし、`node --test` でテスト。DOM描画・モーダル・タブ切替は手動確認。
- **localStorage 注入可**: ストア関数は `storage = globalThis.localStorage` を引数で受け、テストで `memStorage` を注入(既存 `reflections.js` と同一規約)。
- **反省は真実源**: インポートは `createReflection`(`src/reflections.js`)で反省を生成し `state.reflections` に追加、既存の保存フローに乗せる。反省の形は変更しない。
- **進捗キー**: 進捗オーバーレイは反省の `id` をキーにする。形 `{ [reflId]: { issueStage: 0|1|2, goalDone: boolean } }`。
- **風速ビン**: 既定境界 `<3` / `3–6` / `≥6` m/s、`wind.speed==null` は「風速不明」。定数として `progressstore.js` に置く。
- **グラフy軸**: 解決量の推移 = 練習日ごとの「解決(stage=2)到達課題の**累計数**」(単調増加)。
- **テストは日本語 test 名**、`import { test } from 'node:test'` / `import assert from 'node:assert/strict'` を使う(既存踏襲)。

---

## ファイル構成

| ファイル | 新規/変更 | 責務 |
|---|---|---|
| `src/minutes.js` | 新規 | 議事録テキスト→部員別ブロック抽出(goal/issue/discovery)＋名簿照合。純。 |
| `src/progressstore.js` | 新規 | `sailviz.progress` の load/save/不変更新 ＋ 反省×オーバーレイの集計 `summarize`。純。 |
| `src/progress.js` | 新規 | 横タブ・全ファイル読込・4セクション描画・グラフ配線(DOMコントローラ)。 |
| `test/minutes.test.js` | 新規 | パース＋照合の単体テスト。 |
| `test/progressstore.test.js` | 新規 | ストア＋集計の単体テスト。 |
| `index.html` | 変更 | `#progress-screen` セクション・ホームのリンク追加。 |
| `styles.css` | 変更 | 進捗画面・横タブ・課題カード・3段階トグルのスタイル。 |
| `src/app.js` | 変更 | インポートボタン・`showProgress`/`backToHomeFromProgress`・進捗インポートモーダル配線。 |

依存順: Task 1(minutes) → Task 2(progressstore) → Task 3(HTML/CSS枠) → Task 4(progress.js描画) → Task 5(インポートUI) → Task 6(app.js配線)。

---

## Task 1: 議事録パーサ `src/minutes.js`

**Files:**
- Create: `src/minutes.js`
- Test: `test/minutes.test.js`

**Interfaces:**
- Consumes: `memberList`, `toHiragana` from `src/members.js`。
- Produces:
  - `parseMinutes(text: string) -> Array<{ headerName: string, fullNameHint: string|null, goal: string, issue: string, discovery: string, raw: string }>`
  - `matchMember(headerName: string, fullNameHint: string|null, roster = memberList()) -> { member: object|null, how: string }`(`member` は `memberList()` の要素、`how` は `'fullname'|'family'|'kana'|'given'|'none'`)

- [ ] **Step 1: 失敗するテストを書く**

`test/minutes.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMinutes, matchMember } from '../src/minutes.js';
import { memberList } from '../src/members.js';

const SAMPLE = `# 練習振り返り 議事録

## ゆま（本間ゆま）
- **今日の目標**：ジャイブ。加えてクローズ・ランニングの艇速を安定させる。
- **課題**：強風クローズで起こしきれず、あまり何もせず走ってしまった。
- **発見**：北に強く吹いた時のランニングは何もしない方が速いのではと感じた。

## だいき（風間）
- **今日の目標**：リーチの閉じ具合の誤差をなくす。
- **課題**：閉じ過ぎていることが多かった。
- **発見**：特になし。

## しゅゆ
- **今日の目標**：追風のクルーワークを行うこと。
- **課題**：スピンが貼れず、原因を詰めたい。
- **取り組み**：午前・午後とも動画を撮影し学んだ。

## ゆうと（吉田）
- **今日の目標**：タックのタイミングを早く。
- **課題**：うねりの処理ができなかった。
- **今後**：ジャイブでロールをかけたい。`;

test('parseMinutes は ## 見出しごとにブロック分割し括弧内をヒントにする', () => {
  const blocks = parseMinutes(SAMPLE);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].headerName, 'ゆま');
  assert.equal(blocks[0].fullNameHint, '本間ゆま');
  assert.equal(blocks[2].headerName, 'しゅゆ');
  assert.equal(blocks[2].fullNameHint, null);
});

test('parseMinutes は目標/課題/発見ラベルを吸収する', () => {
  const b = parseMinutes(SAMPLE)[0];
  assert.match(b.goal, /ジャイブ/);
  assert.match(b.issue, /強風クローズ/);
  assert.match(b.discovery, /北に強く吹いた/);
});

test('parseMinutes は 今後/取り組み を discovery に集約する', () => {
  const blocks = parseMinutes(SAMPLE);
  const shuyu = blocks[2];
  const yuto = blocks[3];
  assert.match(shuyu.discovery, /動画を撮影/);   // 取り組み → discovery
  assert.match(yuto.discovery, /ロールをかけたい/); // 今後 → discovery
});

test('matchMember: 括弧フルネーム→姓→kana の順で名簿に解決する', () => {
  const roster = memberList();
  assert.equal(matchMember('ゆま', '本間ゆま', roster).member.fullName, '本間 由真');
  assert.equal(matchMember('だいき', '風間', roster).member.fullName, '風間 大煕');
  assert.equal(matchMember('しゅゆ', null, roster).member.fullName, '原田 修有'); // kana
  assert.equal(matchMember('れい', null, roster).member.fullName, '村瀬 礼');     // kana
  assert.equal(matchMember('だれか', null, roster).member, null);                 // 未一致
});

test('parseMinutes は全角半角コロン両対応、未知ラベルは無視', () => {
  const b = parseMinutes('## X（山田太郎）\n- **今日の目標**:半角コロン\n- **雑談**：無視される')[0];
  assert.equal(b.goal, '半角コロン');
  assert.equal(b.issue, '');
  assert.equal(b.discovery, '');
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/minutes.test.js`
Expected: FAIL(`parseMinutes` / `matchMember` が未定義)

- [ ] **Step 3: 最小実装を書く**

`src/minutes.js`:
```js
// 練習振り返り議事録(構造化テキスト)を部員ブロックへ分解し、名簿へ照合する純ロジック。
// 形式: `## 見出し（フルネーム）` ＋ `- **ラベル**：本文`。AI不要・決定的。
import { memberList, toHiragana } from './members.js';

// ラベル(別名込み)→ 反省フィールドキー。今後/取り組みは発見(discovery)に集約する。
const LABEL_MAP = {
  '目標': 'goal', '今日の目標': 'goal',
  '課題': 'issue',
  '発見': 'discovery',
  '今後': 'discovery', '今後の取り組み': 'discovery', '取り組み': 'discovery', '取組': 'discovery',
};

// 見出しから括弧(全角/半角)を剥がし、{ headerName, fullNameHint } を返す。
function splitHeader(line) {
  const m = line.match(/^(.*?)[（(]\s*(.+?)\s*[)）]\s*$/);
  if (m) return { headerName: m[1].trim(), fullNameHint: m[2].trim() };
  return { headerName: line.trim(), fullNameHint: null };
}

// `- **ラベル**：本文` 行を { key, text } に。ラベル別名を解決。非該当は null。
function parseLabelLine(line) {
  const m = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*[：:]\s*(.*)$/);
  if (!m) return null;
  const key = LABEL_MAP[m[1].trim()];
  if (!key) return null;
  return { key, text: m[2].trim() };
}

// 議事録全文 → 部員ブロック配列。
export function parseMinutes(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let cur = null;      // 現在のブロック
  let lastKey = null;  // 継続行(ラベルの折返し)の追記先
  const push = () => { if (cur) blocks.push(cur); };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      push();
      const { headerName, fullNameHint } = splitHeader(h[1]);
      cur = { headerName, fullNameHint, goal: '', issue: '', discovery: '', raw: '' };
      lastKey = null;
      continue;
    }
    if (!cur) continue; // 最初の ## より前(# タイトル等)は無視
    cur.raw += (cur.raw ? '\n' : '') + line;
    const lbl = parseLabelLine(line);
    if (lbl) {
      cur[lbl.key] = cur[lbl.key] ? `${cur[lbl.key]} ${lbl.text}` : lbl.text; // 同キー複数は連結
      lastKey = lbl.key;
    } else if (lastKey && line.trim() && !/^\s*[-*]/.test(line)) {
      cur[lastKey] += (cur[lastKey] ? ' ' : '') + line.trim(); // 折返し継続行を直近ラベルへ
    } else if (/^\s*[-*]/.test(line)) {
      lastKey = null; // 別の(未知)箇条書きに入ったら継続を止める
    }
  }
  push();
  return blocks;
}

// 見出し名/フルネームヒントを名簿へ照合。優先: fullname → family → kana → given。
export function matchMember(headerName, fullNameHint, roster = memberList()) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const hint = norm(fullNameHint);
  const head = String(headerName || '').trim();
  if (hint) {
    const byFull = roster.find((m) => norm(m.fullName) === hint);
    if (byFull) return { member: byFull, how: 'fullname' };
    const byFamHint = roster.find((m) => hint.startsWith(m.family) || m.family === hint);
    if (byFamHint) return { member: byFamHint, how: 'family' };
  }
  const byFam = roster.find((m) => head === m.family || head.startsWith(m.family));
  if (byFam) return { member: byFam, how: 'family' };
  const kana = toHiragana(head);
  const byKana = roster.find((m) => m.kana === kana);
  if (byKana) return { member: byKana, how: 'kana' };
  const byGiven = roster.find((m) => m.given === head);
  if (byGiven) return { member: byGiven, how: 'given' };
  return { member: null, how: 'none' };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/minutes.test.js`
Expected: PASS(全5テスト)

- [ ] **Step 5: コミット**

```bash
git add src/minutes.js test/minutes.test.js
git commit -m "feat(progress): 議事録パーサと名簿照合を追加"
```

---

## Task 2: 進捗ストアと集計 `src/progressstore.js`

**Files:**
- Create: `src/progressstore.js`
- Test: `test/progressstore.test.js`

**Interfaces:**
- Consumes: なし(純)。
- Produces:
  - `STORAGE_KEY = 'sailviz.progress'`
  - `WIND_BINS`(定数): `[{ key, label, max }]` 昇順、末尾は `max: Infinity`。
  - `loadProgress(storage?) -> object`
  - `saveProgress(obj, storage?) -> object`
  - `setIssueStage(obj, reflId, stage) -> object`(新オブジェクトを返す不変更新)
  - `setGoalDone(obj, reflId, done) -> object`
  - `windBinKey(speed) -> string`(null/未定義→`'unknown'`)
  - `summarize(reflections, progress, { bins = WIND_BINS } = {}) -> { byMember, resolutionSeries }`
    - `byMember[fullName] = { goals: [{reflId,text,dateMs,done}], issues: [{reflId,text,dateMs,stage}], discoveriesByBin: { [binKey]: [{reflId,text,dateMs,speed}] } }`
    - `resolutionSeries = { all: [{dateMs,value}], [fullName]: [{dateMs,value}] }`(練習日昇順、value=その日までに解決(stage=2)到達した課題の累計数)

- [ ] **Step 1: 失敗するテストを書く**

`test/progressstore.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, WIND_BINS, loadProgress, saveProgress,
  setIssueStage, setGoalDone, windBinKey, summarize,
} from '../src/progressstore.js';

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

// 反省の最小スタブ(progress が使う field のみ)。
function refl(id, fullName, dateMs, { goal = '', issue = '', discovery = '', speed = null } = {}) {
  return {
    id, people: [fullName], practice: { date: '2026-08-28', startMs: dateMs },
    createdAt: dateMs, notes: { goal, issue, discovery }, wind: speed == null ? null : { speed },
  };
}

test('load/save 往復', () => {
  const st = memStorage();
  saveProgress({ r1: { issueStage: 2, goalDone: true } }, st);
  assert.equal(st.getItem(STORAGE_KEY), '{"r1":{"issueStage":2,"goalDone":true}}');
  assert.deepEqual(loadProgress(st), { r1: { issueStage: 2, goalDone: true } });
});

test('loadProgress は空/壊れ入力で {} を返す', () => {
  assert.deepEqual(loadProgress(memStorage()), {});
  assert.deepEqual(loadProgress(memStorage({ [STORAGE_KEY]: 'not json' })), {});
});

test('setIssueStage/setGoalDone は不変更新で新オブジェクトを返す', () => {
  const a = {};
  const b = setIssueStage(a, 'r1', 1);
  assert.notEqual(a, b);
  assert.deepEqual(b, { r1: { issueStage: 1, goalDone: false } });
  const c = setGoalDone(b, 'r1', true);
  assert.deepEqual(c.r1, { issueStage: 1, goalDone: true });
  assert.deepEqual(b.r1, { issueStage: 1, goalDone: false }); // b は不変
});

test('windBinKey は境界とnullを正しく分類', () => {
  assert.equal(windBinKey(2.9), WIND_BINS[0].key);
  assert.equal(windBinKey(3), WIND_BINS[1].key);
  assert.equal(windBinKey(6), WIND_BINS[2].key);
  assert.equal(windBinKey(null), 'unknown');
});

test('summarize は部員別に目標/課題/発見(風速ビン)を束ねる', () => {
  const reflections = [
    refl('r1', '本間 由真', 1000, { goal: 'ジャイブ', issue: '起こし', discovery: '微風は無操作', speed: 2 }),
    refl('r2', '本間 由真', 2000, { goal: 'クローズ', issue: '角度', discovery: 'ブロー対応', speed: 7 }),
    refl('r3', '風間 大煕', 1000, { goal: 'リーチ', issue: '閉じ過ぎ', discovery: '', speed: 5 }),
  ];
  const progress = { r1: { issueStage: 2, goalDone: true }, r2: { issueStage: 1, goalDone: false } };
  const s = summarize(reflections, progress);
  const yuma = s.byMember['本間 由真'];
  assert.equal(yuma.issues.length, 2);
  assert.equal(yuma.issues[0].stage, 2);
  assert.equal(yuma.goals[0].done, true);
  assert.equal(yuma.discoveriesByBin[WIND_BINS[0].key][0].text, '微風は無操作'); // speed2 → <3
  assert.equal(yuma.discoveriesByBin[WIND_BINS[2].key][0].text, 'ブロー対応');   // speed7 → >=6
});

test('summarize.resolutionSeries は解決課題の累計を練習日昇順で出す', () => {
  const reflections = [
    refl('r1', '本間 由真', 1000, { issue: 'a' }),
    refl('r2', '本間 由真', 2000, { issue: 'b' }),
    refl('r3', '風間 大煕', 1500, { issue: 'c' }),
  ];
  const progress = { r1: { issueStage: 2 }, r2: { issueStage: 2 }, r3: { issueStage: 2 } };
  const s = summarize(reflections, progress);
  assert.deepEqual(s.resolutionSeries.all.map((p) => p.value), [1, 2, 3]); // 1000,1500,2000 で累計
  assert.deepEqual(s.resolutionSeries['本間 由真'].map((p) => p.value), [1, 2]);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test test/progressstore.test.js`
Expected: FAIL(モジュール未定義)

- [ ] **Step 3: 最小実装を書く**

`src/progressstore.js`:
```js
// 課題の3段階進捗(未着手0/取組中1/解決2)と目標達成フラグを localStorage に持つ軽量オーバーレイ。
// キー = 反省id。反省(真実源)とは別ストアにし、進捗トグルで練習ファイルを書き戻さずに済ませる。
// 集計(summarize)は反省配列 × オーバーレイ から画面用データを作る純関数。
export const STORAGE_KEY = 'sailviz.progress';

// 風速ビン(昇順・境界は max 未満)。末尾は上限なし。unknown は speed 欠損。
export const WIND_BINS = [
  { key: 'lt3', label: '〜3 m/s', max: 3 },
  { key: 'mid', label: '3〜6 m/s', max: 6 },
  { key: 'ge6', label: '6 m/s〜', max: Infinity },
];

export function windBinKey(speed) {
  if (speed == null || !Number.isFinite(Number(speed))) return 'unknown';
  const s = Number(speed);
  for (const b of WIND_BINS) if (s < b.max) return b.key;
  return WIND_BINS[WIND_BINS.length - 1].key;
}

export function loadProgress(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function saveProgress(obj, storage = globalThis.localStorage) {
  storage?.setItem(STORAGE_KEY, JSON.stringify(obj));
  return obj;
}

// 既存エントリを {issueStage:0, goalDone:false} で補完して不変更新する。
function updateEntry(obj, reflId, patch) {
  const prev = obj[reflId] || { issueStage: 0, goalDone: false };
  return { ...obj, [reflId]: { issueStage: 0, goalDone: false, ...prev, ...patch } };
}

export function setIssueStage(obj, reflId, stage) {
  return updateEntry(obj, reflId, { issueStage: stage });
}

export function setGoalDone(obj, reflId, done) {
  return updateEntry(obj, reflId, { goalDone: done });
}

// 反省の練習日時(ms)。practice.startMs → createdAt の順。
function reflDateMs(r) {
  return r.practice?.startMs ?? r.createdAt ?? 0;
}

export function summarize(reflections, progress, { bins = WIND_BINS } = {}) {
  const byMember = {};
  const ensure = (name) => (byMember[name] ||= { goals: [], issues: [], discoveriesByBin: {} });
  // 練習日昇順で走査(累計シリーズの単調性のため)。
  const sorted = [...reflections].sort((a, b) => reflDateMs(a) - reflDateMs(b));
  const series = { all: [] };
  let allCum = 0;
  const memberCum = {};
  for (const r of sorted) {
    const name = r.people?.[0];
    if (!name) continue;
    const bucket = ensure(name);
    const dateMs = reflDateMs(r);
    const st = progress[r.id] || {};
    const notes = r.notes || {};
    if (notes.goal) bucket.goals.push({ reflId: r.id, text: notes.goal, dateMs, done: !!st.goalDone });
    if (notes.issue) bucket.issues.push({ reflId: r.id, text: notes.issue, dateMs, stage: st.issueStage ?? 0 });
    if (notes.discovery) {
      const speed = r.wind?.speed ?? null;
      const bk = windBinKey(speed);
      (bucket.discoveriesByBin[bk] ||= []).push({ reflId: r.id, text: notes.discovery, dateMs, speed });
    }
    // 解決(stage=2)到達を累計。課題を持つ反省のみ対象。
    if (notes.issue && (st.issueStage ?? 0) === 2) {
      allCum += 1;
      memberCum[name] = (memberCum[name] || 0) + 1;
      series.all.push({ dateMs, value: allCum });
      (series[name] ||= []).push({ dateMs, value: memberCum[name] });
    }
  }
  return { byMember, resolutionSeries: series };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test test/progressstore.test.js`
Expected: PASS(全6テスト)

- [ ] **Step 5: フルテストで回帰なしを確認しコミット**

```bash
node --test
git add src/progressstore.js test/progressstore.test.js
git commit -m "feat(progress): 進捗ストアと集計(summarize)を追加"
```

---

## Task 3: 画面枠とホーム導線 `index.html` / `styles.css`

**Files:**
- Modify: `index.html`(`#dashboard-screen` セクションの後・`#topbar` の前に `#progress-screen` を追加、`#home-bar` にリンク追加)
- Modify: `styles.css`(末尾に進捗画面スタイルを追加)

**Interfaces:**
- Produces(app.js が参照するDOM id):
  - `#home-progress-link`(ホームバーのリンク)
  - `#progress-screen` / `#progress-home-link` / `#progress-nav`(横タブ) / `#progress-content`(本体)
  - インポートUI: `#reflection-import`(取込ボタン) / `#import-modal` / `#import-file` / `#import-text` / `#import-preview` / `#import-run` / `#import-cancel` / `#import-wind`
  - body クラス `view-progress`

- [ ] **Step 1: `index.html` にホーム導線を追加**

`#home-bar` 内の `home-dashboard-link` の直後に追記:
```html
      <a id="home-progress-link" class="home-link" title="部員ごとの練習進捗を見る">📈 練習進捗管理</a>
```

- [ ] **Step 2: `index.html` に `#progress-screen` を追加**

`</section>`(`#dashboard-screen` の閉じ)の直後、`<header id="topbar">` の直前に追記:
```html
  <section id="progress-screen">
    <header id="progress-bar">
      <a id="progress-home-link" class="home-link" title="ホームへ戻る">← ホーム</a>
      <strong id="progress-title">練習進捗管理</strong>
    </header>
    <nav id="progress-nav"></nav>
    <div id="progress-content"></div>
  </section>

  <section id="import-modal" class="hidden">
    <div class="im-inner">
      <div id="im-bar">
        <strong>議事録から一括取込</strong>
        <span id="import-wind"></span>
        <button id="import-run">取込</button>
        <button id="import-cancel">閉じる</button>
      </div>
      <div class="im-input">
        <label class="btn">議事録ファイルを選択
          <input type="file" id="import-file" accept=".md,.txt" hidden />
        </label>
        <span class="im-or">または貼り付け ↓</span>
        <textarea id="import-text" rows="6" placeholder="## 名前（フルネーム）\n- **今日の目標**：…\n- **課題**：…\n- **発見**：…"></textarea>
      </div>
      <div id="import-preview"></div>
    </div>
  </section>
```

- [ ] **Step 3: サイドバーの反省エリアに取込ボタンを追加**

`index.html` の `#reflection-add` ボタンの直後に追記:
```html
      <button id="reflection-import" class="side-add" title="振り返り議事録を部員別に一括取込">📋 議事録から一括取込</button>
```

- [ ] **Step 4: `styles.css` に進捗画面スタイルを追加**

`styles.css` の末尾に追記:
```css
/* ===== 練習進捗管理画面 ===== */
#progress-screen { display: none; }
body.view-progress #progress-screen { display: flex; flex-direction: column; position: fixed; inset: 0; background: #fff; z-index: 50; }
body.view-progress #home-screen,
body.view-progress #dashboard-screen,
body.view-progress #topbar,
body.view-progress main,
body.view-progress #transport { display: none; }
#progress-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #e5e5e5; }
#progress-nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-bottom: 1px solid #eee; overflow-x: auto; }
#progress-content { flex: 1; overflow: auto; padding: 16px; }
.progress-section { margin-bottom: 24px; }
.progress-section > h3 { margin: 0 0 8px; font-size: 15px; }
.issue-card { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid #eee; border-radius: 6px; margin-bottom: 6px; }
.issue-card .ic-text { flex: 1; }
.issue-card .ic-date { color: #888; font-size: 12px; }
.stage-toggle { display: inline-flex; border: 1px solid #ccc; border-radius: 6px; overflow: hidden; }
.stage-toggle button { border: none; background: #fff; padding: 4px 8px; cursor: pointer; font-size: 12px; }
.stage-toggle button.active { background: #1558d6; color: #fff; }
.wind-bin { margin-bottom: 10px; }
.wind-bin > strong { display: block; margin-bottom: 4px; color: #555; }
.goal-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.goal-row .gr-date { color: #888; font-size: 12px; min-width: 84px; }
#progress-chart-wrap { max-width: 720px; height: 260px; }
```

- [ ] **Step 5: 手動確認とコミット**

`npm run serve` で開き、`#progress-screen` が既定で非表示・DOM が崩れていないことを目視(まだ導線は非配線)。
```bash
git add index.html styles.css
git commit -m "feat(progress): 進捗画面の枠・横タブ・インポートモーダルのHTML/CSSを追加"
```

---

## Task 4: 進捗画面コントローラ `src/progress.js`

**Files:**
- Create: `src/progress.js`
- Modify: `src/app.js`(import 追加・`createProgress` 生成・`showProgress`/`backToHomeFromProgress`・リンク配線)

**Interfaces:**
- Consumes: `memberList`(`members.js`)、`summarize`/`loadProgress`/`saveProgress`/`setIssueStage`/`setGoalDone`/`WIND_BINS`(`progressstore.js`)、`renderChart`(`chartview.js`)。
- Produces:
  - `createProgress({ loadEntries }) -> { render }`
    - `loadEntries: () => Promise<Array<{ name, project }>>`(app.js が dashboard と同じ実装を渡す。`project.reflections` を使う)
    - `render()`: 全反省を集めて横タブ＋4セクション＋グラフを描画

- [ ] **Step 1: `src/progress.js` を実装**

```js
// src/progress.js
// #progress-screen に「横タブ(全て＋名簿) × 目標変化/課題進捗(3段階)/風速別発見/解決量推移グラフ」を描画。
// 反省(真実源)は全練習ファイルから集め、進捗段階は sailviz.progress オーバーレイで持つ。
import { memberList } from './members.js';
import {
  loadProgress, saveProgress, setIssueStage, setGoalDone, summarize, WIND_BINS,
} from './progressstore.js';
import { renderChart } from './chartview.js';

const $ = (id) => document.getElementById(id);
const STAGES = [{ v: 0, label: '未着手' }, { v: 1, label: '取組中' }, { v: 2, label: '解決' }];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

export function createProgress({ loadEntries }) {
  let reflections = [];   // 全練習の反省を平坦化
  let progress = {};      // sailviz.progress
  let selected = 'all';   // 'all' | fullName
  let chart = null;

  function allReflections(entries) {
    const out = [];
    for (const e of entries) for (const r of (e.project?.reflections || [])) out.push(r);
    return out;
  }

  function renderNav() {
    const nav = $('progress-nav');
    const items = [{ key: 'all', label: '全て' }, ...memberList().map((m) => ({ key: m.fullName, label: m.fullName }))];
    nav.innerHTML = items.map((it) =>
      `<button type="button" class="dashboard-nav-item${it.key === selected ? ' active' : ''}" data-key="${esc(it.key)}">${esc(it.label)}</button>`
    ).join('');
    nav.querySelectorAll('.dashboard-nav-item').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (selected === btn.dataset.key) return;
        selected = btn.dataset.key;
        renderNav();
        renderBody();
      }));
  }

  // 現在選択に対応する部員データ(全ては合算表示)。
  function memberBuckets(sum) {
    if (selected === 'all') return Object.entries(sum.byMember); // [ [name, bucket], ... ]
    return sum.byMember[selected] ? [[selected, sum.byMember[selected]]] : [];
  }

  function renderBody() {
    const sum = summarize(reflections, progress);
    const content = $('progress-content');
    const buckets = memberBuckets(sum);

    const goalsHtml = buckets.flatMap(([name, b]) => b.goals.map((g) =>
      `<div class="goal-row"><span class="gr-date">${fmtDate(g.dateMs)}</span>`
      + `<input type="checkbox" data-goal="${esc(g.reflId)}" ${g.done ? 'checked' : ''} />`
      + `<span>${selected === 'all' ? esc(name) + '：' : ''}${esc(g.text)}</span></div>`)).join('') || '<p>(目標なし)</p>';

    const issuesHtml = buckets.flatMap(([name, b]) => b.issues.map((it) =>
      `<div class="issue-card"><span class="ic-date">${fmtDate(it.dateMs)}</span>`
      + `<span class="ic-text">${selected === 'all' ? esc(name) + '：' : ''}${esc(it.text)}</span>`
      + `<span class="stage-toggle">${STAGES.map((s) =>
        `<button data-issue="${esc(it.reflId)}" data-stage="${s.v}" class="${it.stage === s.v ? 'active' : ''}">${s.label}</button>`).join('')}</span></div>`)).join('') || '<p>(課題なし)</p>';

    // 風速ビンごとに発見を集約(全ビン + unknown)。
    const binOrder = [...WIND_BINS, { key: 'unknown', label: '風速不明' }];
    const discHtml = binOrder.map((bin) => {
      const items = buckets.flatMap(([name, b]) => (b.discoveriesByBin[bin.key] || []).map((d) =>
        `<li>${selected === 'all' ? esc(name) + '：' : ''}${esc(d.text)}</li>`));
      return items.length ? `<div class="wind-bin"><strong>${bin.label}</strong><ul>${items.join('')}</ul></div>` : '';
    }).join('') || '<p>(発見なし)</p>';

    content.innerHTML =
      `<section class="progress-section"><h3>目標の変化</h3>${goalsHtml}</section>`
      + `<section class="progress-section"><h3>課題の進捗</h3>${issuesHtml}</section>`
      + `<section class="progress-section"><h3>風速別の発見</h3>${discHtml}</section>`
      + `<section class="progress-section"><h3>解決量の推移</h3><div id="progress-chart-wrap"><canvas id="progress-chart"></canvas></div></section>`;

    wireBody();
    renderChartFor(sum);
  }

  function wireBody() {
    const content = $('progress-content');
    content.querySelectorAll('button[data-issue]').forEach((btn) =>
      btn.addEventListener('click', () => {
        progress = setIssueStage(progress, btn.dataset.issue, Number(btn.dataset.stage));
        saveProgress(progress);
        renderBody();
      }));
    content.querySelectorAll('input[data-goal]').forEach((cb) =>
      cb.addEventListener('change', () => {
        progress = setGoalDone(progress, cb.dataset.goal, cb.checked);
        saveProgress(progress);
        renderBody();
      }));
  }

  function renderChartFor(sum) {
    const canvas = $('progress-chart');
    if (!canvas) return;
    if (chart) { try { chart.destroy(); } catch { /* noop */ } chart = null; }
    const key = selected === 'all' ? 'all' : selected;
    const pts = sum.resolutionSeries[key] || [];
    if (!pts.length) return;
    const datasets = [{
      label: '解決課題(累計)',
      data: pts.map((p) => ({ x: p.dateMs, y: p.value })),
      borderColor: '#1558d6', backgroundColor: '#1558d6', stepped: true, tension: 0,
    }];
    const from = pts[0].dateMs;
    const to = pts[pts.length - 1].dateMs;
    chart = renderChart(canvas, { datasets, from, to, mini: false, fmtX: (ms) => fmtDate(ms).slice(5) });
  }

  async function render() {
    const entries = await loadEntries();
    reflections = allReflections(entries);
    progress = loadProgress();
    renderNav();
    renderBody();
  }

  return { render };
}
```

- [ ] **Step 2: `chartview.renderChart` の期待引数を確認**

Run: `grep -n "export function renderChart" src/chartview.js`
Expected: `renderChart(canvas, { datasets, from, to, mini, fmtX })` を受ける関数が存在(dashboard と同一の呼び出し規約)。
不一致なら Step 1 の `renderChartFor` を実際のシグネチャに合わせて修正する。

- [ ] **Step 3: `app.js` に配線を追加**

`src/app.js` の import 群(`createDashboard` の行付近)に追記:
```js
import { createProgress } from './progress.js';
```

`const dashboard = createDashboard({...})` の直後に追記:
```js
// 進捗画面: dashboard と同じく projectDir の全ファイルを deserialize して渡す。
const progress = createProgress({
  loadEntries: async () => {
    if (!projectDir) return [];
    const files = await listProjectFiles(projectDir);
    const entries = [];
    for (const f of files) {
      try { entries.push({ name: f.name, project: deserializeProject(await readProject(projectDir, f.name)) }); }
      catch { /* 壊れたファイルはスキップ */ }
    }
    return entries;
  },
});
```

`showDashboard`/`backToHomeFromDashboard` の定義付近に追記:
```js
async function showProgress() {
  if (!projectDir && !(await ensureProjectDir())) return;
  document.body.classList.remove('view-home');
  document.body.classList.add('view-progress');
  await progress.render();
}
function backToHomeFromProgress() {
  document.body.classList.remove('view-progress');
  showHome();
}
```

`$('home-dashboard-link').addEventListener('click', showDashboard);` の付近に追記:
```js
$('home-progress-link').addEventListener('click', showProgress);
$('progress-home-link').addEventListener('click', backToHomeFromProgress);
```

- [ ] **Step 4: 手動確認**

`npm run serve` → ホームの「📈 練習進捗管理」→ 横タブ表示、課題カードの3段階トグルで色が変わり再読込しても状態維持(localStorage)、グラフが解決累計で描画されること。反省が無ければ各セクション「(なし)」表示で落ちないこと。

- [ ] **Step 5: コミット**

```bash
git add src/progress.js src/app.js
git commit -m "feat(progress): 進捗画面(横タブ・3段階トグル・風速別発見・推移グラフ)を追加"
```

---

## Task 5: 議事録インポートUI(プレビュー＆手修正)

**Files:**
- Modify: `src/app.js`(インポートモーダルの配線・`createReflection` 生成)

**Interfaces:**
- Consumes: `parseMinutes`/`matchMember`(`minutes.js`)、`memberList`(`members.js`)、既存 `createReflection`/`practiceInfo`/`nowAbsolute`/`fetchWind`/`fetchWindFromCsv`/`persistReflections`/`renderReflectionList`/`firstVisibleTrack`。
- Produces: なし(app.js 内の配線のみ)。

- [ ] **Step 1: `app.js` に import を追加**

`import { memberList, filterMembers } from './members.js';` を利用しつつ、パーサを追加:
```js
import { parseMinutes, matchMember } from './minutes.js';
```

- [ ] **Step 2: インポートモーダルのロジックを追加**

`src/app.js` の「反省ノート」セクション付近(`saveReflection` の後)に追記:
```js
// ================= 議事録一括インポート =================
let importRows = []; // [{ block, memberFullName|null, include }]

function openImportModal() {
  if (!firstVisibleTrack()) { statusEl.textContent = '先に練習(GPS)を読み込んでください'; return; }
  $('import-text').value = '';
  $('import-preview').innerHTML = '';
  $('import-wind').textContent = '';
  importRows = [];
  $('import-modal').classList.remove('hidden');
}
function closeImportModal() { $('import-modal').classList.add('hidden'); }

// テキストをパースしてプレビュー行を構築。
function rebuildImportPreview(text) {
  const roster = memberList();
  const blocks = parseMinutes(text);
  importRows = blocks.map((b) => {
    const { member } = matchMember(b.headerName, b.fullNameHint, roster);
    return { block: b, memberFullName: member?.fullName ?? null, include: true };
  });
  renderImportPreview(roster);
}

function renderImportPreview(roster = memberList()) {
  const el = $('import-preview');
  if (!importRows.length) { el.innerHTML = '<p>議事録を入力するとプレビューされます。</p>'; return; }
  const opts = (sel) => ['<option value="">(未割当)</option>']
    .concat(roster.map((m) => `<option value="${escapeHtml(m.fullName)}"${m.fullName === sel ? ' selected' : ''}>${escapeHtml(m.fullName)}</option>`)).join('');
  el.innerHTML = importRows.map((row, i) => {
    const b = row.block;
    return `<div class="import-row${row.memberFullName ? '' : ' unmatched'}">`
      + `<label><input type="checkbox" data-inc="${i}" ${row.include ? 'checked' : ''} /> 取込</label>`
      + `<span class="ir-head">${escapeHtml(b.headerName)}${b.fullNameHint ? '（' + escapeHtml(b.fullNameHint) + '）' : ''} →</span>`
      + `<select data-member="${i}">${opts(row.memberFullName)}</select>`
      + `<div class="ir-notes">目標: ${escapeHtml(b.goal || '—')}／課題: ${escapeHtml(b.issue || '—')}／発見: ${escapeHtml(b.discovery || '—')}</div>`
      + `</div>`;
  }).join('');
  el.querySelectorAll('select[data-member]').forEach((s) =>
    s.addEventListener('change', (e) => { importRows[+e.target.dataset.member].memberFullName = e.target.value || null; }));
  el.querySelectorAll('input[data-inc]').forEach((cb) =>
    cb.addEventListener('change', (e) => { importRows[+e.target.dataset.inc].include = e.target.checked; }));
}

// 取込実行: 練習の風を1回取得し、採用行を反省化して追加。
async function runImport() {
  const rows = importRows.filter((r) => r.include && r.memberFullName);
  if (!rows.length) { statusEl.textContent = '取込対象がありません(部員を割り当ててください)'; return; }
  const practice = practiceInfo();
  const target = firstVisibleTrack() ? nowAbsolute() : Date.now();
  const wind = await fetchWind(target) ?? await fetchWindFromCsv(target);
  for (const row of rows) {
    const b = row.block;
    state.reflections.push(createReflection({
      id: `refl${Date.now()}_${reflSeq++}`, createdAt: Date.now(),
      text: b.raw, people: [row.memberFullName], wind, practice,
      notes: { goal: b.goal, issue: b.issue, discovery: b.discovery },
    }));
  }
  persistReflections();
  renderReflectionList();
  closeImportModal();
  statusEl.textContent = `${rows.length}名分の反省を議事録から取込みました`;
}

$('reflection-import').addEventListener('click', openImportModal);
$('import-cancel').addEventListener('click', closeImportModal);
$('import-run').addEventListener('click', runImport);
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  $('import-text').value = text;
  rebuildImportPreview(text);
});
$('import-text').addEventListener('input', (e) => rebuildImportPreview(e.target.value));
```

- [ ] **Step 3: インポート行の最小スタイルを追加**

`styles.css` 末尾(進捗スタイルの後)に追記:
```css
#import-modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 60; display: flex; align-items: center; justify-content: center; }
#import-modal.hidden { display: none; }
.im-inner { background: #fff; border-radius: 8px; width: min(760px, 92vw); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; }
#im-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #eee; }
#im-bar strong { flex: 1; }
.im-input { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.im-input textarea { width: 100%; font: inherit; }
.im-or { color: #888; font-size: 12px; }
#import-preview { padding: 0 14px 14px; overflow: auto; }
.import-row { border: 1px solid #eee; border-radius: 6px; padding: 8px; margin-bottom: 6px; }
.import-row.unmatched { border-color: #e0a030; background: #fff8ec; }
.import-row .ir-head { margin: 0 6px; font-weight: 600; }
.import-row .ir-notes { color: #555; font-size: 12px; margin-top: 4px; }
```

- [ ] **Step 4: 手動確認**

練習を読み込む → 「📋 議事録から一括取込」→ 添付議事録を貼り付け → 各部員が自動割当され、未一致行は橙色で手修正できる → 「取込」で反省サイドバーに部員別反省が追加され、進捗画面に反映されること。

- [ ] **Step 5: フルテストとコミット**

```bash
node --test
git add src/app.js styles.css
git commit -m "feat(progress): 議事録一括インポートUI(プレビュー・手修正)を追加"
```

---

## Task 6: 統合手動確認と仕上げ

**Files:**
- Modify: (必要なら)`src/app.js` / `styles.css` の微修正のみ

- [ ] **Step 1: エンドツーエンド手動シナリオ**

1. 保存フォルダを選択し、既存の練習を読み込む。
2. 「📋 議事録から一括取込」で添付フォーマットの全8名を貼り付け→全員自動割当を確認。
3. 「取込」→反省サイドバーに8件追加、💾保存。
4. 「📈 練習進捗管理」→「全て」タブで8名の目標/課題/発見が並ぶ。
5. ある課題を「解決」に→グラフの累計が1増える。ページ再読込しても段階が保持される。
6. 部員タブに切替→その部員だけに絞られる。風速別の発見が風速ビンに分かれる。

- [ ] **Step 2: 回帰確認**

Run: `node --test`
Expected: 全テスト PASS(既存テスト含む)。

- [ ] **Step 3: 最終コミット(差分があれば)**

```bash
git add -A
git commit -m "chore(progress): 統合確認と微調整"
```

---

## Self-Review(記入済み)

- **Spec coverage**:
  - §4 パーサ → Task 1。§7 ストア/`summarize` → Task 2。§3 データモデル(反省真実源＋オーバーレイ) → Task 2/5。
  - §5 インポートUI(前提チェック・プレビュー・手修正・風取得) → Task 5。§6 画面(横タブ・目標変化・課題3段階・風速別発見・推移グラフ) → Task 3/4。
  - §6.1 ルーティング(`view-progress`・ホーム導線・← ホーム) → Task 3/4。§9 スタイル → Task 3/5。§10 テスト → Task 1/2。
- **Placeholder scan**: TODO/TBD なし。全コード実体あり。1点だけ Task 4 Step 2 で `chartview.renderChart` の実シグネチャ確認を指示(既存 dashboard と同一想定だが実挙動で担保)。
- **Type consistency**: `summarize` の戻り(`byMember`/`resolutionSeries`)・`WIND_BINS`(key/label/max)・`setIssueStage/ setGoalDone` の不変更新・進捗キー `reflId` を Task 2 定義と Task 4 消費で一致。反省の `notes.goal/issue/discovery`・`people[0]`・`practice.startMs` は既存 `reflections.js`/`app.js` と一致。
