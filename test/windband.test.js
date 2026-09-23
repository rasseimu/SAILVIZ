import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIND_BANDS, detectBandWord, classifyWindBand } from '../src/windband.js';

test('WIND_BANDS は4帯・キーと境界が固定', () => {
  assert.deepEqual(WIND_BANDS.map((b) => b.key), ['bihuu', 'chuu', 'kyou', 'baku']);
  assert.deepEqual(WIND_BANDS.map((b) => b.max), [3, 6, 10, Infinity]);
});

test('detectBandWord: 語を検出し、複数帯なら最強帯', () => {
  assert.equal(detectBandWord('微風で走らない'), 'bihuu');
  assert.equal(detectBandWord('無風でスタート'), 'bihuu');        // 同義語
  assert.equal(detectBandWord('順風のセーリング'), 'chuu');
  assert.equal(detectBandWord('中風から爆風まで'), 'baku');       // 複数→最強
  assert.equal(detectBandWord('特になし'), null);
});

test('classifyWindBand: 語が数値に優先', () => {
  assert.equal(classifyWindBand('爆風で走らない', 4), 'baku');   // 語=爆風 が speed4 より優先
});

test('classifyWindBand: 語なしは数値フォールバック(境界は排他)', () => {
  assert.equal(classifyWindBand('', 2.9), 'bihuu');
  assert.equal(classifyWindBand('', 3), 'chuu');
  assert.equal(classifyWindBand('', 6), 'kyou');
  assert.equal(classifyWindBand('', 10), 'baku');
  assert.equal(classifyWindBand('', 99), 'baku');
});

test('classifyWindBand: 語なし・数値なしは unknown', () => {
  assert.equal(classifyWindBand('', null), 'unknown');
  assert.equal(classifyWindBand('', undefined), 'unknown');
  assert.equal(classifyWindBand('', NaN), 'unknown');
});
