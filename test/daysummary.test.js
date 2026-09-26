// 今日の練習サマリ(計算)のテスト。合成GPS(等速直進・ジグザグ)で期待値を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ok, fail, daySummarySourceKey, gpsQuality, boatStats, boatLabel, computeComparison, computeDaySummary,
} from '../src/daysummary.js';
import { circDiffDeg, estimateWindAxisSeries } from '../src/windaxis.js';

const T0 = Date.UTC(2026, 7, 23, 4, 0, 0); // 2026-08-23 13:00 JST

// segments: [{ deg, toDeg?, sec, speed }] を順に等速で進む点列(1点/dtMs)。
// toDeg があると区間内で方位を deg→toDeg へ線形に回す(タック/ジャイブの回頭)。
function path(segments, { t0 = T0, dtMs = 1000, lat0 = 35.30, lon0 = 139.48, accuracy = 5 } = {}) {
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = [];
  let t = t0, lat = lat0, lon = lon0;
  for (const s of segments) {
    const n = Math.round((s.sec * 1000) / dtMs);
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0;
      const deg = s.toDeg == null ? s.deg : s.deg + circDiffDeg(s.toDeg, s.deg) * f;
      const r = (deg * Math.PI) / 180;
      const p = { t, lat, lon, speed: s.speed };
      if (accuracy != null) p.accuracy = accuracy;
      pts.push(p);
      lat += (Math.cos(r) * s.speed * dtMs) / 1000 / mLat;
      lon += (Math.sin(r) * s.speed * dtMs) / 1000 / mLon;
      t += dtMs;
    }
  }
  return pts;
}

// 風上0°のビート: 45°/315° を legSec 秒ずつ交互に走り、間に 8 秒・0.6m/s のタックを挟む。
function beatSegments(nLegs, { legSec = 90, speed = 3 } = {}) {
  const segs = [];
  for (let i = 0; i < nLegs; i++) {
    const deg = i % 2 ? 315 : 45;
    segs.push({ deg, sec: legSec, speed });
    if (i < nLegs - 1) segs.push({ deg, toDeg: i % 2 ? 45 : 315, sec: 8, speed: 0.6 });
  }
  return segs;
}

function toTrack(points, name = 'a.csv', color = '#1c72b8') {
  return {
    id: name, name, color, visible: true, points,
    tRange: { start: points[0].t, end: points[points.length - 1].t },
    windAxisOverrides: [],
  };
}

test('ok / fail は Est 型を作る', () => {
  assert.deepEqual(ok(3), { ok: true, value: 3 });
  assert.deepEqual(fail('gps-poor'), { ok: false, reason: 'gps-poor' });
});

test('daySummarySourceKey: 同じ入力なら同じキー、点数や範囲が変われば別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const b = toTrack(path([{ deg: 0, sec: 60, speed: 3 }], { t0: T0 + 1000 }), 'b.csv');
  assert.equal(daySummarySourceKey([a]), daySummarySourceKey([a]));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([a, b]));
  const shorter = toTrack(a.points.slice(0, 30));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([shorter]));
});

test('daySummarySourceKey: 点数と範囲が同じでも座標が違えば別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const moved = toTrack(a.points.map((p, i) => (i === 30 ? { ...p, lat: p.lat + 0.0001 } : p)));
  assert.equal(moved.points.length, a.points.length);
  assert.deepEqual(moved.tRange, a.tRange);
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([moved]));
});

test('daySummarySourceKey: 点数・時刻・座標が同じでも speed が違えば別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const faster = toTrack(a.points.map((p, i) => (i === 30 ? { ...p, speed: p.speed + 0.5 } : p)));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([faster]));
  // 速度列が無い(null)ことと、速度 0 は別物
  const zero = toTrack(a.points.map((p) => ({ ...p, speed: 0 })));
  const none = toTrack(a.points.map((p) => ({ ...p, speed: null })));
  assert.notEqual(daySummarySourceKey([zero]), daySummarySourceKey([none]));
});

