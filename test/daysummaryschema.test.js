// daySummary の形チェックのテスト。表示側が触る全フィールドを1つずつ壊して false になることを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDaySummaryShape, DAY_SUMMARY_REASONS } from '../src/daysummaryschema.js';

const VALID = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(VALID);

test('isDaySummaryShape: fixture(ok:true と ok:false を含む)は通る', () => {
  assert.equal(isDaySummaryShape(VALID), true);
});

test('isDaySummaryShape: 1艇(comparison null・boatIndex null)も通る', () => {
  const d = clone();
  d.boats = [d.boats[0]];
  d.overall.boatCount = 1;
  d.overall.quality.boatIndex = null;
  d.comparison = null;
  assert.equal(isDaySummaryShape(d), true);
});

test('isDaySummaryShape: 開始・終了が不明(null)でも通る', () => {
  const d = clone();
  d.overall.startMs = null; d.overall.endMs = null; d.overall.durationMs = null;
  assert.equal(isDaySummaryShape(d), true);
});

test('DAY_SUMMARY_REASONS は5つの理由コード', () => {
  assert.deepEqual([...DAY_SUMMARY_REASONS].sort(),
    ['gps-poor', 'no-overlap', 'not-moving', 'tacks-insufficient', 'wind-unavailable']);
});

const BROKEN = [
  ['null', () => null],
  ['文字列', () => 'x'],
  ['version 不一致', (d) => { d.version = 2; }],
  ['sourceKey 欠落', (d) => { delete d.sourceKey; }],
  ['computedAt 欠落', (d) => { delete d.computedAt; }],
  ['overall 欠落', (d) => { delete d.overall; }],
  ['overall.startMs が文字列', (d) => { d.overall.startMs = '13:21'; }],
  ['overall.durationMs が Infinity', (d) => { d.overall.durationMs = Infinity; }],
  ['overall.boatCount と boats の数が不一致', (d) => { d.overall.boatCount = 3; }],
  ['overall.quality 欠落', (d) => { delete d.overall.quality; }],
  ['overall.quality.level が未知', (d) => { d.overall.quality.level = 'bad'; }],
  ['overall.quality.note 欠落', (d) => { delete d.overall.quality.note; }],
  ['overall.quality.boatIndex 欠落', (d) => { delete d.overall.quality.boatIndex; }],
  ['overall.quality.boatIndex が範囲外', (d) => { d.overall.quality.boatIndex = 2; }],
  ['overall.windAxis 欠落', (d) => { delete d.overall.windAxis; }],
  ['overall.windAxis の ok が真偽値でない', (d) => { d.overall.windAxis = { value: { deg: 215 } }; }],
  ['overall.windAxis.value.deg 欠落', (d) => { d.overall.windAxis.value = {}; }],
  ['overall.windAxis.value.deg が 360', (d) => { d.overall.windAxis.value.deg = 360; }],
  ['overall.windRange の reason が未知', (d) => { d.overall.windRange.reason = 'oops'; }],
  ['overall.windRange ok:true で maxDeg 欠落', (d) => { d.overall.windRange = { ok: true, value: { minDeg: -8 } }; }],
  ['boats が配列でない', (d) => { d.boats = {}; }],
  ['boat.index 欠落', (d) => { delete d.boats[0].index; }],
  ['boat.name が数値', (d) => { d.boats[0].name = 1; }],
  ['boat.color 欠落', (d) => { delete d.boats[0].color; }],
  ['boat.distanceM 欠落', (d) => { delete d.boats[0].distanceM; }],
  ['boat.durationMs が NaN', (d) => { d.boats[0].durationMs = NaN; }],
  ['boat.avgSpeedMps.value が Infinity', (d) => { d.boats[0].avgSpeedMps.value = Infinity; }],
  ['boat.maxSpeedMps 欠落', (d) => { delete d.boats[0].maxSpeedMps; }],
  ['boat.tacks 欠落', (d) => { delete d.boats[0].tacks; }],
  ['boat.tacks が小数', (d) => { d.boats[0].tacks.value = 1.5; }],
  ['boat.gybes が負数', (d) => { d.boats[0].gybes.value = -1; }],
  ['boat.gybes の reason が未知', (d) => { d.boats[1].gybes.reason = 'x'; }],
  ['boat.quality 欠落', (d) => { delete d.boats[0].quality; }],
  ['boat.quality.level が未知', (d) => { d.boats[0].quality.level = 'ok'; }],
  ['comparison 欠落(undefined)', (d) => { delete d.comparison; }],
  ['comparison.comparableMs 欠落', (d) => { delete d.comparison.comparableMs; }],
  ['comparison.bestUpwind.value.vmgMps 欠落', (d) => { delete d.comparison.bestUpwind.value.vmgMps; }],
  ['comparison.bestUpwind.value.name 欠落', (d) => { delete d.comparison.bestUpwind.value.name; }],
  ['comparison.bestDownwind の reason が未知', (d) => { d.comparison.bestDownwind.reason = 'x'; }],
];

for (const [label, breakIt] of BROKEN) {
  test(`isDaySummaryShape: ${label} なら false`, () => {
    const d = clone();
    const replaced = breakIt(d);
    assert.equal(isDaySummaryShape(replaced === undefined ? d : replaced), false);
  });
}
