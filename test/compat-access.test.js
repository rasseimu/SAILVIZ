// test/compat-access.test.js
// 互換 API の認可(S2.5-P2)。純関数。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacySharedPrincipal, user, anonymous } from '../server/domain/policy.js';
import {
  isCompatWriter, canSeeProject, filterProject, canPutDay, canDeleteDay, managedReflectionPredicate,
  buildReflectionIndex, filterProgressRead, mergeProgressWrite, filterRoadmapRead, mergeRoadmapWrite,
  keepNewApiComments, commentAuthorError,
} from '../server/domain/compatAccess.js';

const ORG = 'o_main';
const W = legacySharedPrincipal({ orgId: ORG, canWrite: true });
const R = legacySharedPrincipal({ orgId: ORG, canWrite: false });
const NOORG = legacySharedPrincipal({ orgId: null, canWrite: true });
// ログインユーザーは表示中の組織(所属の先頭)を持つ。
const MEMBER = user('u_member', [ORG], ORG);
const OUTSIDER = user('u_out', ['o_other'], 'o_other');
const OWNER = user('u_owner', ['o_other'], 'o_other');

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

test('(1) ログインユーザー: 表示中の組織の器で、自分の private・乗った private・組織の org が見える', () => {
  const access = {
    orgId: ORG,
    tracks: [trk('private', { ownerId: 'u_owner' }), trk('private', { crewIds: ['u_owner'] }), trk('org'), trk('private')],
    reflections: [rfl('r0', 'private', { ownerId: 'u_owner' }), rfl('r1', 'private', { ownerId: 'u_x' })],
  };
  // 表示中でない組織の器は、自分の private があっても出さない(設計書 §5.3)
  assert.equal(filterProject(OWNER, proj(4, 2), access), null);
  const o = filterProject(user('u_owner', [ORG], ORG), proj(4, 2), access);
  assert.deepEqual(o.tracks.map((t) => t.id), ['t0', 't1', 't2']);
  assert.deepEqual(o.reflections.map((r) => r.id), ['r0']);
  const m = filterProject(MEMBER, proj(4, 2), access);
  assert.deepEqual(m.tracks.map((t) => t.id), ['t2']);
  assert.deepEqual(m.reflections, []);
});

test('互換 API で書けるのは組織設定済みで書込権限のある共有ログインと、表示中の組織があるユーザー', () => {
  assert.equal(isCompatWriter(W), true);
  assert.equal(isCompatWriter(R), false);
  assert.equal(isCompatWriter(NOORG), false);
  assert.equal(isCompatWriter(MEMBER), true);
  assert.equal(isCompatWriter(user('u_zzz', [])), false);
  assert.equal(isCompatWriter(anonymous()), false);
  assert.equal(isCompatWriter(null), false);
});