test('daySummarySourceKey: accuracy だけ違っても別のキー', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }])); // accuracy 5
  const worse = toTrack(a.points.map((p, i) => (i === 30 ? { ...p, accuracy: 30 } : p)));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([worse]));
  // 精度列が無い GPS と、精度列がある GPS は別物
  const noAcc = toTrack(path([{ deg: 0, sec: 60, speed: 3 }], { accuracy: null }));
  assert.notEqual(daySummarySourceKey([a]), daySummarySourceKey([noAcc]));
});

test('daySummarySourceKey: 艇名・色を変えてもキーは変わらない', () => {
  const a = toTrack(path([{ deg: 0, sec: 60, speed: 3 }]));
  const renamed = { ...a, name: 'A艇', color: '#e67e22' };
  assert.equal(daySummarySourceKey([a]), daySummarySourceKey([renamed]));
});

test('gpsQuality: 1秒間隔・精度5m・欠損なしは良好', () => {
  const q = gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }]));
  assert.equal(q.level, 'good');
  assert.equal(q.note, '欠損0%・記録間隔1秒・精度5m');
});

test('gpsQuality: 記録間隔3秒は注意、6秒は不足', () => {
  assert.equal(gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { dtMs: 3000 })).level, 'caution');
  assert.equal(gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { dtMs: 6000 })).level, 'poor');
});

test('gpsQuality: 10秒超の空白が記録時間の5%以上なら注意', () => {
  const pts = path([{ deg: 0, sec: 300, speed: 3 }]);
  for (let i = 150; i < pts.length; i++) pts[i].t += 30_000; // 30秒の空白(約9%)
  assert.equal(gpsQuality(pts).level, 'caution');
});

test('gpsQuality: 精度中央値25m超は不足、精度列が無ければ精度条件は問わない', () => {
  assert.equal(gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { accuracy: 30 })).level, 'poor');
  const q = gpsQuality(path([{ deg: 0, sec: 300, speed: 3 }], { accuracy: null }));
  assert.equal(q.level, 'good');
  assert.equal(q.note, '欠損0%・記録間隔1秒');
});

test('gpsQuality: 1点しかなければ不足', () => {
  assert.equal(gpsQuality(path([{ deg: 0, sec: 1, speed: 3 }])).level, 'poor');
});

test('boatStats: 等速直進の距離・記録時間・平均速度・最高速度', () => {
  const s = boatStats(path([{ deg: 0, sec: 100, speed: 3 }])); // 100点, 99区間
  assert.ok(Math.abs(s.distanceM - 297) < 3, `distanceM=${s.distanceM}`);
  assert.equal(s.durationMs, 99_000);
  assert.ok(s.avgSpeedMps.ok && Math.abs(s.avgSpeedMps.value - 3) < 0.01);
  assert.ok(s.maxSpeedMps.ok && Math.abs(s.maxSpeedMps.value - 3) < 0.01);
});

test('boatStats: 停船区間は平均速度に含めない', () => {
  const s = boatStats(path([{ deg: 0, sec: 60, speed: 3 }, { deg: 0, sec: 60, speed: 0 }]));
  assert.ok(Math.abs(s.avgSpeedMps.value - 3) < 0.01, `avg=${s.avgSpeedMps.value}`);
});

test('boatStats: 1点だけの速度スパイクは5秒移動平均で抑える', () => {
  const pts = path([{ deg: 0, sec: 100, speed: 3 }]);
  pts[50].speed = 20;
  const s = boatStats(pts);
  assert.ok(s.maxSpeedMps.value < 7, `max=${s.maxSpeedMps.value}`);
});

test('boatStats: 1点だけなら速度は gps-poor、ずっと停船なら not-moving', () => {
  const one = boatStats(path([{ deg: 0, sec: 1, speed: 3 }]));
  assert.equal(one.distanceM, 0);
  assert.deepEqual(one.avgSpeedMps, fail('gps-poor'));
  assert.deepEqual(one.maxSpeedMps, fail('gps-poor'));
  const still = boatStats(path([{ deg: 0, sec: 60, speed: 0 }]));
  assert.deepEqual(still.avgSpeedMps, fail('not-moving'));
  assert.deepEqual(still.maxSpeedMps, fail('not-moving'));
});

function windMap(tracks) {
  return new Map(tracks.map((t) => [t, estimateWindAxisSeries(t, {})]));
}

