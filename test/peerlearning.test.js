import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryPool, buildPeerScreenPrompt, parsePeerScreen, buildPeerGroundPrompt, parsePeerGroundObject } from '../src/peerlearning.js';
import { generatePeerComments } from '../src/peerlearning.js';

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

const POOL = [
  { poolId: 'p0', member: '村瀬 礼', field: 'issue', text: '走らない', dateMs: 1, windBin: 'lt3', evidence: [] },
  { poolId: 'p1', member: '本間 由真', field: 'goal', text: '予選突破', dateMs: 2, windBin: 'mid', evidence: [] },
];

test('buildPeerScreenPrompt: poolId・部員・未解決アイテムが本文に載る', () => {
  const { system, user } = buildPeerScreenPrompt(
    [{ reflId: 'x1', field: 'issue', text: '走らない' }], POOL);
  assert.match(system, /コーチ/);
  assert.match(user, /poolId=p0/);
  assert.match(user, /村瀬 礼/);
  assert.match(user, /reflId=x1/);
});

test('parsePeerScreen: 未知poolId・不正field・非文字列reflIdを除去', () => {
  const raw = JSON.stringify([
    { reflId: 'x1', field: 'issue', poolId: 'p0' },   // OK
    { reflId: 'x2', field: 'discovery', poolId: 'p0' }, // field不正 → 除去
    { reflId: 'x3', field: 'goal', poolId: 'p9' },     // 未知poolId → 除去
    { reflId: 42, field: 'goal', poolId: 'p1' },       // reflId非文字列 → 除去
  ]);
  assert.deepEqual(parsePeerScreen(raw, POOL), [{ reflId: 'x1', field: 'issue', poolId: 'p0' }]);
});

test('parsePeerScreen: コードフェンス付き応答でも配列を取り出す', () => {
  const raw = '```json\n[{"reflId":"x1","field":"goal","poolId":"p1"}]\n```';
  assert.deepEqual(parsePeerScreen(raw, POOL), [{ reflId: 'x1', field: 'goal', poolId: 'p1' }]);
});

test('buildPeerGroundPrompt: 実名・手がかりが本文に載り、実名引用を指示する', () => {
  const matches = [{
    poolId: 'p0', member: '村瀬 礼', field: 'issue', text: '微風で走らない', dateMs: 1,
    windBin: 'lt3', evidence: [{ dateMs: 2, field: 'discovery', text: 'カニンガムを緩める' }],
  }];
  const { system, user } = buildPeerGroundPrompt({ field: 'issue', text: '微風で遅い' }, matches);
  assert.match(system, /実名/);
  assert.match(user, /村瀬 礼/);
  assert.match(user, /カニンガムを緩める/);
  assert.match(user, /poolId=p0/);
});

test('buildPeerGroundPrompt: 空matchesでも throw しない', () => {
  const { system, user } = buildPeerGroundPrompt({ field: 'issue', text: 'x' }, []);
  assert.match(user, /根拠にできる事例が無ければ/);
});

test('parsePeerGroundObject: comment と usedPoolIds を取り出す', () => {
  const raw = '{"comment":"村瀬さんの発見が使えます。","usedPoolIds":["p0","x"]}';
  assert.deepEqual(parsePeerGroundObject(raw), { comment: '村瀬さんの発見が使えます。', usedPoolIds: ['p0', 'x'] });
});

test('parsePeerGroundObject: comment空はnull', () => {
  assert.equal(parsePeerGroundObject('{"comment":"  ","usedPoolIds":[]}'), null);
});

// 2回呼ばれる geminiGenerate をスタブ: 1回目=スクリーニング応答, 2回目以降=根拠付け応答。
function stubGemini(responses) {
  let i = 0;
  return async () => responses[i++];
}

test('generatePeerComments: 空itemsは即[]', async () => {
  const out = await generatePeerComments({ items: [], reflections: [], progress: {}, geminiGenerate: stubGemini([]) });
  assert.deepEqual(out, []);
});

