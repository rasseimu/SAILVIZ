import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalRange, trackLookupTime, clamp, remapEventsToAxis } from '../src/timeaxis.js';

const trackA = { visible: true, tRange: { start: 1000, end: 5000 } };
const trackB = { visible: true, tRange: { start: 3000, end: 4000 } };

test('absolute range spans all visible tracks', () => {
  assert.deepEqual(globalRange([trackA, trackB], 'absolute'), { start: 1000, end: 5000 });
});

test('elapsed range starts at 0, ends at longest duration', () => {
  assert.deepEqual(globalRange([trackA, trackB], 'elapsed'), { start: 0, end: 4000 });
});

test('ignores invisible tracks; empty -> zero range', () => {
  assert.deepEqual(globalRange([{ visible: false, tRange: { start: 1, end: 2 } }], 'absolute'),
    { start: 0, end: 0 });
});

test('trackLookupTime maps by mode', () => {
  assert.equal(trackLookupTime(trackA, 500, 'absolute'), 500);
  assert.equal(trackLookupTime(trackA, 500, 'elapsed'), 1500); // start(1000)+500
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('remapEventsToAxis: absolute leaves events unchanged', () => {
  const evs = [{ kind: 'point', t: 5000, tEnd: null, label: 'a' }];
  assert.equal(remapEventsToAxis(evs, 'absolute', 1000), evs);
});

test('remapEventsToAxis: elapsed subtracts base from t and tEnd', () => {
  const evs = [
    { kind: 'point', t: 5000, tEnd: null, label: 'p' },
    { kind: 'range', t: 6000, tEnd: 8000, label: 'r' },
  ];
  const out = remapEventsToAxis(evs, 'elapsed', 1000);
  assert.equal(out[0].t, 4000);
  assert.equal(out[0].tEnd, null);
  assert.equal(out[1].t, 5000);
  assert.equal(out[1].tEnd, 7000);
  // 元配列は不変
  assert.equal(evs[0].t, 5000);
});
