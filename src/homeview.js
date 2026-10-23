// src/homeview.js
// ホーム画面(直近の練習・全体目標・使い方ガイド)の純関数群。DOM 非依存(node:test で検証する)。
// 練習は /api/summaries の要約(summary.js の practiceSummary)、目標は roadmap オーバーレイを入力にする。
import { formatKt, formatDuration, formatWindDeg } from './daysummaryview.js';
import { roadmapProgress } from './roadmapstore.js';
import { icon } from './icons.js';

// 部全体の目標は roadmap オーバーレイの予約キーに置く(部員のキーはフルネームなので衝突しない)。
// 形は部員エントリと同じ {goal, milestones} にして、DB の行分解(overlayRows.js)をそのまま通す。
export const TEAM_GOAL_KEY = '__team__';

export function teamGoalOf(roadmap) {
  const g = roadmap && roadmap[TEAM_GOAL_KEY] && roadmap[TEAM_GOAL_KEY].goal;
  return typeof g === 'string' ? g : '';
}

export function setTeamGoal(roadmap, text) {
  const prev = (roadmap && roadmap[TEAM_GOAL_KEY]) || {};
  return { ...roadmap, [TEAM_GOAL_KEY]: { milestones: [], ...prev, goal: String(text).trim() } };
}

// 練習日時(trackedAt)が最も新しい練習。日時の無い練習は日時のある練習より後ろ。無ければ null。
export function latestPractice(items) {
  let best = null;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    if (!best) { best = it; continue; }
    const a = typeof it.trackedAt === 'number' ? it.trackedAt : -Infinity;
    const b = typeof best.trackedAt === 'number' ? best.trackedAt : -Infinity;
    if (a > b) best = it;
  }
  return best;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#888';
}

const stat = (label, value) =>
  `<div class="hs-stat"><span class="hs-stat-label">${escapeHtml(label)}</span><span class="hs-stat-value">${value}</span></div>`;

function bestBoat(e) {
  if (!e || !e.ok) return '—';
  const v = e.value;
  return `<span class="hs-swatch" style="background:${safeColor(v.color)}"></span>${escapeHtml(v.name)}`
    + `<small>（${escapeHtml(formatKt(v.vmgMps))}）</small>`;
}

// 直近の練習カードの中身。ボタンは data-home-action で app.js が拾う(open: 練習を開く / summary: サマリを開く)。
export function recentPracticeHtml(item) {
  if (!item) {
    return '<p class="hs-empty">まだ保存済みの練習がありません。「練習データ」から GPS を読み込んで保存すると、ここに直近の練習が表示されます。</p>'
      + '<div class="hs-actions"><button type="button" class="hs-btn hs-btn-primary" data-home-action="practices">練習データへ</button></div>';
  }
  const ds = item.daySummary;
  const stats = [
    stat('トラック', `${item.trackCount ?? 0}艇`),
    stat('反省', `${item.reflectionCount ?? 0}件`),
    stat('動画', `${item.videoCount ?? 0}本`),
  ];
  if (ds) {
    const o = ds.overall || {};
    if (typeof o.durationMs === 'number') stats.unshift(stat('練習時間', escapeHtml(formatDuration(o.durationMs))));
    stats.push(stat('推定風軸', o.windAxis && o.windAxis.ok ? escapeHtml(formatWindDeg(o.windAxis.value.deg)) : '—'));
  }
  const best = ds && ds.comparison
    ? '<div class="hs-best">'
      + `<div><span class="hs-best-label">クローズVMG最高</span>${bestBoat(ds.comparison.bestUpwind)}</div>`
      + `<div><span class="hs-best-label">ランニングVMG最高</span>${bestBoat(ds.comparison.bestDownwind)}</div>`
      + '</div>'
    : '';
  return `<div class="hs-recent-title">${icon('navigation')} ${escapeHtml(item.label || item.name || '')}</div>`
    + (item.wind ? `<div class="hs-wind">${icon('wind')} ${escapeHtml(item.wind)}</div>` : '')
    + `<div class="hs-stats">${stats.join('')}</div>`
    + best
    + (ds ? '' : '<p class="hs-note">この練習はまだサマリが保存されていません。開いて保存するとサマリが表示されます。</p>')
    + '<div class="hs-actions">'
    + `<button type="button" class="hs-btn hs-btn-primary" data-home-action="open">練習を開く</button>`
    + (ds ? `<button type="button" class="hs-btn" data-home-action="summary">${icon('bar-chart-2')} サマリを見る</button>` : '')
    + '</div>';
}

