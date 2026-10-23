// src/maneuverdetect.js
// 推定風軸からタック/ジャイブを検出する純関数群。DOM 非依存(node:test で検証する)。
// 風軸は windaxis.js がタック/ジャイブ(detectManeuvers)から推定する。逆に風軸が分かれば、
// 「風に対してどちら舷から風を受けているか」(スターボード/ポート)が入れ替わった瞬間がマニューバで、
// 艇首が風位を横切ればタック、艇尾が横切ればジャイブと判定できる。
// detectManeuvers の旋回レート(既定 8°/s)・レグ長(8秒・20m)の閾値に依らないため、ゆっくりしたタックや
// 短いレグの間のタックも拾える。
import { circDiffDeg, bearingDeg, windDirAt, detectManeuvers } from './windaxis.js';
import { classifyPointOfSail } from './vmg.js';
import { haversineMeters } from './gps.js';
import { positionAt } from './interpolate.js';

export const DETECT_DEFAULTS = Object.freeze({
  courseHalfMs: 3000, // 進路は前後3秒の両端点を結ぶ方位(位置誤差を均す)
  minChordM: 4, // 前後3秒の移動がこれ未満(ほぼ止まっている)なら進路は不定
  deadbandDeg: 10, // 風位±10°・真追っ手±10°は舷が定まらない(不定)として扱う
  minSideMs: 8000, // 同じ舷をこれ以上続けた区間だけを「その舷で帆走中」とみなす(ふらつきを落とす)
});

// 各点の、風に対する進路の角度(-180〜180°)。正 = 進路が風位より右(風を左舷から受ける = ポート)、
// 負 = 左(右舷から受ける = スターボード)。0 付近が風位、±180 付近が真追っ手。進路が求まらない点は null。
export function relativeCourses(points, windSeries, opts = {}) {
  const o = { ...DETECT_DEFAULTS, ...opts };
  return points.map((p) => {
    const a = positionAt(points, p.t - o.courseHalfMs);
    const b = positionAt(points, p.t + o.courseHalfMs);
    if (!a || !b || haversineMeters(a, b) < o.minChordM) return null;
    const wind = windDirAt(windSeries, p.t);
    return wind == null ? null : circDiffDeg(bearingDeg(a, b), wind);
  });
}

// 舷(+1 = ポート / -1 = スターボード / 0 = 不定)の連続区間。不定の点は区間を切らない。
// minSideMs 未満の区間はふらつきとして捨て、捨てた結果つながった同じ舷の区間はまとめる。
export function sideRuns(points, rel, opts = {}) {
  const o = { ...DETECT_DEFAULTS, ...opts };
  let runs = [];
  for (let i = 0; i < rel.length; i++) {
    const r = rel[i];
    if (r == null || Math.abs(r) < o.deadbandDeg || Math.abs(r) > 180 - o.deadbandDeg) continue;
    const side = r > 0 ? 1 : -1;
    const last = runs.at(-1);
    if (last && last.side === side) last.end = i;
    else runs.push({ side, start: i, end: i });
  }
  // 短い区間を捨てて同じ舷をまとめる、を変化がなくなるまで繰り返す
  for (;;) {
    const kept = runs.filter((r) => points[r.end].t - points[r.start].t >= o.minSideMs);
    const merged = [];
    for (const r of kept) {
      const last = merged.at(-1);
      if (last && last.side === r.side) last.end = r.end;
      else merged.push({ ...r });
    }
    if (merged.length === runs.length) return merged;
    runs = merged;
  }
}

