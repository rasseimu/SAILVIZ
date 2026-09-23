import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, loadWindKnowledge, saveWindKnowledge, clearWindKnowledge,
} from '../src/windknowledgestore.js';

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('save→load ラウンドトリップ', () => {
  const s = memStorage();
  const data = { md: '# x', builtAt: 123, bandBullets: { bihuu: ['a'], chuu: [], kyou: [], baku: [] }, stats: {} };
  saveWindKnowledge(data, s);
  assert.deepEqual(loadWindKnowledge(s), data);
});

test('未保存なら null', () => {
  assert.equal(loadWindKnowledge(memStorage()), null);
});

test('破損JSONは null 扱い', () => {
  assert.equal(loadWindKnowledge(memStorage({ [STORAGE_KEY]: '{壊れ' })), null);
});

test('clear で消える', () => {
  const s = memStorage();
  saveWindKnowledge({ md: '', builtAt: 1, bandBullets: {}, stats: {} }, s);
  clearWindKnowledge(s);
  assert.equal(loadWindKnowledge(s), null);
});
