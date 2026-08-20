import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReflection, windLabel, formatVideoPos,
  loadReflections, saveReflections, STORAGE_KEY,
  previousRig, RIG_FIELDS, NOTE_FIELDS,
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

test('createReflection: rig 数値は正規化(空欄/非数値→null、文字列数値→number)', () => {
  const r = createReflection({
    id: 'r1', createdAt: 1,
    rig: { boatNo: '12', prebend: '3.5', rake: '', gear: 'x', vangPull: 0 },
  });
  // 全 RIG_FIELDS がキーとして存在する
  for (const f of RIG_FIELDS) assert.ok(f in r.rig, `rig.${f} が無い`);
  assert.equal(r.rig.boatNo, 12);
  assert.equal(r.rig.prebend, 3.5);
  assert.equal(r.rig.rake, null);   // 空欄→null
  assert.equal(r.rig.gear, null);   // 非数値→null
  assert.equal(r.rig.vangPull, 0);  // 0 は保持
  assert.equal(r.rig.puller, null); // 未指定→null
});

test('createReflection: waveHeight を数値正規化', () => {
  assert.equal(createReflection({ id: 'a', createdAt: 1, waveHeight: '0.5' }).waveHeight, 0.5);
  assert.equal(createReflection({ id: 'b', createdAt: 1, waveHeight: '' }).waveHeight, null);
  assert.equal(createReflection({ id: 'c', createdAt: 1 }).waveHeight, null);
});

test('createReflection: notes は5項目を文字列で保持', () => {
  const r = createReflection({
    id: 'r1', createdAt: 1,
    notes: { goal: '上らせる', slowFactor: 'ヒール過多', extra: '無視' },
  });
  for (const f of NOTE_FIELDS) assert.ok(f in r.notes, `notes.${f} が無い`);
  assert.equal(r.notes.goal, '上らせる');
  assert.equal(r.notes.slowFactor, 'ヒール過多');
  assert.equal(r.notes.discovery, ''); // 未指定→空文字
  assert.equal('extra' in r.notes, false); // 未知キーは持たない
});

test('previousRig: 最新(末尾)の反省の rig を返す。無ければ空 rig', () => {
  assert.deepEqual(previousRig([]), createReflection({ id: '_', createdAt: 0 }).rig);
  const a = createReflection({ id: 'a', createdAt: 1, rig: { boatNo: 1 } });
  const b = createReflection({ id: 'b', createdAt: 2, rig: { boatNo: 2, rake: 7 } });
  assert.equal(previousRig([a, b]).boatNo, 2);
  assert.equal(previousRig([a, b]).rake, 7);
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
