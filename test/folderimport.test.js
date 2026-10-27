import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  videoOverlapsRange, scanFolderVideos, collectVideoFiles,
  parseYearFolder, parseMonthDayFolder, findPracticeDayFolders, planFolderImport, fileSignature,
} from '../src/folderimport.js';

const range = { start: 1000, end: 2000 };

test('録画区間が範囲に完全に収まる → true', () => {
  assert.equal(videoOverlapsRange(1200, 300, range), true);
});

test('録画区間が範囲より前で終わる → false', () => {
  assert.equal(videoOverlapsRange(100, 300, range), false); // [100,400]
});

test('録画開始が範囲より後 → false', () => {
  assert.equal(videoOverlapsRange(2100, 300, range), false); // [2100,2400]
});

test('範囲の手前で始まり範囲内で終わる（一部重なり）→ true', () => {
  assert.equal(videoOverlapsRange(800, 400, range), true); // [800,1200]
});

test('duration不明で開始が範囲内 → true', () => {
  assert.equal(videoOverlapsRange(1500, null, range), true);
});

test('duration不明で開始が範囲外 → false', () => {
  assert.equal(videoOverlapsRange(2500, null, range), false);
});

test('開始時刻が不明(null) → false', () => {
  assert.equal(videoOverlapsRange(null, 300, range), false);
});

// --- scanFolderVideos: フォルダ直下の動画を走査し範囲内だけ返す ---
// 擬似 FileSystemDirectoryHandle: values() が handle を非同期列挙。
function fileHandle(name, meta) {
  return { kind: 'file', name, getFile: async () => ({ name, meta }) };
}
function fakeDir(entries) {
  return { values: async function* values() { for (const e of entries) yield e; } };
}
const injectedReadTimes = async (file) => file.meta; // getFile が付けた meta を読む体

test('範囲内の動画だけを返し、走査数/スキップ数も数える', async () => {
  const dir = fakeDir([
    fileHandle('a.mp4', { creationMs: 1500, durationMs: null }),   // 開始1500 範囲内 → 採用
    fileHandle('b.mp4', { creationMs: 2500, durationMs: 300 }),    // 開始=2500 範囲外 → 除外
    fileHandle('c.mov', { creationMs: 1400, durationMs: 400 }),    // 開始=1400 一部重なり → 採用
    fileHandle('d.mp4', null),                                     // moov無し(時刻不明) → 除外
    fileHandle('notes.txt', { creationMs: 1500, durationMs: null }), // 動画以外 → 走査対象外
    { kind: 'directory', name: 'sub' },                            // サブフォルダ → 無視
  ]);
  const res = await scanFolderVideos(dir, { start: 1000, end: 2000 }, injectedReadTimes);
  assert.equal(res.scanned, 4);   // 動画ファイル4本
  assert.equal(res.skipped, 2);   // b, d
  assert.deepEqual(res.matched.map((m) => m.file.name), ['a.mp4', 'c.mov']);
  assert.deepEqual(res.matched.map((m) => m.t), [1500, 1400]); // 開始(録画開始=creation_time)
});

test('Pixel(PXL_)動画は creation_time を終了とみなし 開始=終了−長さ で判定する', async () => {
  const dir = fakeDir([
    // creation(終了)=2300, 長さ400 → 開始=1900 範囲内 → 採用(t=1900)
    fileHandle('PXL_20260820_001827685.mp4', { creationMs: 2300, durationMs: 400 }),
    // creation(終了)=1200, 長さ400 → 開始=800 範囲手前で終了1200は範囲内 → 採用(t=800)
    fileHandle('PXL_20260820_002000000.mp4', { creationMs: 1200, durationMs: 400 }),
  ]);
  const res = await scanFolderVideos(dir, { start: 1000, end: 2000 }, injectedReadTimes);
  assert.deepEqual(res.matched.map((m) => m.file.name), [
    'PXL_20260820_001827685.mp4',
    'PXL_20260820_002000000.mp4',
  ]);
  assert.deepEqual(res.matched.map((m) => m.t), [1900, 800]); // 開始=終了−長さ
});

