// src/daysummaryview.js
// 今日の練習サマリ(daySummary)をモーダル内側の HTML 文字列にする純関数群。DOM 非依存。
// daySummary だけを見て組み立てる(トラックの点データを参照しない)ので、
// 読込直後でもホームカードから開いても同じ表示になる。
export const REASON_TEXT = {
  'tacks-insufficient': 'タック数が不足しています',
  'gps-poor': 'GPS精度が不足しています',
  'no-overlap': '比較可能な区間がありません',
  'wind-unavailable': '推定風軸がないため算出できません',
  'not-moving': '走行中のデータがありません',
};
const QUALITY_TEXT = { good: '良好', caution: '注意', poor: '不足' };
const DIRS16 = [
  '北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西',
];
const MPS_TO_KT = 1.943844;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 練習JSON由来の色は信頼しない。#RGB〜#RRGGBBAA 以外は既定色にする。
function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#888';
}

export function formatKt(mps) { return `${(mps * MPS_TO_KT).toFixed(1)}kt`; }
export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h ? `${h}時間${m}分` : `${m}分`;
}
export function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}
export function formatWindDeg(deg) {
  return `${deg}°（${DIRS16[Math.round(deg / 22.5) % 16]}）`;
}
export function formatWindRange({ minDeg, maxDeg }) {
  const side = (v) => (v < 0 ? `左${-v}°` : `右${v}°`);
  return `${side(minDeg)}〜${side(maxDeg)}`;
}

const jstDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const jstClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
});

function reason(r) {
  return `<span class="ds-reason">${escapeHtml(REASON_TEXT[r] ?? '算出できません')}</span>`;
}
// Est 型を表示用 HTML に。ok なら fmt(value) をエスケープ、ok:false なら理由の文言。
function est(e, fmt) {
  if (!e || !e.ok) return reason(e?.reason);
  return escapeHtml(fmt(e.value));
}
function swatch(color) {
  return `<span class="ds-swatch" style="background:${safeColor(color)}"></span>`;
}

// 開始〜終了。JSTで日付をまたぐときだけ終了側にも日付を付ける。
function formatWhen(startMs, endMs, durationMs) {
  const startDay = jstDate.format(new Date(startMs));
  const endDay = jstDate.format(new Date(endMs));
  const end = `${endDay === startDay ? '' : `${endDay} `}${jstClock.format(new Date(endMs))}`;
  return `${startDay} ${jstClock.format(new Date(startMs))}〜${end}（${formatDuration(durationMs)}）`;
}

function overallHtml(o, boats) {
  const when = o.startMs != null && o.endMs != null
    ? formatWhen(o.startMs, o.endMs, o.durationMs)
    : '時刻不明';
  const q = o.quality || { level: 'poor', note: '', boatIndex: null };
  // どの艇の品質かは boatIndex で持つ(艇名を後で変えても追従する)。
  const who = q.boatIndex != null && boats[q.boatIndex] ? `${boats[q.boatIndex].name}: ` : '';
  const note = q.note ? `${who}${q.note}` : '';
  return '<section class="ds-overall">'
    + `<div class="ds-when">${escapeHtml(when)}</div>`
    + `<div>GPS取得 ${o.boatCount}艇</div>`
    + `<div>GPS品質: <span class="ds-q ds-q-${escapeHtml(q.level)}">${escapeHtml(QUALITY_TEXT[q.level] ?? q.level)}</span>`
    + `${note ? ` — ${escapeHtml(note)}` : ''}</div>`
    + `<div class="ds-axis">推定風軸: ${est(o.windAxis, (v) => formatWindDeg(v.deg))}</div>`
    + `<div class="ds-range">推定風軸の変動幅: ${est(o.windRange, formatWindRange)}</div>`
    + '<div class="ds-note">※ 推定風軸はGPS軌跡からの推定値です（実測ではありません）</div>'
    + '</section>';
}

function boatRowHtml(b) {
  const mTd = (!b.tacks.ok && !b.gybes.ok && b.tacks.reason === b.gybes.reason)
    ? `<td colspan="2">${reason(b.tacks.reason)}</td>`
    : `<td>${est(b.tacks, String)}</td><td>${est(b.gybes, String)}</td>`;
  return '<tr>'
    + `<td>${swatch(b.color)}${escapeHtml(b.name)}</td>`
    + `<td>${escapeHtml(formatDistance(b.distanceM))}</td>`
    + `<td>${escapeHtml(formatDuration(b.durationMs))}</td>`
    + `<td>${est(b.avgSpeedMps, formatKt)}</td>`
    + `<td>${est(b.maxSpeedMps, formatKt)}</td>`
    + mTd
    + '</tr>';
}

function boatsHtml(boats) {
  return '<section><h3>艇ごと</h3><div class="ds-table-wrap"><table class="ds-table">'
    + '<thead><tr><th>艇</th><th>走行距離</th><th>記録時間</th><th>平均速度</th><th>最高速度</th>'
    + '<th>タック（推定）</th><th>ジャイブ（推定）</th></tr></thead>'
    + `<tbody>${boats.map(boatRowHtml).join('')}</tbody></table></div></section>`;
}

function bestHtml(e) {
  if (!e || !e.ok) return reason(e?.reason);
  const v = e.value;
  return `${swatch(v.color)}${escapeHtml(v.name)}（平均 ${escapeHtml(formatKt(v.vmgMps))}）`;
}

function comparisonHtml(c) {
  return '<section class="ds-compare"><h3>艇間比較</h3>'
    + `<div>比較可能だった時間: ${est(c.comparableMs, formatDuration)}</div>`
    + `<div>クローズVMG最高: ${bestHtml(c.bestUpwind)}</div>`
    + `<div>ランニングVMG最高: ${bestHtml(c.bestDownwind)}</div>`
    + '</section>';
}

export function renderDaySummaryHtml(ds, { canRecompute = false, unsaved = false } = {}) {
  const boats = Array.isArray(ds.boats) ? ds.boats : [];
  const head = '<div class="ds-head"><strong>今日の練習サマリ</strong>'
    + (canRecompute ? '<button type="button" class="ds-btn" data-ds-action="recompute">再計算</button>' : '')
    + '<button type="button" class="ds-btn" data-ds-action="close" title="閉じる (Esc)">×</button></div>';
  const body = '<div class="ds-body">'
    + overallHtml(ds.overall || {}, boats)
    + boatsHtml(boats)
    + (ds.comparison ? comparisonHtml(ds.comparison) : '')
    + '</div>';
  const actions = '<div class="ds-actions">'
    + '<button type="button" class="ds-btn" data-ds-action="track">軌跡を見る</button>'
    + (ds.comparison ? '<button type="button" class="ds-btn" data-ds-action="compare">艇ごとに比較する</button>' : '')
    + '<button type="button" class="ds-btn" data-ds-action="reflect">今日の反省を書く</button>'
    + (unsaved ? '<div class="ds-hint">保存するとホームからいつでも開けます</div>' : '')
    + '</div>';
  return head + body + actions;
}
