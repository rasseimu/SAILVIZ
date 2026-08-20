import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, speedAt } from '../src/interpolate.js';

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

const SPD = [
  { t: 0, lat: 35.0, lon: 139.0, speed: 2 },
  { t: 1000, lat: 35.0, lon: 139.0, speed: 4 },
  { t: 2000, lat: 35.0, lon: 139.0, speed: 6 },
];

test('speedAt interpolates the recorded speed field', () => {
  assert.equal(speedAt(SPD, 0), 2);
  assert.equal(speedAt(SPD, 500), 3); // 2→4 の中点
  assert.equal(speedAt(SPD, 2000), 6);
});

test('speedAt out of range / empty -> null', () => {
  assert.equal(speedAt(SPD, -1), null);
  assert.equal(speedAt(SPD, 2001), null);
  assert.equal(speedAt([], 0), null);
});

test('speedAt falls back to haversine/dt when speed is null', () => {
  // 経度0.001° ≈ 91.1m @lat35。dt=1s なので ~91 m/s になるはず。
  const pts = [
    { t: 0, lat: 35.0, lon: 139.0, speed: null },
    { t: 1000, lat: 35.0, lon: 139.001, speed: null },
  ];
  const v = speedAt(pts, 500);
  assert.ok(v > 80 && v < 100, `expected ~91 m/s, got ${v}`);
});
