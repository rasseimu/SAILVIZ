import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiToRows, blocksToRows, toCommitRows } from '../src/minutes-rows.js';
import { parseMinutes } from '../src/minutes.js';

test('aiToRows は fullName 有りを取込オン、null を取込オフにする', () => {
  const rows = aiToRows([
    { fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' },
    { fullName: null, goal: 'g2', issue: '', discovery: '', raw: 'r2' },
  ]);
  assert.equal(rows[0].include, true);
  assert.equal(rows[0].fullName, '本間 由真');
  assert.equal(rows[1].include, false);
  assert.equal(rows[1].fullName, null);
});

test('blocksToRows は matchMember で名簿照合し fullName を埋める', () => {
  const blocks = parseMinutes('## ゆま（本間ゆま）\n- **目標**：g\n- **課題**：i');
  const rows = blocksToRows(blocks);
  assert.equal(rows[0].fullName, '本間 由真');
  assert.equal(rows[0].include, true);
  assert.equal(rows[0].goal, 'g');
});

test('blocksToRows は照合不能を null・取込オフにする', () => {
  const blocks = parseMinutes('## 謎の人物\n- **目標**：g');
  assert.equal(blocks.length, 1);
  assert.equal(blocksToRows(blocks)[0].fullName, null);
  assert.equal(blocksToRows(blocks)[0].include, false);
});

test('toCommitRows は取込オフと未割当を除外して整形する', () => {
  const rows = [
    { fullName: '本間 由真', include: true, goal: 'g', issue: 'i', discovery: 'd', raw: 'r' },
    { fullName: '高田 咲', include: false, goal: 'x', issue: '', discovery: '', raw: '' },
    { fullName: null, include: true, goal: 'y', issue: '', discovery: '', raw: '' },
  ];
  const out = toCommitRows(rows);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' });
});