// 舷が入れ替わった区間(前の区間の最後の点〜次の区間の最初の点)で、風に対する進路を連続にたどり(アンラップ)、
// 艇首が風位(0°)を横切ればタック、艇尾が真追っ手(±180°)を横切ればジャイブ。
// 横切りが1回でないもの(ペナルティの1回転など)は除外する。時刻は横切った瞬間(線形補間)。
export function detectManeuversByWind(points, windSeries, opts = {}) {
  if (!Array.isArray(points) || points.length < 3 || !windSeries || !windSeries.length) return [];
  const rel = relativeCourses(points, windSeries, opts);
  const runs = sideRuns(points, rel, opts);
  const out = [];
  for (let k = 1; k < runs.length; k++) {
    const ia = runs[k - 1].end, ib = runs[k].start;
    // アンラップした進路角 u と時刻の列
    const path = [];
    let u = null, prev = null;
    for (let i = ia; i <= ib; i++) {
      if (rel[i] == null) continue;
      u = u == null ? rel[i] : u + circDiffDeg(rel[i], prev);
      prev = rel[i];
      path.push({ t: points[i].t, u });
    }
    if (path.length < 2) continue;
    const u0 = path[0].u, u1 = path.at(-1).u;
    // u0〜u1 の間にある 180° の倍数(偶数倍 = 風位 = タック、奇数倍 = 真追っ手 = ジャイブ)
    const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
    const crossings = [];
    for (let m = Math.ceil(lo / 180); m * 180 <= hi; m++) crossings.push(m);
    if (crossings.length !== 1) continue;
    const target = crossings[0] * 180;
    const kind = crossings[0] % 2 === 0 ? 'tack' : 'gybe';
    let tMs = path[0].t;
    for (let j = 1; j < path.length; j++) {
      const a = path[j - 1], b = path[j];
      if ((a.u - target) * (b.u - target) <= 0) {
        tMs = a.u === b.u ? a.t : a.t + ((target - a.u) / (b.u - a.u)) * (b.t - a.t);
        break;
      }
    }
    const pos = positionAt(points, tMs) || points[ia];
    // 旋回角は、横切った時刻の前後3秒の外側の進路の差(舷が定まった区間どうしの差より、タック全体の角度に近い)
    out.push({ tMs, lat: pos.lat, lon: pos.lon, kind, turnDeg: turnAcrossDeg(points, tMs) ?? Math.abs(u1 - u0) });
  }
  return out;
}

// ===== 風軸が無い艇の代わり: 既存の detectManeuvers の結果を整える =====
// 風軸推定ができなかった艇(系列が空)は舷の入れ替わりを判定できないので、従来どおり detectManeuvers の
// 結果を使い、時刻を実際の旋回の中心へ寄せ、向きが変わっていない見かけのマニューバを落とす。

export const MIN_TURN_ACROSS_DEG = 60; // 旋回の前後で実際に向きが変わっていない検出は除外する
const TURN_GAP_MS = 3000; // 前後3秒(減速を切り出す窓)の外側で進路を比べる

// 旋回の外側の進路の変化(度)。前 = [t-gap-span, t-gap]、後 = [t+gap, t+gap+span] の各区間の
// 両端を結ぶ方位の差。位置誤差でレグの途中に出る見かけのマニューバ(向きが変わっていない)を落とすのに使う。
// 減速が無いぶん「最も減速しなかったタック」として上位に来てしまうため。求められなければ null。
export function turnAcrossDeg(points, tMs, { gapMs = TURN_GAP_MS, spanMs = 5000 } = {}) {
  const at = (t) => positionAt(points, t);
  const b0 = at(tMs - gapMs - spanMs), b1 = at(tMs - gapMs), a0 = at(tMs + gapMs), a1 = at(tMs + gapMs + spanMs);
  if (!b0 || !b1 || !a0 || !a1) return null;
  return Math.abs(circDiffDeg(bearingDeg(a0, a1), bearingDeg(b0, b1)));
}

// 実際に向きを変えた時刻へ寄せる。detectManeuvers の tMs は前後レグの境目の中点で、位置誤差があると
// 数秒ずれる。tMs ± searchMs の中で、直前 spanMs と直後 spanMs の進路(各区間の両端を結ぶ方位)の差が
// 最大になる時刻を旋回の中心とする。差が同じなら元の tMs に近い方。求められなければ null。
export function turnCenterMs(points, tMs, { searchMs = 10000, stepMs = 500, spanMs = 5000 } = {}) {
  let best = null;
  for (let dt = -searchMs; dt <= searchMs; dt += stepMs) {
    const c = tMs + dt;
    const deg = turnAcrossDeg(points, c, { gapMs: 0, spanMs });
    if (deg == null) continue;
    if (!best || deg > best.deg + 1e-9 || (Math.abs(deg - best.deg) <= 1e-9 && Math.abs(dt) < Math.abs(best.t - tMs))) {
      best = { t: c, deg };
    }
  }
  return best ? best.t : null;
}

