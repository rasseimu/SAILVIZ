// 風軸の部分再推定。全体推定に「選択範囲だけの分離推定」をスプライスした系列を返す。
// トラック全体の平滑化/外れ値除去で巻き添えになった区間を、その範囲の点だけで
// 推定し直して局所的に上書きする。純関数(DOM非依存・テスト可能)。
import { estimateWindAxisSeries } from './windaxis.js';

// 範囲リストを正規化: start<end のみ採用し、start昇順ソート、重なり/接触をマージ。
export function normalizeOverrides(overrides) {
  const valid = (Array.isArray(overrides) ? overrides : [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start < r.end)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end); // 重なり/接触をマージ
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// 既存の補正範囲リストに1範囲を足し、正規化した新配列を返す(元配列は破壊しない)。
// タイムライン右クリックの「風軸を再推定」で、選択範囲を各トラックへ追加するのに使う。
export function pushOverrideRange(overrides, range) {
  return normalizeOverrides([...(Array.isArray(overrides) ? overrides : []), range]);
}

// track 全体の推定に、各 override 範囲の分離推定を上書きした系列を返す。
export function applyWindAxisOverrides(track, { marks = [], overrides = [] } = {}) {
  const base = estimateWindAxisSeries(track, { marks });
  const ranges = normalizeOverrides(overrides);
  if (ranges.length === 0) return base;

  const inAnyRange = (t) => ranges.some((r) => t >= r.start && t <= r.end);
  const kept = base.filter((s) => !inAnyRange(s.tMs)); // 範囲外はそのまま残す

  const locals = [];
  const pts = Array.isArray(track.points) ? track.points : [];
  for (const r of ranges) {
    const subset = pts.filter((p) => p.t >= r.start && p.t <= r.end);
    if (subset.length === 0) continue; // 点が無い範囲はギャップ
    let local;
    try {
      local = estimateWindAxisSeries({ ...track, points: subset }, { marks });
    } catch {
      local = []; // 分離推定失敗もギャップ扱い
    }
    for (const s of local) {
      if (s.tMs >= r.start && s.tMs <= r.end) locals.push(s);
    }
  }
  return [...kept, ...locals].sort((a, b) => a.tMs - b.tMs);
}
