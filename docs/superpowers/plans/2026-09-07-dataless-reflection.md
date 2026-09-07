# データなしでも反省を書ける Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPS/動画が無くても反省を作成・保存でき、後日その練習にGPS/動画を紐付けられるようにする。

**Architecture:** ページ日時 `state.practiceDate`（絶対ms/null）を反省追加・議事録取込の各ダイアログ内で取得し、最初に入った値を採用。保存は `state.currentFileName` を覚えて同一ファイルへ上書きし、初回のみ練習日時からファイル名を採番（衝突は分単位でずらして一意化）。これにより後付けGPS紐付けでもファイルが増えない。

**Tech Stack:** バニラJS（ES modules）、`node --test`、File System Access API、Intl（Asia/Tokyo 固定）。ビルド無し。

**Spec:** `docs/superpowers/specs/2026-09-07-dataless-reflection-design.md`

## Global Constraints

- 純ロジックは DOM/ブラウザAPI非依存に保ち `node --test` で単体テストする。`app.js`/`index.html` は自動テスト対象外（手動Chrome確認）。
- 時刻表示・整形は **Asia/Tokyo 固定**（既存コードと同じ）。JST は UTC+9・DST無し。
- 純関数に `Date.now()`/引数無し `new Date()` を持ち込まない（決定性のため引数注入）。ブラウザ配線（app.js）では現在時刻取得可。
- `PROJECT_VERSION` は **1 のまま**。旧保存ファイル（`practiceDate` 欠落）は null で読めること。
- 既存346テストを緑のまま維持（回帰禁止）。テストは `npm test`（= `node --test`）。
- コミットのフッタは既存慣習に合わせる（Co-Authored-By 行）。

---

### Task 1: JST壁時計 ⇄ epoch ms 変換（純関数）

**Files:**
- Modify: `src/time.js`（末尾に追加）
- Test: `test/time.test.js`（末尾に追加）

**Interfaces:**
- Produces:
  - `jstWallToMs(wall: string) -> number` : `'YYYY-MM-DDTHH:mm'`（datetime-local 値、JST壁時計）を絶対msに。不正入力は `NaN`。
  - `msToJstWall(ms: number) -> string` : 絶対ms を `'YYYY-MM-DDTHH:mm'`（JST）へ。非有限は `''`。

- [ ] **Step 1: Write the failing tests**

`test/time.test.js` の末尾に追記:

```js
import { jstWallToMs, msToJstWall } from '../src/time.js';

test('jstWallToMs: JST壁時計を絶対msに(UTC+9)', () => {
  // 2026-09-07 13:30 JST == 2026-09-07 04:30 UTC
  assert.equal(jstWallToMs('2026-09-07T13:30'), Date.UTC(2026, 8, 7, 4, 30));
});

test('jstWallToMs: 不正入力は NaN', () => {
  assert.ok(Number.isNaN(jstWallToMs('')));
  assert.ok(Number.isNaN(jstWallToMs('nope')));
  assert.ok(Number.isNaN(jstWallToMs(null)));
});

test('msToJstWall: 絶対msをJST壁時計文字列に', () => {
  assert.equal(msToJstWall(Date.UTC(2026, 8, 7, 4, 30)), '2026-09-07T13:30');
});

test('jstWallToMs/msToJstWall: 往復', () => {
  const ms = jstWallToMs('2026-01-05T00:00');
  assert.equal(msToJstWall(ms), '2026-01-05T00:00');
});

test('msToJstWall: 非有限は空文字', () => {
  assert.equal(msToJstWall(NaN), '');
  assert.equal(msToJstWall(Infinity), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/time.test.js`
Expected: FAIL（`jstWallToMs`/`msToJstWall` が未定義）

- [ ] **Step 3: Implement in `src/time.js`**

`src/time.js` の末尾に追記:

```js
// JST(UTC+9, DST無し)の壁時計 'YYYY-MM-DDTHH:mm'(datetime-local 値) ⇄ 絶対ms。
// datetime-local はマシンローカルTZだが、アプリは Asia/Tokyo 固定表示のため
// 入力値を常に JST 壁時計として解釈する(マシンTZ非依存)。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstWallToMs(wall) {
  if (typeof wall !== 'string') return NaN;
  const m = wall.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS;
}

export function msToJstWall(ms) {
  if (!Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/time.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/time.js test/time.test.js
git commit -m "feat: JST壁時計⇄epoch ms 変換ユーティリティ

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 議事録からの日時抽出（純関数）

**Files:**
- Modify: `src/minutes.js`（末尾に追加）
- Test: `test/minutes.test.js`（末尾に追加）

**Interfaces:**
- Produces:
  - `parseMinutesDate(text: string, opts?: { defaultYear?: number }) -> { y, mo, d, h, mi } | null`
  - 年ありは本文の年を、年なしは `defaultYear` を採用。時刻が無ければ `h=0, mi=0`。日付が無い/年なしで `defaultYear` 未指定なら `null`。

- [ ] **Step 1: Write the failing tests**

`test/minutes.test.js` の末尾に追記（先頭の import に `parseMinutesDate` を追加）:

```js
import { parseMinutesDate } from '../src/minutes.js';

test('parseMinutesDate: 年ありスラッシュ + 時刻', () => {
  assert.deepEqual(parseMinutesDate('練習 2026/9/7 13:30 の記録'),
    { y: 2026, mo: 9, d: 7, h: 13, mi: 30 });
});

test('parseMinutesDate: ISO ハイフン(時刻なしは0:0)', () => {
  assert.deepEqual(parseMinutesDate('日付：2026-09-07'),
    { y: 2026, mo: 9, d: 7, h: 0, mi: 0 });
});

test('parseMinutesDate: 和暦表記 2026年9月7日 13時30分', () => {
  assert.deepEqual(parseMinutesDate('2026年9月7日 13時30分〜'),
    { y: 2026, mo: 9, d: 7, h: 13, mi: 30 });
});

test('parseMinutesDate: 年なしは defaultYear を補う', () => {
  assert.deepEqual(parseMinutesDate('9月7日の練習', { defaultYear: 2026 }),
    { y: 2026, mo: 9, d: 7, h: 0, mi: 0 });
});

test('parseMinutesDate: 年なしで defaultYear 無しは null', () => {
  assert.equal(parseMinutesDate('9月7日の練習'), null);
});

