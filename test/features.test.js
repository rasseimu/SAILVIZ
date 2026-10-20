import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFeatures, injectFeatureMeta, FEATURE_META_NAME } from '../server/features.js';
import { serveStatic } from '../server/static.js';
import { accountExtrasFromMeta } from '../src/account/logic.js';

test('resolveFeatures: 既定(未設定・空・1以外)は隠す。FEATURE_ACCOUNT_EXTRAS=1 だけ ON', () => {
  assert.equal(resolveFeatures({}).accountExtras, false);
  assert.equal(resolveFeatures({ FEATURE_ACCOUNT_EXTRAS: '' }).accountExtras, false);
  assert.equal(resolveFeatures({ FEATURE_ACCOUNT_EXTRAS: '0' }).accountExtras, false);
  assert.equal(resolveFeatures({ FEATURE_ACCOUNT_EXTRAS: 'true' }).accountExtras, false);
  assert.equal(resolveFeatures({ FEATURE_ACCOUNT_EXTRAS: '1' }).accountExtras, true);
});

test('injectFeatureMeta: OFF は HTML を変えない。ON は </head> の前に meta を入れる', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  assert.equal(injectFeatureMeta(html, { accountExtras: false }), html);
  const on = injectFeatureMeta(html, { accountExtras: true });
  assert.ok(on.includes(`<meta name="${FEATURE_META_NAME}" content="account-extras" /></head>`));
  assert.equal(injectFeatureMeta('no head', { accountExtras: true }), 'no head');
});

test('accountExtrasFromMeta: meta が無い・空・別の値は false。account-extras を含むと true', () => {
  assert.equal(accountExtrasFromMeta(null), false);
  assert.equal(accountExtrasFromMeta(''), false);
  assert.equal(accountExtrasFromMeta('other'), false);
  assert.equal(accountExtrasFromMeta('account-extras'), true);
  assert.equal(accountExtrasFromMeta('foo, account-extras'), true);
});

function fakeRes() {
  const r = { status: 0, headers: {}, body: '' };
  r.writeHead = (s, h) => { r.status = s; r.headers = h || {}; return r; };
  r.end = (b) => { r.body = b == null ? '' : String(b); };
  return r;
}

test('serveStatic: /account は features ON のときだけ meta 入り。他のファイルは変えない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sv-feat-'));
  try {
    await writeFile(join(root, 'account.html'), '<html><head></head><body></body></html>');
    await writeFile(join(root, 'a.js'), '</head>');
    const off = fakeRes();
    await serveStatic({ url: '/account' }, off, root, { features: { accountExtras: false } });
    assert.ok(!off.body.includes(FEATURE_META_NAME));
    const none = fakeRes();
    await serveStatic({ url: '/account' }, none, root);
    assert.ok(!none.body.includes(FEATURE_META_NAME));
    const on = fakeRes();
    await serveStatic({ url: '/join/abc' }, on, root, { features: { accountExtras: true } });
    assert.ok(on.body.includes(FEATURE_META_NAME));
    const js = fakeRes();
    await serveStatic({ url: '/a.js' }, js, root, { features: { accountExtras: true } });
    assert.equal(js.body, '</head>');
  } finally { await rm(root, { recursive: true, force: true }); }
});
