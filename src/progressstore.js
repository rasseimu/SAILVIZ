// 課題の3段階進捗(未着手0/取組中1/解決2)と目標達成フラグを localStorage に持つ軽量オーバーレイ。
// キー = 反省id。反省(真実源)とは別ストアにし、進捗トグルで練習ファイルを書き戻さずに済ませる。
// 集計(summarize)は反省配列 × オーバーレイ から画面用データを作る純関数。
export const STORAGE_KEY = 'sailviz.progress';

// 風速ビン(昇順・境界は max 未満)。末尾は上限なし。unknown は speed 欠損。
export const WIND_BINS = [
  { key: 'lt3', label: '〜3 m/s', max: 3 },
  { key: 'mid', label: '3〜6 m/s', max: 6 },
  { key: 'ge6', label: '6 m/s〜', max: Infinity },
];

export function windBinKey(speed) {
  if (speed == null || !Number.isFinite(Number(speed))) return 'unknown';
  const s = Number(speed);
  for (const b of WIND_BINS) if (s < b.max) return b.key;
  return WIND_BINS[WIND_BINS.length - 1].key;
}

export function loadProgress(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function saveProgress(obj, storage = globalThis.localStorage) {
  storage?.setItem(STORAGE_KEY, JSON.stringify(obj));
  return obj;
}

// 既存エントリを {issueStage:0, goalDone:false} で補完して不変更新する。
function updateEntry(obj, reflId, patch) {
  const prev = obj[reflId] || { issueStage: 0, goalDone: false };
  return { ...obj, [reflId]: { issueStage: 0, goalDone: false, ...prev, ...patch } };
}

export function setIssueStage(obj, reflId, stage) {
  return updateEntry(obj, reflId, { issueStage: stage });
}

export function setGoalDone(obj, reflId, done) {
  return updateEntry(obj, reflId, { goalDone: done });
}

// コメントは項目(reflId)×フィールド別に {text, ts} の配列で持つ。真実源は書き換えない。
// field ∈ {goal,issue,discovery}。ts は投稿時刻(ms)。
export function addComment(obj, reflId, field, text, ts) {
  const t = String(text).trim();
  if (t === '') return obj;
  const prev = obj[reflId] || { issueStage: 0, goalDone: false };
  const comments = { ...(prev.comments || {}) };
  comments[field] = [...(comments[field] || []), { text: t, ts }];
  return { ...obj, [reflId]: { issueStage: 0, goalDone: false, ...prev, comments } };
}

export function removeComment(obj, reflId, field, idx) {
  const prev = obj[reflId];
  if (!prev?.comments?.[field]) return obj;
  const list = prev.comments[field].filter((_, i) => i !== idx);
  const comments = { ...prev.comments };
  if (list.length) comments[field] = list;
  else delete comments[field];
  const entry = { ...prev };
  if (Object.keys(comments).length) entry.comments = comments;
  else delete entry.comments;
  return { ...obj, [reflId]: entry };
}

// 反省テキストのオーバーレイ上書き。field ∈ {goal,issue,discovery}。
// 空文字/空白のみは上書き削除(元の反省テキストに戻す)。真実源は書き換えない。
export function setTextOverride(obj, reflId, field, text) {
  const prev = obj[reflId] || { issueStage: 0, goalDone: false };
  const text0 = { ...(prev.text || {}) };
  if (String(text).trim() === '') delete text0[field];
  else text0[field] = text;
  const entry = { issueStage: 0, goalDone: false, ...prev };
  if (Object.keys(text0).length) entry.text = text0;
  else delete entry.text;
  return { ...obj, [reflId]: entry };
}

// 反省の練習日時(ms)。practice.startMs → createdAt の順。
function reflDateMs(r) {
  return r.practice?.startMs ?? r.createdAt ?? 0;
}

export function summarize(reflections, progress, { bins = WIND_BINS } = {}) {
  const byMember = {};
  const ensure = (name) => (byMember[name] ||= { goals: [], issues: [], discoveriesByBin: {} });
  // 練習日昇順で走査(累計シリーズの単調性のため)。
  const sorted = [...reflections].sort((a, b) => reflDateMs(a) - reflDateMs(b));
  const series = { all: [] };       // 解決日の累計
  const addedSeries = { all: [] };  // 課題追加日の累計
  const firstDateMs = {};           // scope ごとの最初の反省日(x軸左端)
  let allCum = 0;
  let allAdded = 0;
  const memberCum = {};
  const memberAdded = {};
  for (const r of sorted) {
    const name = r.people?.[0];
    if (!name) continue;
    const bucket = ensure(name);
    const dateMs = reflDateMs(r);
    // 最初の反省日(課題有無に依らない)。sorted は昇順なので初出が最古。
    if (firstDateMs.all == null) firstDateMs.all = dateMs;
    if (firstDateMs[name] == null) firstDateMs[name] = dateMs;
    const st = progress[r.id] || {};
    const notes = r.notes || {};
    const ov = st.text || {};
    const cm = st.comments || {};
    // 表示テキストはオーバーレイ優先。ただし元反省に存在する項目のみ対象(新規追加はしない)。
    if (notes.goal) bucket.goals.push({ reflId: r.id, text: ov.goal ?? notes.goal, dateMs, done: !!st.goalDone, comments: cm.goal || [] });
    if (notes.issue) bucket.issues.push({ reflId: r.id, text: ov.issue ?? notes.issue, dateMs, stage: st.issueStage ?? 0, comments: cm.issue || [] });
    if (notes.discovery) {
      const speed = r.wind?.speed ?? null;
      const bk = windBinKey(speed);
      (bucket.discoveriesByBin[bk] ||= []).push({ reflId: r.id, text: ov.discovery ?? notes.discovery, dateMs, speed, comments: cm.discovery || [] });
    }
    // 課題追加を累計(ステージ無関係)。課題を持つ反省のみ対象。
    if (notes.issue) {
      allAdded += 1;
      memberAdded[name] = (memberAdded[name] || 0) + 1;
      addedSeries.all.push({ dateMs, value: allAdded });
      (addedSeries[name] ||= []).push({ dateMs, value: memberAdded[name] });
    }
    // 解決(stage=2)到達を累計。課題を持つ反省のみ対象。
    if (notes.issue && (st.issueStage ?? 0) === 2) {
      allCum += 1;
      memberCum[name] = (memberCum[name] || 0) + 1;
      series.all.push({ dateMs, value: allCum });
      (series[name] ||= []).push({ dateMs, value: memberCum[name] });
    }
  }
  return { byMember, resolutionSeries: series, issueAddedSeries: addedSeries, firstDateMs };
}
