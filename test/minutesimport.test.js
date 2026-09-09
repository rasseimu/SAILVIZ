import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCommitRows, mergeRowsByMember, reflectionsFromRows, emptyProject,
} from '../server/minutesimport.js';
import { deserializeProject } from '../src/project.js';

test('validateCommitRows は正常な行で null を返す', () => {
  const rows = [{ fullName: '本間 由真', goal: 'g', issue: '', discovery: '', raw: '' }];
  assert.equal(validateCommitRows(rows, 1_700_000_000_000), null);
});

test('validateCommitRows は非数 practiceDate / 空 rows / 名簿外を検出する', () => {
  assert.match(validateCommitRows([{ fullName: '本間 由真' }], NaN), /practiceDate/);
  assert.match(validateCommitRows([], 1), /rows/);
  assert.match(validateCommitRows([{ fullName: '存在 しない' }], 1), /名簿外/);
});

test('mergeRowsByMember は同一 fullName を初出順で連結する', () => {
  const merged = mergeRowsByMember([
    { fullName: '本間 由真', goal: 'g1', issue: 'i1', discovery: '', raw: 'r1' },
    { fullName: '高田 咲', goal: 'x', issue: '', discovery: '', raw: '' },
    { fullName: '本間 由真', goal: 'g2', issue: '', discovery: 'd2', raw: 'r2' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].fullName, '本間 由真');
  assert.equal(merged[0].goal, 'g1\ng2');
  assert.equal(merged[0].issue, 'i1');
  assert.equal(merged[0].discovery, 'd2');
  assert.equal(merged[0].raw, 'r1\nr2');
  assert.equal(merged[1].fullName, '高田 咲');
});

test('reflectionsFromRows は決定的 id とフィールドマッピングを作る', () => {
  const refls = reflectionsFromRows({
    rows: [{ fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' }],
    now: 1720000000000,
  });
  assert.equal(refls[0].id, 'refl1720000000000_0');
  assert.equal(refls[0].createdAt, 1720000000000);
  assert.deepEqual(refls[0].people, ['本間 由真']);
  assert.equal(refls[0].text, 'r');
  assert.equal(refls[0].notes.goal, 'g');
  assert.equal(refls[0].notes.issue, 'i');
  assert.equal(refls[0].notes.discovery, 'd');
  assert.equal(refls[0].wind, null);
  assert.equal(refls[0].practice, null);
});

test('emptyProject は deserializeProject を通る骨組みを返す', () => {
  const p = emptyProject(1_700_000_000_000, '2026-09-09T00:00:00.000Z');
  assert.equal(p.version, 1);
  assert.equal(p.practiceDate, 1_700_000_000_000);
  assert.deepEqual(p.reflections, []);
  assert.doesNotThrow(() => deserializeProject(p));
});
