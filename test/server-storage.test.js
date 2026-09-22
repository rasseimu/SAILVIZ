import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isValidProjectName, listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay, findProjectByPracticeDate,
} from '../server/storage.js';

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sailviz-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('isValidProjectName accepts .sailviz.json, rejects traversal', () => {
  assert.equal(isValidProjectName('sailviz-20260101-0900.sailviz.json'), true);
  assert.equal(isValidProjectName('../etc/passwd'), false);
  assert.equal(isValidProjectName('foo.json'), false);
  assert.equal(isValidProjectName('a/b.sailviz.json'), false);
});

test('writeProject then readProject round-trips', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260101-0900.sailviz.json';
    await writeProject(dir, name, { version: 1, hello: 'world' });
    assert.deepEqual(await readProject(dir, name), { version: 1, hello: 'world' });
  });
});

test('listProjects returns names desc with labels', async () => {
  await withTmp(async (dir) => {
    await writeProject(dir, 'sailviz-20260101-0900.sailviz.json', {});
    await writeProject(dir, 'sailviz-20260102-0900.sailviz.json', {});
    const list = await listProjects(dir);
    assert.equal(list[0].name, 'sailviz-20260102-0900.sailviz.json');
    assert.equal(typeof list[0].label, 'string');
  });
});

test('deleteProject removes file', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260101-0900.sailviz.json';
    await writeProject(dir, name, {});
    await deleteProject(dir, name);
    await assert.rejects(() => readProject(dir, name));
  });
});

test('overlay read is forgiving, write round-trips', async () => {
  await withTmp(async (dir) => {
    assert.deepEqual(await readOverlay(dir, 'progress'), {});
    await writeOverlay(dir, 'progress', { a: 1 });
    assert.deepEqual(await readOverlay(dir, 'progress'), { a: 1 });
  });
});

test('findProjectByPracticeDate は practiceDate 一致を返し、無ければ null', async () => {
  await withTmp(async (dir) => {
    const name = 'sailviz-20260909-0000.sailviz.json';
    await writeProject(dir, name, { version: 1, practiceDate: 1_700_000_000_000, reflections: [] });
    const hit = await findProjectByPracticeDate(dir, 1_700_000_000_000);
    assert.equal(hit.name, name);
    assert.equal(await findProjectByPracticeDate(dir, 999), null);
  });
});

// JST 日単位一致テスト
// BASE = Date.UTC(2026, 8, 7, 15, 0, 0) = JST 2026-09-08 00:00 = 1788793200000
// BASE + 13.5h = 1788841800000 (同日 JST 13:30)
// DIFF_DAY = Date.UTC(2026, 8, 8, 15, 0, 0) = JST 2026-09-09 00:00 (別日)
test('findProjectByPracticeDate は JST 日単位で一致する(デスクトップの時刻付き practiceDate も検出)', async () => {
  await withTmp(async (dir) => {
    const NONMID_PD = 1_788_841_800_000; // JST 2026-09-08 13:30
    const SAME_DAY_MIDNIGHT = 1_788_793_200_000; // JST 2026-09-08 00:00
    const DIFF_DAY = Date.UTC(2026, 8, 8, 15, 0, 0); // JST 2026-09-09 00:00 (別日)

    const name = 'sailviz-20260908-1330.sailviz.json';
    await writeProject(dir, name, { version: 1, practiceDate: NONMID_PD, reflections: [] });

    // 同じ JST 日の midnight で検索 → ヒット
    const hitMidnight = await findProjectByPracticeDate(dir, SAME_DAY_MIDNIGHT);
    assert.ok(hitMidnight, '同日 midnight で検索してもヒットするはず');
    assert.equal(hitMidnight.name, name);

    // 同じ JST 日の別時刻で検索 → ヒット
    const hitSameTime = await findProjectByPracticeDate(dir, NONMID_PD);
    assert.ok(hitSameTime, '同じ practiceDate で検索してもヒットするはず');
    assert.equal(hitSameTime.name, name);

    // 別日で検索 → null
    const miss = await findProjectByPracticeDate(dir, DIFF_DAY);
    assert.equal(miss, null, '別日の検索は null を返すはず');

    // practiceDate が数値でないプロジェクトはスキップされる
    const badName = 'sailviz-20260908-9999.sailviz.json';
    await writeProject(dir, badName, { version: 1, practiceDate: 'not-a-number', reflections: [] });
    const hitAfterBad = await findProjectByPracticeDate(dir, SAME_DAY_MIDNIGHT);
    assert.ok(hitAfterBad, '非数値 practiceDate プロジェクトがあってもヒットするはず');
    assert.equal(hitAfterBad.name, name);
  });
});
