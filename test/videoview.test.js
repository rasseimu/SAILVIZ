import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRotation, rotatedFitBox } from '../src/videoview.js';

test('nextRotation cycles 0→90→180→270→0', () => {
  assert.equal(nextRotation(0), 90);
  assert.equal(nextRotation(90), 180);
  assert.equal(nextRotation(180), 270);
  assert.equal(nextRotation(270), 0);
});

test('rotatedFitBox keeps W×H for 0/180, swaps for 90/270', () => {
  assert.deepEqual(rotatedFitBox(0, 800, 600), { w: 800, h: 600 });
  assert.deepEqual(rotatedFitBox(180, 800, 600), { w: 800, h: 600 });
  assert.deepEqual(rotatedFitBox(90, 800, 600), { w: 600, h: 800 });
  assert.deepEqual(rotatedFitBox(270, 800, 600), { w: 600, h: 800 });
});
