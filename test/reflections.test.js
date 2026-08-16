import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReflection, windLabel, formatVideoPos,
  loadReflections, saveReflections, STORAGE_KEY,
} from '../src/reflections.js';

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('formatVideoPos は mm:ss', () => {
  assert.equal(formatVideoPos(0), '0:00');
  assert.equal(formatVideoPos(65000), '1:05');
  assert.equal(formatVideoPos(600000), '10:00');
});

test('createReflection は入力を正規化しコピーを持つ', () => {
  const people = ['村瀬 礼'];
  const videos = [{ name: 'a.mp4', tMs: 12000 }, { name: 'b.mp4' }];
  const r = createReflection({ id: 'r1', createdAt: 100, text: 'いい風', people, videos });
  assert.equal(r.id, 'r1');
  assert.equal(r.text, 'いい風');
  assert.deepEqual(r.people, ['村瀬 礼']);
  assert.equal(r.videos[1].tMs, 0); // 既定0
  people.push('X'); // 元配列を変えても反省側は不変
  assert.equal(r.people.length, 1);
});

test('windLabel: アメダス風', () => {
  const l = windLabel(
    { dir: '南南西', speed: 3.2, source: 'amedas', station: '辻堂', obsMs: 1 },
    { formatObs: () => '12:40' },
  );
  assert.equal(l, '風: 南南西 3.2m/s(辻堂 12:40)');
});

test('windLabel: 手入力風と未設定', () => {
  assert.equal(windLabel({ dir: '北', speed: 5, source: 'manual' }), '風: 北 5m/s(手入力)');
  assert.equal(windLabel(null), '風: 未設定');
});

test('save→load ラウンドトリップ', () => {
  const st = memStorage();
  const r = createReflection({ id: 'r1', createdAt: 1, text: 'x' });
  saveReflections([r], st);
  const back = loadReflections(st);
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 'r1');
  assert.equal(st.getItem(STORAGE_KEY) !== null, true);
});

test('load: 空/壊れたJSONは空配列', () => {
  assert.deepEqual(loadReflections(memStorage()), []);
  assert.deepEqual(loadReflections(memStorage({ [STORAGE_KEY]: '{bad' })), []);
  assert.deepEqual(loadReflections(memStorage({ [STORAGE_KEY]: '"notarray"' })), []);
});
