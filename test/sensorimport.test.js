import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSensorCsv, jstMidnightMs, jstStamp, computeBounds, buildTrack } from '../server/sensorimport.js';

// Sensor Logger 形式（time は epoch ns）。2026-09-08 09:06 JST 付近、相模湾。
const NS = 1_000_000; // ms->ns
const t0 = Date.UTC(2026, 8, 8, 0, 6, 0); // 2026-09-08 00:06 UTC = 09:06 JST
const CSV = [
  'time,latitude,longitude,speed,bearing,horizontalAccuracy',
  `${t0 * NS},35.300,139.480,3.1,90,10`,
  `${(t0 + 10000) * NS},35.301,139.481,3.2,92,10`,
  `${(t0 + 20000) * NS},35.302,139.482,3.0,88,12`,
].join('\n');

test('parseSensorCsv: 点・bounds・practiceDate(JST) を返す', () => {
  const r = parseSensorCsv(CSV);
  assert.equal(r.points.length, 3);
  assert.ok(r.bounds.minLat <= 35.300 && r.bounds.maxLat >= 35.302);
  assert.equal(r.practiceDate, jstMidnightMs(t0)); // 2026-09-08 00:00 JST
});

test('parseSensorCsv: GPS 点ゼロは throw', () => {
  assert.throws(() => parseSensorCsv('time,latitude,longitude\n'));
});

test('parseSensorCsv: 非GPSヘッダーは throw', () => {
  assert.throws(() => parseSensorCsv('label,start,end\n'), /not a gps csv/);
});

test('jstStamp: JST の YYYYMMDD-HHMM', () => {
  assert.equal(jstStamp(t0), '20260908-0906');
});

test('buildTrack: 既存 Track 形状', () => {
  const { points, bounds } = parseSensorCsv(CSV);
  const tr = buildTrack({ id: 'imp_x', name: '4649', points, bounds, colorIndex: 0, source: { importId: 'imp_x' } });
  assert.equal(tr.id, 'imp_x');
  assert.equal(tr.name, '4649');
  assert.equal(tr.visible, true);
  assert.ok(typeof tr.color === 'string');
  assert.equal(tr.points.length, 3);
  assert.ok(tr.bounds && typeof tr.bounds.minLat === 'number');
  assert.deepEqual(tr.source, { importId: 'imp_x' });
});
