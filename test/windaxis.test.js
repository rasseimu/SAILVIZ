import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeg, circDiffDeg, circMeanDeg, circMedianDeg, bisectorDeg, bearingDeg,
} from '../src/windaxis.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// 円周量の近さ（北またぎ対応）
const nearCirc = (a, b, eps = 0.5) =>
  assert.ok(Math.abs(circDiffDeg(a, b)) < eps, `circ ${a} != ${b}`);

test('normalizeDeg wraps into [0,360)', () => {
  near(normalizeDeg(370), 10);
  near(normalizeDeg(-10), 350);
  near(normalizeDeg(0), 0);
});

test('circDiffDeg signed shortest difference', () => {
  near(circDiffDeg(10, 350), 20);    // 10 - 350 = -340 -> +20
  near(circDiffDeg(350, 10), -20);
  near(circDiffDeg(90, 0), 90);
  near(circDiffDeg(180, 0), 180);    // antiparallel: return +180, not -180
  near(circDiffDeg(0, 180), 180);    // antiparallel: return +180, not -180
});

test('circMeanDeg averages across north', () => {
  nearCirc(circMeanDeg([350, 10]), 0);
  nearCirc(circMeanDeg([10, 20, 30]), 20);
});

test('circMedianDeg is robust to an outlier', () => {
  near(circMedianDeg([9, 10, 11, 200]), 10);   // medoid: exactly 10
  near(circMedianDeg([10, 10, 10, 200]), 10);  // all-equal: exactly 10
  near(circMedianDeg([45]), 45);               // singleton: exactly 45
  nearCirc(circMedianDeg([358, 0, 2]), 0);     // crossing north: ≈ 0
});

test('bisectorDeg picks the inner bisector', () => {
  nearCirc(bisectorDeg(45, 315), 0);    // タック: 風上
  nearCirc(bisectorDeg(135, 225), 180);  // ジャイブ: 風下
});

test('bearingDeg north/east', () => {
  nearCirc(bearingDeg({ lat: 35.30, lon: 139.48 }, { lat: 35.31, lon: 139.48 }), 0, 1);
  nearCirc(bearingDeg({ lat: 35.30, lon: 139.48 }, { lat: 35.30, lon: 139.49 }), 90, 1);
});
