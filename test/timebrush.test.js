import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msToX, xToMs, clampRange } from '../src/timebrush.js';

test('msToX / xToMs は往復する', () => {
  const scale = { min: 1000, max: 2000, width: 100 };
  assert.equal(msToX(1500, scale), 50);
  assert.equal(xToMs(50, scale), 1500);
});

test('msToX: min==max でも例外にならない', () => {
  assert.equal(msToX(1000, { min: 1000, max: 1000, width: 100 }), 0);
});

test('clampRange: 範囲内へ収め from<=to を保証', () => {
  assert.deepEqual(clampRange({ from: -5, to: 50 }, { min: 0, max: 40 }), { from: 0, to: 40 });
  assert.deepEqual(clampRange({ from: 30, to: 10 }, { min: 0, max: 40 }), { from: 10, to: 30 });
});
