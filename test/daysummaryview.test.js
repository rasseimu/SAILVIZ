// 今日の練習サマリ(表示)のテスト。daySummary オブジェクトだけから HTML を組むことを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REASON_TEXT, formatKt, formatDuration, formatDistance, formatWindDeg, formatWindRange,
  renderDaySummaryHtml,
} from '../src/daysummaryview.js';
import { DAY_SUMMARY_REASONS } from '../src/daysummaryschema.js';

const START = Date.UTC(2026, 7, 23, 4, 21); // 2026-08-23 13:21 JST
const END = START + (2 * 60 + 27) * 60_000; // 15:48 JST

function boat(i, over = {}) {
  return {
    index: i, name: `boat${i}.csv`, color: '#1c72b8',
    distanceM: 18_200, durationMs: (2 * 60 + 21) * 60_000,
    avgSpeedMps: { ok: true, value: 3.0864 }, maxSpeedMps: { ok: true, value: 5.04 },
    tacks: { ok: true, value: 24 }, gybes: { ok: true, value: 11 },
    quality: { level: 'good', note: '欠損0%・記録間隔1秒・精度5m' },
    ...over,
  };
}

function fixture(over = {}) {
  return {
    version: 1, sourceKey: 'k', computedAt: 0,
    overall: {
      startMs: START, endMs: END, durationMs: END - START, boatCount: 1,
      quality: { level: 'caution', note: '欠損12%・記録間隔2秒', boatIndex: null },
      windAxis: { ok: true, value: { deg: 215 } },
      windRange: { ok: true, value: { minDeg: -8, maxDeg: 14 } },
    },
    boats: [boat(0)],
    comparison: null,
    ...over,
  };
}

function twoBoats() {
  return fixture({
    overall: { ...fixture().overall, boatCount: 2 },
    boats: [boat(0), boat(1, { color: '#e67e22' })],
    comparison: {
      comparableMs: { ok: true, value: 102 * 60_000 },
      bestUpwind: { ok: true, value: { index: 0, name: 'boat0.csv', color: '#1c72b8', vmgMps: 1.75 } },
      bestDownwind: { ok: false, reason: 'no-overlap' },
    },
  });
}

test('REASON_TEXT は保存形の理由コードをすべて持つ', () => {
  assert.deepEqual(Object.keys(REASON_TEXT).sort(), [...DAY_SUMMARY_REASONS].sort());
});

test('形チェック用 fixture(2艇・ok:false 混在)を例外なく描画できる', () => {
  const ds = JSON.parse(readFileSync(new URL('./fixtures/day-summary-v1.json', import.meta.url), 'utf8'));
  const html = renderDaySummaryHtml(ds);
  assert.ok(html.includes('b.csv: 欠損0%・記録間隔10秒'));
  assert.ok(html.includes(REASON_TEXT['gps-poor']));
});

test('整形: kt・時間・距離・方位・変動幅', () => {
  assert.equal(formatKt(3.0864), '6.0kt');
  assert.equal(formatDuration((2 * 60 + 27) * 60_000), '2時間27分');
  assert.equal(formatDuration(45 * 60_000), '45分');
  assert.equal(formatDistance(18_200), '18.2km');
  assert.equal(formatDistance(297), '297m');
  assert.equal(formatWindDeg(215), '215°（南西）');
  assert.equal(formatWindDeg(0), '0°（北）');
  assert.equal(formatWindRange({ minDeg: -8, maxDeg: 14 }), '左8°〜右14°');
});

test('練習全体: JSTの開始〜終了・練習時間・艇数・品質・推定風軸', () => {
  const html = renderDaySummaryHtml(fixture());
  assert.ok(html.includes('2026-08-23 13:21〜15:48（2時間27分）'));
  assert.ok(html.includes('GPS取得 1艇'));
  assert.ok(html.includes('注意'));
  assert.ok(html.includes('欠損12%・記録間隔2秒'));
  assert.ok(html.includes('215°（南西）'));
  assert.ok(html.includes('左8°〜右14°'));
});

test('練習全体: JSTで日付をまたぐときは終了側にも日付を出す', () => {
  const ds = fixture();
  ds.overall.startMs = Date.parse('2026-08-07T13:55:00+09:00');
  ds.overall.endMs = Date.parse('2026-08-08T13:35:00+09:00');
  ds.overall.durationMs = ds.overall.endMs - ds.overall.startMs;
  assert.ok(renderDaySummaryHtml(ds).includes('2026-08-07 13:55〜2026-08-08 13:35（23時間40分）'));
});

