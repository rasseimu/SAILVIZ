import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, deserializeProject, PROJECT_VERSION } from '../src/project.js';

function sampleState() {
  return {
    mode: 'elapsed',
    accuracyFilter: false,
    crop: { start: 10, end: 90 },
    tracks: [{
      id: 'a.csv', name: 'a.csv', color: '#1c72b8', visible: true,
      points: [{ t: 0, lat: 35, lon: 139 }, { t: 1000, lat: 35.1, lon: 139.1 }],
      bounds: { minLat: 35, maxLat: 35.1, minLon: 139, maxLon: 139.1 },
      tRange: { start: 0, end: 1000 },
    }],
    events: [{ kind: 'point', t: 500, tEnd: null, label: 'タック', lat: null, lon: null }],
    marks: [{ id: 'mk0', lat: 35.05, lon: 139.05, shape: 'triangle', color: '#e02020' }],
    pins: [250, 750],
    videos: [{ id: 'vid0', t: 300, url: 'blob:xyz', name: 'v.mp4', durationMs: 5000 }],
    reflections: [{ id: 'r1', createdAt: 1, text: 'メモ', people: [], videos: [], wind: null, practice: null }],
    // 直列化されてはいけないもの
    transform: { scale: 1, cx: 0, cy: 0, w: 800, h: 600, proj: () => {} },
  };
}

test('serialize→deserialize でトラック/タグ/マーク/ピン/動画メタ/反省/モード/クロップが保たれる', () => {
  const out = deserializeProject(serializeProject(sampleState(), { savedAt: '2026-08-17T00:00:00.000Z' }));
  assert.equal(out.mode, 'elapsed');
  assert.equal(out.accuracyFilter, false);
  assert.deepEqual(out.crop, { start: 10, end: 90 });
  assert.equal(out.tracks[0].points.length, 2);
  assert.equal(out.marks[0].shape, 'triangle');
  assert.equal(out.marks[0].lat, 35.05);
  assert.deepEqual(out.pins, [250, 750]);
  assert.equal(out.videos[0].name, 'v.mp4');
  assert.equal(out.reflections[0].text, 'メモ');
});

test('transform と video.url は保存オブジェクトに含まれない', () => {
  const saved = serializeProject(sampleState(), { savedAt: 's' });
  assert.equal('transform' in saved, false);
  assert.equal('url' in saved.videos[0], false);
  assert.equal(saved.version, PROJECT_VERSION);
  assert.equal(saved.savedAt, 's');
});

test('version 不一致は throw', () => {
  assert.throws(() => deserializeProject({ version: 999 }));
  assert.throws(() => deserializeProject(null));
});
