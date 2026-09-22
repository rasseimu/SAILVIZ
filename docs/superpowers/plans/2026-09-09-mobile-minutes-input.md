# スマホ議事録入力ページ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** スマホのブラウザで会議テキストを AI(Gemini)整形し、部員別の反省(Reflection)として練習日プロジェクトに保存するモバイル Web ページ `/minutes.html` を追加する。

**Architecture:** 純ロジック(AI応答JSON検証・行モデル・部員マージ・反省生成・プロジェクト骨組み)を DOM/HTTP から分離し `node --test` で検証。保存は新規 `POST /api/minutes-imports/commit` が practiceDate 一致プロジェクトへ find-or-create + append。UI は薄い DOM グルー。直近の `/api/sensor-imports/commit`(endpoint + 純ヘルパー + テスト)と同じパターン。

**Tech Stack:** 依存ゼロ。Node 標準 http サーバー(`server/`)、バニラ ES モジュール(`src/`)、`node --test` + `assert/strict`。

**Spec:** `docs/superpowers/specs/2026-09-09-mobile-minutes-input-design.md`

## Global Constraints

- 依存追加禁止(標準ライブラリ・既存モジュールのみ)。ES モジュール(`"type":"module"`)。
- 純ロジックは DOM/`fetch`/`fs` 非依存モジュールに置き、`node --test` で単体テスト可能にする。
- 保存・AI 呼び出しは unlock 必須(`isAuthorized`)。未認証は 401。
- Reflection は既存 `createReflection`(`src/reflections.js`)で生成。`id`/`createdAt` は呼び出し側で採番(テスト決定性)。wind/rig/practice は null(YAGNI)。
- 練習日は **JST 0 時 ms**。変換は `jstWallToMs(value + 'T00:00')`(`src/time.js`)。
- 既存 `src/app.js` デスクトップ議事録インポート、Flutter/iOS には一切触れない。
- プロジェクト骨組みは `deserializeProject`(`version:1` 必須)を通る形状。
- コミットは各タスク末尾で1回。既存コミット文体(`feat(server): …` / `feat(web): …`)に倣う。

---

### Task 1: `parseAiMinutes` と `buildMinutesSystemPrompt`(純)

AI(Gemini)応答 JSON を検証済み行に変換する純関数と、Gemini への system 指示文ビルダーを `src/minutes.js` に追加する。

**Files:**
- Modify: `src/minutes.js`(末尾に追加)
- Test: `test/minutes.test.js`(末尾に追加)

**Interfaces:**
- Consumes: `memberList()` from `src/members.js`(既存 import 済み)
- Produces:
  - `buildMinutesSystemPrompt(roster = memberList()) -> string`
  - `parseAiMinutes(jsonText, roster = memberList()) -> Array<{fullName: string|null, goal: string, issue: string, discovery: string, raw: string}>`

- [ ] **Step 1: Write the failing test**

`test/minutes.test.js` の末尾に追記(先頭 import 行も更新):

```js
// 先頭の import 行を差し替え(parseAiMinutes, buildMinutesSystemPrompt を追加)
// import { parseMinutes, matchMember, parseMinutesDate, parseAiMinutes, buildMinutesSystemPrompt } from '../src/minutes.js';

test('parseAiMinutes は名簿内 fullName の行を検証して返す', () => {
  const json = JSON.stringify([
    { fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' },
  ]);
  const rows = parseAiMinutes(json);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' });
});

test('parseAiMinutes は名簿外 fullName を null にする', () => {
  const rows = parseAiMinutes(JSON.stringify([{ fullName: '存在 しない', goal: 'g' }]));
  assert.equal(rows[0].fullName, null);
  assert.equal(rows[0].goal, 'g');
  assert.equal(rows[0].issue, '');
});

test('parseAiMinutes は壊れた JSON で [] を返す(throw しない)', () => {
  assert.deepEqual(parseAiMinutes('これは JSON ではない'), []);
  assert.deepEqual(parseAiMinutes('{"not":"array"}'), []);
});

test('parseAiMinutes は非オブジェクト要素をスキップし文字列強制する', () => {
  const rows = parseAiMinutes(JSON.stringify([null, 5, { fullName: '本間 由真', goal: 42 }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal, ''); // 数値は文字列でないため空
});

test('buildMinutesSystemPrompt は全部員の fullName を含む', () => {
  const s = buildMinutesSystemPrompt();
  for (const m of memberList()) assert.ok(s.includes(m.fullName), `${m.fullName} が無い`);
  assert.match(s, /JSON/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/minutes.test.js`
Expected: FAIL(`parseAiMinutes is not a function` 等)

- [ ] **Step 3: Write minimal implementation**

`src/minutes.js` の末尾に追加:

```js
// Gemini への system 指示。roster の fullName に限定し、部員別 JSON 配列で返させる。
export function buildMinutesSystemPrompt(roster = memberList()) {
  const names = roster.map((m) => m.fullName).join('、');
  return [
    'あなたはヨット部の振り返り会議の書記です。会話テキストを部員別の構造化議事録に整形します。',
    '出力は JSON 配列のみ。各要素は {"fullName","goal","issue","discovery","raw"} を持つオブジェクト。',
    `fullName は次の名簿のいずれかに正確一致する氏名のみ使う: ${names}。`,
    '名簿に無い人物や話者不明の内容は出力しない(その要素を作らない)。',
    'goal=その人の目標、issue=課題/反省、discovery=発見/気づき/今後。該当が無ければ空文字。',
    'raw=その部員に関する会話の該当部分の原文抜粋。',
    '説明文やコードフェンスは付けず、JSON 配列だけを返す。',
  ].join('\n');
}

// AI(Gemini)応答 JSON → 検証済み行配列。壊れた入力は握りつぶして [] を返す(呼び出し側でフォールバック導線)。
export function parseAiMinutes(jsonText, roster = memberList()) {
  let data;
  try { data = JSON.parse(String(jsonText)); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const names = new Set(roster.map((m) => m.fullName));
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = [];
  for (const it of data) {
    if (!it || typeof it !== 'object') continue;
    out.push({
      fullName: names.has(it.fullName) ? it.fullName : null,
      goal: str(it.goal), issue: str(it.issue), discovery: str(it.discovery), raw: str(it.raw),
    });
  }
  return out;
}
```

`test/minutes.test.js` 先頭 import を更新:

```js
import { parseMinutes, matchMember, parseMinutesDate, parseAiMinutes, buildMinutesSystemPrompt } from '../src/minutes.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/minutes.test.js`
Expected: PASS(全テスト)

- [ ] **Step 5: Commit**

```bash
git add src/minutes.js test/minutes.test.js
git commit -m "feat(minutes): AI応答JSON検証 parseAiMinutes と system プロンプト"
```

---

### Task 2: プレビュー行モデル `src/minutes-rows.js`(純)

モバイルプレビューの行(取込チェック + 部員割当)を組み立て/抽出する DOM 非依存の純モジュール。

**Files:**
- Create: `src/minutes-rows.js`
- Test: `test/minutes-rows.test.js`

**Interfaces:**
- Consumes: `matchMember` from `src/minutes.js`(Task 1 と同ファイル、既存関数)、`memberList` from `src/members.js`、`parseMinutes` の block 形状 `{headerName, fullNameHint, goal, issue, discovery, raw}`、`parseAiMinutes` の item 形状(Task 1)
- Produces(Row = `{fullName: string|null, include: boolean, goal, issue, discovery, raw}`):
  - `aiToRows(items, roster = memberList()) -> Row[]`
  - `blocksToRows(blocks, roster = memberList()) -> Row[]`
  - `toCommitRows(rows) -> Array<{fullName, goal, issue, discovery, raw}>`

- [ ] **Step 1: Write the failing test**

`test/minutes-rows.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiToRows, blocksToRows, toCommitRows } from '../src/minutes-rows.js';
import { parseMinutes } from '../src/minutes.js';

test('aiToRows は fullName 有りを取込オン、null を取込オフにする', () => {
  const rows = aiToRows([
    { fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' },
    { fullName: null, goal: 'g2', issue: '', discovery: '', raw: 'r2' },
  ]);
  assert.equal(rows[0].include, true);
  assert.equal(rows[0].fullName, '本間 由真');
  assert.equal(rows[1].include, false);
  assert.equal(rows[1].fullName, null);
});

test('blocksToRows は matchMember で名簿照合し fullName を埋める', () => {
  const blocks = parseMinutes('## ゆま（本間ゆま）\n- **目標**：g\n- **課題**：i');
  const rows = blocksToRows(blocks);
  assert.equal(rows[0].fullName, '本間 由真');
  assert.equal(rows[0].include, true);
  assert.equal(rows[0].goal, 'g');
});

test('blocksToRows は照合不能を null・取込オフにする', () => {
  const blocks = parseMinutes('## 謎の人物\n- **目標**：g');
  assert.equal(blocks.length, 1);
  assert.equal(blocksToRows(blocks)[0].fullName, null);
  assert.equal(blocksToRows(blocks)[0].include, false);
});

test('toCommitRows は取込オフと未割当を除外して整形する', () => {
  const rows = [
    { fullName: '本間 由真', include: true, goal: 'g', issue: 'i', discovery: 'd', raw: 'r' },
    { fullName: '高田 咲', include: false, goal: 'x', issue: '', discovery: '', raw: '' },
    { fullName: null, include: true, goal: 'y', issue: '', discovery: '', raw: '' },
  ];
  const out = toCommitRows(rows);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/minutes-rows.test.js`
Expected: FAIL(`Cannot find module '../src/minutes-rows.js'`)

- [ ] **Step 3: Write minimal implementation**

`src/minutes-rows.js`:

```js
// モバイル議事録プレビューの行モデル(DOM 非依存・純)。
// Row = { fullName: string|null, include: boolean, goal, issue, discovery, raw }
import { matchMember } from './minutes.js';
import { memberList } from './members.js';

// parseAiMinutes の出力 → プレビュー行。未割当(null)は既定で取込オフ。
export function aiToRows(items, roster = memberList()) {
  return items.map((it) => ({
    fullName: it.fullName ?? null,
    include: !!it.fullName,
    goal: it.goal || '', issue: it.issue || '', discovery: it.discovery || '', raw: it.raw || '',
  }));
}

// parseMinutes のブロック → プレビュー行(AIなしフォールバック)。matchMember で名簿照合。
export function blocksToRows(blocks, roster = memberList()) {
  return blocks.map((b) => {
    const { member } = matchMember(b.headerName, b.fullNameHint, roster);
    const fullName = member ? member.fullName : null;
    return {
      fullName, include: !!fullName,
      goal: b.goal || '', issue: b.issue || '', discovery: b.discovery || '', raw: b.raw || '',
    };
  });
}

// 取込対象(採用かつ部員割当済み)のみ commit ペイロード行へ。
export function toCommitRows(rows) {
  return rows
    .filter((r) => r.include && r.fullName)
    .map((r) => ({ fullName: r.fullName, goal: r.goal, issue: r.issue, discovery: r.discovery, raw: r.raw }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/minutes-rows.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/minutes-rows.js test/minutes-rows.test.js
git commit -m "feat(minutes): プレビュー行モデル(aiToRows/blocksToRows/toCommitRows)"
```

