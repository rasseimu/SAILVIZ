// test/overlay-rows.test.js
// progress.json / roadmap.json の decompose→assemble 往復一致(純関数)。実データ全件で検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  decomposeProgress, assembleProgress, decomposeRoadmap, assembleRoadmap,
} from '../server/domain/overlayRows.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('progress: 基本エントリが往復一致', () => {
  const p = {
    refl1_0: { issueStage: 0, goalDone: false, text: { goal: 'g' },
      comments: { goal: [{ text: 'c1', ts: 100 }, { text: 'c2', ts: 200, url: 'http://x', ai: true }] } },
    refl1_1: { issueStage: 2, goalDone: true },
  };
  assert.deepStrictEqual(assembleProgress(decomposeProgress(p, { now: 1 })), p);
});

test('roadmap: 基本エントリが往復一致', () => {
  const r = { '村瀬 礼': { goal: '全日本', milestones: [{ id: 'm1', title: 't', done: false, doneAt: null }] } };
  assert.deepStrictEqual(assembleRoadmap(decomposeRoadmap(r, { now: 1 })), r);
});

test('実データ progress.json 往復一致', () => {
  const f = join(ROOT, 'data', 'progress.json');
  if (!existsSync(f)) { assert.ok(true, 'no progress.json'); return; }
  const p = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepStrictEqual(assembleProgress(decomposeProgress(p, { now: 1 })), p);
});

test('実データ roadmap.json 往復一致', () => {
  const f = join(ROOT, 'data', 'roadmap.json');
  if (!existsSync(f)) { assert.ok(true, 'no roadmap.json'); return; }
  const r = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepStrictEqual(assembleRoadmap(decomposeRoadmap(r, { now: 1 })), r);
});
