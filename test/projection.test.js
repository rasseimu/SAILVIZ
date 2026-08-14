import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBounds, makeProjection, project, fitTransform } from '../src/projection.js';

function track(points) {
  return { visible: true, points };
}

test('computeBounds over visible tracks', () => {
  const b = computeBounds([
    track([{ lat: 35.0, lon: 139.0 }, { lat: 35.5, lon: 139.5 }]),
    track([{ lat: 34.9, lon: 139.6 }]),
  ]);
  assert.deepEqual(b, { minLat: 34.9, maxLat: 35.5, minLon: 139.0, maxLon: 139.6 });
});

test('computeBounds ignores invisible + empty -> null', () => {
  assert.equal(computeBounds([{ visible: false, points: [{ lat: 1, lon: 1 }] }]), null);
});

test('project: north is +y, east is +x, origin at center', () => {
  const b = { minLat: 35, maxLat: 36, minLon: 139, maxLon: 140 };
  const proj = makeProjection(b);
  const center = project(35.5, 139.5, proj);
  assert.ok(Math.abs(center.x) < 1e-9 && Math.abs(center.y) < 1e-9);
  const north = project(36, 139.5, proj);
  assert.ok(north.y > 0);
  const east = project(35.5, 140, proj);
  assert.ok(east.x > 0);
});

test('fitTransform keeps aspect ratio (uniform scale)', () => {
  const b = { minLat: 35, maxLat: 35.1, minLon: 139, maxLon: 139.2 };
  const t = fitTransform(b, 800, 400, 0.05);
  assert.ok(t.scale > 0 && Number.isFinite(t.scale));
  assert.equal(t.w, 800);
  assert.equal(t.h, 400);
});