---

### Task 3: commit 純ヘルパー `server/minutesimport.js`

バリデーション・部員マージ・反省生成・空プロジェクト骨組みの純ロジック。HTTP 非依存。

**Files:**
- Create: `server/minutesimport.js`
- Test: `test/minutesimport.test.js`

**Interfaces:**
- Consumes: `memberList` from `src/members.js`、`createReflection` from `src/reflections.js`、`PROJECT_VERSION` from `src/project.js`、`deserializeProject` from `src/project.js`(テストで骨組み検証)
- Produces:
  - `validateCommitRows(rows, practiceDate, roster = memberList()) -> string|null`(問題文字列 or null)
  - `mergeRowsByMember(rows) -> rows`(初出順、同一 fullName を連結)
  - `reflectionsFromRows({ rows, now }) -> Reflection[]`(`id: refl${now}_${i}`, `createdAt: now`)
  - `emptyProject(practiceDate, savedAt = null) -> project`

- [ ] **Step 1: Write the failing test**

`test/minutesimport.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCommitRows, mergeRowsByMember, reflectionsFromRows, emptyProject,
} from '../server/minutesimport.js';
import { deserializeProject } from '../src/project.js';

test('validateCommitRows は正常な行で null を返す', () => {
  const rows = [{ fullName: '本間 由真', goal: 'g', issue: '', discovery: '', raw: '' }];
  assert.equal(validateCommitRows(rows, 1_700_000_000_000), null);
});

test('validateCommitRows は非数 practiceDate / 空 rows / 名簿外を検出する', () => {
  assert.match(validateCommitRows([{ fullName: '本間 由真' }], NaN), /practiceDate/);
  assert.match(validateCommitRows([], 1), /rows/);
  assert.match(validateCommitRows([{ fullName: '存在 しない' }], 1), /名簿外/);
});

test('mergeRowsByMember は同一 fullName を初出順で連結する', () => {
  const merged = mergeRowsByMember([
    { fullName: '本間 由真', goal: 'g1', issue: 'i1', discovery: '', raw: 'r1' },
    { fullName: '高田 咲', goal: 'x', issue: '', discovery: '', raw: '' },
    { fullName: '本間 由真', goal: 'g2', issue: '', discovery: 'd2', raw: 'r2' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].fullName, '本間 由真');
  assert.equal(merged[0].goal, 'g1\ng2');
  assert.equal(merged[0].issue, 'i1');
  assert.equal(merged[0].discovery, 'd2');
  assert.equal(merged[0].raw, 'r1\nr2');
  assert.equal(merged[1].fullName, '高田 咲');
});

test('reflectionsFromRows は決定的 id とフィールドマッピングを作る', () => {
  const refls = reflectionsFromRows({
    rows: [{ fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' }],
    now: 1720000000000,
  });
  assert.equal(refls[0].id, 'refl1720000000000_0');
  assert.equal(refls[0].createdAt, 1720000000000);
  assert.deepEqual(refls[0].people, ['本間 由真']);
  assert.equal(refls[0].text, 'r');
  assert.equal(refls[0].notes.goal, 'g');
  assert.equal(refls[0].notes.issue, 'i');
  assert.equal(refls[0].notes.discovery, 'd');
  assert.equal(refls[0].wind, null);
  assert.equal(refls[0].practice, null);
});

test('emptyProject は deserializeProject を通る骨組みを返す', () => {
  const p = emptyProject(1_700_000_000_000, '2026-09-09T00:00:00.000Z');
  assert.equal(p.version, 1);
  assert.equal(p.practiceDate, 1_700_000_000_000);
  assert.deepEqual(p.reflections, []);
  assert.doesNotThrow(() => deserializeProject(p));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/minutesimport.test.js`
Expected: FAIL(`Cannot find module '../server/minutesimport.js'`)

- [ ] **Step 3: Write minimal implementation**

`server/minutesimport.js`:

```js
// スマホ議事録 commit の純ロジック(HTTP 非依存)。node --test 可能。
import { memberList } from '../src/members.js';
import { createReflection } from '../src/reflections.js';
import { PROJECT_VERSION } from '../src/project.js';

// commit 行のバリデーション。問題があれば理由文字列、無ければ null。
export function validateCommitRows(rows, practiceDate, roster = memberList()) {
  if (!Number.isFinite(practiceDate)) return 'practiceDate が数値でない';
  if (!Array.isArray(rows) || rows.length === 0) return 'rows が空';
  const names = new Set(roster.map((m) => m.fullName));
  for (const r of rows) {
    if (!r || typeof r.fullName !== 'string' || !names.has(r.fullName)) {
      return `名簿外の fullName: ${r && r.fullName}`;
    }
  }
  return null;
}

// 同一 fullName の複数行を1行にマージ(初出順、goal/issue/discovery/raw を改行連結)。
export function mergeRowsByMember(rows) {
  const order = [];
  const byName = new Map();
  const join = (a, b) => (a && b ? `${a}\n${b}` : a || b || '');
  for (const r of rows) {
    if (!byName.has(r.fullName)) {
      byName.set(r.fullName, {
        fullName: r.fullName, goal: r.goal || '', issue: r.issue || '',
        discovery: r.discovery || '', raw: r.raw || '',
      });
      order.push(r.fullName);
      continue;
    }
    const cur = byName.get(r.fullName);
    cur.goal = join(cur.goal, r.goal || '');
    cur.issue = join(cur.issue, r.issue || '');
    cur.discovery = join(cur.discovery, r.discovery || '');
    cur.raw = join(cur.raw, r.raw || '');
  }
  return order.map((n) => byName.get(n));
}

// マージ済み行 → Reflection 配列。id/createdAt は now から決定的に採番(デスクトップと同じ timestamp+seq 方式)。
export function reflectionsFromRows({ rows, now }) {
  return rows.map((r, i) => createReflection({
    id: `refl${now}_${i}`,
    createdAt: now,
    text: r.raw,
    people: [r.fullName],
    notes: { goal: r.goal, issue: r.issue, discovery: r.discovery },
    wind: null,
    practice: null,
  }));
}

// deserializeProject を通る空プロジェクト骨組み。
export function emptyProject(practiceDate, savedAt = null) {
  return {
    version: PROJECT_VERSION,
    savedAt,
    mode: 'absolute',
    accuracyFilter: true,
    crop: { start: 0, end: 0 },
    tracks: [], events: [], marks: [], pins: [], videos: [],
    reflections: [],
    practiceDate,
    basemap: null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/minutesimport.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/minutesimport.js test/minutesimport.test.js
git commit -m "feat(server): 議事録 commit 純ヘルパー(merge/reflections/skeleton)"
```

---

### Task 4: `findProjectByPracticeDate`(storage)

practiceDate 一致プロジェクトを探すストレージ関数。既存 `findReflectionByDate` と同型。

**Files:**
- Modify: `server/storage.js`(末尾に追加)
- Test: `test/server-storage.test.js`(末尾に追加)

**Interfaces:**
- Consumes: `listProjects`, `readProject`(同ファイル既存)
- Produces: `findProjectByPracticeDate(dataDir, practiceDate) -> {name, label}|null`

- [ ] **Step 1: Write the failing test**

`test/server-storage.test.js` の末尾に追加(先頭 import に `findProjectByPracticeDate` を追加):

```js
// 先頭 import に findProjectByPracticeDate を追加すること。

test('findProjectByPracticeDate は practiceDate 一致を返し、無ければ null', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260909-0000.sailviz.json';
    await writeProject(dir, name, { version: 1, practiceDate: 1_700_000_000_000, reflections: [] });
    const hit = await findProjectByPracticeDate(dir, 1_700_000_000_000);
    assert.equal(hit.name, name);
    assert.equal(await findProjectByPracticeDate(dir, 999), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-storage.test.js`
Expected: FAIL(`findProjectByPracticeDate is not a function` / import エラー)

- [ ] **Step 3: Write minimal implementation**

`server/storage.js` の末尾に追加:

```js
// practiceDate(JST 0 時 ms)が一致する最初のプロジェクト {name,label} を返す。無ければ null。
export async function findProjectByPracticeDate(dataDir, practiceDate) {
  const list = await listProjects(dataDir);
  for (const { name, label } of list) {
    let proj;
    try { proj = await readProject(dataDir, name); } catch { continue; }
    if (Number(proj.practiceDate) === Number(practiceDate)) return { name, label };
  }
  return null;
}
```

`test/server-storage.test.js` 先頭 import に追加:

```js
import {
  isValidProjectName, listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay, findProjectByPracticeDate,
} from '../server/storage.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-storage.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/storage.js test/server-storage.test.js
git commit -m "feat(server): findProjectByPracticeDate(練習日一致プロジェクト検索)"
```

---

### Task 5: `POST /api/minutes-imports/commit` ルート

find-or-create + append を行う endpoint を配線する。

**Files:**
- Modify: `server/api.js`(import 追加 + ルート追加)
- Test: `test/server-minutesimport.test.js`(新規)

**Interfaces:**
- Consumes: `validateCommitRows`, `mergeRowsByMember`, `reflectionsFromRows`, `emptyProject`(Task 3)、`findProjectByPracticeDate`(Task 4)、`listProjects`, `readProject`, `writeProject`(既存 storage)、`uniqueProjectName` from `src/projectfs.js`、`isAuthorized`(既存)
- Produces: HTTP `POST /api/minutes-imports/commit` → `200 {name, added, created}` / `400` / `401`

- [ ] **Step 1: Write the failing test**

`test/server-minutesimport.test.js`:

```js
// test/server-minutesimport.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../server/api.js';

let server, base, dataDir;
const TOKEN = 's3cret';
const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
// JST 2026-09-09 00:00 = UTC 2026-09-08 15:00
const PD_NEW = Date.UTC(2026, 8, 8, 15, 0, 0);
// JST 2026-09-10 00:00(append テスト用に別日)
const PD_APPEND = Date.UTC(2026, 8, 9, 15, 0, 0);

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sv-mi-'));
  const api = createApi({ dataDir, token: TOKEN });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await rm(dataDir, { recursive: true, force: true }); });

const commit = (body, headers = bearer) => fetch(`${base}/api/minutes-imports/commit`, {
  method: 'POST', headers, body: JSON.stringify(body),
});

test('commit: 未認証は 401', async () => {
  const r = await commit({ practiceDate: PD_NEW, rows: [{ fullName: '本間 由真' }] }, { 'content-type': 'application/json' });
  assert.equal(r.status, 401);
});

test('commit: 名簿外 fullName は 400', async () => {
  const r = await commit({ practiceDate: PD_NEW, rows: [{ fullName: '存在 しない', goal: 'g' }] });
  assert.equal(r.status, 400);
});

test('commit: 新規プロジェクトを作成して反省を保存', async () => {
  const r = await commit({
    practiceDate: PD_NEW,
    rows: [{ fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' }],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.created, true);
  assert.equal(j.added, 1);
  assert.match(j.name, /^sailviz-20260909-0000\.sailviz\.json$/);
  const proj = await (await fetch(`${base}/api/projects/${j.name}`)).json();
  assert.equal(proj.reflections.length, 1);
  assert.deepEqual(proj.reflections[0].people, ['本間 由真']);
  assert.equal(proj.reflections[0].notes.goal, 'g');
  assert.equal(proj.practiceDate, PD_NEW);
});

test('commit: 既存(practiceDate 一致)へ append し同一部員はマージ', async () => {
  const name = 'sailviz-20260910-0000.sailviz.json';
  await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: bearer,
    body: JSON.stringify({ version: 1, practiceDate: PD_APPEND, reflections: [] }),
  });
  const r = await commit({
    practiceDate: PD_APPEND,
    rows: [
      { fullName: '高田 咲', goal: 'a', issue: '', discovery: '', raw: 'r1' },
      { fullName: '高田 咲', goal: 'b', issue: '', discovery: '', raw: 'r2' },
    ],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.created, false);
  assert.equal(j.name, name);
  assert.equal(j.added, 1); // 同一部員2行 → 1反省
  const proj = await (await fetch(`${base}/api/projects/${name}`)).json();
  assert.equal(proj.reflections.length, 1);
  assert.equal(proj.reflections[0].notes.goal, 'a\nb');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-minutesimport.test.js`
Expected: FAIL(commit が 404/no route → ステータス不一致)

- [ ] **Step 3: Write minimal implementation**

`server/api.js` の import ブロックを更新:

```js
// 既存: import { listProjects, readProject, writeProject, ... } from './storage.js';
// findProjectByPracticeDate を storage import に追加する。
```

具体的には `./storage.js` からの import に `findProjectByPracticeDate` を、新規 import を2行追加:

```js
import { uniqueProjectName } from '../src/projectfs.js';
import {
  validateCommitRows, mergeRowsByMember, reflectionsFromRows, emptyProject,
} from './minutesimport.js';
```

ルートは `/api/sensor-imports` ブロックの直後に追加:

```js
if (path === '/api/minutes-imports/commit' && method === 'POST') {
  if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
  const body = await readBody(req) || {};
  const practiceDate = Number(body.practiceDate);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const bad = validateCommitRows(rows, practiceDate);
  if (bad) { send(res, 400, { error: bad }); return true; }

  const reflections = reflectionsFromRows({ rows: mergeRowsByMember(rows), now: Date.now() });
  const found = await findProjectByPracticeDate(dataDir, practiceDate);
  let name, created = false, proj;
  if (found) {
    name = found.name;
    proj = await readProject(dataDir, name);
    if (!Array.isArray(proj.reflections)) proj.reflections = [];
  } else {
    const existing = (await listProjects(dataDir)).map((p) => p.name);
    name = uniqueProjectName(practiceDate, existing);
    proj = emptyProject(practiceDate, new Date().toISOString());
    created = true;
  }
  proj.reflections.push(...reflections);
  if (typeof proj.practiceDate !== 'number') proj.practiceDate = practiceDate;
  await writeProject(dataDir, name, proj);
  send(res, 200, { name, added: reflections.length, created });
  return true;
}
```

`./storage.js` の import 行に `findProjectByPracticeDate` を追加(既存 import 文へ):

```js
import {
  listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay, OVERLAY_NAMES, isValidProjectName,
  saveUpload, findReflectionByDate, readUpload, renameUpload, isValidImportId, isValidUploadFile,
  findProjectByPracticeDate,
} from './storage.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-minutesimport.test.js`
Expected: PASS(4 テスト)

- [ ] **Step 5: Commit**

```bash
git add server/api.js test/server-minutesimport.test.js
git commit -m "feat(server): POST /api/minutes-imports/commit で反省を保存"
```

---

### Task 6: `apiCommitMinutes`(クライアント fetch ラッパ)

commit endpoint を叩く薄い fetch ラッパを追加。

**Files:**
- Modify: `src/api.js`(末尾に追加)
- Test: `test/api-client.test.js`(末尾に追加)

**Interfaces:**
- Consumes: 内部 `send`(既存)
- Produces: `apiCommitMinutes({ practiceDate, rows }) -> Promise<{name, added, created}>`(非 2xx で throw)

- [ ] **Step 1: Write the failing test**

`test/api-client.test.js` の末尾に追加(先頭 import に `apiCommitMinutes` を追加):

```js
// 先頭 import を: import { apiGetProject, apiPutProject, apiUnlock, apiCommitMinutes } from '../src/api.js';

test('apiCommitMinutes returns parsed json on 200', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ name: 'x.sailviz.json', added: 2, created: true }) });
  const r = await apiCommitMinutes({ practiceDate: 1, rows: [] });
  assert.equal(r.added, 2);
  assert.equal(r.name, 'x.sailviz.json');
});

test('apiCommitMinutes throws on non-2xx', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: '名簿外' }) });
  await assert.rejects(() => apiCommitMinutes({ practiceDate: 1, rows: [] }), /名簿外/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-client.test.js`