// タックかジャイブか(detectManeuvers の結果用)。風軸があれば旋回前後のレグが両方クローズならタック、
// 両方ランニングならジャイブ、回航(片方だけ)やリーチを含むものは null。風軸が無ければ既存の判別に従う。
// windaxis.js の classifyManeuver は減速率で判別するため、「減速が小さいタック」がジャイブ扱いになりうる。
export function maneuverKind(m, windFromDeg) {
  if (windFromDeg == null || !Number.isFinite(m.headingBefore) || !Number.isFinite(m.headingAfter)) {
    return m.type === 'tack' || m.type === 'gybe' ? m.type : null;
  }
  const before = classifyPointOfSail(m.headingBefore, windFromDeg);
  const after = classifyPointOfSail(m.headingAfter, windFromDeg);
  if (before === 'upwind' && after === 'upwind') return 'tack';
  if (before === 'downwind' && after === 'downwind') return 'gybe';
  return null;
}

// detectManeuvers の結果を {tMs, lat, lon, kind, turnDeg} に整える。
export function legacyManeuverEvents(points, maneuvers, windSeries, opts = {}) {
  const out = [];
  for (const m of maneuvers || []) {
    const kind = maneuverKind(m, windDirAt(windSeries, m.tMs));
    if (!kind) continue;
    const tMs = turnCenterMs(points, m.tMs) ?? m.tMs;
    const turnDeg = turnAcrossDeg(points, tMs);
    if (turnDeg == null || turnDeg < (opts.minTurnAcrossDeg ?? MIN_TURN_ACROSS_DEG)) continue;
    const pos = positionAt(points, tMs) || m;
    out.push({ tMs, lat: pos.lat, lon: pos.lon, kind, turnDeg });
  }
  return out;
}

// 艇のタック/ジャイブ(地図のピン・top3・今日の練習サマリの回数で共通)。風軸があれば舷の入れ替わりから、
// 無ければ detectManeuvers から。marks は detectManeuvers のマーク近傍除外に渡す。
export function detectManeuverEvents(track, windSeries, { marks = [], ...opts } = {}) {
  const points = Array.isArray(track?.points) ? track.points : [];
  if (windSeries && windSeries.length) return detectManeuversByWind(points, windSeries, opts);
  return legacyManeuverEvents(points, detectManeuvers(track, { marks }), windSeries, opts);
}

// ===== 誤検出の除外(下バー右クリック「タック/ジャイブを除外」) =====
// 除外区間は艇ごとに track.maneuverExclusions = [{start, end}](絶対 epoch ms)として保存する。
// 区間内に時刻があるマニューバは、地図のピン・top3・VMG 欄の回数から外す(今日の練習サマリの回数は
// 風軸の手動上書きと同じく対象外)。

// 有効な除外区間だけを返す(旧データ・壊れた値は無視)。
function validRanges(list) {
  return (Array.isArray(list) ? list : []).filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
}

// 除外区間に入っていないマニューバだけを返す(区間の両端を含む)。
export function excludeManeuvers(events, exclusions) {
  const ranges = validRanges(exclusions);
  if (!ranges.length) return events || [];
  return (events || []).filter((e) => !ranges.some((r) => e.tMs >= r.start && e.tMs <= r.end));
}

// 除外区間を足す。同じ区間が既にあれば足さない。元の配列は変えない。
export function addManeuverExclusion(list, range) {
  const ranges = validRanges(list);
  if (!(Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.end > range.start)) return ranges;
  if (ranges.some((r) => r.start === range.start && r.end === range.end)) return ranges;
  return [...ranges, { start: range.start, end: range.end }];
}

// range と重なる除外区間を取り除く(「除外を解除」)。元の配列は変えない。
export function removeManeuverExclusions(list, range) {
  return validRanges(list).filter((r) => r.end < range.start || r.start > range.end);
}
