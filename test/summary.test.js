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

test('practiceSummary: ラベルはトラッキング開始時刻(最古のtRange.start, JST)から', () => {
  const start = Date.parse('2026-08-23T00:27:00Z'); // = JST 09:27
  const project = {
    savedAt: '2026-08-23T10:00:00.000Z',
    tracks: [
      { tRange: { start: start + 60_000, end: start + 120_000 } },
      { tRange: { start, end: start + 90_000 } }, // こちらが最古
    ],
  };
  // ファイル名は 19:00 だが、ラベルはトラッキングの 09:27(JST) になる
  const s = practiceSummary(project, { name: 'sailviz-20260823-1900.sailviz.json' });
  assert.equal(s.label, '2026-08-23 09:27');
  assert.equal(s.trackedAt, start);
});

test('practiceSummary: tRange が無ければ従来通りファイル名ラベルにフォールバック', () => {
  const s = practiceSummary({ tracks: [{ points: [1, 2] }] }, { name: 'sailviz-20260823-1100.sailviz.json' });
  assert.equal(s.label, '2026-08-23 11:00');
  assert.equal(s.trackedAt, null);
});

test('practiceSummary: トラックが無くても動画の時刻から練習日を決める(保存日ではない)', () => {
  const vt = Date.parse('2026-08-23T00:27:00Z'); // JST 09:27
  const s = practiceSummary(
    { tracks: [], videos: [{ t: vt + 5000 }, { t: vt }] },
    { name: 'sailviz-20260824-1328.sailviz.json' }, // 保存は翌日だが…
  );
  assert.equal(s.label, '2026-08-23 09:27'); // 動画の最古時刻(=前日)を採用
  assert.equal(s.trackedAt, vt);
});

test('practiceSummary: トラックと動画の両方があれば最古を採用', () => {
  const base = Date.parse('2026-08-23T01:00:00Z');
  const s = practiceSummary({
    tracks: [{ tRange: { start: base + 600_000 } }],
    videos: [{ t: base }], // 動画の方が古い
  }, {});
  assert.equal(s.trackedAt, base);
});