Expected: FAIL(`apiCommitMinutes is not a function`)

- [ ] **Step 3: Write minimal implementation**

`src/api.js` の末尾に追加:

```js
export async function apiCommitMinutes({ practiceDate, rows }) {
  const res = await send('/api/minutes-imports/commit', 'POST', { practiceDate, rows });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `取込に失敗 (${res.status})`);
  }
  return res.json();
}
```

`test/api-client.test.js` 先頭 import 更新:

```js
import { apiGetProject, apiPutProject, apiUnlock, apiCommitMinutes } from '../src/api.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api-client.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/api-client.test.js
git commit -m "feat(web): apiCommitMinutes(議事録 commit fetch ラッパ)"
```

---

### Task 7: `minutes.html` + `src/minutes-input.js`(DOM グルー) + スタイル

モバイルページ本体と画面ロジックを追加する。純ロジックは Task 1/2/6 で検証済み。ここは配線 + `minutes.html` の id 健全性テストで守る。

**Files:**
- Create: `minutes.html`
- Create: `src/minutes-input.js`
- Modify: `styles.css`(末尾にモバイル向けクラスを追記)
- Test: `test/minutes-html.test.js`(新規, `test/html-ids.test.js` に倣う)

**Interfaces:**
- Consumes: `apiAuthStatus`, `apiUnlock`, `apiCommitMinutes`(`src/api.js`)、`geminiGenerate`(`src/gemini.js`)、`buildMinutesSystemPrompt`, `parseAiMinutes`, `parseMinutes`, `parseMinutesDate`(`src/minutes.js`)、`aiToRows`, `blocksToRows`, `toCommitRows`(`src/minutes-rows.js`)、`memberList`(`src/members.js`)、`jstWallToMs`, `msToJstWall`(`src/time.js`)
- Produces: `/minutes.html`(静的配信)。DOM id: `mn-lock`, `mn-password`, `mn-unlock-btn`, `mn-lock-msg`, `mn-app`, `mn-text`, `mn-ai-btn`, `mn-manual-btn`, `mn-status`, `mn-preview`, `mn-date`, `mn-commit-btn`, `mn-toast`

- [ ] **Step 1: Write the failing test**

`test/minutes-html.test.js`:

```js
// minutes.html の id 健全性ガード(重複なし + 必須 id 存在)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = () => readFileSync(join(__dir, '..', 'minutes.html'), 'utf8');

test('minutes.html に重複 id が無い', () => {
  const ids = [...html().matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set(); const dupes = new Set();
  for (const id of ids) { if (seen.has(id)) dupes.add(id); seen.add(id); }
  assert.deepEqual([...dupes], [], `重複 id: ${[...dupes].join(', ')}`);
});

test('minutes.html に画面ロジックが参照する必須 id が揃う', () => {
  const h = html();
  for (const id of ['mn-lock', 'mn-password', 'mn-unlock-btn', 'mn-app', 'mn-text',
    'mn-ai-btn', 'mn-manual-btn', 'mn-status', 'mn-preview', 'mn-date', 'mn-commit-btn', 'mn-toast']) {
    assert.ok(new RegExp(`id="${id}"`).test(h), `${id} が無い`);
  }
});

test('minutes.html は src/minutes-input.js を module で読み込む', () => {
  assert.match(html(), /<script[^>]+type="module"[^>]+src="src\/minutes-input\.js"/);
  assert.match(html(), /viewport/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/minutes-html.test.js`
Expected: FAIL(`ENOENT: minutes.html`)

- [ ] **Step 3: Write minimal implementation**

`minutes.html`(リポジトリ直下):

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>振り返り議事録 入力 — SailViz</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body class="mn-body">
  <main class="mn-wrap">
    <h1 class="mn-title">振り返り議事録 入力</h1>

    <section id="mn-lock" class="mn-card hidden">
      <p>編集モードのパスワードを入力してください。</p>
      <input id="mn-password" type="password" inputmode="text" autocomplete="current-password" placeholder="パスワード">
      <button id="mn-unlock-btn" type="button">ログイン</button>
      <p id="mn-lock-msg" class="mn-msg"></p>
    </section>

    <section id="mn-app" class="hidden">
      <label class="mn-label" for="mn-text">会議テキスト(音声入力 or 貼り付け)</label>
      <textarea id="mn-text" class="mn-text" rows="10" placeholder="キーボードのマイクで話すか、貼り付けてください"></textarea>

      <div class="mn-btnrow">
        <button id="mn-ai-btn" type="button" class="mn-primary">AI整形</button>
        <button id="mn-manual-btn" type="button">AIなしで整形</button>
      </div>
      <p id="mn-status" class="mn-msg" aria-live="polite"></p>

      <div id="mn-preview" class="mn-preview"></div>

      <label class="mn-label" for="mn-date">練習日</label>
      <input id="mn-date" type="date">

      <button id="mn-commit-btn" type="button" class="mn-primary mn-commit">取込(保存)</button>
    </section>
  </main>
  <div id="mn-toast" class="mn-toast hidden"></div>
  <script type="module" src="src/minutes-input.js"></script>
