// test/compat-access.test.js
// 互換 API の認可(S2.5-P2)。純関数。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacySharedPrincipal, user, anonymous } from '../server/domain/policy.js';
import {
  isCompatWriter, canSeeProject, filterProject, canPutDay, canDeleteDay, managedReflectionPredicate,
  buildReflectionIndex, filterProgressRead, mergeProgressWrite, filterRoadmapRead, mergeRoadmapWrite,
} from '../server/domain/compatAccess.js';

const ORG = 'o_main';
const W = legacySharedPrincipal({ orgId: ORG, canWrite: true });
const R = legacySharedPrincipal({ orgId: ORG, canWrite: false });
const NOORG = legacySharedPrincipal({ orgId: null, canWrite: true });
const MEMBER = user('u_member', [ORG]);
const OUTSIDER = user('u_out', ['o_other']);
const OWNER = user('u_owner', ['o_other']);

const trk = (visibility, over = {}) => ({ kind: 'practice', visibility, ownerId: null, crewIds: [], ...over });
const rfl = (id, visibility, over = {}) => ({ id, visibility, ownerId: null, ...over });
const proj = (n, m) => ({
  version: 1,
  tracks: Array.from({ length: n }, (_, i) => ({ id: `t${i}` })),
  reflections: Array.from({ length: m }, (_, i) => ({ id: `r${i}` })),
});

test('(2) 共有ログイン: org の中身は見え、private の軌跡・反省は消える。器は残る', () => {
  const access = { orgId: ORG, tracks: [trk('org'), trk('private')], reflections: [rfl('r0', 'org'), rfl('r1', 'private')] };
  const out = filterProject(W, proj(2, 2), access);
  assert.deepEqual(out.tracks.map((t) => t.id), ['t0']);
  assert.deepEqual(out.reflections.map((r) => r.id), ['r0']);
  assert.equal(out.version, 1);
});

test('(2) 見える中身が1つも無い器は null (一覧からも消える)', () => {
  const access = { orgId: ORG, tracks: [trk('private')], reflections: [rfl('r0', 'private')] };
  assert.equal(filterProject(W, proj(1, 1), access), null);
  assert.equal(canSeeProject(W, access), false);
  assert.equal(canSeeProject(R, access), false);
});

test('(2) 他組織の器: org は見えず、public だけ見える', () => {
  const access = { orgId: 'o_other', tracks: [trk('org'), trk('public')], reflections: [rfl('r0', 'org')] };
  const out = filterProject(W, proj(2, 1), access);
  assert.deepEqual(out.tracks.map((t) => t.id), ['t1']);
  assert.deepEqual(out.reflections, []);
});

test('(2) レースの軌跡は誰にでも見える', () => {
  const access = { orgId: 'o_other', tracks: [trk('private', { kind: 'race' })], reflections: [] };
  assert.equal(filterProject(OUTSIDER, proj(1, 0), access).tracks.length, 1);
});

test('(2) 空の器は組織メンバー(共有ログイン含む)にだけ見える', () => {
  const access = { orgId: ORG, tracks: [], reflections: [] };
  assert.equal(canSeeProject(W, access), true);
  assert.equal(canSeeProject(MEMBER, access), true);
  assert.equal(canSeeProject(OUTSIDER, access), false);
  assert.equal(canSeeProject(anonymous(), access), false);
  assert.equal(canSeeProject(W, null), false);
});

test('(b) 組織未設定の共有ログインは何も見えない (空の器も public も)', () => {
  assert.equal(canSeeProject(NOORG, { orgId: ORG, tracks: [trk('public')], reflections: [] }), false);
  assert.equal(canSeeProject(NOORG, { orgId: null, tracks: [], reflections: [] }), false);
  assert.equal(canSeeProject(NOORG, { orgId: null, tracks: [trk('org')], reflections: [] }), false);
});

test('(1) ログインユーザー: 自分の private・乗った private・組織の org が見える', () => {
  const access = {
    orgId: ORG,
    tracks: [trk('private', { ownerId: 'u_owner' }), trk('private', { crewIds: ['u_owner'] }), trk('org'), trk('private')],
    reflections: [rfl('r0', 'private', { ownerId: 'u_owner' }), rfl('r1', 'private', { ownerId: 'u_x' })],
  };
  const o = filterProject(OWNER, proj(4, 2), access);
  assert.deepEqual(o.tracks.map((t) => t.id), ['t0', 't1']); // org は他組織なので見えない
  assert.deepEqual(o.reflections.map((r) => r.id), ['r0']);
  const m = filterProject(MEMBER, proj(4, 2), access);
  assert.deepEqual(m.tracks.map((t) => t.id), ['t2']);
  assert.deepEqual(m.reflections, []);
});

