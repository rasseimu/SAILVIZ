// test/homeview.test.js
// ホーム画面(直近の練習・全体目標・使い方ガイド)の純関数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAM_GOAL_KEY, teamGoalOf, setTeamGoal, latestPractice, recentPracticeHtml, memberGoalsHtml, guideHtml, GUIDE_STEPS,
} from '../src/homeview.js';
import { decomposeRoadmap, assembleRoadmap } from '../server/domain/overlayRows.js';

test('teamGoalOf / setTeamGoal: 予約キーに置き、部員のエントリは変えない', () => {
  assert.equal(teamGoalOf({}), '');
  assert.equal(teamGoalOf(null), '');
  const rm = { '村瀬 礼': { goal: '上り速く', milestones: [{ id: 'a', title: 'x', done: false, doneAt: null }] } };
  const next = setTeamGoal(rm, '  全日本インカレ入賞  ');
  assert.equal(teamGoalOf(next), '全日本インカレ入賞');
  assert.deepEqual(next['村瀬 礼'], rm['村瀬 礼']);
  assert.deepEqual(next[TEAM_GOAL_KEY].milestones, []);
  assert.equal(rm[TEAM_GOAL_KEY], undefined); // 元は変えない
});

test('setTeamGoal: 既存の milestones は残す', () => {
  const rm = { [TEAM_GOAL_KEY]: { goal: 'old', milestones: [{ id: 'm1', title: 't', done: true, doneAt: 1 }] } };
  assert.deepEqual(setTeamGoal(rm, 'new')[TEAM_GOAL_KEY].milestones, rm[TEAM_GOAL_KEY].milestones);
});

test('全体目標は roadmap の DB 行分解を往復する', () => {
  const rm = setTeamGoal({ '村瀬 礼': { goal: 'g', milestones: [] } }, '部の目標');
  assert.equal(teamGoalOf(assembleRoadmap(decomposeRoadmap(rm))), '部の目標');
});

test('latestPractice: trackedAt が最新の練習。日時なしは後ろ。空は null', () => {
  assert.equal(latestPractice([]), null);
  assert.equal(latestPractice(null), null);
  const a = { name: 'a', trackedAt: 100 };
  const b = { name: 'b', trackedAt: 300 };
  const c = { name: 'c', trackedAt: null };
  assert.equal(latestPractice([a, c, b]), b);
  assert.equal(latestPractice([c, a]), a);
  assert.equal(latestPractice([c]), c);
});

const summaryWithDs = {
  name: 'p1.json', label: '2026/10/18 (土) 9:30', trackCount: 3, reflectionCount: 5, videoCount: 2, wind: '北 4m/s',
  daySummary: {
    overall: { durationMs: 2 * 3600_000, windAxis: { ok: true, value: { deg: 0 } } },
    comparison: {
      bestUpwind: { ok: true, value: { index: 0, name: '4899<b>', color: '#ff0000', vmgMps: 2 } },
      bestDownwind: { ok: false, reason: 'no-overlap' },
    },
  },
};

test('recentPracticeHtml: 練習なしは案内と練習データへの導線', () => {
  const html = recentPracticeHtml(null);
  assert.match(html, /まだ保存済みの練習がありません/);
  assert.match(html, /data-home-action="practices"/);
});

test('recentPracticeHtml: サマリありなら時間・風軸・VMG最高とサマリボタン(艇名はエスケープ)', () => {
  const html = recentPracticeHtml(summaryWithDs);
  assert.match(html, /2026\/10\/18/);
  assert.match(html, /2時間0分/);
  assert.match(html, /0°（北）/);
  assert.match(html, /4899&lt;b&gt;/);
  assert.doesNotMatch(html, /4899<b>/);
  assert.match(html, /data-home-action="open"/);
  assert.match(html, /data-home-action="summary"/);
});

test('recentPracticeHtml: サマリなしならサマリボタンを出さない', () => {
  const html = recentPracticeHtml({ ...summaryWithDs, daySummary: null });
  assert.match(html, /data-home-action="open"/);
  assert.doesNotMatch(html, /data-home-action="summary"/);
  assert.match(html, /サマリが保存されていません/);
});

test('memberGoalsHtml: 目標がある部員だけ、段階の進み具合つき', () => {
  const members = [{ fullName: 'A 太郎' }, { fullName: 'B 花子' }, { fullName: 'C 次郎' }];
  const rm = {
    'A 太郎': { goal: '上り<速く>', milestones: [{ id: '1', done: true }, { id: '2', done: false }] },
    'B 花子': { goal: '  ', milestones: [] },
    [TEAM_GOAL_KEY]: { goal: '部', milestones: [] },
  };
  const html = memberGoalsHtml(rm, members);
  assert.match(html, /A 太郎/);
  assert.match(html, /上り&lt;速く&gt;/);
  assert.match(html, /1\/2 段階/);
  assert.doesNotMatch(html, /B 花子/);
  assert.doesNotMatch(html, /C 次郎/);
  assert.match(memberGoalsHtml({}, members), /まだ登録されていません/);
});

test('guideHtml: 全手順を番号付きで出し、画面遷移か組織管理へのリンクを持つ', () => {
  const html = guideHtml();
  assert.equal((html.match(/class="hs-guide-step"/g) || []).length, GUIDE_STEPS.length);
  assert.match(html, /data-home-nav="progress"/);
  assert.match(html, /data-home-nav="study"/);
  assert.match(html, /「プロ動画」「コーチング\(beta\)」フォルダの動画/, '勉強ページのガイドは両方のフォルダ');
  assert.match(html, /href="\/account#org"/);
});
