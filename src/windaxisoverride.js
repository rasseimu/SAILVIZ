// 風軸の部分補正。全体推定に「選択範囲の再推定」または「手動固定角」を上書きした系列を返す。
// エントリは {start, end, manualDeg?}。manualDeg があればその区間を固定角に、無ければ
// その範囲の点だけで分離再推定して局所的に上書きする。純関数(DOM非依存・テスト可能)。
import { estimateWindAxisSeries, normalizeDeg } from './windaxis.js';

// エントリを valid化(start<end)＋start昇順ソート。manualDeg は [0,360) に正規化して保持。
// 重なりは統合しない(重なり解決は pushOverride の supersede が担う)。
export function normalizeOverrides(overrides) {
  return (Array.isArray(overrides) ? overrides : [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start < r.end)
    .map((r) => (Number.isFinite(r.manualDeg)
      ? { start: r.start, end: r.end, manualDeg: normalizeDeg(r.manualDeg) }
      : { start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
}

// 既存エントリのうち entry と時間的に重なるものを外し、entry を追加する(supersede)。非破壊。
// タイムライン右クリックの「風軸を再推定 / 手動設定」で、選択範囲を各トラックへ適用するのに使う。
// 同じ区間を後から操作すると上書きされる(取り消しUI無しの方針と一致)。
export function pushOverride(overrides, entry) {
  const kept = (Array.isArray(overrides) ? overrides : [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end)
      && !(entry.start < r.end && r.start < entry.end)); // [start,end) 重なりを除外
  return normalizeOverrides([...kept, entry]);
}

// track 全体の推定に、各 override エントリ(再推定 or 手動固定角)を上書きした系列を返す。
export function applyWindAxisOverrides(track, { marks = [], overrides = [] } = {}) {
  const base = estimateWindAxisSeries(track, { marks });
  const entries = normalizeOverrides(overrides);
  if (entries.length === 0) return base;

  const inAnyRange = (t) => entries.some((r) => t >= r.start && t <= r.end);
  const kept = base.filter((s) => !inAnyRange(s.tMs)); // 範囲外はそのまま残す

  const locals = [];
  const pts = Array.isArray(track.points) ? track.points : [];
  for (const r of entries) {
    if (Number.isFinite(r.manualDeg)) {
      // 手動固定角: 区間の両端に同じ角度を置き、windDirAt 補間で区間内を一定にする。
      locals.push({ tMs: r.start, windFromDeg: r.manualDeg, source: 'manual' });
      locals.push({ tMs: r.end, windFromDeg: r.manualDeg, source: 'manual' });
      continue;
    }
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
