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

// --- Task 6 tests ---
import { buildKnowledgePrompt, parseKnowledgeResponse } from '../src/windknowledge.js';

test('buildKnowledgePrompt: 帯ラベル・両入力・8点上限指示・出力形式を含む', () => {
  const input = {
    teamByBand: {
      bihuu: { resolved: [{ field: 'issue', text: '微風で走らない', evidence: [{ field: 'discovery', text: 'カニンガムを緩める' }] }], notes: [] },
      chuu: { resolved: [], notes: [] }, kyou: { resolved: [], notes: [] }, baku: { resolved: [], notes: [] },
    },
    refsByBand: { general: [{ title: 'ラダーの働き', summary: '舵' }], bihuu: [{ title: '微風のランニング', summary: '微風' }], chuu: [], kyou: [], baku: [] },
  };
  const { system, user } = buildKnowledgePrompt(input);
  assert.match(system, /コーチ/);
  assert.match(system, /憶測/);           // 憶測禁止
  assert.match(user, /微風/);
  assert.match(user, /カニンガムを緩める/); // チーム証拠
  assert.match(user, /微風のランニング/);   // 参考文献
  assert.match(user, /最大8/);             // 8点上限
  assert.match(user, /bihuu/);             // 帯キーでのJSON出力形式
});

test('parseKnowledgeResponse: 帯別配列を取り出し8点で切る', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `点${i}`);
  const raw = JSON.stringify({ bihuu: nine, chuu: ['a'], kyou: [], baku: ['x'] });
  const out = parseKnowledgeResponse(raw);
  assert.equal(out.bihuu.length, 8);   // 9→8
  assert.deepEqual(out.chuu, ['a']);
  assert.deepEqual(out.kyou, []);
  assert.deepEqual(out.baku, ['x']);
});

test('parseKnowledgeResponse: 欠損帯は空、非文字列は除去', () => {
  const raw = JSON.stringify({ bihuu: ['ok', 42, null, 'ok2'] }); // chuu/kyou/baku 欠損
  const out = parseKnowledgeResponse(raw);
  assert.deepEqual(out.bihuu, ['ok', 'ok2']);
  assert.deepEqual(out.chuu, []);
  assert.deepEqual(out.kyou, []);
  assert.deepEqual(out.baku, []);
});

test('parseKnowledgeResponse: 非JSONは例外', () => {
  assert.throws(() => parseKnowledgeResponse('ぜんぜんJSONじゃない'));
});

test('parseKnowledgeResponse: コードフェンス付きでも解釈', () => {
  const raw = '```json\n{"bihuu":["a"]}\n```';
  assert.deepEqual(parseKnowledgeResponse(raw).bihuu, ['a']);
});

// --- Task 7 tests ---
import { renderKnowledgeMd, generateWindKnowledge } from '../src/windknowledge.js';

test('renderKnowledgeMd: 帯見出しと箇条書き、空帯はデータ不足', () => {
  const md = renderKnowledgeMd({ bihuu: ['微風のコツ 〔部内実績〕'], chuu: [], kyou: [], baku: [] }, Date.UTC(2026, 8, 23));
  assert.match(md, /# 風速帯別/);
  assert.match(md, /## 微風/);
  assert.match(md, /微風のコツ/);
  assert.match(md, /## 中風・順風[\s\S]*（データ不足）/);
});

test('generateWindKnowledge: 入力→Gemini1回→md/bandBullets/statsを返す', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  let calls = 0;
  const geminiGenerate = async () => { calls++; return JSON.stringify({ bihuu: ['微風は緩める 〔部内実績〕'], chuu: [], kyou: [], baku: [] }); };
  const res = await generateWindKnowledge({ reflections, progress, sources: [], geminiGenerate, nowMs: 999 });
  assert.equal(calls, 1);
  assert.equal(res.builtAt, 999);
  assert.deepEqual(res.bandBullets.bihuu, ['微風は緩める 〔部内実績〕']);
  assert.match(res.md, /微風は緩める/);
  assert.equal(res.stats.reflections, 2);
  assert.equal(res.stats.perBand.bihuu, 1);
});
