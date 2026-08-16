import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMp4CreationTime, parseMp4Times, parseMp4TimesFromFile } from '../src/videometa.js';

const MAC_EPOCH_OFFSET = 2082844800; // 1904→1970 の秒差

// 簡易 box ビルダ: [size(4)][type(4)][payload]
function box(type, payload) {
  const size = 8 + payload.length;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(payload, 8);
  return buf;
}
function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
// version0 の mvhd ペイロード(creation/modification/timescale/duration)
function mvhdV0(creationSec, timescale = 0, duration = 0) {
  const p = new Uint8Array(4 + 16);
  const dv = new DataView(p.buffer);
  dv.setUint8(0, 0);            // version
  dv.setUint32(4, creationSec); // creation_time
  dv.setUint32(12, timescale);  // timescale
  dv.setUint32(16, duration);   // duration
  return p;
}
function mvhdV1(creationSec, timescale = 0, duration = 0) {
  const p = new Uint8Array(4 + 28);
  const dv = new DataView(p.buffer);
  dv.setUint8(0, 1);                    // version 1 → 64bit
  // creation_time は 8 バイト。上位32bitは0、下位に値。
  dv.setUint32(4, Math.floor(creationSec / 2 ** 32));
  dv.setUint32(8, creationSec >>> 0);
  dv.setUint32(20, timescale);          // timescale (4)
  dv.setUint32(28, duration >>> 0);     // duration 下位32bit
  return p;
}

test('parses mvhd creation_time (version 0) into unix ms', () => {
  const unixSec = Math.floor(Date.parse('2024-08-07T05:30:00Z') / 1000);
  const creation = unixSec + MAC_EPOCH_OFFSET;
  const ftyp = box('ftyp', new Uint8Array([0, 0, 0, 0])); // 先頭に無関係boxを置く
  const moov = box('moov', box('mvhd', mvhdV0(creation)));
  const file = concat(ftyp, moov);
  const got = parseMp4CreationTime(file.buffer);
  assert.equal(got, unixSec * 1000);
});

test('parses mvhd creation_time (version 1 / 64-bit)', () => {
  const unixSec = Math.floor(Date.parse('2024-08-07T05:30:00Z') / 1000);
  const creation = unixSec + MAC_EPOCH_OFFSET;
  const moov = box('moov', box('mvhd', mvhdV1(creation)));
  const got = parseMp4CreationTime(moov.buffer);
  assert.equal(got, unixSec * 1000);
});

test('parseMp4Times returns creation and duration (ms)', () => {
  const unixSec = Math.floor(Date.parse('2024-08-07T05:30:00Z') / 1000);
  const creation = unixSec + MAC_EPOCH_OFFSET;
  const timescale = 600, durationUnits = 600 * 90; // 90秒
  const moov = box('moov', box('mvhd', mvhdV0(creation, timescale, durationUnits)));
  const got = parseMp4Times(moov.buffer);
  assert.equal(got.creationMs, unixSec * 1000);
  assert.equal(got.durationMs, 90 * 1000);
  // creation_time が「録画終了」の端末では 開始 = creation - duration
  assert.equal(got.creationMs - got.durationMs, (unixSec - 90) * 1000);
});

test('parseMp4Times: durationMs is null when timescale is 0', () => {
  const moov = box('moov', box('mvhd', mvhdV0(2082844800 + 100, 0, 0)));
  const got = parseMp4Times(moov.buffer);
  assert.equal(got.durationMs, null);
});

test('returns null when moov/mvhd absent', () => {
  const ftyp = box('ftyp', new Uint8Array([1, 2, 3, 4]));
  assert.equal(parseMp4CreationTime(ftyp.buffer), null);
});

test('returns null when creation_time is 0 (未設定)', () => {
  const moov = box('moov', box('mvhd', mvhdV0(0)));
  assert.equal(parseMp4CreationTime(moov.buffer), null);
});

// --- parseMp4TimesFromFile: Blob を部分読みして moov を探す（大容量動画で全読みしない）---
function blobOf(u8) { return new Blob([u8]); }

test('parseMp4TimesFromFile: moov が先頭側にある（fast-start）', async () => {
  const unixSec = Math.floor(Date.parse('2024-08-07T05:30:00Z') / 1000);
  const creation = unixSec + MAC_EPOCH_OFFSET;
  const ftyp = box('ftyp', new Uint8Array([0, 0, 0, 0]));
  const moov = box('moov', box('mvhd', mvhdV0(creation, 600, 600 * 90)));
  const mdat = box('mdat', new Uint8Array(1000)); // 実データ相当の大きめ box
  const got = await parseMp4TimesFromFile(blobOf(concat(ftyp, moov, mdat)));
  assert.equal(got.creationMs, unixSec * 1000);
  assert.equal(got.durationMs, 90 * 1000);
});

test('parseMp4TimesFromFile: moov が末尾にある（mdat を飛ばして探す）', async () => {
  const unixSec = Math.floor(Date.parse('2024-08-07T05:30:00Z') / 1000);
  const creation = unixSec + MAC_EPOCH_OFFSET;
  const ftyp = box('ftyp', new Uint8Array([0, 0, 0, 0]));
  const mdat = box('mdat', new Uint8Array(5000)); // 巨大な実データを飛ばす必要がある
  const moov = box('moov', box('mvhd', mvhdV0(creation, 600, 600 * 90)));
  const got = await parseMp4TimesFromFile(blobOf(concat(ftyp, mdat, moov)));
  assert.equal(got.creationMs, unixSec * 1000);
  assert.equal(got.durationMs, 90 * 1000);
});

test('parseMp4TimesFromFile: moov が無ければ null', async () => {
  const ftyp = box('ftyp', new Uint8Array([1, 2, 3, 4]));
  const mdat = box('mdat', new Uint8Array(100));
  const got = await parseMp4TimesFromFile(blobOf(concat(ftyp, mdat)));
  assert.equal(got, null);
});