test('computeComparison: 並走した2艇のうち速い方がクローズVMG最高艇', () => {
  const a = toTrack(path(beatSegments(5, { speed: 3 })), 'a.csv', '#1c72b8');
  const b = toTrack(path(beatSegments(5, { speed: 2.5 }), { lon0: 139.481 }), 'b.csv', '#e67e22');
  const c = computeComparison([a, b], windMap([a, b]));
  assert.ok(c.comparableMs.ok && c.comparableMs.value > 0);
  assert.equal(c.comparableMs.value % 30_000, 0);
  assert.ok(c.bestUpwind.ok);
  assert.equal(c.bestUpwind.value.index, 0);
  assert.equal(c.bestUpwind.value.name, 'a.csv');
  assert.equal(c.bestUpwind.value.color, '#1c72b8');
  assert.ok(c.bestUpwind.value.vmgMps > 1.5);
  // 風下を走っていないので、ランニングは比較できない
  assert.deepEqual(c.bestDownwind, fail('no-overlap'));
});

test('computeComparison: 時間帯が重ならなければ no-overlap', () => {
  const a = toTrack(path(beatSegments(5)), 'a.csv');
  const b = toTrack(path(beatSegments(5), { t0: T0 + 86_400_000 }), 'b.csv');
  const c = computeComparison([a, b], windMap([a, b]));
  assert.deepEqual(c.comparableMs, fail('no-overlap'));
  assert.deepEqual(c.bestUpwind, fail('no-overlap'));
  assert.deepEqual(c.bestDownwind, fail('no-overlap'));
});

test('computeComparison: どの艇にも風軸系列がなければ wind-unavailable', () => {
  const a = toTrack(path([{ deg: 0, sec: 300, speed: 3 }]), 'a.csv');
  const b = toTrack(path([{ deg: 0, sec: 300, speed: 3 }], { lon0: 139.481 }), 'b.csv');
  const c = computeComparison([a, b], new Map([[a, []], [b, []]]));
  assert.deepEqual(c.comparableMs, fail('wind-unavailable'));
  assert.deepEqual(c.bestUpwind, fail('wind-unavailable'));
  assert.deepEqual(c.bestDownwind, fail('wind-unavailable'));
});

test('boatLabel: 名前が無ければ id、色が無ければ #888。常に文字列', () => {
  assert.deepEqual(boatLabel({ id: 'x.csv', name: 'A艇', color: '#123456' }), { name: 'A艇', color: '#123456' });
  assert.deepEqual(boatLabel({ id: 'x.csv' }), { name: 'x.csv', color: '#888' });
  assert.deepEqual(boatLabel({ id: 7 }), { name: '7', color: '#888' });
});

test('computeDaySummary: 1艇・4タックのビート', () => {
  const a = toTrack(path(beatSegments(5)), 'a.csv');
  const s = computeDaySummary([a], { marks: [], now: 123 });
  assert.equal(s.version, 1);
  assert.equal(s.computedAt, 123);
  assert.equal(s.sourceKey, daySummarySourceKey([a]));
  assert.equal(s.overall.boatCount, 1);
  assert.equal(s.overall.startMs, a.tRange.start);
  assert.equal(s.overall.endMs, a.tRange.end);
  assert.equal(s.overall.durationMs, a.tRange.end - a.tRange.start);
  assert.equal(s.overall.quality.level, 'good');
  assert.equal(s.overall.quality.boatIndex, null);
  assert.deepEqual(s.boats[0].tacks, ok(4));
  assert.deepEqual(s.boats[0].gybes, ok(0));
  assert.equal(s.boats[0].name, 'a.csv');
  assert.equal(s.boats[0].index, 0);
  assert.ok(s.overall.windAxis.ok);
  assert.ok(Math.abs(circDiffDeg(s.overall.windAxis.value.deg, 0)) <= 5,
    `deg=${s.overall.windAxis.value.deg}`);
  // 推定点の時間幅が約5分(<10分)なので変動幅は出さない
  assert.deepEqual(s.overall.windRange, fail('tacks-insufficient'));
  // 1艇なら艇間比較はない
  assert.equal(s.comparison, null);
});

