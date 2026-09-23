// test/windknowledge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeInput } from '../src/windknowledge.js';

function refl(id, name, notes, { speed = null, dateMs = 0 } = {}) {
  return { id, people: [name], notes, wind: { speed }, practice: { startMs: dateMs } };
}

test('buildKnowledgeInput: 解決済み課題+以降の発見を帯別にまとめ、実名を含めない', () => {
  const reflections = [
    refl('r1', '村瀬 礼', { issue: '微風で走らない' }, { speed: 2, dateMs: 100 }),
    refl('d1', '村瀬 礼', { discovery: 'カニンガムを緩める' }, { speed: 2, dateMs: 150 }),
  ];
  const progress = { r1: { issueStage: 2 } };
  const { teamByBand } = buildKnowledgeInput(reflections, progress, []);
  const bihuu = teamByBand.bihuu;
  assert.equal(bihuu.resolved.length, 1);
  assert.equal(bihuu.resolved[0].text, '微風で走らない');
  assert.ok(bihuu.resolved[0].evidence.some((e) => e.text === 'カニンガムを緩める'));
  // 実名がどこにも載らない
  assert.ok(!JSON.stringify(teamByBand).includes('村瀬'));
});

test('buildKnowledgeInput: slowFactor/fastFactor も notes として帯別に拾う', () => {
  const reflections = [
    refl('r2', '本間 由真', { slowFactor: '強風でヒールしすぎ', fastFactor: '微風で艇を立てた' }, { speed: 4, dateMs: 10 }),
  ];
  const { teamByBand } = buildKnowledgeInput(reflections, {}, []);
  // slowFactor は語「強風」で kyou、fastFactor は語「微風」で bihuu(語優先)
  assert.ok(teamByBand.kyou.notes.some((n) => n.field === 'slowFactor'));
  assert.ok(teamByBand.bihuu.notes.some((n) => n.field === 'fastFactor'));
});

test('buildKnowledgeInput: unknown帯のデータは出力に含めない', () => {
  const reflections = [refl('r3', 'A', { discovery: '風速も語もなし' }, { speed: null })];
  const { teamByBand } = buildKnowledgeInput(reflections, {}, []);
  assert.ok(!Object.keys(teamByBand).includes('unknown'));
});

test('buildKnowledgeInput: 参考文献をタイトル/要約の語で帯タグ、語なしは general', () => {
  const sources = [
    { id: 'ch11', title: '微風のランニング', summary: '微風風下' },
    { id: 'ch21', title: '強風のクローズのコツ', summary: '強風クローズ' },
    { id: 'ch1', title: 'ラダーの働き', summary: '舵の基礎' }, // 語なし → general
  ];
  const { refsByBand } = buildKnowledgeInput([], {}, sources);
  assert.ok(refsByBand.bihuu.some((r) => r.title === '微風のランニング'));
  assert.ok(refsByBand.kyou.some((r) => r.title === '強風のクローズのコツ'));
  assert.ok(refsByBand.general.some((r) => r.title === 'ラダーの働き'));
});
