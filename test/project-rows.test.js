// test/project-rows.test.js
// decomposeProject(旧JSON→行)/ assembleProject(行→旧JSON)の往復一致。
// 純関数なので node:sqlite 不要。実データ(data/projects)全件で元と一致することを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decomposeProject, assembleProject } from '../server/domain/projectRows.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ_DIR = join(ROOT, 'data', 'projects');

function roundTrip(proj, legacyName) {
  return assembleProject(decomposeProject(proj, { legacyName, pdId: 'pd_test', now: 123 }));
}

test('最小プロジェクトが往復一致', () => {
  const proj = {
    version: 3, savedAt: '2026-09-01T00:00:00.000Z', mode: 'absolute', accuracyFilter: true,
    crop: { start: 0, end: 0 }, tracks: [], events: [], marks: [], pins: [], videos: [], reflections: [],
  };
  assert.deepStrictEqual(roundTrip(proj, 'x.sailviz.json'), proj);
});

test('source 無し・tRange 有りのトラックが往復一致(旧/デモ形)', () => {
  const proj = {
    version: 3, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 1 },
    tracks: [{ id: 't1', name: '1', color: '#e6194B', visible: true,
      points: [{ t: 1.5, lat: 35.1, lon: 139.2, speed: 0.3 }],
      bounds: { minLat: 35.1, maxLat: 35.1, minLon: 139.2, maxLon: 139.2 }, tRange: { start: 1, end: 2 } }],
    events: [], marks: [], pins: [], videos: [], reflections: [],
  };
  assert.deepStrictEqual(roundTrip(proj, 'x.sailviz.json'), proj);
});

test('source 有り・tRange 無しのトラックが往復一致(新規取込形)', () => {
  const proj = {
    mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
    tracks: [{ id: 'imp_1', name: '4321', color: '#3cb44b', visible: false,
      points: [{ t: 1, lat: 35, lon: 139, speed: 1, bearing: 90, accuracy: 5 }],
      bounds: { minLat: 35, maxLat: 35, minLon: 139, maxLon: 139 },
      source: { importId: 'imp_1', filename: '4321_20261003-1306.csv', boatNumber: '4321', uploadedAt: 999 } }],
    events: [], marks: [], pins: [], videos: [], reflections: [],
  };
  assert.deepStrictEqual(roundTrip(proj, 'x.sailviz.json'), proj);
});

test('reflections と未知キー(daySummary/practiceDate)が往復一致', () => {
  const proj = {
    version: 3, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
    practiceDate: 1788361200000, daySummary: { v: 1, note: 'x' }, basemap: null,
    tracks: [], events: [], marks: [], pins: [], videos: [],
    reflections: [{ id: 'refl1_0', createdAt: 100, text: 'a', people: ['村瀬 礼'], videos: [],
      wind: null, practice: null, notes: { goal: 'g', issue: '', discovery: '' } },
      { id: 'refl1_1', createdAt: 200, text: 'b', people: [], videos: [], wind: null, practice: null, notes: {} }],
  };
  assert.deepStrictEqual(roundTrip(proj, 'x.sailviz.json'), proj);
});

test('実データ data/projects/*.json が全件往復一致', () => {
  if (!existsSync(PROJ_DIR)) { assert.ok(true, 'no corpus'); return; }
  const files = readdirSync(PROJ_DIR).filter((f) => f.endsWith('.sailviz.json'));
  assert.ok(files.length > 0, 'corpus not empty');
  for (const f of files) {
    const proj = JSON.parse(readFileSync(join(PROJ_DIR, f), 'utf8'));
    assert.deepStrictEqual(roundTrip(proj, f), proj, `round-trip mismatch for ${f}`);
  }
});

test('denormalized date はファイル名から導出(practiceDate 欠落時)', () => {
  const rows = decomposeProject({ tracks: [], reflections: [] }, { legacyName: 'sailviz-20260903-0844.sailviz.json', pdId: 'pd_x', now: 1 });
  assert.equal(rows.practiceDay.date, '2026-09-03');
});