test('parseMinutesDate: 日付が無ければ null', () => {
  assert.equal(parseMinutesDate('今日は良い風でした', { defaultYear: 2026 }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/minutes.test.js`
Expected: FAIL（`parseMinutesDate` 未定義）

- [ ] **Step 3: Implement in `src/minutes.js`**

`src/minutes.js` の末尾に追記:

```js
// 議事録本文から練習日時を抽出する決定的パーサ。
// 年が無い形式(9月7日 等)は defaultYear(投稿年=現在のJST年)で補う。
// 返り値 { y, mo, d, h, mi } または null。純関数(現在時刻に依存しない)。
export function parseMinutesDate(text, { defaultYear } = {}) {
  const s = String(text);
  const validMd = (mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  let y = null, mo = null, d = null;
  // 年あり: 2026/9/7, 2026-09-07, 2026.9.7, 2026年9月7日
  let m = s.match(/(\d{4})\s*[/年.\-]\s*(\d{1,2})\s*[/月.\-]\s*(\d{1,2})\s*日?/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    // 年なし: 9月7日 / 9/7 → defaultYear を補う
    m = s.match(/(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?/);
    if (m && defaultYear != null) { y = defaultYear; mo = +m[1]; d = +m[2]; }
  }
  if (y == null || !validMd(mo, d)) return null;
  // 時刻(任意): 13:30 / 13時30分。無ければ 0:0。範囲外は 0:0 に丸める。
  let h = 0, mi = 0;
  const t = s.match(/(\d{1,2})\s*[:時]\s*(\d{1,2})\s*分?/);
  if (t) { h = +t[1]; mi = +t[2]; }
  if (h > 23 || mi > 59) { h = 0; mi = 0; }
  return { y, mo, d, h, mi };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/minutes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/minutes.js test/minutes.test.js
git commit -m "feat: 議事録本文から練習日時を抽出(年なしは投稿年補完)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: ファイル名の衝突回避（純関数）

**Files:**
- Modify: `src/projectfs.js`（`projectFileName` の直後に追加）
- Test: `test/projectfs.test.js`（末尾に追加、import に追記）

**Interfaces:**
- Consumes: `projectFileName(date: Date) -> string`（既存）
- Produces: `uniqueProjectName(baseMs: number, existing?: string[] | Set<string>) -> string`
  - `projectFileName(new Date(baseMs))` を起点に、`existing` に含まれる間 +1分して再生成。最大1440回で打ち切り最後の候補を返す。

- [ ] **Step 1: Write the failing tests**

`test/projectfs.test.js` の import に `uniqueProjectName` を追加し、末尾に追記:

```js
test('uniqueProjectName: 衝突なしはそのまま', () => {
  const base = Date.UTC(2026, 8, 7, 4, 30); // 13:30 JST
  const name = uniqueProjectName(base, []);
  assert.equal(name, 'sailviz-20260907-1330.sailviz.json');
});

test('uniqueProjectName: 衝突したら分をずらす', () => {
  const base = Date.UTC(2026, 8, 7, 4, 30);
  const taken = ['sailviz-20260907-1330.sailviz.json'];
  assert.equal(uniqueProjectName(base, taken), 'sailviz-20260907-1331.sailviz.json');
});

test('uniqueProjectName: 連続衝突は空くまでずらす(Set可)', () => {
  const base = Date.UTC(2026, 8, 7, 4, 30);
  const taken = new Set([
    'sailviz-20260907-1330.sailviz.json',
    'sailviz-20260907-1331.sailviz.json',
  ]);
  assert.equal(uniqueProjectName(base, taken), 'sailviz-20260907-1332.sailviz.json');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/projectfs.test.js`
Expected: FAIL（`uniqueProjectName` 未定義）

- [ ] **Step 3: Implement in `src/projectfs.js`**

`projectFileName` 関数の直後に追加:

```js
// baseMs から projectFileName を生成し、existing に衝突する間 +1分して一意名を返す。
// existing はファイル名の配列 or Set。現実には衝突しないための保険(最大1440分=1日)。
export function uniqueProjectName(baseMs, existing = []) {
  const has = existing instanceof Set ? (n) => existing.has(n) : (n) => existing.includes(n);
  let ms = baseMs;
  let name = projectFileName(new Date(ms));
  for (let i = 0; i < 1440 && has(name); i++) {
    ms += 60 * 1000;
    name = projectFileName(new Date(ms));
  }
  return name;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/projectfs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/projectfs.js test/projectfs.test.js
git commit -m "feat: 保存ファイル名の衝突を分単位でずらして一意化

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: スキーマに practiceDate を追加

**Files:**
- Modify: `src/project.js`（`serializeProject`/`deserializeProject`）
- Test: `test/project.test.js`

**Interfaces:**
- Consumes: `state.practiceDate: number | null`（直列化対象）
- Produces: 保存JSONに `practiceDate: number | null`。`deserializeProject(obj).practiceDate` を返す。

- [ ] **Step 1: Write the failing tests**

`test/project.test.js` の `sampleState()` に `practiceDate` を追加:

```js
    reflections: [{ id: 'r1', createdAt: 1, text: 'メモ', people: [], videos: [], wind: null, practice: null }],
    practiceDate: 1757217000000,
```

末尾に追記:

```js
test('practiceDate が往復で保たれる', () => {
  const out = deserializeProject(serializeProject(sampleState(), { savedAt: 's' }));
  assert.equal(out.practiceDate, 1757217000000);
});

test('practiceDate 欠落(旧ファイル)は null', () => {
  const out = deserializeProject({ version: 1 });
  assert.equal(out.practiceDate, null);
});

test('practiceDate が数値でなければ null', () => {
  const out = deserializeProject({ version: 1, practiceDate: 'bad' });
  assert.equal(out.practiceDate, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/project.test.js`
Expected: FAIL（`practiceDate` が undefined）

- [ ] **Step 3: Implement in `src/project.js`**

`serializeProject` の返すオブジェクトに追記（`reflections:` 行の後、閉じ括弧の前）:

```js
    reflections: state.reflections.map((r) => ({ ...r })),
    practiceDate: typeof state.practiceDate === 'number' ? state.practiceDate : null,
```

`deserializeProject` の返すオブジェクトに追記（`reflections:` 行の後）:

```js
    reflections: arr(obj.reflections),
    practiceDate: typeof obj.practiceDate === 'number' ? obj.practiceDate : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/project.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/project.js test/project.test.js
git commit -m "feat: 保存スキーマに practiceDate を追加(旧ファイルはnull)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: カード表示で practiceDate を優先

**Files:**
- Modify: `src/summary.js`（`practiceSummary`）
- Test: `test/summary.test.js`

**Interfaces:**
- Consumes: `project.practiceDate: number | null`（`earliestContentMs` より優先）
- Produces: `practiceSummary(...).label` / `.trackedAt` が practiceDate を最優先。

- [ ] **Step 1: Write the failing tests**

`test/summary.test.js` の末尾に追記:

```js
test('practiceSummary: practiceDate があればデータ時刻より優先', () => {
  const project = {
    practiceDate: Date.UTC(2026, 8, 7, 4, 30), // 13:30 JST
    tracks: [{ tRange: { start: Date.UTC(2020, 0, 1, 0, 0) } }],
  };
  const s = practiceSummary(project, { name: 'sailviz-20200101-0900.sailviz.json' });
  assert.equal(s.label, '2026-09-07 13:30');
  assert.equal(s.trackedAt, Date.UTC(2026, 8, 7, 4, 30));
});

test('practiceSummary: practiceDate 無しはデータ時刻に従来どおりフォールバック', () => {
  const project = { tracks: [{ tRange: { start: Date.UTC(2026, 7, 23, 2, 0) } }] };
  const s = practiceSummary(project, {});
  assert.equal(s.label, '2026-08-23 11:00');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/summary.test.js`
Expected: FAIL（practiceDate を見ていないので label がデータ時刻由来）

- [ ] **Step 3: Implement in `src/summary.js`**

`practiceSummary` 内、`const trackedAt = earliestContentMs(p);` を差し替え:

```js
  // 練習日時は practiceDate(ユーザー入力/議事録抽出)を最優先。無ければデータ時刻。
  const trackedAt = typeof p.practiceDate === 'number' ? p.practiceDate : earliestContentMs(p);
```

（以降の `label` / `trackedAt` 参照はそのままで良い。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/summary.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/summary.js test/summary.test.js
git commit -m "feat: ホームカードのラベル/並びで practiceDate を優先

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: HTML に日時入力を追加

**Files:**
- Modify: `index.html`（反省エディタ・議事録モーダル）
- Test: `test/html-ids.test.js`（存在チェックを追加）

**Interfaces:**
- Produces: DOM id `refl-date`（反省エディタ内 `datetime-local`）、`import-date`（議事録モーダル内 `datetime-local`）。

- [ ] **Step 1: Write the failing test**

`test/html-ids.test.js` の末尾に追記:

```js
test('index.html に refl-date と import-date が存在する', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  assert.ok(/id="refl-date"/.test(html), 'refl-date が無い');
  assert.ok(/id="import-date"/.test(html), 'import-date が無い');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/html-ids.test.js`
Expected: FAIL（両id未追加）

- [ ] **Step 3: Add the inputs in `index.html`**

反省エディタ: `#refl-input-wrap` 内の `<textarea id="refl-text" ...>` の**直前**に追加:

```html
      <label id="refl-date-row">練習日時 <input type="datetime-local" id="refl-date" /></label>
```

議事録モーダル: `.im-input` の中、`<span class="im-or">...</span>` の**直後**に追加:

```html
        <label class="im-date">練習日時 <input type="datetime-local" id="import-date" /></label>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/html-ids.test.js`
Expected: PASS（新規id存在＋重複なし）

- [ ] **Step 5: Commit**

```bash
git add index.html test/html-ids.test.js
git commit -m "feat: 反省/議事録ダイアログに練習日時入力を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 練習アイデンティティ（state + 保存/読込/リセット）

**Files:**
- Modify: `src/app.js`（`state` 定義、`resetState`、`loadPractice`、`saveProject`、import 行）

**Interfaces:**
- Consumes: `uniqueProjectName`（Task 3）、`serializeProject`（practiceDate 対応済／Task 4）、`earliestContentMs`（既存）、`listProjectFiles`（既存）。
- Produces: `state.practiceDate: number | null`、`state.currentFileName: string | null`。保存は currentFileName へ上書き、初回のみ採番。

自動テストは無い（`app.js` はブラウザ入口）。回帰は `npm test` で、機能は Task 10 の手動Chrome確認で担保する。

- [ ] **Step 1: import を追加**

`src/app.js` の projectfs import に `uniqueProjectName` を追加:

```js
import {
  projectFileName, listProjectFiles, readProject, writeProject, readProgress, writeProgress,
  uniqueProjectName,
} from './projectfs.js';
```

- [ ] **Step 2: state に2フィールド追加**

`const state = { ... }` の `reflections: loadReflections(),` の直後に追加:

```js
  practiceDate: null,      // ページ(練習)の日時(絶対ms)。ダイアログで取得。保存対象。
  currentFileName: null,   // 現在ロード/保存中のファイル名。後付け紐付けで同一ファイル上書き。
```

- [ ] **Step 3: resetState でクリア**

`resetState` 内、`state.crop = { start: 0, end: 0 };` の直後に追加:

```js
  state.practiceDate = null;
  state.currentFileName = null;
```

- [ ] **Step 4: loadPractice で復元**

`loadPractice` 内、`state.reflections = data.reflections;` の直後に追加:

```js
  state.practiceDate = data.practiceDate ?? null;
  state.currentFileName = name;
```

- [ ] **Step 5: saveProject を currentFileName 上書き方式に**

`saveProject` を次で置き換え:

```js
async function saveProject() {
  const dir = await ensureProjectDir();
  if (!dir) return;
  const obj = serializeProject(state, { savedAt: new Date().toISOString() });
  // 既存ファイルを開いている/一度保存済みなら同名に上書き(後付けGPSでファイルを増やさない)。
  // 新規は練習日時(ユーザー指定→データ時刻→now)から採番し、衝突は分単位でずらす。
  let name = state.currentFileName;
  if (!name) {
    const baseMs = state.practiceDate ?? earliestContentMs(obj) ?? Date.now();
    const existing = (await listProjectFiles(dir)).map((f) => f.name);
    name = uniqueProjectName(baseMs, existing);
    state.currentFileName = name;
  }
  try {
    await writeProject(dir, name, obj);
  } catch (e) {
    statusEl.textContent = `保存に失敗: ${e.message}`; return;
  }
  cacheSummary(name, practiceSummary(obj, { name })); // ホームのカードに即反映
  statusEl.textContent = `保存しました: ${name}`;
}
```

- [ ] **Step 6: 回帰確認**

Run: `npm test`
Expected: PASS（全テスト緑。`app.js` は未テストだが他モジュールに回帰が無いこと）

- [ ] **Step 7: Commit**

```bash
git add src/app.js
git commit -m "feat: currentFileName で同一ファイル上書き保存(後付け紐付け対応)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 反省エディタの日時入力 + practiceInfo 拡張

**Files:**
- Modify: `src/app.js`（`practiceInfo`、`openReflectionEditor`、`saveReflection`、import 行）

**Interfaces:**
- Consumes: `jstWallToMs`/`msToJstWall`（Task 1）、`state.practiceDate`（Task 7）、`#refl-date`（Task 6）。
- Produces: 反省保存時に `state.practiceDate` を設定/更新。`practiceInfo()` がトラック無しでも practiceDate から日時を返す。

- [ ] **Step 1: import を追加**

`src/app.js` の time.js import（`parseTime` を読んでいる箇所）に追記。無ければ追加:

```js
import { jstWallToMs, msToJstWall } from './time.js';
```

- [ ] **Step 2: practiceInfo を拡張**

`practiceInfo` を次で置き換え:

```js
function practiceInfo() {
  const fmt = (ms) => new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
  const range = globalRange(state.tracks, 'absolute');
  if (range.end > range.start) {
    return { date: fmt(range.start), startMs: range.start, endMs: range.end };
  }
  if (state.practiceDate != null) {
    return { date: fmt(state.practiceDate), startMs: state.practiceDate, endMs: state.practiceDate };
  }
  return null;
}
```

- [ ] **Step 3: openReflectionEditor で #refl-date をプリフィル**

`openReflectionEditor` 内、`$('refl-text').value = existing?.text ?? '';` の直後に追加:

```js
  {
    const ms = state.practiceDate ?? existing?.practice?.startMs ?? practiceInfo()?.startMs ?? null;
    $('refl-date').value = ms != null ? msToJstWall(ms) : '';
  }
```

- [ ] **Step 4: saveReflection で practiceDate を設定/更新**

`saveReflection` の先頭（`const text = $('refl-text').value.trim();` の直後）に追加:

```js
  // 日時が入力/変更されていればページ練習日時に反映(最初に入った値を採用、変更は上書き)。
  const dateMs = jstWallToMs($('refl-date').value);
  if (Number.isFinite(dateMs) && (state.practiceDate == null || dateMs !== state.practiceDate)) {
    state.practiceDate = dateMs;
  }
```

（新規反省の作成は既存どおり `practice: practiceInfo()` を使う。上の更新後に呼ばれるため practiceDate が反映される。）

- [ ] **Step 5: 回帰確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app.js
git commit -m "feat: 反省エディタに練習日時入力を追加しページ日時に反映

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 議事録モーダルの日時（抽出＋入力）+ GPS必須ガード撤去

**Files:**
- Modify: `src/app.js`（`openImportModal`、`rebuildImportPreview`、`runImport`、minutes import 行）

**Interfaces:**
- Consumes: `parseMinutesDate`（Task 2）、`jstWallToMs`/`msToJstWall`（Task 1）、`state.practiceDate`（Task 7）、`#import-date`（Task 6）。
- Produces: データ無しでも議事録取込可能。抽出/入力した日時を `state.practiceDate` に反映。

- [ ] **Step 1: minutes import に parseMinutesDate を追加**

`src/app.js` の minutes.js import に追記:

```js
import { parseMinutes, matchMember, parseMinutesDate } from './minutes.js';
```

（既存 import が `parseMinutes, matchMember` の形であることを確認して合わせる。）

- [ ] **Step 2: openImportModal のGPSガード撤去 + 日時プリフィル**

`openImportModal` を次で置き換え:

```js
function openImportModal() {
  $('import-text').value = '';
  $('import-preview').innerHTML = '';
  $('import-wind').textContent = '';
  $('import-date').value = state.practiceDate != null ? msToJstWall(state.practiceDate) : '';
  importRows = [];
  $('import-modal').classList.remove('hidden');
}
```

- [ ] **Step 3: rebuildImportPreview で日付抽出プリフィル**

`rebuildImportPreview` の先頭（`const roster = memberList();` の直前）に追加:

```js
  // 議事録本文から日時を抽出(取れれば #import-date が空のときだけプリフィル。上書きしない)。
  if (!$('import-date').value) {
    const dt = parseMinutesDate(text, { defaultYear: currentJstYear() });
    if (dt) {
      const two = (n) => String(n).padStart(2, '0');
      $('import-date').value = `${dt.y}-${two(dt.mo)}-${two(dt.d)}T${two(dt.h)}:${two(dt.mi)}`;
    }
  }
```

`rebuildImportPreview` 関数の直前に補助関数を追加:

```js
// 現在のJST年(議事録に年が無い場合の補完に使う)。
function currentJstYear() {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(new Date()));
}
```

- [ ] **Step 4: runImport で practiceDate 反映 + 風targetを練習日に**

`runImport` の先頭2行（`const rows = ...; if (!rows.length) ... return;` の直後）に追加し、続く `practice`/`target` を差し替え:

```js
  // ダイアログ日時をページ練習日時へ反映(未設定なら設定、変更なら上書き)。
  const dImp = jstWallToMs($('import-date').value);
  if (Number.isFinite(dImp) && (state.practiceDate == null || dImp !== state.practiceDate)) {
    state.practiceDate = dImp;
  }
  const practice = practiceInfo();
  const target = firstVisibleTrack() ? nowAbsolute() : (state.practiceDate ?? Date.now());
```

（元の `const practice = practiceInfo();` と `const target = firstVisibleTrack() ? nowAbsolute() : Date.now();` の2行は削除して上に置き換える。）

- [ ] **Step 5: 回帰確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app.js
git commit -m "feat: 議事録取込をデータなし対応にし日時を抽出/入力しページ日時へ反映

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 手動Chrome確認 + ロードマップ更新

**Files:**
- Modify: `docs/roadmap.md`（項目24）

- [ ] **Step 1: 全テスト**

Run: `npm test`
Expected: PASS（全件緑）

- [ ] **Step 2: 手動確認（`npm run serve` → Chrome で http://localhost:8000）**

以下を確認（verify スキル or 手動）:
1. ホーム →「＋ 新規練習」→ トラック空のまま「＋ 反省を追加」→ ダイアログ内「練習日時」に日付を入力し本文を書いて保存 → 反省一覧に日付付きで出る。
2. 「💾 保存」→ フォルダ選択 → 保存成功。ホームに戻ると入力した練習日でカードが並ぶ。
3. そのカードを開く → GPS(CSV)取込 → 再度「💾 保存」→ **同じファイル名に上書き**（ホームでカードが増えない・練習日は入力した日を維持）。
4. 「📋 議事録から一括取込」を **GPS無し**で開けること。日付を含む議事録を貼ると「練習日時」が自動プリフィル。日付が無い議事録では空のまま手入力でき、取込後にページ日時へ反映される。

- [ ] **Step 3: roadmap を更新**

`docs/roadmap.md` の項目24 のステータス行を更新:

```md
- **ステータス**: ✅ 完了（データ無しでも「新規練習」から反省を作成・保存可能。練習日時は反省追加/議事録取込の各ダイアログ内で取得（議事録は本文から日時抽出、年なしは投稿年補完、取れなければ手入力）、最初に入った日時をページ日時(`state.practiceDate`)に採用。保存は `currentFileName` で同一ファイルへ上書きするため、メモ練習に後からGPS/動画を取込→保存してもファイルが増えない（練習日はユーザー指定を維持）。カードのラベル/並びは practiceDate 優先。JST壁時計変換・議事録日付抽出・ファイル名一意化は純関数化しテスト、全テスト通過）
```

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs: ロードマップ項目24(データなし反省)を完了に更新

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- practiceDate 概念 → Task 4/7 ✅
- 反省ダイアログ日時 → Task 6/8 ✅
- 議事録日時抽出＋GPSガード撤去 → Task 2/6/9 ✅（年補完＝投稿年 Task 2 ✅）
- currentFileName 上書き＋一意化 → Task 3/7 ✅
- practiceInfo 拡張 → Task 8 ✅
- summary ラベル/並び → Task 5 ✅
- JST変換注意点 → Task 1 ✅
- 後付け紐付けの手動確認 → Task 10 ✅

**Placeholder scan:** 具体コードとコマンドのみ。TBD/TODO 無し。

**Type consistency:** `jstWallToMs`/`msToJstWall`（Task1）、`parseMinutesDate(text,{defaultYear})`（Task2）、`uniqueProjectName(baseMs,existing)`（Task3）、`state.practiceDate`/`state.currentFileName`（Task7）を各所で同名参照。`practiceInfo()` は `{date,startMs,endMs}|null` で統一。整合。
