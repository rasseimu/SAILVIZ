// test/sailingspan.test.js
// 練習の最初と最後(出艇前・着艇後)を除いた帆走中の時間帯。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sailingSpan, cachedSailingSpan, outsideSpan } from '../src/sailingspan.js';

const KT = 1 / 1.943844; // 1kt を m/s で
// 1Hz の点列と速度。segs: [{sec, kt, acc?}]
function make(segs) {
  const points = [], speeds = [];
  let t = 0;
  for (const s of segs) {
    for (let i = 0; i < s.sec; i++) { points.push({ t: t * 1000, accuracy: s.acc ?? 5 }); speeds.push(s.kt * KT); t++; }
  }
  return { points, speeds };
}

test('sailingSpan: 止まっている最初と最後を除き、帆走を始めてから終えるまで', () => {
  const { points, speeds } = make([{ sec: 300, kt: 0 }, { sec: 1200, kt: 5 }, { sec: 300, kt: 0 }]);
  const span = sailingSpan(points, speeds);
  assert.ok(Math.abs(span.start - 300000) <= 1000, String(span.start));
  assert.ok(Math.abs(span.end - 1499000) <= 1000, String(span.end));
});

test('sailingSpan: 測位直後の飛び(精度が悪い・数秒だけ速い)は帆走の始まりとみなさない', () => {
  const { points, speeds } = make([
    { sec: 10, kt: 15, acc: 40 }, { sec: 20, kt: 8, acc: 5 }, { sec: 300, kt: 0 }, { sec: 1200, kt: 5 }, { sec: 60, kt: 0 },
  ]);
  const span = sailingSpan(points, speeds);
  assert.ok(Math.abs(span.start - 330000) <= 1000, String(span.start));
});

test('sailingSpan: 帆走の途中で一時的に遅くなっても(ハーバーへ戻る等)切らない / 帆走しなければ null', () => {
  const { points, speeds } = make([{ sec: 600, kt: 5 }, { sec: 600, kt: 0.5 }, { sec: 600, kt: 5 }]);
  const span = sailingSpan(points, speeds);
  assert.ok(span.start <= 1000 && span.end >= 1799000 - 1000);
  const still = make([{ sec: 600, kt: 1.5 }]);
  assert.equal(sailingSpan(still.points, still.speeds), null);
  assert.equal(sailingSpan([], []), null);
});

test('cachedSailingSpan / outsideSpan', () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, lat: 0, lon: 0 }));
  let calls = 0;
  const speedsOf = (p) => { calls++; return p.map(() => 0); };
  assert.equal(cachedSailingSpan(pts, speedsOf), null); // 止まっている
  assert.equal(cachedSailingSpan(pts, speedsOf), null);
  assert.equal(calls, 1); // 2回目はキャッシュ
  assert.equal(cachedSailingSpan(undefined, speedsOf), null);
  assert.equal(outsideSpan(5, null), false);
  assert.equal(outsideSpan(5, { start: 10, end: 20 }), true);
  assert.equal(outsideSpan(10, { start: 10, end: 20 }), false);
  assert.equal(outsideSpan(21, { start: 10, end: 20 }), true);
});