test('練習全体: UTCでは日付が変わってもJSTで同日なら終了側の日付は省く', () => {
  const ds = fixture();
  ds.overall.startMs = Date.parse('2026-08-07T08:30:00+09:00'); // UTC 8/6 23:30
  ds.overall.endMs = Date.parse('2026-08-07T09:30:00+09:00'); // UTC 8/7 00:30
  ds.overall.durationMs = ds.overall.endMs - ds.overall.startMs;
  assert.ok(renderDaySummaryHtml(ds).includes('2026-08-07 08:30〜09:30（1時間0分）'));
});

test('2艇で quality.boatIndex があれば、その艇の現在の名前を品質の根拠の前に付ける', () => {
  const ds = twoBoats();
  ds.overall.quality = { level: 'poor', note: '欠損0%・記録間隔10秒', boatIndex: 1 };
  ds.boats[1].name = 'B艇';
  assert.ok(renderDaySummaryHtml(ds).includes('B艇: 欠損0%・記録間隔10秒'));
});

test('推定値の見出しに「推定」が付く', () => {
  const html = renderDaySummaryHtml(fixture());
  assert.ok(html.includes('推定風軸'));
  assert.ok(html.includes('推定風軸の変動幅'));
  assert.ok(html.includes('タック（推定）'));
  assert.ok(html.includes('ジャイブ（推定）'));
  assert.ok(html.includes('GPS軌跡からの推定値'));
});

test('算出不能の項目は数値ではなく理由を出す', () => {
  const ds = fixture({
    overall: {
      ...fixture().overall,
      windAxis: { ok: false, reason: 'tacks-insufficient' },
      windRange: { ok: false, reason: 'tacks-insufficient' },
    },
    boats: [boat(0, {
      tacks: { ok: false, reason: 'gps-poor' }, gybes: { ok: false, reason: 'gps-poor' },
      avgSpeedMps: { ok: false, reason: 'not-moving' }, maxSpeedMps: { ok: false, reason: 'not-moving' },
    })],
  });
  const html = renderDaySummaryHtml(ds);
  const axisRow = html.match(/<div class="ds-axis">([\s\S]*?)<\/div>/)[1];
  assert.ok(axisRow.includes(REASON_TEXT['tacks-insufficient']));
  assert.ok(!/\d+°/.test(axisRow), `axis row should have no degrees: ${axisRow}`);
  assert.ok(html.includes(REASON_TEXT['gps-poor']));
  assert.ok(html.includes(REASON_TEXT['not-moving']));
  assert.ok(!html.includes('0kt'));
  // タックとジャイブが同じ理由なら1セルにまとめる
  assert.ok(html.includes(`<td colspan="2"><span class="ds-reason">${REASON_TEXT['gps-poor']}</span></td>`));
});

test('1艇なら艇間比較と「艇ごとに比較する」を出さない', () => {
  const html = renderDaySummaryHtml(fixture());
  assert.ok(!html.includes('艇間比較'));
  assert.ok(!html.includes('data-ds-action="compare"'));
  assert.ok(html.includes('data-ds-action="track"'));
  assert.ok(html.includes('data-ds-action="reflect"'));
});

test('2艇なら艇間比較と「艇ごとに比較する」を出す', () => {
  const html = renderDaySummaryHtml(twoBoats());
  assert.ok(html.includes('艇間比較'));
  assert.ok(html.includes('比較可能だった時間'));
  assert.ok(html.includes('1時間42分'));
  assert.ok(html.includes('クローズVMG最高'));
  assert.ok(html.includes('boat0.csv'));
  assert.ok(html.includes('3.4kt'));
  assert.ok(html.includes(REASON_TEXT['no-overlap']));
  assert.ok(html.includes('data-ds-action="compare"'));
});

test('艇名をエスケープし、不正な色は #888 にする', () => {
  const ds = fixture({ boats: [boat(0, { name: '<script>alert(1)</script>', color: 'red;background:url(x)' })] });
  const html = renderDaySummaryHtml(ds);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('url(x)'));
  assert.ok(html.includes('background:#888'));
});

test('保存案内と再計算ボタンはオプションで出し分ける', () => {
  const base = renderDaySummaryHtml(fixture());
  assert.ok(!base.includes('保存するとホームからいつでも開けます'));
  assert.ok(!base.includes('data-ds-action="recompute"'));
  const html = renderDaySummaryHtml(fixture(), { unsaved: true, canRecompute: true });
  assert.ok(html.includes('保存するとホームからいつでも開けます'));
  assert.ok(html.includes('data-ds-action="recompute"'));
});
