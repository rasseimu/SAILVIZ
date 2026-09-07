// test/server-import.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFolder } from '../server/import.js';
import { listProjects, readOverlay } from '../server/storage.js';

test('importFolder copies projects and overlays', async () => {
  const src = await mkdtemp(join(tmpdir(), 'src-'));
  const data = await mkdtemp(join(tmpdir(), 'data-'));
  try {
    await writeFile(join(src, 'sailviz-20260101-0900.sailviz.json'), JSON.stringify({ version: 1 }));
    await writeFile(join(src, 'sailviz-progress.json'), JSON.stringify({ r1: {} }));
    const r = await importFolder(src, data);
    assert.equal(r.projects, 1);
    assert.equal((await listProjects(data)).length, 1);
    assert.deepEqual(await readOverlay(data, 'progress'), { r1: {} });
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