test('互換 API で書けるのは組織設定済みで書込権限のある共有ログインだけ', () => {
  assert.equal(isCompatWriter(W), true);
  assert.equal(isCompatWriter(R), false);
  assert.equal(isCompatWriter(NOORG), false);
  assert.equal(isCompatWriter(MEMBER), false);
  assert.equal(isCompatWriter(anonymous()), false);
  assert.equal(isCompatWriter(null), false);
});

test('(3) PUT: 新しい器は書ける・既存の器は自組織のものだけ', () => {
  assert.equal(canPutDay(W, null), true);
  assert.equal(canPutDay(W, { orgId: ORG, tracks: [], reflections: [] }), true);
  assert.equal(canPutDay(W, { orgId: 'o_other', tracks: [], reflections: [] }), false);
  assert.equal(canPutDay(W, { orgId: null, tracks: [], reflections: [] }), false);
  assert.equal(canPutDay(NOORG, null), false);
  assert.equal(canPutDay(MEMBER, null), false);
});

test('(3) PUT で管理する反省は、見えて書ける行だけ', () => {
  const managed = managedReflectionPredicate(W, ORG);
  assert.equal(managed({ id: 'a', visibility: 'org', ownerId: null }), true);
  assert.equal(managed({ id: 'a', visibility: 'public', ownerId: 'u_x' }), true);
  assert.equal(managed({ id: 'a', visibility: 'private', ownerId: 'u_x' }), false);
  assert.equal(managedReflectionPredicate(W, 'o_other')({ id: 'a', visibility: 'org', ownerId: null }), false);
});

test('(3) DELETE: 中身が全部書けるときだけ。見えない項目が混じる器は消さない', () => {
  const ok = { orgId: ORG, tracks: [trk('org')], reflections: [rfl('r0', 'org')] };
  const hidden = { orgId: ORG, tracks: [trk('org')], reflections: [rfl('r0', 'org'), rfl('r1', 'private')] };
  assert.equal(canDeleteDay(W, ok), true);
  assert.equal(canDeleteDay(W, hidden), false);
  assert.equal(canDeleteDay(W, { orgId: ORG, tracks: [], reflections: [] }), true);
  assert.equal(canDeleteDay(W, { orgId: 'o_other', tracks: [], reflections: [] }), false);
  assert.equal(canDeleteDay(R, ok), false);
  assert.equal(canDeleteDay(MEMBER, ok), false);
  assert.equal(canDeleteDay(W, null), false);
});

// ---- (4) progress ----
const idx = buildReflectionIndex([
  { id: 'rA', visibility: 'org', ownerId: null, orgId: ORG },
  { id: 'rP', visibility: 'private', ownerId: 'u_x', orgId: ORG },
  { id: 'rO', visibility: 'public', ownerId: 'u_y', orgId: 'o_other' },
  { id: 'rOO', visibility: 'org', ownerId: 'u_y', orgId: 'o_other' },
  { id: 'rD', visibility: 'org', ownerId: null, orgId: ORG },
  { id: 'rD', visibility: 'private', ownerId: 'u_x', orgId: ORG }, // 旧データの ID 重複
]);
const PROG = {
  rA: { issueStage: 1, goalDone: false, comments: { goal: [{ text: 'a', ts: 1 }] } },
  rP: { issueStage: 2, goalDone: true },
  rO: { issueStage: 3 },
  rOO: { issueStage: 4 },
  rD: { issueStage: 5 },
  orphan: { issueStage: 9 },
};

test('(4) progress 読み取り: 見える反省の進捗だけ。孤立した進捗は共有ログインにだけ', () => {
  assert.deepEqual(Object.keys(filterProgressRead(W, PROG, idx)).sort(), ['orphan', 'rA', 'rO']);
  assert.deepEqual(Object.keys(filterProgressRead(R, PROG, idx)).sort(), ['orphan', 'rA', 'rO']);
  assert.deepEqual(Object.keys(filterProgressRead(NOORG, PROG, idx)), []);
  assert.deepEqual(Object.keys(filterProgressRead(MEMBER, PROG, idx)).sort(), ['rA', 'rO']);
  // 他組織 (o_other) のメンバー: 自分の組織の org と public は見えるが、孤立した進捗や o_main の org は見えない
  assert.deepEqual(Object.keys(filterProgressRead(OUTSIDER, PROG, idx)).sort(), ['rO', 'rOO']);
  assert.deepEqual(Object.keys(filterProgressRead(user('u_zzz', []), PROG, idx)).sort(), ['rO']);
});

