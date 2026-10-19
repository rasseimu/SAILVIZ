// test/server-static-pages.test.js
// アカウント画面のページパス(/account・/verify-email・/reset-password)を account.html として配信する(S2.7)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic, pagePathFor } from '../server/static.js';

function fakeRes() {
  return {
    status: 0, headers: {}, body: '',
    writeHead(code, h) { this.status = code; this.headers = h || {}; return this; },
    end(chunk) { if (chunk !== undefined) this.body = chunk; return this; },
  };
}

test('pagePathFor: 受け口のパスだけ account.html に対応づける', () => {
  assert.equal(pagePathFor('/account'), '/account.html');
  assert.equal(pagePathFor('/account/'), '/account.html');
  assert.equal(pagePathFor('/verify-email'), '/account.html');
  assert.equal(pagePathFor('/reset-password'), '/account.html');
  assert.equal(pagePathFor('/verify-email/x'), null);
  assert.equal(pagePathFor('/index.html'), null);
  assert.equal(pagePathFor('/'), null);
});

test('serveStatic: /verify-email?token=… は HTML を返し no-store・Referrer-Policy 付き', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sailviz-pages-'));
  try {
    await writeFile(join(root, 'account.html'), '<h1>acct</h1>');
    const res = fakeRes();
    await serveStatic({ url: '/verify-email?token=abc' }, res, root);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '<h1>acct</h1>');
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  } finally { await rm(root, { recursive: true, force: true }); }
});
