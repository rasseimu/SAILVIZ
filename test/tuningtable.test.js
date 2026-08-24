import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTuningTable } from '../src/tuningtable.js';

const PARAMS = ['gear', 'rake'];
const LABELS = { gear: 'ギア', rake: 'レーキ' };
const COLORS = { 4899: '#f00', 4304: '#00f' };
const ROWS = [
  { tMs: 100, boat: 4899, rig: { gear: 1, rake: 6750 } },
  { tMs: 300, boat: 4304, rig: { gear: 2, rake: 6800 } },
];

test('buildTuningTable: ヘッダに日付・艇＋各パラメータラベル', () => {
  const html = buildTuningTable({ rows: ROWS, params: PARAMS, labels: LABELS, colors: COLORS, from: 0, to: 1000, fmtDate: () => '06-15' });
  assert.ok(html.includes('<table'));
  assert.ok(html.includes('日付'));
  assert.ok(html.includes('艇'));
  assert.ok(html.includes('ギア'));
  assert.ok(html.includes('レーキ'));
});

test('buildTuningTable: 期間内の行だけ・値と艇番号を表示', () => {
  const html = buildTuningTable({ rows: ROWS, params: PARAMS, labels: LABELS, colors: COLORS, from: 0, to: 200, fmtDate: () => 'D' });
  assert.ok(html.includes('4899'));      // 100 は範囲内
  assert.ok(!html.includes('4304'));     // 300 は範囲外
  assert.ok(html.includes('6750'));
});

test('buildTuningTable: 値が無い欄は空(—)で埋める', () => {
  const rows = [{ tMs: 50, boat: 4899, rig: { gear: 1 } }]; // rake 欠損
  const html = buildTuningTable({ rows, params: PARAMS, labels: LABELS, colors: COLORS, from: 0, to: 100, fmtDate: () => 'D' });
  assert.ok(html.includes('—'));
});

test('buildTuningTable: 該当行なしでも <table> を返す', () => {
  const html = buildTuningTable({ rows: [], params: PARAMS, labels: LABELS, colors: COLORS, from: 0, to: 100, fmtDate: () => 'D' });
  assert.ok(html.includes('<table'));
});
