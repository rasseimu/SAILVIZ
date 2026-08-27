import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTuning, collectTuningRows, reflectionTimeMs, activeBoats, FOCUS_BOATS, TUNING_PARAMS } from '../src/tuning.js';

test('TUNING_PARAMS は RIG_FIELDS から boatNo を除いた11項目', () => {
  assert.ok(!TUNING_PARAMS.includes('boatNo'));
  assert.equal(TUNING_PARAMS.length, 11);
  assert.ok(TUNING_PARAMS.includes('rake'));
});

test('reflectionTimeMs: practice.startMs を最優先', () => {
  const r = { practice: { startMs: 1000 }, createdAt: 9999 };
  assert.equal(reflectionTimeMs(r, {}), 1000);
});

test('reflectionTimeMs: practice が無ければ project 最古実データ→createdAt', () => {
  const proj = { tracks: [{ tRange: { start: 500 } }], videos: [{ t: 800 }] };
  assert.equal(reflectionTimeMs({ createdAt: 9999 }, proj), 500);
  assert.equal(reflectionTimeMs({ createdAt: 9999 }, {}), 9999);
});

test('collectTuning: 艇別・パラメータ別に時系列化し6艇のみ・昇順・null除外', () => {
  const entries = [
    { project: { reflections: [
      { practice: { startMs: 200 }, rig: { boatNo: 4899, rake: 10, gear: null } },
      { practice: { startMs: 100 }, rig: { boatNo: 4899, rake: 8 } },
      { practice: { startMs: 150 }, rig: { boatNo: 9999, rake: 5 } }, // 対象外
    ] } },
    { project: { reflections: [
      { practice: { startMs: 300 }, rig: { boatNo: 4304, rake: 12 } },
    ] } },
  ];
  const out = collectTuning(entries);
  assert.deepEqual(out.boats, [4899, 4304]); // 出現順(FOCUS_BOATS内)
  assert.deepEqual(out.series.rake[4899], [{ tMs: 100, value: 8 }, { tMs: 200, value: 10 }]);
  assert.deepEqual(out.series.rake[4304], [{ tMs: 300, value: 12 }]);
  assert.equal(out.series.gear[4899], undefined); // null しか無い欄は空
  assert.deepEqual(out.domain, { min: 100, max: 300 });
});

test('collectTuning: 空入力は domain=null', () => {
  const out = collectTuning([]);
  assert.equal(out.domain, null);
  assert.deepEqual(out.boats, []);
});

test('collectTuningRows: 6艇のみ・tMs昇順(同時刻は艇番号順)・rig保持', () => {
  const entries = [
    { project: { reflections: [
      { practice: { startMs: 200 }, rig: { boatNo: 4859, rake: 9 } },
      { practice: { startMs: 200 }, rig: { boatNo: 4304, rake: 12 } },
      { practice: { startMs: 100 }, rig: { boatNo: 4899, rake: 8 } },
      { practice: { startMs: 150 }, rig: { boatNo: 9999, rake: 5 } }, // 対象外
    ] } },
  ];
  const rows = collectTuningRows(entries);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.tMs, r.boat]), [[100, 4899], [200, 4304], [200, 4859]]);
  assert.equal(rows[0].rig.rake, 8);
});

test('collectTuningRows: 空入力は空配列', () => {
  assert.deepEqual(collectTuningRows([]), []);
});

test('activeBoats: all は全艇、艇番号は該当艇のみ', () => {
  const boats = [4899, 4859, 4304];
  assert.deepEqual(activeBoats('all', boats), boats);
  assert.deepEqual(activeBoats(null, boats), boats);
  assert.deepEqual(activeBoats('4859', boats), [4859]);
  assert.deepEqual(activeBoats(4859, boats), [4859]);
});

test('activeBoats: データの無い艇を選ぶと空', () => {
  assert.deepEqual(activeBoats('4677', [4899, 4304]), []);
});
