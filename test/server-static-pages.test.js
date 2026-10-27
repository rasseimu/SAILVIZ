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

test('serveStatic: 受け口以外(/・/index.html)には Referrer-Policy を付けず、/account.html の直接指定も配信する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sailviz-pages-'));
  try {
    await writeFile(join(root, 'account.html'), '<h1>acct</h1>');
    await writeFile(join(root, 'index.html'), '<h1>idx</h1>');
    for (const url of ['/', '/index.html']) {
      const res = fakeRes();
      await serveStatic({ url }, res, root);
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), '<h1>idx</h1>');
      assert.equal(res.headers['referrer-policy'], undefined, url);
    }
    const direct = fakeRes();
    await serveStatic({ url: '/account.html' }, direct, root);
    assert.equal(direct.status, 200);
    assert.equal(direct.body.toString(), '<h1>acct</h1>');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pagePathFor: /join/:code は account.html(招待の参加ページ、S2.10)', () => {
  assert.equal(pagePathFor('/join/abc'), '/account.html');
  assert.equal(pagePathFor('/join/abc/'), '/account.html');
  assert.equal(pagePathFor('/join'), null);
  assert.equal(pagePathFor('/join/a/b'), null);
});

test('serveStatic: /?invite=<code> は /join/<code> へ 302(サーバの招待 URL の形、S2.10)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sailviz-pages-'));
  try {
    await writeFile(join(root, 'index.html'), '<h1>idx</h1>');
    const res = fakeRes();
    await serveStatic({ url: '/?invite=Ab-_09' }, res, root);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/join/Ab-_09');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    const odd = fakeRes();
    await serveStatic({ url: '/?invite=a%2Fb%20c' }, odd, root);
    assert.equal(odd.headers.location, '/join/a%2Fb%20c');
    const empty = fakeRes();
    await serveStatic({ url: '/?invite=' }, empty, root);
    assert.equal(empty.status, 200); // 空は通常のトップ
    const other = fakeRes();
    await serveStatic({ url: '/index.html?invite=x' }, other, root);
    assert.equal(other.status, 200); // 寄せるのは / だけ
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('serveStatic: /join/<code> は account.html を返し no-store・Referrer-Policy: no-referrer 付き(S2.10-P2)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sailviz-pages-'));
  try {
    await writeFile(join(root, 'account.html'), '<h1>acct</h1>');
    for (const url of ['/join/Ab-_09', '/join/Ab-_09/']) {
      const res = fakeRes();
      await serveStatic({ url }, res, root);
      assert.equal(res.status, 200, url);
      assert.equal(res.body.toString(), '<h1>acct</h1>');
      assert.match(res.headers['content-type'], /text\/html/);
      assert.match(res.headers['cache-control'], /no-store/);
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
    }
    // 深いパス(/join/a/b)は参加ページではない → 404(P3-4: /?invite=a/b → 302 後 404 は実害なし、変更不要)
    const deep = fakeRes();
    await serveStatic({ url: '/join/a/b' }, deep, root);
    assert.equal(deep.status, 404);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test('serveStatic: 画面のアドレス(/home・/practices・/practice など)は index.html を返す。末尾スラッシュ・下の階層は返さない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sailviz-pages-'));
  try {
    await writeFile(join(root, 'index.html'), '<h1>idx</h1>');
    for (const url of ['/home', '/practices', '/practice', '/practice?id=pd_0123456789', '/dashboard', '/progress', '/roadmap']) {
      const res = fakeRes();
      await serveStatic({ url }, res, root);
      assert.equal(res.status, 200, url);
      assert.equal(res.body.toString(), '<h1>idx</h1>', url);
      assert.equal(res.headers['referrer-policy'], undefined, url);
    }
    for (const url of ['/home/', '/practice/x', '/nope']) {
      const res = fakeRes();
      await serveStatic({ url }, res, root);
      assert.equal(res.status, 404, url);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
