// src/daysummaryflow.js
// 今日の練習サマリの状態遷移(いつ作り直すか・いつ自動表示するか・何を保存するか)。DOM 非依存の純関数。
// app.js は結果を state と DOM に反映するだけにし、振る舞いはここのテストで守る。
// 結果の基本形: { summary, saved, recomputed, error }
//   summary: state.daySummary に入れる値 / saved: それが保存済みの内容と同じか
import { computeDaySummary, daySummarySourceKey, syncDaySummaryLabels } from './daysummary.js';

// 現在の GPS と一致するサマリにする。
// - GPS が無ければ null
// - sourceKey が一致すれば艇名・色だけ現在のトラックに合わせる(数値は GPS 読込時点のまま)
// - 不一致・未計算・force なら再計算。失敗したら null(GPS と食い違う古いサマリを残さない)
export function refreshDaySummary(
  { summary, saved }, tracks, { marks = [], compute = computeDaySummary, force = false } = {},
) {
  const list = tracks || [];
  if (!list.length) return { summary: null, saved: false, recomputed: false, error: null };
  if (!force && summary && summary.sourceKey === daySummarySourceKey(list)) {
    const synced = syncDaySummaryLabels(summary, list);
    return { summary: synced, saved: saved && synced === summary, recomputed: false, error: null };
  }
  try {
    return { summary: compute(list, { marks }), saved: false, recomputed: true, error: null };
  } catch (error) {
    return { summary: null, saved: false, recomputed: false, error };
  }
}

// GPS 読込(loadFiles)の後。GPS が増えて作り直せたときだけ自動表示する(初回・後付けGPS)。
export function daySummaryAfterGpsLoad(current, tracks, tracksBefore, opts) {
  if ((tracks || []).length <= tracksBefore) {
    return { ...current, recomputed: false, error: null, autoOpen: false };
  }
  const r = refreshDaySummary(current, tracks, opts);
  return { ...r, autoOpen: r.recomputed };
}

// 保存済み練習を開いた(loadPractice)後。自動表示はしない。
// サマリが無い(機能追加前の練習)・GPS と食い違うときは黙って作り直す(次の保存で永続化)。
export function daySummaryAfterPracticeLoad(savedSummary, tracks, opts) {
  const r = refreshDaySummary({ summary: savedSummary, saved: savedSummary != null }, tracks, opts);
  return { ...r, autoOpen: false };
}

// モーダルの導線ボタン。ホームから開いた(練習未読込)ときは先に読み込み、
// 確認ダイアログのキャンセルや読込失敗なら画面遷移しない。戻り値は導線を実行したか。
export async function runDaySummaryAction(action, { fromHomeName = null } = {}, deps) {
  if (fromHomeName && !(await deps.loadPractice(fromHomeName))) return false;
  deps.showTrack();
  if (action === 'compare') deps.setVmgOn(true);
  else if (action === 'reflect') await deps.openReflectionEditor();
  return true;
}
