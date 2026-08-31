import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windDirName, blockHour, amedasUrl, parseWind, fetchWind, AMEDAS_NAME, dirIdxToDeg } from '../src/wind.js';

test('dirIdxToDeg: 16方位を度に変換(北=0/静穏=null)', () => {
  assert.equal(dirIdxToDeg(0), null);   // 静穏は方向なし
  assert.equal(dirIdxToDeg(16), 0);     // 北=0°(360→0)
  assert.equal(dirIdxToDeg(1), 22.5);   // 北北東
  assert.equal(dirIdxToDeg(4), 90);     // 東
  assert.equal(dirIdxToDeg(8), 180);    // 南
  assert.equal(dirIdxToDeg(12), 270);   // 西
});

test('windDirName は16方位＋静穏＋範囲外', () => {
  assert.equal(windDirName(0), '静穏');
  assert.equal(windDirName(8), '南');
  assert.equal(windDirName(16), '北');
  assert.equal(windDirName(17), '不明');
  assert.equal(windDirName(null), '不明');
});

test('blockHour は3時間ブロック開始時', () => {
  assert.equal(blockHour(0), '00');
  assert.equal(blockHour(10), '09');
  assert.equal(blockHour(23), '21');
});

test('amedasUrl は JST 日付とブロックでURLを組む', () => {
  // 2026-08-15T23:10:00+09:00 → ブロック21
  const ms = Date.parse('2026-08-15T23:10:00+09:00');
  assert.equal(amedasUrl(ms), 'https://www.jma.go.jp/bosai/amedas/data/point/46141/20260815_21.json');
});

test('amedasUrl は UTC 深夜を JST 翌日に繰り上げる', () => {
  // 2026-08-15T20:00:00Z = 2026-08-16T05:00:00+09:00 → 05時→ブロック03、日付は16日
  const ms = Date.parse('2026-08-15T20:00:00Z');
  assert.equal(amedasUrl(ms), 'https://www.jma.go.jp/bosai/amedas/data/point/46141/20260816_03.json');
});

test('parseWind は目標時刻に最も近い有効サンプルを選ぶ', () => {
  const json = {
    '20260815223000': { wind: [1.0, 0], windDirection: [4, 0] },
    '20260815224000': { wind: [1.3, 0], windDirection: [8, 0] },
    '20260815225000': { wind: [1.6, 0], windDirection: [16, 0] },
  };
  const target = Date.parse('2026-08-15T22:41:00+09:00');
  const w = parseWind(json, target);
  assert.equal(w.speed, 1.3);
  assert.equal(w.dirIdx, 8);
  assert.equal(w.dirName, '南');
});

test('parseWind は風の欠測サンプルを飛ばす', () => {
  const json = {
    '20260815224000': { wind: [null, 1], windDirection: [null, 1] },
    '20260815225000': { wind: [2.0, 0], windDirection: [2, 0] },
  };
  const w = parseWind(json, Date.parse('2026-08-15T22:40:00+09:00'));
  assert.equal(w.speed, 2.0);
  assert.equal(w.dirName, '北東');
});

test('parseWind は全欠測なら null', () => {
  assert.equal(parseWind({}, 0), null);
  assert.equal(parseWind(null, 0), null);
});

test('fetchWind は成功時に整形結果を返す', async () => {
  const json = { '20260815225000': { wind: [3.2, 0], windDirection: [9, 0] } };
  const fakeFetch = async () => ({ ok: true, json: async () => json });
  const w = await fetchWind(Date.parse('2026-08-15T22:50:00+09:00'), { fetch: fakeFetch });
  assert.equal(w.source, 'amedas');
  assert.equal(w.station, AMEDAS_NAME);
  assert.equal(w.dir, '南南西');
  assert.equal(w.speed, 3.2);
});

test('fetchWind はHTTPエラーで null(手入力フォールバック)', async () => {
  const w = await fetchWind(Date.now?.() ?? 0, { fetch: async () => ({ ok: false }) });
  assert.equal(w, null);
});

test('fetchWind は例外で null', async () => {
  const w = await fetchWind(0, { fetch: async () => { throw new Error('network'); } });
  assert.equal(w, null);
});
