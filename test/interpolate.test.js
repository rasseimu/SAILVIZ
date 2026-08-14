import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAt } from '../src/interpolate.js';

const PTS = [
  { t: 0, lat: 35.0, lon: 139.0 },
  { t: 1000, lat: 35.0, lon: 139.2 },
  { t: 2000, lat: 35.4, lon: 139.2 },
];

test('exact endpoints', () => {
  assert.deepEqual(positionAt(PTS, 0), { lat: 35.0, lon: 139.0 });
  assert.deepEqual(positionAt(PTS, 2000), { lat: 35.4, lon: 139.2 });
});

test('linear interpolation mid-segment', () => {
  const p = positionAt(PTS, 500);
  assert.ok(Math.abs(p.lat - 35.0) < 1e-9);
  assert.ok(Math.abs(p.lon - 139.1) < 1e-9);
});

test('out of range -> null', () => {
  assert.equal(positionAt(PTS, -1), null);
  assert.equal(positionAt(PTS, 2001), null);
});

test('empty -> null', () => {
  assert.equal(positionAt([], 0), null);
});