test('computeDaySummary: 10分以上のビートなら変動幅を出す', () => {
  const a = toTrack(path(beatSegments(13)), 'a.csv');
  const s = computeDaySummary([a], { now: 0 });
  assert.ok(s.overall.windRange.ok);
  assert.ok(Math.abs(s.overall.windRange.value.minDeg) <= 3);
  assert.ok(Math.abs(s.overall.windRange.value.maxDeg) <= 3);
  assert.ok(s.overall.windRange.value.minDeg <= s.overall.windRange.value.maxDeg);
});

test('computeDaySummary: タックが無ければ推定風軸は 0 ではなく理由', () => {
  const a = toTrack(path([{ deg: 0, sec: 300, speed: 3 }]), 'a.csv');
  const s = computeDaySummary([a], { now: 0 });
  assert.deepEqual(s.boats[0].tacks, ok(0));
  assert.deepEqual(s.overall.windAxis, fail('tacks-insufficient'));
  assert.deepEqual(s.overall.windRange, fail('tacks-insufficient'));
});

test('computeDaySummary: ジャイブだけならタック0・推定風軸は理由表示', () => {
  const segs = [
    { deg: 135, sec: 90, speed: 3 }, { deg: 135, toDeg: 225, sec: 8, speed: 3 },
    { deg: 225, sec: 90, speed: 3 }, { deg: 225, toDeg: 135, sec: 8, speed: 3 },
    { deg: 135, sec: 90, speed: 3 },
  ];
  const s = computeDaySummary([toTrack(path(segs), 'a.csv')], { now: 0 });
  assert.deepEqual(s.boats[0].tacks, ok(0));
  assert.deepEqual(s.boats[0].gybes, ok(2));
  assert.deepEqual(s.overall.windAxis, fail('tacks-insufficient'));
});

test('computeDaySummary: GPS品質が不足ならタック数と推定風軸は gps-poor', () => {
  const a = toTrack(path(beatSegments(5), { dtMs: 10_000 }), 'a.csv');
  const s = computeDaySummary([a], { now: 0 });
  assert.equal(s.overall.quality.level, 'poor');
  assert.deepEqual(s.boats[0].tacks, fail('gps-poor'));
  assert.deepEqual(s.boats[0].gybes, fail('gps-poor'));
  assert.deepEqual(s.overall.windAxis, fail('gps-poor'));
});

test('computeDaySummary: 一部の艇が不足でも、他の艇から推定風軸を出す', () => {
  const good = toTrack(path(beatSegments(5)), 'good.csv');
  const poor = toTrack(path(beatSegments(5), { dtMs: 10_000, lon0: 139.481 }), 'poor.csv');
  const s = computeDaySummary([good, poor], { now: 0 });
  assert.equal(s.overall.quality.level, 'poor');
  assert.equal(s.overall.quality.boatIndex, 1);
  assert.ok(!s.overall.quality.note.includes('poor.csv')); // 艇名は note に埋め込まない
  assert.ok(s.overall.windAxis.ok);
  assert.ok(Math.abs(circDiffDeg(s.overall.windAxis.value.deg, 0)) <= 5);
});

test('computeDaySummary: 2艇なら艇間比較を持つ', () => {
  const a = toTrack(path(beatSegments(5, { speed: 3 })), 'a.csv');
  const b = toTrack(path(beatSegments(5, { speed: 2.5 }), { lon0: 139.481 }), 'b.csv');
  const s = computeDaySummary([a, b], { now: 0 });
  assert.equal(s.overall.boatCount, 2);
  assert.notEqual(s.comparison, null);
  assert.equal(s.comparison.bestUpwind.value.index, 0);
});

test('computeDaySummary: 実行時間は実データ相当(3艇×約1.3万点)でも1秒未満', () => {
  const tracks = [0, 1, 2].map((i) => toTrack(
    path(beatSegments(140, { legSec: 90 }), { lon0: 139.48 + i * 0.001 }), `b${i}.csv`));
  const t0 = performance.now();
  computeDaySummary(tracks, { now: 0 });
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `computeDaySummary took ${ms.toFixed(0)}ms`);
});
