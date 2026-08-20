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
  // ドラッグで下へ50px -> 内容が下がる = world中心(北正y)は上へ
  const T3 = pan(T, 0, 50);
  assert.ok(T3.cy > 0);
  assert.equal(T3.cx, 0);
});

const TR = { scale: 100, cx: 0, cy: 0, w: 800, h: 600, proj: null, rot: Math.PI / 2 };

test('rot=0 (undefined) keeps legacy mapping', () => {
  assert.deepEqual(worldToScreen({ x: 0, y: 1 }, { ...T, rot: 0 }), worldToScreen({ x: 0, y: 1 }, T));
});

test('90° rotation maps north (+y) to screen right', () => {
  const s = worldToScreen({ x: 0, y: 1 }, TR);
  assert.ok(Math.abs(s.px - 500) < 1e-9 && Math.abs(s.py - 300) < 1e-9);
});

test('screenToWorld inverts worldToScreen under rotation', () => {
  const w0 = { x: 0.7, y: -0.3 };
  const w1 = screenToWorld(worldToScreen(w0, TR), TR);
  assert.ok(Math.abs(w1.x - w0.x) < 1e-9 && Math.abs(w1.y - w0.y) < 1e-9);
});

test('zoomAt keeps cursor world point fixed under rotation', () => {
  const cursor = { px: 550, py: 200 };
  const before = screenToWorld(cursor, TR);
  const T2 = zoomAt(TR, cursor.px, cursor.py, 2);
  const after = screenToWorld(cursor, T2);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
});

test('pan grabs the world point under the cursor under rotation', () => {
  // ドラッグ前後で、カーソル下のworld点が (dpx,dpy) ぶん移動した先のカーソルに一致する。
  const cursor = { px: 500, py: 250 }, d = { dpx: 40, dpy: -25 };
  const grabbed = screenToWorld(cursor, TR);
  const T2 = pan(TR, d.dpx, d.dpy);
  const moved = screenToWorld({ px: cursor.px + d.dpx, py: cursor.py + d.dpy }, T2);
  assert.ok(Math.abs(moved.x - grabbed.x) < 1e-9 && Math.abs(moved.y - grabbed.y) < 1e-9);
});
