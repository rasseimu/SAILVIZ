// 全練習の反省 rig を「艇番号×パラメータ」の時系列に集計する純モジュール。
import { RIG_FIELDS } from './reflections.js';

export const FOCUS_BOATS = [4899, 4859, 4807, 4677, 4519, 4304];
export const BOAT_COLORS = {
  4899: '#e6194b', 4859: '#3cb44b', 4807: '#4363d8',
  4677: '#f58231', 4519: '#911eb4', 4304: '#f032e6',
};
export const TUNING_PARAMS = RIG_FIELDS.filter((f) => f !== 'boatNo');

// project の最古実データ時刻(トラックGPS開始/動画配置時刻の最小)。無ければ null。
function earliestContentMs(project) {
  let min = null;
  const consider = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && (min == null || v < min)) min = v;
  };
  if (Array.isArray(project?.tracks)) for (const t of project.tracks) consider(t?.tRange?.start);
  if (Array.isArray(project?.videos)) for (const v of project.videos) consider(v?.t);
  return min;
}

// 反省1件のx軸時刻: practice.startMs → 練習最古実データ → createdAt。
export function reflectionTimeMs(reflection, project) {
  const p = reflection?.practice?.startMs;
  if (typeof p === 'number' && Number.isFinite(p)) return p;
  const e = earliestContentMs(project);
  if (e != null) return e;
  const c = reflection?.createdAt;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

export function collectTuning(entries) {
  const series = {};
  for (const param of TUNING_PARAMS) series[param] = {};
  const boatsSeen = [];
  let min = null; let max = null;

  for (const { project } of entries || []) {
    const reflections = Array.isArray(project?.reflections) ? project.reflections : [];
    for (const r of reflections) {
      const boat = Number(r?.rig?.boatNo);
      if (!FOCUS_BOATS.includes(boat)) continue;
      const tMs = reflectionTimeMs(r, project);
      if (tMs == null) continue;
      if (!boatsSeen.includes(boat)) boatsSeen.push(boat);
      for (const param of TUNING_PARAMS) {
        const value = r.rig?.[param];
        if (value == null || !Number.isFinite(Number(value))) continue;
        (series[param][boat] ||= []).push({ tMs, value: Number(value) });
        if (min == null || tMs < min) min = tMs;
        if (max == null || tMs > max) max = tMs;
      }
    }
  }

  for (const param of TUNING_PARAMS) {
    for (const boat of Object.keys(series[param])) {
      series[param][boat].sort((a, b) => a.tMs - b.tMs);
    }
  }
  const boats = FOCUS_BOATS.filter((b) => boatsSeen.includes(b));
  return { boats, series, domain: min == null ? null : { min, max } };
}

// 表(行=練習日×艇)用に、反省を平坦な行リストへ。6艇のみ・tMs昇順(同時刻は艇番号順)。
// 各行: { tMs, boat, rig }。rig は反省の rig をそのまま(値は null 含む)。
export function collectTuningRows(entries) {
  const rows = [];
  for (const { project } of entries || []) {
    const reflections = Array.isArray(project?.reflections) ? project.reflections : [];
    for (const r of reflections) {
      const boat = Number(r?.rig?.boatNo);
      if (!FOCUS_BOATS.includes(boat)) continue;
      const tMs = reflectionTimeMs(r, project);
      if (tMs == null) continue;
      rows.push({ tMs, boat, rig: r.rig || {} });
    }
  }
  rows.sort((a, b) => (a.tMs - b.tMs) || (a.boat - b.boat));
  return rows;
}