// --- collectVideoFiles: 名前一致の動画 File のみ収集 ---
test('collectVideoFiles は nameSet に含まれる名前の File だけ返す', async () => {
  const dir = fakeDir([
    fileHandle('a.mp4', null),
    fileHandle('b.mov', null),
    fileHandle('c.mp4', null),
    { kind: 'directory', name: 'sub' },
  ]);
  const map = await collectVideoFiles(dir, new Set(['a.mp4', 'c.mp4', 'missing.mp4']));
  assert.deepEqual([...map.keys()].sort(), ['a.mp4', 'c.mp4']);
  assert.equal(map.get('a.mp4').name, 'a.mp4');
});

test('scanFolderVideos の entries は走査した全動画(範囲外・時刻不明も)を {file, t, durationMs} で返す', async () => {
  const dir = fakeDir([
    fileHandle('a.mp4', { creationMs: 1500, durationMs: null }),
    fileHandle('b.mp4', { creationMs: 2500, durationMs: 300 }),
    fileHandle('d.mp4', null),
    fileHandle('notes.txt', null),
  ]);
  const res = await scanFolderVideos(dir, { start: 1000, end: 2000 }, injectedReadTimes);
  assert.deepEqual(res.entries.map((e) => [e.file.name, e.t, e.durationMs]), [
    ['a.mp4', 1500, null], ['b.mp4', 2500, 300], ['d.mp4', null, null],
  ]);
  assert.equal(res.matched.length, 1); // 既存の判定は不変
});

// --- フォルダ名の解釈 ---
test('parseMonthDayFolder: 先頭の「月」「日」を読み、括弧・曜日・日・メモは無視する', () => {
  const ok = {
    '1 12（月）': [1, 12], '1 28(水)': [1, 28], '2 21': [2, 21], '2 22日': [2, 22], '8:27': [8, 27],
    '7 5(日)ファミリーデイ': [7, 5], '10 17(土）': [10, 17], '8/27': [8, 27], '8月27日': [8, 27],
    '９ １１(金)（コーチング2日目）': [9, 11], '８：２７': [8, 27], '8　27(木)': [8, 27], '12 31': [12, 31],
  };
  for (const [name, [month, day]] of Object.entries(ok)) {
    assert.deepEqual(parseMonthDayFolder(name), { month, day }, name);
  }
});

test('parseMonthDayFolder: 月日として読めない名前は null', () => {
  for (const name of ['プロ動画', '2026練習', '13 40', '0 10', '2 32', '2 0', 'abc', '', '827', '8 270', ' ', null]) {
    assert.equal(parseMonthDayFolder(name), null, String(name));
  }
});

test('parseYearFolder: `<4桁>練習` だけを年として読む', () => {
  assert.equal(parseYearFolder('2026練習'), 2026);
  assert.equal(parseYearFolder('２０２５練習'), 2025);
  assert.equal(parseYearFolder('練習動画'), null);
  assert.equal(parseYearFolder('2026'), null);
  assert.equal(parseYearFolder('2026練習(旧)'), null);
  assert.equal(parseYearFolder('プロ動画'), null);
  assert.equal(parseYearFolder(undefined), null);
});

// --- findPracticeDayFolders: <ルート>/<年>練習/<月日> ---
function dirHandle(name, children = []) {
  return { kind: 'directory', name, values: async function* values() { for (const c of children) yield c; } };
}
const target = { year: 2026, month: 8, day: 27 };

