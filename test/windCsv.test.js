import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dirIdxFromName, parseWindCsv, pickWindFromRows, fetchWindFromCsv,
} from '../src/windCsv.js';

test('dirIdxFromName は日本語16方位を AMEDAS の整数に逆引き', () => {
  assert.equal(dirIdxFromName('静穏'), 0);
  assert.equal(dirIdxFromName('北北東'), 1);
  assert.equal(dirIdxFromName('南'), 8);
  assert.equal(dirIdxFromName('北'), 16);
  assert.equal(dirIdxFromName('×'), null);   // 欠測記号
  assert.equal(dirIdxFromName(''), null);
});

test('parseWindCsv はヘッダを飛ばし datetime/風速/風向 を取り出す', () => {
  const csv = [
    'ダウンロードした時刻：2026/08/16 15:37:14',
    '',
    ',辻堂,辻堂,辻堂,辻堂,辻堂',
    '年月日時,風速(m/s),風速(m/s),風速(m/s),風速(m/s),風速(m/s)',
    ',,,風向,風向,',
    ',,品質情報,,品質情報,均質番号',
    '2025/1/1 1:00:00,2.4,8,北北東,8,1',
    '2025/1/1 2:00:00,,0,,,1',        // 欠測(風速空)→スキップ
  ].join('\n');
  const rows = parseWindCsv(csv);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    obsMs: Date.parse('2025-01-01T01:00:00+09:00'),
    speed: 2.4,
    dirIdx: 1,
    dirName: '北北東',
  });
});

test('pickWindFromRows は目標時刻に最も近い行を選ぶ', () => {
  const rows = [
    { obsMs: Date.parse('2025-06-01T13:00:00+09:00'), speed: 3.0, dirIdx: 8, dirName: '南' },
    { obsMs: Date.parse('2025-06-01T14:00:00+09:00'), speed: 4.0, dirIdx: 16, dirName: '北' },
  ];
  const target = Date.parse('2025-06-01T13:40:00+09:00');
  const w = pickWindFromRows(rows, target);
  assert.equal(w.speed, 4.0);
  assert.equal(w.dir, '北');
  assert.equal(w.dirIdx, 16);
  assert.equal(w.source, 'csv');
  assert.equal(w.station, '辻堂');
  assert.equal(w.obsMs, Date.parse('2025-06-01T14:00:00+09:00'));
});

test('pickWindFromRows は許容差(±90分)を超えると null', () => {
  const rows = [
    { obsMs: Date.parse('2025-06-01T13:00:00+09:00'), speed: 3.0, dirIdx: 8, dirName: '南' },
  ];
  const target = Date.parse('2025-06-01T15:00:00+09:00'); // 120分差
  assert.equal(pickWindFromRows(rows, target), null);
});

test('fetchWindFromCsv は Shift-JIS の実CSVをデコードして風を返す', async () => {
  const bytes = readFileSync(new URL('../sample-data/data.csv', import.meta.url));
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => bytes });
  // 実データにある時刻(2025/1/1 1:00 JST)を狙う
  const target = Date.parse('2025-01-01T01:05:00+09:00');
  const w = await fetchWindFromCsv(target, { fetch: fakeFetch, url: 'sample-data/data.csv' });
  assert.equal(w.source, 'csv');
  assert.equal(w.station, '辻堂');
  assert.equal(typeof w.speed, 'number');
  assert.equal(w.obsMs, Date.parse('2025-01-01T01:00:00+09:00'));
});