test('(3) PUT: 新しい器は書ける・既存の器は自組織のものだけ', () => {
  assert.equal(canPutDay(W, null), true);
  assert.equal(canPutDay(W, { orgId: ORG, tracks: [], reflections: [] }), true);
  assert.equal(canPutDay(W, { orgId: 'o_other', tracks: [], reflections: [] }), false);
  assert.equal(canPutDay(W, { orgId: null, tracks: [], reflections: [] }), false);
  assert.equal(canPutDay(NOORG, null), false);
  assert.equal(canPutDay(user('u_zzz', []), null), false);
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
  assert.equal(canDeleteDay(MEMBER, ok), true);
  assert.equal(canDeleteDay(OUTSIDER, ok), false);
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

test('(4) progress 読み取り: 見える反省の進捗だけ。孤立した進捗は共有ログインにだけ。user は表示中の組織だけ', () => {
  assert.deepEqual(Object.keys(filterProgressRead(W, PROG, idx)).sort(), ['orphan', 'rA', 'rO']);
  assert.deepEqual(Object.keys(filterProgressRead(R, PROG, idx)).sort(), ['orphan', 'rA', 'rO']);
  assert.deepEqual(Object.keys(filterProgressRead(NOORG, PROG, idx)), []);
  // user は他組織の public (rO) も出さない
  assert.deepEqual(Object.keys(filterProgressRead(MEMBER, PROG, idx)).sort(), ['rA']);
  // 他組織 (o_other) のメンバー: 自分の組織の org と public は見えるが、孤立した進捗や o_main の org は見えない
  assert.deepEqual(Object.keys(filterProgressRead(OUTSIDER, PROG, idx)).sort(), ['rO', 'rOO']);
  assert.deepEqual(Object.keys(filterProgressRead(user('u_zzz', []), PROG, idx)), []);
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
  assert.deepEqual(Object.keys(filterRoadmapRead(user('u_out', []), RM, RM_ACCESS)), [], '表示中の組織が無ければ本人の行も出さない');
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

// ---- 表示中の組織(activeOrgId)への絞り込み ----
const OA = 'o_a'; const OB = 'o_b';
const XA = user('u_x', [OA, OB], OA); // A と B に所属し、A を表示中
const XB = user('u_x', [OA, OB], OB);
const FORBIDDEN = { ...user('u_x', [OA], null), orgForbidden: true };

test('isCompatWriter: activeOrgId のある user は書き手、orgForbidden は書き手でない', () => {
  assert.equal(isCompatWriter(XA), true);
  assert.equal(isCompatWriter(user('u_x', [OA], null)), false);
  assert.equal(isCompatWriter(FORBIDDEN), false);
  assert.equal(isCompatWriter({ ...user('u_x', [OA], OA), orgForbidden: true }), false);
});

test('canSeeProject: user は表示中でない組織の器を(public でも)見ない', () => {
  const inB = { orgId: OB, tracks: [trk('public')], reflections: [rfl('r0', 'public')] };
  assert.equal(canSeeProject(XA, inB), false);
  assert.equal(filterProject(XA, proj(1, 1), inB), null);
  assert.equal(canSeeProject(XB, inB), true);
  const other = { orgId: 'o_other', tracks: [trk('public')], reflections: [] };
  assert.equal(canSeeProject(XA, other), false, '他組織の public も出さない');
  assert.equal(canSeeProject(XA, { orgId: OB, tracks: [], reflections: [] }), false, '空の器も表示中の組織だけ');
  assert.equal(canSeeProject(XA, { orgId: OA, tracks: [], reflections: [] }), true);
  assert.equal(canSeeProject(FORBIDDEN, { orgId: OA, tracks: [trk('org')], reflections: [] }), false);
  // 共有ログインは今までどおり他組織の public が見える
  assert.equal(canSeeProject(W, other), true);
});

test('canPutDay / canDeleteDay: user は表示中の組織の器だけ', () => {
  const dayA = { orgId: OA, tracks: [trk('org')], reflections: [rfl('r0', 'org')] };
  const dayB = { orgId: OB, tracks: [trk('org')], reflections: [rfl('r0', 'org')] };
  assert.equal(canPutDay(XA, null), true, '新しい器は書ける');
  assert.equal(canPutDay(XA, dayA), true);
  assert.equal(canPutDay(XA, dayB), false, '所属していても表示中でない組織は書かない');
  assert.equal(canPutDay(FORBIDDEN, null), false);
  assert.equal(canDeleteDay(XA, dayA), true, '作成者でなくても表示中の組織なら消せる');
  assert.equal(canDeleteDay(XA, dayB), false);
  assert.equal(canDeleteDay(XB, dayB), true);
  assert.equal(canDeleteDay(XA, { ...dayA, reflections: [rfl('r0', 'private', { ownerId: 'u_y' })] }), false);
  assert.equal(managedReflectionPredicate(XA, OA)({ id: 'a', visibility: 'org', ownerId: null }), true);
  assert.equal(managedReflectionPredicate(XA, OB)({ id: 'a', visibility: 'org', ownerId: null }), false);
});

const idx2 = buildReflectionIndex([
  { id: 'rA', visibility: 'org', ownerId: 'u_y', orgId: OA },
  { id: 'rB', visibility: 'org', ownerId: 'u_y', orgId: OB },
  { id: 'rDup', visibility: 'org', ownerId: null, orgId: OA }, // 同じ反省 ID が A と B にある
  { id: 'rDup', visibility: 'org', ownerId: null, orgId: OB },
]);
const PROG2 = { rA: { issueStage: 1 }, rB: { issueStage: 2 }, rDup: { issueStage: 3 }, orphan: { issueStage: 4 } };

test('mergeProgressWrite: 表示中の組織の外にも同じ反省 ID があれば書かない', () => {
  const out = mergeProgressWrite(XA, PROG2, { rA: { issueStage: 1 }, rDup: { issueStage: 99 } }, idx2);
  assert.deepEqual(out.rDup, PROG2.rDup, 'B にもある rDup は変わらない');
  assert.deepEqual(out.rB, PROG2.rB, 'incoming に無い B の進捗は消さない');
  assert.deepEqual(out.orphan, PROG2.orphan, '孤立した進捗も user は消さない');
  // incoming に無くても、外にある ID は消えない
  const out2 = mergeProgressWrite(XA, PROG2, {}, idx2);
  assert.deepEqual(Object.keys(out2).sort(), ['orphan', 'rB', 'rDup']);
  assert.deepEqual(Object.keys(filterProgressRead(XA, PROG2, idx2)), ['rA']);
});

test('mergeProgressWrite: 表示中の組織の反省の進捗は作成者でなくても書ける', () => {
  const out = mergeProgressWrite(XA, PROG2, { rA: { issueStage: 7, comments: { goal: [{ text: 'c', ts: 1 }] } } }, idx2);
  assert.equal(out.rA.issueStage, 7);
  assert.equal(out.rA.comments.goal.length, 1);
  const outB = mergeProgressWrite(XB, PROG2, { rB: { issueStage: 8 }, rA: { issueStage: 9 } }, idx2);
  assert.equal(outB.rB.issueStage, 8);
  assert.deepEqual(outB.rA, PROG2.rA, '表示中でない A は変わらない');
});

test('filterRoadmapRead / mergeRoadmapWrite: user は表示中の組織の行だけ読み書きし、新しい名前は書き手として作れる', () => {
  const access = [
    { legacyName: 'a1', orgId: OA, userId: null },
    { legacyName: 'a2', orgId: OA, userId: 'u_y' },
    { legacyName: 'b1', orgId: OB, userId: 'u_x' }, // 本人の行でも表示中でなければ出さない
  ];
  const rm = { a1: { goal: '1' }, a2: { goal: '2' }, b1: { goal: '3' } };
  assert.deepEqual(Object.keys(filterRoadmapRead(XA, rm, access)).sort(), ['a1', 'a2']);
  assert.deepEqual(Object.keys(filterRoadmapRead(XB, rm, access)), ['b1']);
  const out = mergeRoadmapWrite(XA, rm, { a1: { goal: 'x' }, b1: { goal: '乗っ取り' }, N: { goal: 'new' } }, access);
  assert.equal(out.a1.goal, 'x');
  assert.equal('a2' in out, false, '表示中の組織の行は全置き換えで消える');
  assert.equal(out.b1.goal, '3', '表示中でない組織の行は元のまま');
  assert.equal(out.N.goal, 'new');
  assert.deepEqual(mergeRoadmapWrite(FORBIDDEN, rm, { a1: { goal: 'x' }, N: { goal: 'n' } }, access), rm);
});

test('keepNewApiComments: Web の古い進捗にない新 API のコメント(via: api)を残し、Web で消した名前付きのコメントは残さない', () => {
  const existing = {
    issueStage: 1,
    comments: {
      goal: [{ text: 'web', ts: 1, author: '乗員1' }, { text: 'app', ts: 2, authorUserId: 'u_a', author: '乗員2', via: 'api' }],
      issue: [{ text: 'app2', ts: 3, authorUserId: 'u_b', author: '乗員3', via: 'api' }],
      discovery: [{ text: '消した', ts: 4, author: '乗員1' }],
    },
  };
  // Web はアプリのコメントを読む前の進捗を送る(goal の web だけ残し、discovery の名前付きコメントを消した)
  const incoming = { issueStage: 2, comments: { goal: [{ text: 'web', ts: 1, author: '乗員1' }, { text: 'new', ts: 5, author: '乗員1' }] } };
  const out = keepNewApiComments(existing, incoming);
  assert.deepEqual(out, {
    issueStage: 2,
    comments: {
      goal: [{ text: 'web', ts: 1, author: '乗員1' }, { text: 'new', ts: 5, author: '乗員1' }, existing.comments.goal[1]],
      issue: [existing.comments.issue[0]],
    },
  });
  assert.equal(incoming.comments.goal.length, 2, 'incoming は書き換えない');
  // Web が新 API のコメントを読んだ後なら(同じ ts・text がある)二重にしない
  const seen = { comments: { goal: [existing.comments.goal[1]] } };
  assert.deepEqual(keepNewApiComments({ comments: { goal: [existing.comments.goal[1]] } }, seen), seen);
  // 残すものが無ければ incoming のまま(comments キーを足さない)
  assert.deepEqual(keepNewApiComments({ comments: { goal: [{ text: 'web', ts: 1 }] } }, { goalDone: true }), { goalDone: true });
  // mergeProgressWrite でも残る
  const idx = buildReflectionIndex([{ id: 'r1', visibility: 'org', ownerId: null, orgId: ORG }]);
  const merged = mergeProgressWrite(W, { r1: existing }, { r1: incoming }, idx);
  assert.deepEqual(merged.r1, out);
});

test('keepNewApiComments: 読んだ時刻(readAt)より前からある新 API のコメントは、Web が消せば消え、後に足されたものだけ残る', () => {
  const before = { text: '読む前', ts: 10, authorUserId: 'u_a', author: '乗員2', via: 'api' };
  const after = { text: '読んだ後', ts: 30, authorUserId: 'u_a', author: '乗員2', via: 'api' };
  const same = { text: '同時', ts: 20, authorUserId: 'u_a', author: '乗員2', via: 'api' };
  const existing = { comments: { goal: [before, same, after] } };
  assert.deepEqual(keepNewApiComments(existing, { comments: { goal: [] } }, 20), { comments: { goal: [same, after] } });
  // readAt が無い(古い Web の画面)ときは今までどおり全部残す
  assert.deepEqual(keepNewApiComments(existing, { comments: { goal: [] } }), { comments: { goal: [before, same, after] } });
  // mergeProgressWrite に readAt を渡す(項目ごと無い場合も同じ)
  const idx = buildReflectionIndex([{ id: 'r1', visibility: 'org', ownerId: null, orgId: ORG }]);
  assert.deepEqual(mergeProgressWrite(W, { r1: existing }, { r1: { comments: {} } }, idx, { readAt: 20 }).r1, { comments: { goal: [same, after] } });
  assert.deepEqual(mergeProgressWrite(W, { r1: { issueStage: 1, comments: { goal: [before] } } }, {}, idx, { readAt: 20 }), {});
});

test('mergeProgressWrite: incoming に反省の項目ごと無くても、新 API のコメントだけは残し、進捗の値は戻さない', () => {
  const idx = buildReflectionIndex([{ id: 'r1', visibility: 'org', ownerId: null, orgId: ORG }, { id: 'r2', visibility: 'org', ownerId: null, orgId: ORG }]);
  const app = { text: 'app', ts: 2, authorUserId: 'u_a', author: '乗員2', via: 'api' };
  const existing = {
    r1: { issueStage: 3, goalDone: true, comments: { goal: [{ text: 'web', ts: 1, author: '乗員1' }, app] } },
    r2: { issueStage: 1, comments: { goal: [{ text: 'web', ts: 1, author: '乗員1' }] } },
  };
  const out = mergeProgressWrite(W, existing, {}, idx);
  assert.deepEqual(out, { r1: { comments: { goal: [app] } } });
  assert.deepEqual(keepNewApiComments(existing.r2, {}), {}, '新 API のコメントが無ければ何も足さない');
});

test('commentAuthorError: 新しく足したコメントは名簿の名前が要る(AI コメントと前からあるコメントは問わない)', () => {
  const roster = [{ fullName: '乗員1' }, { fullName: '乗員2' }];
  const existing = { r1: { comments: { goal: [{ text: '旧', ts: 1 }] } } };
  // 前からある名前なしのコメントはそのまま送り返してよい
  assert.equal(commentAuthorError(existing, { r1: { comments: { goal: [{ text: '旧', ts: 1 }] } } }, roster), null);
  // 新しいコメントに名簿の名前があれば通る
  assert.equal(commentAuthorError(existing, { r1: { comments: { goal: [{ text: '旧', ts: 1 }, { text: '新', ts: 2, author: '乗員2' }] } } }, roster), null);
  // 名前が無い・名簿外・空白だけは断る
  assert.match(commentAuthorError(existing, { r1: { comments: { goal: [{ text: '新', ts: 2 }] } } }, roster), /名前/);
  assert.match(commentAuthorError(existing, { r1: { comments: { issue: [{ text: '新', ts: 2, author: '部外者' }] } } }, roster), /部外者/);
  assert.match(commentAuthorError({}, { r2: { comments: { goal: [{ text: '新', ts: 2, author: '  ' }] } } }, roster), /名前/);
  // AI コメントは名前が無くてよい
  assert.equal(commentAuthorError({}, { r2: { comments: { goal: [{ text: 'AI', ts: 2, ai: true }] } } }, roster), null);
  // 形の崩れた入力では投げない
  assert.equal(commentAuthorError(null, { r1: 'x', r2: { comments: { goal: 'x' } } }, roster), null);
});
