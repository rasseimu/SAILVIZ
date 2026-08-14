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
    closePath: rec('closePath'), fillRect: rec('fillRect'),
    set strokeStyle(_v) {}, set fillStyle(_v) {}, set lineWidth(_v) {},
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
