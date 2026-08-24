import { test } from 'node:test';
import assert from 'node:assert/strict';
import { practiceSummary } from '../src/summary.js';

test('practiceSummary: 件数・風・ラベルを拾う(大きな points には触れない)', () => {
  const project = {
    savedAt: '2026-08-23T02:00:00.000Z',
    tracks: [{ points: [1, 2, 3] }, { points: [] }],
    events: [{}],
    videos: [{}, {}, {}],
    reflections: [
      { wind: null },
      { wind: { dir: '南西', speed: 4.2 } },
    ],
  };
  const s = practiceSummary(project, { name: 'sailviz-20260823-1100.sailviz.json' });
  assert.equal(s.label, '2026-08-23 11:00');
  assert.equal(s.trackCount, 2);
  assert.equal(s.reflectionCount, 2);
  assert.equal(s.videoCount, 3);
  assert.equal(s.eventCount, 1);
  assert.equal(s.wind, '南西 4.2m/s');
});

test('practiceSummary: 欠損フィールドは 0/null に丸める', () => {
  const s = practiceSummary({}, {});
  assert.equal(s.trackCount, 0);
  assert.equal(s.reflectionCount, 0);
  assert.equal(s.videoCount, 0);
  assert.equal(s.eventCount, 0);
  assert.equal(s.wind, null);
  assert.equal(s.label, '');
});

test('practiceSummary: 風は最初に wind を持つ反省から(speed 0 も保持)', () => {
  const s = practiceSummary({ reflections: [{ wind: null }, { wind: { dir: '北', speed: 0 } }] }, {});
  assert.equal(s.wind, '北 0m/s');
});

test('practiceSummary: name 無しは savedAt をラベルに使う', () => {
  const s = practiceSummary({ savedAt: '2026-08-23T02:00:00.000Z' }, {});
  assert.equal(s.label, '2026-08-23T02:00:00.000Z');
});
