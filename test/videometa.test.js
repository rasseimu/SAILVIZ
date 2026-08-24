import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMp4CreationTime, parseMp4Times, parseMp4TimesFromFile, embeddedStartMs, isEndTimeDevice, findAppleCreationMs } from '../src/videometa.js';

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
});

// creation_time は「録画開始時刻」として扱う。duration は減算しない。
test('embeddedStartMs returns creation_time as start (duration not subtracted)', () => {
  assert.equal(embeddedStartMs({ creationMs: 1_000_000, durationMs: 59_000 }), 1_000_000);
});

test('embeddedStartMs ignores duration even when present', () => {
  assert.equal(embeddedStartMs({ creationMs: 5_000, durationMs: 90_000 }), 5_000);
});

test('embeddedStartMs returns null for missing meta', () => {
  assert.equal(embeddedStartMs(null), null);
});

// --- 端末判定: Pixel は creation_time が録画終了なので 開始 = 終了 − 長さ ---
test('isEndTimeDevice: PXL_ 名は終了時刻端末とみなす', () => {
  assert.equal(isEndTimeDevice('PXL_20260820_001827685.mp4'), true);
  assert.equal(isEndTimeDevice('pxl_20260820_001827685.mp4'), true); // 大小無視
});

test('isEndTimeDevice: iPhone等の名前は false', () => {
  assert.equal(isEndTimeDevice('IMG_1234.mov'), false);
  assert.equal(isEndTimeDevice('video.mp4'), false);
  assert.equal(isEndTimeDevice(undefined), false);
});

test('embeddedStartMs: Pixel名+長さあり → creation − duration', () => {
  assert.equal(
    embeddedStartMs({ creationMs: 1_000_000, durationMs: 59_000 }, 'PXL_20260820_001827685.mp4'),
    941_000,
  );
});

test('embeddedStartMs: Pixel名+長さなし → creation のまま(減算しない)', () => {
  assert.equal(
    embeddedStartMs({ creationMs: 1_000_000, durationMs: null }, 'PXL_20260820_001827685.mp4'),
    1_000_000,
  );
});

test('embeddedStartMs: iPhone名は長さがあっても creation のまま(9324dd8回帰防止)', () => {
  assert.equal(
    embeddedStartMs({ creationMs: 1_000_000, durationMs: 59_000 }, 'IMG_1234.mov'),
    1_000_000,
  );
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

// --- findAppleCreationMs: 書き出しで mvhd が化けても元の撮影日時を moov メタから拾う ---
function asciiBytes(str) { return new Uint8Array([...str].map((c) => c.charCodeAt(0))); }

test('findAppleCreationMs: creationdate キー近傍の ISO 日時(TZ付き)を ms で返す', () => {
  // keys(キー名) → ilst(値) の並びを模した最小バイト列
  const blob = asciiBytes('....keys....com.apple.quicktime.creationdate....ilst....2026-08-23T09:27:01+0900....');
  const ms = findAppleCreationMs(blob.buffer);
  assert.equal(ms, Date.parse('2026-08-23T09:27:01+0900'));
});

test('findAppleCreationMs: creationdate キーが無ければ null(誤検出しない)', () => {
  const blob = asciiBytes('mvhd....2026-08-23T09:27:01+0900....'); // キー無しの裸の日付は拾わない
  assert.equal(findAppleCreationMs(blob.buffer), null);
});

test('findAppleCreationMs: Z(UTC)表記も解釈する', () => {
  const blob = asciiBytes('creationdate....2026-08-23T00:27:01Z');
  assert.equal(findAppleCreationMs(blob.buffer), Date.parse('2026-08-23T00:27:01Z'));
});

// 一部端末/書き出しは creationdate ではなく QuickTime udta の `date` アトム
// (ASCII "date" の直後に ISO8601)へ録画時刻を残す。mvhd は書き出し時刻に化ける。
test('findAppleCreationMs: udta date アトム("date"直後のISO)を拾う', () => {
  // box: [size][type "date"][payload=ISO文字列そのまま]（実ファイルの構造）
  const dateAtom = box('date', asciiBytes('2026-08-23T15:47:35+0900'));
  const blob = concat(asciiBytes('....udta....loci....'), dateAtom, asciiBytes('....'));
  assert.equal(findAppleCreationMs(blob.buffer), Date.parse('2026-08-23T15:47:35+0900'));
});

test('findAppleCreationMs: "date"の直後にISOが無ければ拾わない(誤検出防止)', () => {
  // "update" は "date" を部分文字列に含むが、直後にISOが無いので採用しない
  const blob = asciiBytes('....update....something else....2026-08-23T09:27:01+0900....');
  assert.equal(findAppleCreationMs(blob.buffer), null);
});

test('findAppleCreationMs: creationdate は date アトムより優先', () => {
  const dateAtom = box('date', asciiBytes('2026-08-23T15:47:35+0900'));
  const blob = concat(asciiBytes('creationdate....2026-08-23T09:27:01+0900....'), dateAtom);
  assert.equal(findAppleCreationMs(blob.buffer), Date.parse('2026-08-23T09:27:01+0900'));
});

// mvhd が書き出し時刻に化けても、Apple の元撮影日時があれば最優先で録画開始に使う
test('embeddedStartMs: appleCreationMs があれば mvhd より優先', () => {
  assert.equal(
    embeddedStartMs({ creationMs: 9_999_000, durationMs: 60_000, appleCreationMs: 1_000_000 }, 'X.MP4'),
    1_000_000,
  );
});

test('embeddedStartMs: appleCreationMs は Pixel の終了時刻ロジックより優先', () => {
  assert.equal(
    embeddedStartMs({ creationMs: 9_999_000, durationMs: 60_000, appleCreationMs: 1_000_000 }, 'PXL_x.mp4'),
    1_000_000,
  );
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
