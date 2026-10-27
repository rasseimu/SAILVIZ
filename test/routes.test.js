// test/routes.test.js — 画面とアドレスの対応(src/routes.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathFor, routeFromLocation, APP_PATHS } from '../src/routes.js';

test('pathFor: 画面ごとのアドレス。練習は id を付ける', () => {
  assert.equal(pathFor('top'), '/home');
  assert.equal(pathFor('home'), '/practices');
  assert.equal(pathFor('dashboard'), '/dashboard');
  assert.equal(pathFor('progress'), '/progress');
  assert.equal(pathFor('roadmap'), '/roadmap');
  assert.equal(pathFor('study'), '/study');
  assert.equal(pathFor('track'), '/practice');
  assert.equal(pathFor('track', { id: 'pd_0123456789' }), '/practice?id=pd_0123456789');
  assert.equal(pathFor('track', { id: 'sailviz-20260101-0900.sailviz.json' }), '/practice?id=sailviz-20260101-0900.sailviz.json');
  assert.equal(pathFor('unknown'), null);
});

test('routeFromLocation: アドレスから画面を決める。/ と知らないアドレスは null', () => {
  assert.deepEqual(routeFromLocation('/home', ''), { view: 'top', id: null });
  assert.deepEqual(routeFromLocation('/practices', ''), { view: 'home', id: null });
  assert.deepEqual(routeFromLocation('/dashboard', ''), { view: 'dashboard', id: null });
  assert.deepEqual(routeFromLocation('/progress', ''), { view: 'progress', id: null });
  assert.deepEqual(routeFromLocation('/roadmap', ''), { view: 'roadmap', id: null });
  assert.deepEqual(routeFromLocation('/study', ''), { view: 'study', id: null });
  assert.deepEqual(routeFromLocation('/study', '?id=pd_0123456789'), { view: 'study', id: null }, 'study は id を持たない');
  assert.deepEqual(routeFromLocation('/practice', ''), { view: 'track', id: null });
  assert.deepEqual(routeFromLocation('/practice', '?id=pd_0123456789'), { view: 'track', id: 'pd_0123456789' });
  assert.deepEqual(routeFromLocation('/practice', '?id='), { view: 'track', id: null });
  assert.equal(routeFromLocation('/', ''), null);
  assert.equal(routeFromLocation('/index.html', ''), null);
  assert.equal(routeFromLocation('/nope', ''), null);
});

test('pathFor と routeFromLocation は往復で一致する', () => {
  for (const [view, id] of [['top'], ['home'], ['dashboard'], ['progress'], ['roadmap'], ['study'], ['track'], ['track', 'pd_0123456789']]) {
    const u = new URL(pathFor(view, { id }), 'http://x');
    assert.deepEqual(routeFromLocation(u.pathname, u.search), { view, id: id ?? null });
  }
});

test('APP_PATHS: サーバーが index.html を返すアドレス', () => {
  assert.deepEqual([...APP_PATHS].sort(), ['/dashboard', '/home', '/practice', '/practices', '/progress', '/roadmap', '/study']);
});