test('generatePeerComments: 解決履歴が空なら即[](geminiは呼ばれない)', async () => {
  let called = 0;
  const gg = async () => { called++; return '[]'; };
  const out = await generatePeerComments({
    items: [{ reflId: 'x1', field: 'issue', text: 'a' }],
    reflections: [], progress: {}, geminiGenerate: gg,
  });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test('generatePeerComments: スクリーニング→根拠付けを組み立て、url/refsを付ける', async () => {
  // 履歴: 村瀬の解決済み課題 r1 + 以降の発見 d1
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  // 対象(未解決): 本間の課題 x1。スクリーニングが p0 を関連付け、根拠付けが p0 を使用。
  const items = [{ reflId: 'x1', field: 'issue', text: '微風で遅い' }];
  const gg = stubGemini([
    JSON.stringify([{ reflId: 'x1', field: 'issue', poolId: 'p0' }]),
    JSON.stringify({ comment: '村瀬さんはカニンガムを緩めて解決しました。', usedPoolIds: ['p0'] }),
  ]);
  const out = await generatePeerComments({ items, reflections, progress, geminiGenerate: gg });
  assert.equal(out.length, 1);
  assert.equal(out[0].reflId, 'x1');
  assert.equal(out[0].field, 'issue');
  assert.match(out[0].comment, /村瀬/);
  assert.equal(out[0].url, 'peer:x1:issue:p0');
  assert.equal(out[0].refs.length, 1);
  assert.equal(out[0].refs[0].link, null);
  assert.match(out[0].refs[0].title, /村瀬 礼/);
});

test('generatePeerComments: スクリーニングが空なら根拠付けを呼ばず[]', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: 'a' }, wind: { speed: 2 }, practice: { startMs: 100 } },
  ];
  const gg = stubGemini(['[]']);
  const out = await generatePeerComments({
    items: [{ reflId: 'x1', field: 'issue', text: 'b' }],
    reflections, progress: { r1: { issueStage: 2 } }, geminiGenerate: gg,
  });
  assert.deepEqual(out, []);
});

test('generatePeerComments: 根拠付けが例外でも他アイテムを止めない', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: 'a' }, wind: { speed: 2 }, practice: { startMs: 100 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  const items = [
    { reflId: 'x1', field: 'issue', text: 'b' },
    { reflId: 'x2', field: 'issue', text: 'c' },
  ];
  let call = 0;
  const gg = async () => {
    call++;
    if (call === 1) return JSON.stringify([
      { reflId: 'x1', field: 'issue', poolId: 'p0' },
      { reflId: 'x2', field: 'issue', poolId: 'p0' },
    ]);
    if (call === 2) throw new Error('根拠付け失敗'); // x1 は失敗
    return JSON.stringify({ comment: 'x2の助言', usedPoolIds: ['p0'] }); // x2 は成功
  };
  const out = await generatePeerComments({ items, reflections, progress, geminiGenerate: gg });
  assert.equal(out.length, 1);
  assert.equal(out[0].reflId, 'x2');
});

test('buildPeerGroundPrompt: bandBullets があれば技術ノートを本文に含める', () => {
  const matches = [{ poolId: 'p0', member: '村瀬 礼', field: 'issue', text: '微風で走らない', evidence: [] }];
  const { user } = buildPeerGroundPrompt({ field: 'issue', text: '微風で遅い' }, matches, ['微風は緩める 〔部内実績〕']);
  assert.match(user, /風速帯の技術ノート/);
  assert.match(user, /微風は緩める/);
});

test('buildPeerGroundPrompt: bandBullets 空なら技術ノートを付けない(後方互換)', () => {
  const { user } = buildPeerGroundPrompt({ field: 'issue', text: 'x' }, [], []);
  assert.doesNotMatch(user, /風速帯の技術ノート/);
});

test('generatePeerComments: digest 注入(該当帯ノートが根拠付けに載る)', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const progress = { r1: { issueStage: 2 } };
  const items = [{ reflId: 'x1', field: 'issue', text: '微風で遅い' }];
  let groundUser = '';
  let call = 0;
  const gg = async ({ parts }) => {
    call++;
    if (call === 1) return JSON.stringify([{ reflId: 'x1', field: 'issue', poolId: 'p0' }]);
    groundUser = parts.map((p) => p.text || '').join('');
    return JSON.stringify({ comment: '村瀬さんが緩めて解決。', usedPoolIds: ['p0'] });
  };
  const out = await generatePeerComments({
    items, reflections, progress, geminiGenerate: gg,
    digest: { bihuu: ['微風は緩める 〔部内実績〕'], chuu: [], kyou: [], baku: [] },
  });
  assert.equal(out.length, 1);
  assert.match(groundUser, /風速帯の技術ノート/);
  assert.match(groundUser, /微風は緩める/);
});

test('generatePeerComments: digest 不在でも従来通り(回帰)', async () => {
  const reflections = [
    { id: 'r1', people: ['村瀬 礼'], notes: { issue: '微風で走らない' }, wind: { speed: 2 }, practice: { startMs: 100 } },
    { id: 'd1', people: ['村瀬 礼'], notes: { discovery: 'カニンガムを緩める' }, wind: { speed: 2 }, practice: { startMs: 150 } },
  ];
  const gg = stubGemini([
    JSON.stringify([{ reflId: 'x1', field: 'issue', poolId: 'p0' }]),
    JSON.stringify({ comment: '助言。', usedPoolIds: ['p0'] }),
  ]);
  const out = await generatePeerComments({
    items: [{ reflId: 'x1', field: 'issue', text: '微風で遅い' }],
    reflections, progress: { r1: { issueStage: 2 } }, geminiGenerate: gg, // digest なし
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].comment, '助言。');
});
