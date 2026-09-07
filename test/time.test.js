import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime } from '../src/time.js';

test('ns integer -> ms', () => {
  // 1786078509603689000 ns == 1786078509603.689 ms
  assert.equal(parseTime(1786078509603689000), 1786078509603.689);
});

test('ns string -> ms', () => {
  assert.equal(parseTime('1786078509603689000'), 1786078509603.689);
});

test('ms-scale number passes through', () => {
  assert.equal(parseTime(1786078509603), 1786078509603);
});

test('ISO string -> ms', () => {
  assert.equal(parseTime('2026-08-07T00:00:00.000Z'), Date.parse('2026-08-07T00:00:00.000Z'));
});

test('garbage -> NaN', () => {
  assert.ok(Number.isNaN(parseTime('not-a-time')));
  assert.ok(Number.isNaN(parseTime('')));
});

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
