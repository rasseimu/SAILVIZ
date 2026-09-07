import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isValidProjectName, listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay,
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
