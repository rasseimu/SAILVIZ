import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldToScreen, screenToWorld, pan, zoomAt } from '../src/viewport.js';

const T = { scale: 100, cx: 0, cy: 0, w: 800, h: 600, proj: null };

test('center world maps to screen center', () => {
  const s = worldToScreen({ x: 0, y: 0 }, T);
  assert.deepEqual(s, { px: 400, py: 300 });
});

test('north (+y) goes up (smaller py)', () => {
  assert.ok(worldToScreen({ x: 0, y: 1 }, T).py < 300);
});

test('screenToWorld is inverse of worldToScreen', () => {
  const w0 = { x: 0.7, y: -0.3 };
  const s = worldToScreen(w0, T);
  const w1 = screenToWorld(s, T);
  assert.ok(Math.abs(w1.x - w0.x) < 1e-9 && Math.abs(w1.y - w0.y) < 1e-9);
});

test('zoomAt keeps the cursor world point fixed', () => {
  const cursor = { px: 550, py: 200 };
  const before = screenToWorld(cursor, T);
  const T2 = zoomAt(T, cursor.px, cursor.py, 2);
  const after = screenToWorld(cursor, T2);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
  assert.ok(T2.scale === 200);
});

test('pan shifts center by pixel delta', () => {
  const T2 = pan(T, 100, 0); // ドラッグで右へ100px -> world中心は左へ
  assert.ok(T2.cx < 0);
});
