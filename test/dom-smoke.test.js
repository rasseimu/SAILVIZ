// DOM層（renderer/playback/timeline）のヘッドレス統合スモーク。
// canvas 2D context / requestAnimationFrame / performance をモックし、
// 実サンプルCSVから組んだトラックで例外なく動作することを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCsv } from '../src/csv.js';
import { parseGpsPoints, rejectOutliers } from '../src/gps.js';
import { computeBounds, fitTransform } from '../src/projection.js';
import { globalRange } from '../src/timeaxis.js';
import { drawScene } from '../src/renderer.js';
import { createTimeline } from '../src/timeline.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// 呼ばれたメソッド名を記録するモック 2D context
function mockCtx() {
  const calls = {};
  const rec = (name) => (...a) => { calls[name] = (calls[name] || 0) + 1; };
  return {
    calls,
    clearRect: rec('clearRect'), beginPath: rec('beginPath'), moveTo: rec('moveTo'),
    lineTo: rec('lineTo'), stroke: rec('stroke'), arc: rec('arc'), fill: rec('fill'),
    closePath: rec('closePath'), fillRect: rec('fillRect'), setLineDash: rec('setLineDash'),
    arcTo: rec('arcTo'), fillText: rec('fillText'), strokeText: rec('strokeText'),
    set strokeStyle(_v) {}, set fillStyle(_v) {}, set lineWidth(_v) {}, set globalAlpha(_v) {},
    set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {}, set lineJoin(_v) {},
    set lineCap(_v) {}, set shadowBlur(_v) {}, set shadowColor(_v) {},
  };
}

function loadTrack(fileName, color) {
  const text = readFileSync(join(__dir, '..', 'sample-data', fileName), 'utf8');
  const { header, rows } = parseCsv(text);
  const { points } = rejectOutliers(parseGpsPoints(header, rows));
  return {
    id: fileName, name: fileName, color, visible: true, points,
    bounds: computeBounds([{ visible: true, points }]),
    tRange: { start: points[0].t, end: points[points.length - 1].t },
  };
}

test('renderer draws a real track without throwing and strokes the polyline', () => {
  const track = loadTrack('Location0807.csv', '#1c72b8');
  assert.ok(track.points.length > 100, 'sample track has many points');
  const T = fitTransform(track.bounds, 800, 600);
  const range = globalRange([track], 'absolute');
  const ctx = mockCtx();
  assert.doesNotThrow(() => drawScene(ctx, {
    transform: T, tracks: [track], events: [], now: range.start,
    mode: 'absolute', crop: range,
  }));
  assert.ok(ctx.calls.stroke > 0, 'polyline stroked');
  assert.ok(ctx.calls.arc > 0, 'current-position marker drawn');
});

test('renderer draws a video badge at the interpolated reference-track position', () => {
  const track = loadTrack('Location0807.csv', '#1c72b8');
  const T = fitTransform(track.bounds, 800, 600);
  const range = globalRange([track], 'absolute');
  const midT = (track.tRange.start + track.tRange.end) / 2;
  const ctx = mockCtx();
  drawScene(ctx, {
    transform: T, tracks: [track], events: [], marks: [],
    videos: [{ id: 'v0', t: midT, url: 'blob:x', name: 'clip.mp4' }],
    now: range.start, mode: 'absolute', crop: range, referenceTrack: track,
  });
  const withBadge = ctx.calls.fill || 0;
  // 基準トラックが無ければバッジは描かれない
  const ctx2 = mockCtx();
  drawScene(ctx2, {
    transform: T, tracks: [track], events: [], marks: [],
    videos: [{ id: 'v0', t: midT, url: 'blob:x', name: 'clip.mp4' }],
    now: range.start, mode: 'absolute', crop: range, referenceTrack: null,
  });
  assert.ok(withBadge > (ctx2.calls.fill || 0), 'video badge adds fills when reference track present');
});

test('renderer pins a lat/lon-less tag via reference-track interpolation', () => {
  const track = loadTrack('Location0807.csv', '#1c72b8');
  const T = fitTransform(track.bounds, 800, 600);
  const range = globalRange([track], 'absolute');
  const midT = (track.tRange.start + track.tRange.end) / 2;
  const ctx = mockCtx();
  drawScene(ctx, {
    transform: T, tracks: [track],
    events: [{ kind: 'point', t: midT, tEnd: null, label: 'x', lat: null, lon: null }],
    now: range.start, mode: 'absolute', crop: range, referenceTrack: track,
  });
  const withPin = ctx.calls.fill || 0;
  // 基準トラックが無ければ補間ピンは描かれない
  const ctx2 = mockCtx();
  drawScene(ctx2, {
    transform: T, tracks: [track],
    events: [{ kind: 'point', t: midT, tEnd: null, label: 'x', lat: null, lon: null }],
    now: range.start, mode: 'absolute', crop: range, referenceTrack: null,
  });
  assert.ok(withPin > (ctx2.calls.fill || 0), 'interpolated pin adds a fill when reference track present');
});