test('findPracticeDayFolders: 練習動画ルートから年フォルダ → 月日フォルダを探す(同じ月日は全部)', async () => {
  const d1 = dirHandle('8 27(木)');
  const d2 = dirHandle('8:27');
  const root = dirHandle('練習動画', [
    dirHandle('2025練習', [dirHandle('8 27(水)')]),
    dirHandle('2026練習', [dirHandle('8 26(水)'), d1, d2, fileHandle('8 27.mp4', null), dirHandle('9 27')]),
    dirHandle('プロ動画', [dirHandle('8 27')]),
  ]);
  const res = await findPracticeDayFolders(root, target);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.yearDirs.map((d) => d.name), ['2026練習']);
  assert.deepEqual(res.dayDirs, [d1, d2]);
});

test('findPracticeDayFolders: ルート自体が `2026練習` でも動く', async () => {
  const day = dirHandle('8 27');
  const root = dirHandle('2026練習', [day, dirHandle('8 28')]);
  const res = await findPracticeDayFolders(root, target);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.dayDirs, [day]);
});

test('findPracticeDayFolders: 年フォルダが無ければ noYear、月日フォルダが無ければ noDay', async () => {
  const noYear = await findPracticeDayFolders(dirHandle('練習動画', [dirHandle('2025練習', [dirHandle('8 27')])]), target);
  assert.equal(noYear.status, 'noYear');
  assert.deepEqual(noYear.dayDirs, []);
  const noDay = await findPracticeDayFolders(dirHandle('練習動画', [dirHandle('2026練習', [dirHandle('8 28')])]), target);
  assert.equal(noDay.status, 'noDay');
  assert.equal(noDay.yearDirs.length, 1);
});

test('findPracticeDayFolders: 直下だけを見る(孫の月日フォルダ・孫の年フォルダは見ない)', async () => {
  const deepDay = await findPracticeDayFolders(dirHandle('練習動画', [
    dirHandle('2026練習', [dirHandle('8月', [dirHandle('8 27')])]),
  ]), target);
  assert.equal(deepDay.status, 'noDay');
  const deepYear = await findPracticeDayFolders(dirHandle('Drive', [dirHandle('練習動画', [dirHandle('2026練習', [dirHandle('8 27')])])]), target);
  assert.equal(deepYear.status, 'noYear');
});

// --- planFolderImport: 再リンクと新規の振り分け ---
const f = (name) => ({ name }); // File の代わり(同一性で比べる)
const e = (file, t, durationMs = null) => ({ file, t, durationMs });

test('planFolderImport: 未リンク動画が1本で同名の候補が1つなら、時刻が違ってもそのまま再リンク(旧来どおり)', () => {
  const v = { id: 'vid0', t: 100, name: 'a.mp4', durationMs: null };
  const fa = f('a.mp4');
  const plan = planFolderImport({ stateVideos: [v], entries: [e(fa, 99999)], matched: [e(fa, 99999)] });
  assert.deepEqual(plan.relink, [{ video: v, file: fa }]);
  assert.deepEqual(plan.add, [], '再リンクに使ったファイルは新規に足さない');
});

test('planFolderImport: 同名の候補が複数なら ±2秒以内で最も近いものを選ぶ(無ければ再リンクしない)', () => {
  const v1 = { id: 'vid0', t: 10000, name: 'IMG_0001.MOV' };
  const v2 = { id: 'vid1', t: 50000, name: 'other.mp4' };
  const fNear = f('IMG_0001.MOV'); const fFar = f('IMG_0001.MOV');
  const fo1 = f('other.mp4'); const fo2 = f('other.mp4');
  const plan = planFolderImport({
    stateVideos: [v1, v2],
    entries: [e(fFar, 30000), e(fNear, 11500), e(fo1, 60000), e(fo2, 70000)],
    matched: [],
  });
  assert.deepEqual(plan.relink, [{ video: v1, file: fNear }]);
});

