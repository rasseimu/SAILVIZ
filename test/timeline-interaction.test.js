import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline } from '../src/timeline.js';

// ヘッドレスでポインタ操作を検証するためのcanvasスタブ。
// tToX が 1:1 になるよう width=1000, range=[0,1000] を使う。
const ACTIVE_CROP = 'rgba(230,126,34,0.30)';

function harness(videos = []) {
  const handlers = {};
  const noop = () => {};
  const fills = []; // renderで設定された fillStyle を記録
  const ctx = new Proxy({}, {
    get: () => noop,
    set: (_t, prop, val) => { if (prop === 'fillStyle') fills.push(val); return true; },
  });
  const canvas = {
    width: 1000, height: 40, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 40 }),
    setPointerCapture: noop, releasePointerCapture: noop,
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const calls = { crop: [], scrub: [], video: [] };
  const tl = createTimeline(canvas, {
    onCropChange: (c) => calls.crop.push(c),
    onScrub: (t) => calls.scrub.push(t),
    onVideoClick: (id) => calls.video.push(id),
    onPinAdd: () => {}, onPinRemove: () => {},
  });
  tl.render({ range: { start: 0, end: 1000 }, crop: { start: 200, end: 400 }, now: 300, events: [], videos, pins: [] });
  // clientY 省略時は中央高さ(=バー以外)を既定にする。
  const fire = (type, x, y = 20) => handlers[type]({ clientX: x, clientY: y, pointerId: 1, preventDefault: noop });
  const lastRenderFills = () => { const i = fills.lastIndexOf('#c7d3dd'); return fills.slice(i); };
  return { fire, calls, lastRenderFills };
}

test('click inside crop seeks (scrub), no window move', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, calls } = harness();
    fire('pointerdown', 300);
    fire('pointerup', 300);
    assert.deepEqual(calls.scrub, [300]);
    assert.deepEqual(calls.crop, []);
  } finally { mock.timers.reset(); }
});

test('immediate drag (before long-press) scrubs only, window stays', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, calls } = harness();
    fire('pointerdown', 300);
    fire('pointermove', 340); // 400ms前
    fire('pointerup', 340);
    assert.deepEqual(calls.crop, []); // 窓は動かない
    assert.ok(calls.scrub.includes(340)); // scrubは動く
  } finally { mock.timers.reset(); }
});

test('long-press then drag moves window AND scrubs', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, calls } = harness();
    fire('pointerdown', 300);
    mock.timers.tick(400); // 長押し成立
    fire('pointermove', 340); // +40 ドラッグ
    fire('pointerup', 340);
    // 平行移動: 200..400 が +40 → 240..440
    assert.deepEqual(calls.crop.at(-1), { start: 240, end: 440 });
    // scrub も併走(ポインタ時刻へ)
    assert.ok(calls.scrub.includes(340));
  } finally { mock.timers.reset(); }
});

test('jitter/scrub during the wait still establishes long-press (regression)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, calls } = harness();
    fire('pointerdown', 300);
    fire('pointermove', 320); // 待機中に動く(scrub) — 従来はここで成立が潰れていた
    mock.timers.tick(400); // それでも400msで成立(起点は現在位置320)
    fire('pointermove', 360); // 320→360 = +40 平行移動
    fire('pointerup', 360);
    assert.deepEqual(calls.crop.at(-1), { start: 240, end: 440 });
  } finally { mock.timers.reset(); }
});

test('crop color switches to active on long-press establish and reverts on release', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, lastRenderFills } = harness();
    assert.ok(!lastRenderFills().includes(ACTIVE_CROP), '初期は通常色');
    fire('pointerdown', 300);
    mock.timers.tick(400); // 成立 → 即再描画で色変更
    assert.ok(lastRenderFills().includes(ACTIVE_CROP), '成立で掴み色');
    fire('pointerup', 300); // 解除 → 再描画で元色に戻る
    assert.ok(!lastRenderFills().includes(ACTIVE_CROP), '解除で通常色に戻る');
  } finally { mock.timers.reset(); }
});

test('clicking a video bar (top strip) fires onVideoClick, not scrub/crop', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, calls } = harness([{ id: 'vid0', t: 500, tEnd: 700 }]);
    fire('pointerdown', 600, 4); // 上端ストリップ内、バーの x 範囲(500..700)
    fire('pointerup', 600, 4);
    assert.deepEqual(calls.video, ['vid0']);
    assert.deepEqual(calls.scrub, []);
    assert.deepEqual(calls.crop, []);
  } finally { mock.timers.reset(); }
});

test('point video (unknown length) is clickable near its x', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, calls } = harness([{ id: 'vid1', t: 500, tEnd: null }]);
    fire('pointerdown', 501, 4);
    fire('pointerup', 501, 4);
    assert.deepEqual(calls.video, ['vid1']);
  } finally { mock.timers.reset(); }
});

test('video bar click below the top strip is treated as scrub, not video', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // crop=200..400。バー(500..700)は crop 外なので中央高さクリックは scrub 扱い。
    const { fire, calls } = harness([{ id: 'vid0', t: 500, tEnd: 700 }]);
    fire('pointerdown', 600, 20); // 中央高さ
    fire('pointerup', 600, 20);
    assert.deepEqual(calls.video, []);
    assert.ok(calls.scrub.length > 0);
  } finally { mock.timers.reset(); }
});

test('crop handle takes priority over an overlapping video bar', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // 左ハンドル(x=200)に重なる位置から始まる動画。上端でもハンドル操作を優先。
    const { fire, calls } = harness([{ id: 'vid0', t: 200, tEnd: 400 }]);
    fire('pointerdown', 200, 4);
    fire('pointermove', 260, 4);
    fire('pointerup', 260, 4);
    assert.deepEqual(calls.video, []);
    assert.ok(calls.crop.length > 0); // ハンドルドラッグでcrop変更
  } finally { mock.timers.reset(); }
});

test('long-press move keeps width and clamps at range end', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fire, calls } = harness();
    fire('pointerdown', 300);
    mock.timers.tick(400);
    fire('pointermove', 950); // 大きく右へ → end=1000でクランプ、幅200維持
    fire('pointerup', 950);
    assert.deepEqual(calls.crop.at(-1), { start: 800, end: 1000 });
  } finally { mock.timers.reset(); }
});