test('renderer draws a per-track speed label at the current position', () => {
  const track = {
    id: 't', name: 't', color: '#1c72b8', visible: true,
    points: [
      { t: 0, lat: 35.0, lon: 139.0, speed: 3 },
      { t: 1000, lat: 35.001, lon: 139.001, speed: 5 },
    ],
    bounds: { minLat: 35.0, maxLat: 35.001, minLon: 139.0, maxLon: 139.001 },
    tRange: { start: 0, end: 1000 },
  };
  const T = fitTransform(track.bounds, 800, 600);
  const ctx = mockCtx();
  drawScene(ctx, {
    transform: T, tracks: [track], events: [], now: 500,
    mode: 'absolute', crop: { start: 0, end: 1000 },
  });
  assert.ok(ctx.calls.fillText > 0, 'speed label drawn as text');

  // now が軌跡の時間範囲外なら現在位置マーカーごと描かれない=速度ラベルも無し
  const ctx2 = mockCtx();
  drawScene(ctx2, {
    transform: T, tracks: [track], events: [], now: 5000,
    mode: 'absolute', crop: { start: 0, end: 1000 },
  });
  assert.ok(!ctx2.calls.fillText, 'no label when now is out of range');
});

test('renderer overlays a neon glow on the VMG winner segment', () => {
  const track = loadTrack('Location0807.csv', '#1c72b8');
  const T = fitTransform(track.bounds, 800, 600);
  const range = globalRange([track], 'absolute');
  const base = mockCtx();
  drawScene(base, {
    transform: T, tracks: [track], events: [], now: range.start,
    mode: 'absolute', crop: range, vmgWinners: [],
  });
  const neon = mockCtx();
  drawScene(neon, {
    transform: T, tracks: [track], events: [], now: range.start,
    mode: 'absolute', crop: range,
    vmgWinners: [{ track, boatId: track.id, color: '#1c72b8', lo: track.tRange.start, hi: track.tRange.end }],
  });
  assert.ok(neon.calls.stroke > base.calls.stroke, 'winner segment adds extra glow strokes');
});

test('playback advances now, clamps to range, and auto-pauses at end', () => {
  // rAF / performance をモック
  let cb = null; let idSeq = 1;
  globalThis.requestAnimationFrame = (fn) => { cb = fn; return idSeq++; };
  globalThis.cancelAnimationFrame = () => { cb = null; };
  globalThis.performance = { now: () => 0 };

  return import('../src/playback.js').then(({ createPlayback }) => {
    const ticks = [];
    const pb = createPlayback({ onTick: (n) => ticks.push(n) });
    pb.setRange({ start: 1000, end: 3000 });
    pb.setSpeed(1);
    assert.equal(pb.getNow(), 1000, 'now clamped to range start');
    pb.play();
    // フレームを手動で進める（1秒刻み）
    cb && cb(1000); // dt=1000 -> now=2000
    assert.ok(pb.getNow() > 1000 && pb.getNow() <= 3000);
    cb && cb(3000); // 大きく進めて末尾到達 -> clamp + auto pause
    assert.equal(pb.getNow(), 3000, 'clamped to range end');
    assert.equal(pb.isPlaying(), false, 'auto-paused at end');
    assert.ok(ticks.length > 0, 'onTick fired');
  });
});

test('timeline render does not throw with a fake canvas', () => {
  const ctx = mockCtx();
  const canvas = {
    width: 600, height: 48, getContext: () => ctx,
    addEventListener: () => {}, setPointerCapture: () => {}, releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, width: 600 }),
  };
  const tl = createTimeline(canvas, { onCropChange: () => {}, onScrub: () => {} });
  const track = loadTrack('Location0807.csv', '#1c72b8');
  const range = globalRange([track], 'absolute');
  assert.doesNotThrow(() => tl.render({
    range, crop: range, now: range.start,
    events: [
      { kind: 'point', t: range.start + 1000, tEnd: null, label: 'x', lat: null, lon: null },
      { kind: 'range', t: range.start + 2000, tEnd: range.start + 5000, label: 'r', lat: null, lon: null },
    ],
  }));
  assert.ok(ctx.calls.fillRect > 0, 'timeline drew rects');
});