test('planFolderImport: 同名の未リンク動画が複数・候補1つなら、±2秒以内の1本だけにつなぐ', () => {
  const v1 = { id: 'vid0', t: 10000, name: 'IMG_0001.MOV' };
  const v2 = { id: 'vid1', t: 90000, name: 'IMG_0001.MOV' };
  const file = f('IMG_0001.MOV');
  const plan = planFolderImport({ stateVideos: [v1, v2], entries: [e(file, 90500)], matched: [] });
  assert.deepEqual(plan.relink, [{ video: v2, file }]);
  const none = planFolderImport({ stateVideos: [v1, v2], entries: [e(file, 50000)], matched: [] });
  assert.deepEqual(none.relink, []);
});

test('planFolderImport: リンク済みの動画は再リンクしない。name + t が一覧にある・matched 同士で重なる動画は足さない', () => {
  const linked = { id: 'vid0', t: 1000, name: 'a.mp4', url: 'blob:a' };
  const fa = f('a.mp4'); const fb1 = f('b.mp4'); const fb2 = f('b.mp4'); const fc = f('IMG_0001.MOV');
  const plan = planFolderImport({
    stateVideos: [linked],
    entries: [e(fa, 1000), e(fb1, 2000), e(fb2, 2000), e(fc, 3000, 500)],
    matched: [e(fa, 1000), e(fb1, 2000), e(fb2, 2000), e(fc, 3000, 500)], // b は2つの月日フォルダに同じ動画
  });
  assert.deepEqual(plan.relink, []);
  assert.deepEqual(plan.add, [e(fb1, 2000), e(fc, 3000, 500)]);
});

test('planFolderImport: 同名でも時刻が違う(別人の)動画は新規に足す', () => {
  const linked = { id: 'vid0', t: 1000, name: 'IMG_0001.MOV', url: 'blob:a' };
  const other = f('IMG_0001.MOV');
  const plan = planFolderImport({ stateVideos: [linked], entries: [e(other, 8000)], matched: [e(other, 8000)] });
  assert.deepEqual(plan.add, [e(other, 8000)]);
});

test('planFolderImport: 動画が無い・入力が空でも動く', () => {
  assert.deepEqual(planFolderImport({ stateVideos: [], entries: [], matched: [] }), { relink: [], add: [] });
  assert.deepEqual(planFolderImport({}), { relink: [], add: [] });
});

test('planFolderImport: ドロップで現在位置に置いた(t が撮影時刻と違う)リンク済み動画と同じファイルは、二重に足さない', () => {
  const dropped = { id: 'vid0', t: 5000, name: 'clip.mp4', url: 'blob:x', fileSig: fileSignature({ size: 123, lastModified: 777 }) };
  const same = { name: 'clip.mp4', size: 123, lastModified: 777 };
  const otherSameName = { name: 'clip.mp4', size: 999, lastModified: 777 }; // 同名だが別のファイル(別人の動画)
  const plan = planFolderImport({
    stateVideos: [dropped],
    entries: [e(same, 1000), e(otherSameName, 2000)],
    matched: [e(same, 1000), e(otherSameName, 2000)],
  });
  assert.deepEqual(plan.relink, []);
  assert.deepEqual(plan.add, [e(otherSameName, 2000)]);
});

test('planFolderImport: 未リンク(url なし)の動画は fileSig があっても新規の除外に使わない', () => {
  const unlinked = { id: 'vid0', t: 5000, name: 'x.mp4', fileSig: '1:1' };
  const fx = { name: 'x.mp4', size: 1, lastModified: 1 };
  const fy = { name: 'y.mp4', size: 1, lastModified: 1 };
  const plan = planFolderImport({ stateVideos: [unlinked], entries: [e(fx, 1000), e(fy, 1000)], matched: [e(fy, 1000)] });
  assert.deepEqual(plan.relink, [{ video: unlinked, file: fx }]);
  assert.deepEqual(plan.add, [e(fy, 1000)]);
});

test('fileSignature: サイズと更新時刻。どちらも無ければ null', () => {
  assert.equal(fileSignature({ size: 10, lastModified: 20 }), '10:20');
  assert.equal(fileSignature({ name: 'a' }), null);
  assert.equal(fileSignature(null), null);
});
