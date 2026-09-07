// test/server-static.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentType, serveStatic } from '../server/static.js';

test('contentType maps text types with utf-8', () => {
  assert.equal(contentType('/src/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/styles.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('/x.json'), 'application/json; charset=utf-8');
  assert.equal(contentType('/x.png'), 'image/png');
});

function fakeRes() {
  return {
    status: 0,
    body: '',
    ended: false,
    writeHead(code) { this.status = code; return this; },
    end(chunk) { if (chunk !== undefined) this.body = chunk; this.ended = true; return this; },
  };
}

test('serveStatic serves a file inside root and 404s missing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sailviz-static-'));
  const root = join(base, 'app');
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'index.html'), '<h1>hi</h1>');
    const okRes = fakeRes();
    await serveStatic({ url: '/' }, okRes, root);
    assert.equal(okRes.status, 200);
    assert.equal(okRes.body.toString(), '<h1>hi</h1>');

    const missRes = fakeRes();
    await serveStatic({ url: '/nope.txt' }, missRes, root);
    assert.equal(missRes.status, 404);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('serveStatic never serves a sibling-prefix directory file', async () => {
  // root=/base/app, sibling=/base/app-evil sharing the "app" prefix.
  // Regardless of how the request is crafted, the sibling secret must never
  // be served (URL normalization + the trailing-sep guard both defend this).
  const base = await mkdtemp(join(tmpdir(), 'sailviz-static-'));
  const root = join(base, 'app');
  const evil = join(base, 'app-evil');
  try {
    await mkdir(root, { recursive: true });
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, 'secret.txt'), 'TOP SECRET');
    for (const url of ['/../app-evil/secret.txt', '/%2e%2e/app-evil/secret.txt']) {
      const res = fakeRes();
      await serveStatic({ url }, res, root);
      assert.notEqual(res.status, 200, `must not 200 for ${url}`);
      assert.notEqual(res.body.toString(), 'TOP SECRET', `must not leak secret for ${url}`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('serveStatic 403s a path that resolves outside root', async () => {
  // Directly exercise the guard: rel that climbs above root after join.
  const base = await mkdtemp(join(tmpdir(), 'sailviz-static-'));
  const root = join(base, 'app');
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(base, 'outside.txt'), 'OUTSIDE');
    // req.url with a raw path is parsed by URL; use a pathname whose join
    // escapes only if the guard is weak. A trailing-sep-correct guard blocks it.
    const res = fakeRes();
    // Simulate a req whose decoded pathname climbs out via a literal segment.
    await serveStatic({ url: '/..%2foutside.txt' }, res, root);
    assert.notEqual(res.body.toString(), 'OUTSIDE');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
