// test/sailbands.test.js
// クローズ/ランニングの帯(座標はダミー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointOfSailAt, pointOfSailBands } from '../src/sailbands.js';

const DEG = 1 / 111195; // 緯度 1m 相当
const NORTH = [{ tMs: 0, windFromDeg: 0 }]; // 北風

// legs: [{sec, hdg}] を 1Hz・3 m/s で順に走る(t は t0 秒から)
function run(legs, t0 = 0) {
  const points = [];
  let lat = 0, lon = 0, t = t0;
  for (const leg of legs) {
    for (let j = 0; j < leg.sec; j++) {
      const r = leg.hdg * Math.PI / 180;
      lat += 3 * Math.cos(r) * DEG; lon += 3 * Math.sin(r) * DEG;
      points.push({ t: t * 1000, lat, lon }); t++;
    }
  }
  return points;
}
const boat = (points, extra = {}) => ({ visible: true, points, tRange: { start: points[0].t, end: points.at(-1).t }, ...extra });

test('pointOfSailAt: 風軸に対する進路でクローズ/ランニング。リーチ・止まっている・風軸なしは null', () => {
  assert.equal(pointOfSailAt(run([{ sec: 30, hdg: 45 }]), NORTH, 15000), 'upwind');
  assert.equal(pointOfSailAt(run([{ sec: 30, hdg: 150 }]), NORTH, 15000), 'downwind');
  assert.equal(pointOfSailAt(run([{ sec: 30, hdg: 90 }]), NORTH, 15000), null);
  const still = Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, lat: 0, lon: 0 }));
  assert.equal(pointOfSailAt(still, NORTH, 15000), null);
  assert.equal(pointOfSailAt(run([{ sec: 30, hdg: 45 }]), [], 15000), null);
});

test('pointOfSailBands: 上り→下りを2本の帯にし、短い切れ目(回航)はちらつかせない', () => {
  const tr = boat(run([{ sec: 120, hdg: 45 }, { sec: 4, hdg: 90 }, { sec: 120, hdg: 160 }]));
  const wind = new Map([[tr, NORTH]]);
  const bands = pointOfSailBands([tr], wind, { range: { start: 0, end: 243000 }, mode: 'absolute' });
  assert.deepEqual(bands.map((b) => b.kind), ['upwind', 'downwind']);
  assert.ok(bands[0].start <= 4000 && Math.abs(bands[0].end - 120000) <= 6000, JSON.stringify(bands[0]));
  assert.ok(Math.abs(bands[1].start - 124000) <= 6000 && bands[1].end >= 236000, JSON.stringify(bands[1]));
});

test('pointOfSailBands: 艇の多数決。同数なら帯なし。風軸の無い艇・非表示の艇は数えない', () => {
  const up = boat(run([{ sec: 60, hdg: 45 }])), up2 = boat(run([{ sec: 60, hdg: 315 }]));
  const down = boat(run([{ sec: 60, hdg: 170 }]));
  const range = { start: 0, end: 59000 };
  const w = (...ts) => new Map(ts.map((t) => [t, NORTH]));
  assert.deepEqual(pointOfSailBands([up, up2, down], w(up, up2, down), { range }).map((b) => b.kind), ['upwind']);
  assert.deepEqual(pointOfSailBands([up, down], w(up, down), { range }), []);
  assert.deepEqual(pointOfSailBands([up, down], w(down), { range }).map((b) => b.kind), ['downwind']);
  const hidden = { ...down, visible: false };
  assert.deepEqual(pointOfSailBands([up, hidden], w(up, hidden), { range }).map((b) => b.kind), ['upwind']);
});

test('pointOfSailBands: elapsed は各艇自身の開始を0に。範囲が空・艇なしは []', () => {
  const late = boat(run([{ sec: 60, hdg: 45 }], 5000)); // 5000 秒後に開始
  const bands = pointOfSailBands([late], new Map([[late, NORTH]]), { range: { start: 0, end: 59000 }, mode: 'elapsed' });
  assert.deepEqual(bands.map((b) => b.kind), ['upwind']);
  assert.deepEqual(pointOfSailBands([late], new Map([[late, NORTH]]), { range: { start: 0, end: 59000 }, mode: 'absolute' }), []);
  assert.deepEqual(pointOfSailBands([], new Map(), { range: { start: 0, end: 1 } }), []);
  assert.deepEqual(pointOfSailBands([late], new Map([[late, NORTH]]), { range: { start: 5, end: 5 } }), []);
});
