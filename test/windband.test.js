import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIND_BANDS, detectBandWord, classifyWindBand,
  adjacentBands, bandLabel, filterByBand, bandSectionFromDigest,
} from '../src/windband.js';

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

test('adjacentBands: 配列上の前後の帯', () => {
  assert.deepEqual(adjacentBands('bihuu'), ['chuu']);
  assert.deepEqual(adjacentBands('chuu').sort(), ['bihuu', 'kyou']);
  assert.deepEqual(adjacentBands('baku'), ['kyou']);
  assert.deepEqual(adjacentBands('unknown'), []);
});

test('bandLabel: キー→ラベル、未知はそのまま', () => {
  assert.equal(bandLabel('kyou'), '強風 (6〜10 m/s)');
  assert.equal(bandLabel('nope'), 'nope');
});

const C = (id, band) => ({ id, band });
const getBand = (c) => c.band;

test('filterByBand: 同帯が min 以上なら同帯のみ(+general)', () => {
  const cands = [C('a', 'kyou'), C('b', 'kyou'), C('c', 'bihuu'), C('g', 'general')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  assert.deepEqual(out.map((c) => c.id), ['a', 'b', 'g']);
});

test('filterByBand: 同帯不足なら隣接帯へ拡大', () => {
  const cands = [C('a', 'kyou'), C('c', 'chuu'), C('d', 'bihuu')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  // kyou(1件)<min → 隣接(chuu)を追加。bihuu は非隣接で除外。
  assert.deepEqual(out.map((c) => c.id).sort(), ['a', 'c']);
});

test('filterByBand: 隣接でも不足なら全帯へ', () => {
  const cands = [C('a', 'kyou'), C('d', 'bihuu')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  assert.deepEqual(out.map((c) => c.id).sort(), ['a', 'd']);
});

test('filterByBand: general は常に含まれる', () => {
  const cands = [C('a', 'bihuu'), C('g', 'general')];
  const out = filterByBand(cands, 'kyou', { min: 2, getBand });
  assert.ok(out.some((c) => c.id === 'g'));
});

test('bandSectionFromDigest: 指定帯の配列/欠損は空', () => {
  const bullets = { kyou: ['x', 'y'], bihuu: [] };
  assert.deepEqual(bandSectionFromDigest(bullets, 'kyou'), ['x', 'y']);
  assert.deepEqual(bandSectionFromDigest(bullets, 'baku'), []);
  assert.deepEqual(bandSectionFromDigest(null, 'kyou'), []);
});
