import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, speedAt, positionOnTracksAt } from '../src/interpolate.js';

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

// 午前・午後を別トラックで読み込んだときの動画/イベントバッジ配置。
// 時刻を含む可視トラックを探す(基準トラック優先、無ければ他の可視トラック)。
const MORNING = { visible: true, points: [{ t: 0, lat: 35.0, lon: 139.0 }, { t: 100, lat: 35.1, lon: 139.1 }] };
const AFTERNOON = { visible: true, points: [{ t: 200, lat: 35.2, lon: 139.2 }, { t: 300, lat: 35.3, lon: 139.3 }] };

test('positionOnTracksAt: 基準トラック範囲外でも別の可視トラックに配置する', () => {
  // 基準=午前。午後の時刻(t=250)は午前範囲外だが、午後トラックで配置できるべき。
  const pos = positionOnTracksAt([MORNING, AFTERNOON], MORNING, 250);
  assert.ok(pos, 'should place on the afternoon track, not null');
  assert.ok(pos.lat > 35.19 && pos.lat < 35.31, `lat in afternoon span, got ${pos?.lat}`);
});

test('positionOnTracksAt: 基準トラックが時刻を含むなら基準を優先', () => {
  const pos = positionOnTracksAt([MORNING, AFTERNOON], MORNING, 50);
  assert.ok(pos.lat > 34.99 && pos.lat < 35.11, `lat in morning span, got ${pos?.lat}`);
});

test('positionOnTracksAt: どのトラック範囲にも無ければ null', () => {
  assert.equal(positionOnTracksAt([MORNING, AFTERNOON], MORNING, 150), null);
});

test('positionOnTracksAt: 非表示トラックは無視する', () => {
  const hiddenPM = { ...AFTERNOON, visible: false };
  assert.equal(positionOnTracksAt([MORNING, hiddenPM], MORNING, 250), null);
});

test('positionOnTracksAt: 基準トラックなし(null)でも可視トラックから探す', () => {
  const pos = positionOnTracksAt([MORNING, AFTERNOON], null, 250);
  assert.ok(pos && pos.lat > 35.19, 'finds afternoon track without a reference');
});