// 部員ごとの大目標と段階の進み具合(目標を書いた部員だけ)。members は members.js の memberList()。
export function memberGoalsHtml(roadmap, members) {
  const rows = [];
  for (const m of Array.isArray(members) ? members : []) {
    const e = roadmap && roadmap[m.fullName];
    if (!e || typeof e.goal !== 'string' || !e.goal.trim()) continue;
    const { done, total } = roadmapProgress(Array.isArray(e.milestones) ? e.milestones : []);
    rows.push('<li class="hs-member-goal">'
      + `<span class="hs-member-name">${escapeHtml(m.fullName)}</span>`
      + `<span class="hs-member-text">${escapeHtml(e.goal)}</span>`
      + (total ? `<span class="hs-member-prog">${done}/${total} 段階</span>` : '')
      + '</li>');
  }
  if (!rows.length) return '<p class="hs-note">部員の目標はまだ登録されていません(進捗管理 → 目標ロードマップから登録できます)。</p>';
  return `<ul class="hs-member-goals">${rows.join('')}</ul>`;
}

// 使い方ガイド。nav は押したときに開く画面(data-home-nav。app.js の NAV_ACTIONS のキー)。
export const GUIDE_STEPS = [
  { icon: 'folder', title: '練習データを取り込む', nav: 'home',
    text: '「練習データ」で「新規練習」を押し、各艇の GPS ログ(CSV)を読み込みます。動画フォルダを選ぶと、練習時間内の動画も自動で取り込めます。' },
  { icon: 'map', title: '軌跡を再生して振り返る', nav: 'home',
    text: '地図上で全艇の軌跡を同時に再生できます。「VMG」で区間ごとに速かった艇を強調し、「サマリ」で練習全体の数字を確認します。'
      + '「速度」では各艇の速度の推移を1つのグラフで表示し、赤い縦線が再生時刻に追従します(パネルはドラッグで移動、右下の角で拡大縮小)。'
      + '速度は記録 speed と GPS 座標の移動距離から求めた値を切り替えたり、重ねて比べたりできます。' },
  { icon: 'award', title: 'VMG で艇どうしを比べる', nav: 'home',
    text: '「VMG」を ON にすると、30秒ごとに同じ走種で VMG(推定風軸方向の前進成分)が最も良い艇が発光します。'
      + 'パネルの勝率は、各艇が比較に参加した時間のうち最良だった割合です。'
      + '風軸は GPS からの推定値(または手動設定)で、実測値ではありません。' },
  { icon: 'edit-3', title: '反省を書いて保存する', nav: 'home',
    text: '左の「反省を追加」で今日の目標・課題・発見を記録し、「保存」で部内に共有します。議事録からの一括取込もできます。' },
  { icon: 'trending-up', title: '進捗と目標を管理する', nav: 'progress',
    text: '「進捗管理」で部員ごとの課題の変化やコメントを確認し、目標ロードマップで段階ごとの達成を管理します。' },
  { icon: 'tool', title: 'セッティングを比べる', nav: 'dashboard',
    text: '「チューニングダッシュボード」で艇ごとのリグ設定と風速を並べ、速かった日の設定を再現します。' },
  { icon: 'building-2', title: '組織とメンバーを管理する', href: '/account#org',
    text: '左下のアカウント → 「組織管理」で、メールアドレスの変更・組織の追加・招待リンクの発行ができます。' },
];

export function guideHtml(steps = GUIDE_STEPS) {
  return '<ol class="hs-guide">' + steps.map((s, i) => {
    const target = s.href
      ? `<a class="hs-guide-link" href="${escapeHtml(s.href)}">開く ${icon('arrow-right')}</a>`
      : `<button type="button" class="hs-guide-link" data-home-nav="${escapeHtml(s.nav)}">開く ${icon('arrow-right')}</button>`;
    return '<li class="hs-guide-step">'
      + `<span class="hs-guide-num">${i + 1}</span>`
      + `<div class="hs-guide-body"><div class="hs-guide-title">${icon(s.icon)} ${escapeHtml(s.title)}</div>`
      + `<p>${escapeHtml(s.text)}</p>${target}</div>`
      + '</li>';
  }).join('') + '</ol>';
}
