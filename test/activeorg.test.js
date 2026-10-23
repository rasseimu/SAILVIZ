// test/activeorg.test.js
// 表示中の組織(localStorage に覚える組織 ID)。合成 ID だけを使う。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getActiveOrgId, setActiveOrgId, resolveActiveOrg } from '../src/activeorg.js';

const KEY = 'sailviz.activeOrg.v1';
const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}
function useStorage(value) {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

beforeEach(() => useStorage(fakeStorage()));
afterEach(() => {
  if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
  else delete globalThis.localStorage;
});

test('activeorg: set/get で覚え、null で消す', () => {
  assert.equal(getActiveOrgId(), null);
  setActiveOrgId('org_a');
  assert.equal(getActiveOrgId(), 'org_a');
  assert.equal(globalThis.localStorage.getItem(KEY), 'org_a');
  setActiveOrgId(null);
  assert.equal(getActiveOrgId(), null);
  assert.equal(globalThis.localStorage.getItem(KEY), null);
});

test('activeorg: resolveActiveOrg は所属に無い ID を捨てて先頭にする', () => {
  const orgs = [{ id: 'org_a', name: 'A' }, { id: 'org_b', name: 'B' }];
  setActiveOrgId('org_b');
  assert.equal(resolveActiveOrg(orgs), 'org_b'); // 所属していれば覚えているほう
  setActiveOrgId('org_gone');
  assert.equal(resolveActiveOrg(orgs), 'org_a');
  assert.equal(getActiveOrgId(), 'org_a'); // 保存し直す
  assert.equal(resolveActiveOrg([]), null);
  assert.equal(getActiveOrgId(), null);
  assert.equal(resolveActiveOrg(undefined), null);
});

test('activeorg: localStorage が投げても null で動く', () => {
  const boom = () => { throw new Error('denied'); };
  useStorage({ getItem: boom, setItem: boom, removeItem: boom });
  assert.equal(getActiveOrgId(), null);
  assert.doesNotThrow(() => setActiveOrgId('org_a'));
  assert.doesNotThrow(() => setActiveOrgId(null));
  assert.equal(resolveActiveOrg([{ id: 'org_a' }]), 'org_a');
  // localStorage そのものが無い(読むだけで投げる)場合も同じ
  Object.defineProperty(globalThis, 'localStorage', { get: boom, configurable: true });
  assert.equal(getActiveOrgId(), null);
  assert.doesNotThrow(() => setActiveOrgId('org_a'));
});
