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
