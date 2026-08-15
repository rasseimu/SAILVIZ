import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMp4CreationTime } from '../src/videometa.js';

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
// version0 の mvhd ペイロード(creation/modification/timescale/duration + 残りは省略可)
function mvhdV0(creationSec) {
  const p = new Uint8Array(4 + 16);
  const dv = new DataView(p.buffer);
  dv.setUint8(0, 0);            // version
  dv.setUint32(4, creationSec); // creation_time
  return p;
}
function mvhdV1(creationSec) {
  const p = new Uint8Array(4 + 28);
  const dv = new DataView(p.buffer);
  dv.setUint8(0, 1);                    // version 1 → 64bit
  // creation_time は 8 バイト。上位32bitは0、下位に値。
  dv.setUint32(4, Math.floor(creationSec / 2 ** 32));
  dv.setUint32(8, creationSec >>> 0);
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

test('returns null when moov/mvhd absent', () => {
  const ftyp = box('ftyp', new Uint8Array([1, 2, 3, 4]));
  assert.equal(parseMp4CreationTime(ftyp.buffer), null);
});

test('returns null when creation_time is 0 (未設定)', () => {
  const moov = box('moov', box('mvhd', mvhdV0(0)));
  assert.equal(parseMp4CreationTime(moov.buffer), null);
});
