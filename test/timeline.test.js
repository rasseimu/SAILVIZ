import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveCropRange, cropStartTo, pinHitIndex } from '../src/timeline.js';

const range = { start: 0, end: 100 };

test('moveCropRange shifts window and keeps width', () => {
  const c = moveCropRange({ start: 20, end: 40 }, 10, range);
  assert.deepEqual(c, { start: 30, end: 50 });
});

test('moveCropRange clamps at range start keeping width', () => {
  const c = moveCropRange({ start: 20, end: 40 }, -50, range);
  assert.deepEqual(c, { start: 0, end: 20 });
});

test('moveCropRange clamps at range end keeping width', () => {
  const c = moveCropRange({ start: 20, end: 40 }, 100, range);
  assert.deepEqual(c, { start: 80, end: 100 });
});

test('cropStartTo moves start keeping width', () => {
  const c = cropStartTo({ start: 20, end: 40 }, 55, range);
  assert.deepEqual(c, { start: 55, end: 75 });
});

test('cropStartTo clamps so end stays within range', () => {
  const c = cropStartTo({ start: 20, end: 40 }, 95, range);
  assert.deepEqual(c, { start: 80, end: 100 });
});

test('cropStartTo clamps at range start', () => {
  const c = cropStartTo({ start: 20, end: 40 }, -10, range);
  assert.deepEqual(c, { start: 0, end: 20 });
});

test('pinHitIndex returns nearest pin within tolerance', () => {
  assert.equal(pinHitIndex([10, 50, 90], 52, 8), 1);
});

test('pinHitIndex returns -1 when none within tolerance', () => {
  assert.equal(pinHitIndex([10, 50, 90], 30, 8), -1);
});

test('pinHitIndex picks the closest when two are in range', () => {
  assert.equal(pinHitIndex([48, 54], 50, 8), 0);
});
