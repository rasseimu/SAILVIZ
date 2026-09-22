import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryPool } from '../src/peerlearning.js';

// 反省を1件作るヘルパ。dateMs は practice.startMs に入れる(summarize の reflDateMs 準拠)。
function refl(id, name, notes, { speed = null, dateMs = 0 } = {}) {
  return { id, people: [name], notes, wind: { speed }, practice: { startMs: dateMs } };
}

test('buildHistoryPool: 解決済み課題(stage2)と達成済み目標(done)だけを拾う', () => {
  const reflections = [
    refl('r1', '村瀬 礼', { issue: '走らない' }, { dateMs: 100 }),
    refl('r2', '村瀬 礼', { issue: '曲がらない' }, { dateMs: 200 }),
    refl('r3', '村瀬 礼', { goal: '一次予選突破' }, { dateMs: 300 }),
  ];
  const progress = {
    r1: { issueStage: 2 },   // 解決 → 入る
    r2: { issueStage: 1 },   // 取組中 → 入らない
    r3: { goalDone: true },  // 達成 → 入る
  };
  const pool = buildHistoryPool(reflections, progress);
  assert.equal(pool.length, 2);
  assert.deepEqual(pool.map((p) => [p.member, p.field, p.text]).sort(), [
    ['村瀬 礼', 'goal', '一次予選突破'],
    ['村瀬 礼', 'issue', '走らない'],
  ]);
  assert.ok(pool.every((p) => typeof p.poolId === 'string' && p.poolId.length));
});

test('buildHistoryPool: 手がかりは同一部員の"以降"の発見/変化、最大K件・風速帯優先', () => {
  const reflections = [
    refl('r1', '村瀬 礼', { issue: '微風で走らない' }, { speed: 2, dateMs: 100 }),
    // 同一部員・以降の発見(微風=近い風速帯)→ 優先
    refl('r2', '村瀬 礼', { discovery: 'カニンガムを緩める' }, { speed: 2, dateMs: 150 }),
    // 同一部員・以降の発見(強風=遠い風速帯)
    refl('r3', '村瀬 礼', { discovery: 'ベンド最大' }, { speed: 8, dateMs: 160 }),
    // 別部員の発見 → 入らない
    refl('r4', '本間 由真', { discovery: '関係ない' }, { speed: 2, dateMs: 170 }),
    // 以前の発見 → 入らない
    refl('r0', '村瀬 礼', { discovery: '過去の発見' }, { speed: 2, dateMs: 50 }),
  ];
  const progress = { r1: { issueStage: 2 } };
  const pool = buildHistoryPool(reflections, progress, { maxEvidence: 5 });
  assert.equal(pool.length, 1);
  const texts = pool[0].evidence.map((e) => e.text);
  assert.ok(texts.includes('カニンガムを緩める'));
  assert.ok(texts.includes('ベンド最大'));
  assert.ok(!texts.includes('関係ない'));   // 別部員は除外
  assert.ok(!texts.includes('過去の発見'));  // 以前は除外
  // 風速帯が近い(微風)発見が先頭
  assert.equal(pool[0].evidence[0].text, 'カニンガムを緩める');
});

test('buildHistoryPool: maxEvidence で件数を制限する', () => {
  const reflections = [refl('r1', '村瀬 礼', { issue: 'x' }, { dateMs: 100 })];
  for (let i = 0; i < 8; i++) {
    reflections.push(refl(`d${i}`, '村瀬 礼', { discovery: `発見${i}` }, { dateMs: 200 + i }));
  }
  const pool = buildHistoryPool(reflections, { r1: { issueStage: 2 } }, { maxEvidence: 3 });
  assert.equal(pool[0].evidence.length, 3);
});

test('buildHistoryPool: 解決済みが無ければ空配列', () => {
  const pool = buildHistoryPool([refl('r1', '村瀬 礼', { issue: 'x' }, { dateMs: 1 })], { r1: { issueStage: 1 } });
  assert.deepEqual(pool, []);
});

test('buildHistoryPool: textOverride(st.text)を優先する', () => {
  const reflections = [refl('r1', '村瀬 礼', { issue: '元テキスト' }, { dateMs: 100 })];
  const progress = { r1: { issueStage: 2, text: { issue: '修正後テキスト' } } };
  const pool = buildHistoryPool(reflections, progress);
  assert.equal(pool[0].text, '修正後テキスト');
});

test('buildHistoryPool: unknown 風速帯は同一bin判定から除外される', () => {
  const reflections = [
    // 解決済み課題：風速なし(unknown)
    refl('r1', '村瀬 礼', { issue: '風速不明で走らない' }, { speed: null, dateMs: 100 }),
    // より新しい発見：風速なし(unknown)
    refl('d1', '村瀬 礼', { discovery: '最近の発見' }, { speed: null, dateMs: 200 }),
    // より古い発見：速度4(known)
    refl('d2', '村瀬 礼', { discovery: '過去の発見' }, { speed: 4, dateMs: 150 }),
  ];
  const progress = { r1: { issueStage: 2 } };
  const pool = buildHistoryPool(reflections, progress);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].evidence.length, 2);
  // unknown 同士は同一bin判定されないため、発見順(新しい順)で '最近の発見' が先頭
  assert.equal(pool[0].evidence[0].text, '最近の発見');
  assert.equal(pool[0].evidence[1].text, '過去の発見');
});
