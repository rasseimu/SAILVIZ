// test/server-static.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentType } from '../server/static.js';

test('contentType maps text types with utf-8', () => {
  assert.equal(contentType('/src/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/styles.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('/x.json'), 'application/json; charset=utf-8');
  assert.equal(contentType('/x.png'), 'image/png');
});
