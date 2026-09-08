import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveUpload, readUpload, renameUpload, isValidImportId, isValidUploadFile,
  findReflectionByDate, writeProject, uploadPath,
} from '../server/storage.js';

test('isValidImportId / isValidUploadFile', () => {
  assert.equal(isValidImportId('imp_20260908_ab12'), true);
  assert.equal(isValidImportId('../evil'), false);
  assert.equal(isValidUploadFile('4649_20260908-0906.csv'), true);
  assert.equal(isValidUploadFile('../x.csv'), false);
  assert.equal(isValidUploadFile('x.json'), false);
});

test('uploadPath throws on invalid importId / filename', () => {
  assert.throws(() => uploadPath('/tmp', '../evil', 'raw.csv'), /invalid importId/);
  assert.throws(() => uploadPath('/tmp', 'imp_1', '../x.csv'), /invalid upload file/);
});

test('saveUpload -> readUpload -> renameUpload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sv-up-'));
  await saveUpload(dir, 'imp_1', 'raw.csv', 'a,b\n1,2\n');
  assert.equal(await readUpload(dir, 'imp_1', 'raw.csv'), 'a,b\n1,2\n');
  await renameUpload(dir, 'imp_1', 'raw.csv', '4649_20260908-0906.csv');
  assert.equal(await readUpload(dir, 'imp_1', '4649_20260908-0906.csv'), 'a,b\n1,2\n');
  await rm(dir, { recursive: true, force: true });
});

test('findReflectionByDate: person と practiceDate で一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sv-find-'));
  const pd = Date.UTC(2026, 8, 7, 15, 0); // 適当な JST 0 時相当
  await writeProject(dir, 'sailviz-20260908-0906-m1.sailviz.json', {
    version: 1, practiceDate: pd, reflections: [{ people: ['山田 太郎'] }],
  });
  const hit = await findReflectionByDate(dir, '山田 太郎', pd);
  assert.equal(hit.name, 'sailviz-20260908-0906-m1.sailviz.json');
  assert.equal(await findReflectionByDate(dir, '別人', pd), null);
  assert.equal(await findReflectionByDate(dir, '山田 太郎', pd + 1), null);
  await rm(dir, { recursive: true, force: true });
});