test('(4)(c) progress 書き込み: 見えない反省 (private・ID 重複の一方が private) の進捗は元のまま', () => {
  const incoming = {
    rA: { issueStage: 7, goalDone: true },
    rP: { issueStage: 99 },
    rD: { issueStage: 99 },
    orphan: { issueStage: 10 },
  };
  const out = mergeProgressWrite(W, PROG, incoming, idx);
  assert.deepEqual(out.rP, PROG.rP, 'private は元のまま');
  assert.deepEqual(out.rD, PROG.rD, 'ID 重複で片方が private なら元のまま');
  assert.equal(out.rA.issueStage, 7);
  assert.equal(out.rA.goalDone, true);
  assert.equal(out.orphan.issueStage, 10);
  // incoming に無い (読めて更新できる) 項目は従来どおり消える。他組織の public は読めるが更新できず残る
  assert.equal('rOO' in out, true, '見えない他組織 org は残る');
  assert.deepEqual(out.rOO, PROG.rOO);
  assert.deepEqual(out.rO, PROG.rO, '他組織 public は更新できず残る');
});

test('(4)(d) progress 書き込み: 他組織の public にはコメントも進捗も書けない。自組織なら書ける', () => {
  const incoming = {
    rA: { issueStage: 1, comments: { goal: [{ text: 'a', ts: 1 }, { text: '新しい', ts: 2 }] } },
    rO: { issueStage: 9, comments: { goal: [{ text: '他組織へ', ts: 3 }] } },
  };
  const out = mergeProgressWrite(W, PROG, incoming, idx);
  assert.equal(out.rA.comments.goal.length, 2);
  assert.deepEqual(out.rO, PROG.rO);
});

test('(4) progress 書き込み: 新しい反省の進捗は作れる。読めない反省には作れない', () => {
  const out = mergeProgressWrite(W, {}, { rA: { issueStage: 1 }, rP: { issueStage: 2 }, rZ: 'x' }, idx);
  assert.deepEqual(out, { rA: { issueStage: 1 } });
});

test('(4) progress 書き込み: トークンの無い共有ログイン・組織未設定は何も変えない', () => {
  for (const s of [R, NOORG]) {
    const out = mergeProgressWrite(s, PROG, { rA: { issueStage: 100 } }, idx);
    assert.equal(out.rA.issueStage, 1);
    assert.deepEqual(out, PROG);
  }
});

// ---- (4)(e) roadmap ----
const RM_ACCESS = [
  { legacyName: 'A', orgId: ORG, userId: null },
  { legacyName: 'B', orgId: ORG, userId: 'u_b' },
  { legacyName: 'C', orgId: 'o_other', userId: null },
  { legacyName: 'D', orgId: null, userId: null },
  { legacyName: 'E', orgId: 'o_other', userId: 'u_out' },
];
const RM = { A: { goal: 'a' }, B: { goal: 'b' }, C: { goal: 'c' }, D: { goal: 'd' }, E: { goal: 'e' } };

test('(e) roadmap 読み取り: 組織メンバーだけ。他組織・組織なしの行は見えない', () => {
  assert.deepEqual(Object.keys(filterRoadmapRead(W, RM, RM_ACCESS)).sort(), ['A', 'B']);
  assert.deepEqual(Object.keys(filterRoadmapRead(R, RM, RM_ACCESS)).sort(), ['A', 'B']);
  assert.deepEqual(Object.keys(filterRoadmapRead(NOORG, RM, RM_ACCESS)), []);
  assert.deepEqual(Object.keys(filterRoadmapRead(MEMBER, RM, RM_ACCESS)).sort(), ['A', 'B']);
  assert.deepEqual(Object.keys(filterRoadmapRead(OUTSIDER, RM, RM_ACCESS)).sort(), ['C', 'E'], '他組織のメンバーは自組織の行だけ');
  assert.deepEqual(Object.keys(filterRoadmapRead(user('u_zzz', []), RM, RM_ACCESS)), [], '組織に入っていないユーザーは何も見えない');
  assert.deepEqual(Object.keys(filterRoadmapRead(user('u_out', []), RM, RM_ACCESS)), ['E'], '本人の行は見える');
  assert.deepEqual(Object.keys(filterRoadmapRead(anonymous(), RM, RM_ACCESS)), []);
});

test('(4) roadmap 書き込み: 見えない行は元のまま、新しい名前は追加、incoming に無い自組織の行は消える', () => {
  const out = mergeRoadmapWrite(W, RM, { A: { goal: 'a2' }, C: { goal: '乗っ取り' }, N: { goal: 'new' } }, RM_ACCESS);
  assert.equal(out.A.goal, 'a2');
  assert.equal(out.C.goal, 'c');
  assert.equal(out.D.goal, 'd');
  assert.equal(out.E.goal, 'e');
  assert.equal(out.N.goal, 'new');
  assert.equal('B' in out, false, '自組織の B は incoming に無いので消える (従来の全置き換え。紐付け済みは DB 側で残る)');
});

test('(4) roadmap 書き込み: トークンの無い共有ログイン・組織未設定は何も変えない', () => {
  for (const s of [R, NOORG]) {
    assert.deepEqual(mergeRoadmapWrite(s, RM, { A: { goal: 'x' }, N: { goal: 'n' } }, RM_ACCESS), RM);
  }
});