</body>
</html>
```

`src/minutes-input.js`:

```js
// スマホ議事録入力ページの画面ロジック(DOM グルー)。純ロジックは import 先で検証済み。
import { apiAuthStatus, apiUnlock, apiCommitMinutes } from './api.js';
import { geminiGenerate } from './gemini.js';
import { buildMinutesSystemPrompt, parseAiMinutes, parseMinutes, parseMinutesDate } from './minutes.js';
import { aiToRows, blocksToRows, toCommitRows } from './minutes-rows.js';
import { memberList } from './members.js';
import { jstWallToMs, msToJstWall } from './time.js';

const $ = (id) => document.getElementById(id);
const roster = memberList();
let rows = []; // Row[]（minutes-rows の形状）

function setStatus(msg) { $('mn-status').textContent = msg || ''; }
function toast(msg) {
  const t = $('mn-toast');
  t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
}

// 練習日 <input type=date> の値(YYYY-MM-DD) → JST 0 時 ms。
function selectedPracticeDate() {
  const v = $('mn-date').value;
  return v ? jstWallToMs(`${v}T00:00`) : NaN;
}
function todayJstDate() { return msToJstWall(Date.now()).slice(0, 10); }

// 本文から練習日を拾って date 欄をプリフィル(取れなければ今日 JST)。
function prefillDate(text) {
  const defaultYear = Number(todayJstDate().slice(0, 4));
  const d = parseMinutesDate(text, { defaultYear });
  if (d) {
    $('mn-date').value = `${d.y}-${String(d.mo).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  } else if (!$('mn-date').value) {
    $('mn-date').value = todayJstDate();
  }
}

function renderPreview() {
  const box = $('mn-preview');
  box.textContent = '';
  if (!rows.length) { box.textContent = '整形結果はここに表示されます。'; return; }
  rows.forEach((row, i) => {
    const card = document.createElement('div');
    card.className = 'mn-row' + (row.fullName ? '' : ' mn-unmatched');

    const head = document.createElement('div');
    head.className = 'mn-row-head';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = row.include;
    chk.addEventListener('change', () => { rows[i].include = chk.checked; });
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(未割当)';
    sel.appendChild(none);
    for (const m of roster) {
      const o = document.createElement('option');
      o.value = m.fullName; o.textContent = m.fullName;
      if (m.fullName === row.fullName) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      rows[i].fullName = sel.value || null;
      if (rows[i].fullName) rows[i].include = true;
      card.classList.toggle('mn-unmatched', !rows[i].fullName);
    });
    head.append(chk, sel);

    const body = document.createElement('div');
    body.className = 'mn-row-body';
    const line = (label, val) => {
      if (!val) return;
      const p = document.createElement('p');
      p.innerHTML = `<b>${label}</b>：`;
      p.appendChild(document.createTextNode(val));
      body.appendChild(p);
    };
    line('目標', row.goal); line('課題', row.issue); line('発見', row.discovery);

    card.append(head, body);
    box.appendChild(card);
  });
}

async function doAi() {
  const text = $('mn-text').value.trim();
  if (!text) { setStatus('テキストを入力してください。'); return; }
  setStatus('AI整形中…');
  try {
    const json = await geminiGenerate({
      system: buildMinutesSystemPrompt(roster),
      parts: [{ text }],
      responseMimeType: 'application/json',
    });
    rows = aiToRows(parseAiMinutes(json, roster), roster);
    if (!rows.length) { setStatus('AIが部員を抽出できませんでした。「AIなしで整形」を試してください。'); }
    else setStatus(`${rows.length}件を整形しました。`);
    prefillDate(text);
    renderPreview();
  } catch (e) {
    setStatus(`AI整形に失敗: ${e.message}。「AIなしで整形」を試してください。`);
  }
}

function doManual() {
  const text = $('mn-text').value.trim();
  if (!text) { setStatus('テキストを入力してください。'); return; }
  rows = blocksToRows(parseMinutes(text), roster);
  setStatus(rows.length ? `${rows.length}件を整形しました(AIなし)。` : '部員ブロックを検出できませんでした。');
  prefillDate(text);
  renderPreview();
}

async function doCommit() {
  const practiceDate = selectedPracticeDate();
  if (!Number.isFinite(practiceDate)) { setStatus('練習日を選択してください。'); return; }
  const payload = toCommitRows(rows);
  if (!payload.length) { setStatus('取込対象(採用かつ部員割当済み)がありません。'); return; }
  setStatus('保存中…');
  try {
    const res = await apiCommitMinutes({ practiceDate, rows: payload });
    toast(`${res.added}件を保存しました`);
    setStatus(`保存しました: ${res.name}`);
    rows = []; renderPreview();
    $('mn-text').value = '';
  } catch (e) {
    setStatus(`保存に失敗: ${e.message}`);
  }
}

async function refreshLock() {
  const unlocked = await apiAuthStatus().catch(() => false);
  $('mn-lock').classList.toggle('hidden', unlocked);
  $('mn-app').classList.toggle('hidden', !unlocked);
}

async function doUnlock() {
  const ok = await apiUnlock($('mn-password').value).catch(() => false);
  $('mn-lock-msg').textContent = ok ? '' : 'パスワードが違います。';
  if (ok) { $('mn-password').value = ''; await refreshLock(); }
}

function init() {
  $('mn-unlock-btn').addEventListener('click', doUnlock);
  $('mn-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('mn-ai-btn').addEventListener('click', doAi);
  $('mn-manual-btn').addEventListener('click', doManual);
  $('mn-commit-btn').addEventListener('click', doCommit);
  $('mn-date').value = todayJstDate();
  renderPreview();
  refreshLock();
}

init();
```

`styles.css` の末尾に追記:

```css
/* --- スマホ議事録入力ページ (minutes.html) --- */
.mn-body { margin: 0; background: #f5f6f8; color: #1a1a1a;
  font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif; }
.mn-wrap { max-width: 640px; margin: 0 auto; padding: 16px 14px 40px; }
.mn-title { font-size: 1.25rem; margin: 8px 0 16px; }
.mn-card { background: #fff; border-radius: 10px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.mn-label { display: block; font-weight: 600; margin: 14px 0 6px; }
.mn-text { width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px;
  border: 1px solid #c9ccd1; border-radius: 8px; resize: vertical; }
.mn-btnrow { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mn-btnrow button, .mn-commit, #mn-unlock-btn { font-size: 16px; padding: 12px 16px;
  border-radius: 8px; border: 1px solid #c9ccd1; background: #fff; cursor: pointer; }
.mn-primary { background: #1e66d0; color: #fff; border-color: #1e66d0; }
.mn-commit { width: 100%; margin-top: 16px; }
#mn-password { width: 100%; box-sizing: border-box; font-size: 16px; padding: 12px;
  border: 1px solid #c9ccd1; border-radius: 8px; margin-bottom: 10px; }
.mn-msg { color: #555; min-height: 1.2em; margin: 8px 0; font-size: .9rem; }
.mn-preview { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.mn-row { background: #fff; border: 1px solid #e0e2e6; border-radius: 8px; padding: 10px; }
.mn-row.mn-unmatched { border-color: #e0a800; background: #fffdf3; }
.mn-row-head { display: flex; align-items: center; gap: 10px; }
.mn-row-head input[type=checkbox] { width: 22px; height: 22px; }
.mn-row-head select { flex: 1; font-size: 16px; padding: 8px; border-radius: 6px; border: 1px solid #c9ccd1; }
.mn-row-body { margin-top: 8px; font-size: .92rem; }
.mn-row-body p { margin: 4px 0; }
#mn-date { font-size: 16px; padding: 10px; border: 1px solid #c9ccd1; border-radius: 8px; }
.mn-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: #222; color: #fff; padding: 10px 18px; border-radius: 20px; font-size: .95rem; }
.hidden { display: none !important; }
```

> 注: `.hidden` が `styles.css` に既存の場合はこの重複ブロックを外す(既存定義を使う)。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/minutes-html.test.js`
Expected: PASS(3 テスト)

- [ ] **Step 5: 手動ブラウザ確認(任意だが推奨)**

`SAILVIZ_WRITE_TOKEN=xxx GEMINI_API_KEY=yyy node server/index.js` で起動し、スマホ幅で
`http://localhost:8000/minutes.html` を開く。unlock → テキスト貼付 → AI整形/AIなし整形 →
プレビュー編集 → 練習日 → 取込 → プロジェクトが `data/projects/` に作られることを確認。

- [ ] **Step 6: Commit**

```bash
git add minutes.html src/minutes-input.js styles.css test/minutes-html.test.js
git commit -m "feat(web): モバイル議事録入力ページ minutes.html と画面ロジック"
```

---

### Task 8: 全テスト実行と最終確認

**Files:** なし(検証のみ)

- [ ] **Step 1: 全テストを走らせる**

Run: `node --test`
Expected: 全 PASS(既存テストの回帰なし + 新規 5 ファイル pass)

- [ ] **Step 2: 差分の目視確認**

Run: `git log --oneline -8` と `git status`
Expected: Task 1–7 の 7 コミット、作業ツリークリーン。既存 `src/app.js`/Flutter 無変更。

---

## Self-Review

**1. Spec coverage:**
- §4 フロー(unlock/textarea/AI整形/AIなし整形/プレビュー編集/練習日/取込) → Task 7(UI) + Task 1/2/6(純ロジック)。✅
- §5 endpoint 契約(find-or-create/append/merge/400/401) → Task 3–5。✅
- §6 モジュール別追加(`parseAiMinutes`/`buildMinutesSystemPrompt`/`apiCommitMinutes`/`findProjectByPracticeDate`/`minutes-input.js`/`server/minutesimport.js`) → Task 1/6/4/7/3。✅
- §7 テスト計画(minutes.test/minutesimport.test/endpoint test/AI parse) → Task 1/3/5。✅
- YAGNI(wind/rig/practice null) → Task 3 `reflectionsFromRows`。✅

**2. Placeholder scan:** TBD/TODO/「適切に処理」なし。各コード step は実コードを含む。✅

**3. Type consistency:**
- Row 形状 `{fullName, include, goal, issue, discovery, raw}` は Task 2 定義、Task 7 で消費、一致。✅
- commit 行 `{fullName, goal, issue, discovery, raw}`(include 無し)は Task 2 `toCommitRows` 出力 = Task 3 `validateCommitRows`/`mergeRowsByMember` 入力 = Task 5 body.rows、一致。✅
- `reflectionsFromRows({rows, now})`(practiceDate 引数なし、id は `refl${now}_${i}`)は Task 3 定義・テスト・Task 5 呼び出しで一致。✅ (spec §5 の `refl${practiceDate}_${i}` から、重複回避のため timestamp 方式へ精緻化。)
- `apiCommitMinutes({practiceDate, rows}) -> {name, added, created}` は Task 6 定義、Task 7 消費、Task 5 レスポンスと一致。✅
- `findProjectByPracticeDate(dataDir, practiceDate) -> {name,label}|null` は Task 4 定義、Task 5 消費、一致。✅
