// test/progress-band-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateItemsWithBand } from '../src/progress.js';

test('annotateItemsWithBand: item.text の語優先→反省speedで帯付け', () => {
  const reflections = [
    { id: 'r1', wind: { speed: 8 }, notes: {} },   // speed8 → kyou
    { id: 'r2', wind: { speed: 2 }, notes: {} },
  ];
  const items = [
    { reflId: 'r1', field: 'issue', text: '走らない' },            // 語なし→speed8→kyou
    { reflId: 'r2', field: 'issue', text: '爆風で怖い' },          // 語=爆風→baku(speed2を上書き)
  ];
  const out = annotateItemsWithBand(items, reflections);
  assert.equal(out[0].band, 'kyou');
  assert.equal(out[1].band, 'baku');
});

test('annotateItemsWithBand: 反省が見つからず語も無ければ unknown', () => {
  const out = annotateItemsWithBand([{ reflId: 'zzz', field: 'goal', text: 'x' }], []);
  assert.equal(out[0].band, 'unknown');
});
