import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoOverlapsRange, scanFolderVideos } from '../src/folderimport.js';

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
    fileHandle('b.mp4', { creationMs: 2500, durationMs: 300 }),    // 開始=2200 範囲外 → 除外
    fileHandle('c.mov', { creationMs: 1400, durationMs: 400 }),    // 開始=1000 一部重なり → 採用
    fileHandle('d.mp4', null),                                     // moov無し(時刻不明) → 除外
    fileHandle('notes.txt', { creationMs: 1500, durationMs: null }), // 動画以外 → 走査対象外
    { kind: 'directory', name: 'sub' },                            // サブフォルダ → 無視
  ]);
  const res = await scanFolderVideos(dir, { start: 1000, end: 2000 }, injectedReadTimes);
  assert.equal(res.scanned, 4);   // 動画ファイル4本
  assert.equal(res.skipped, 2);   // b, d
  assert.deepEqual(res.matched.map((m) => m.file.name), ['a.mp4', 'c.mov']);
  assert.deepEqual(res.matched.map((m) => m.t), [1500, 1000]); // 開始(録画開始=creation−duration)
});
