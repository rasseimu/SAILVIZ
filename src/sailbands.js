// src/sailbands.js
// クローズ(風上)/ランニング(風下)の時間帯を求める純関数群。DOM 非依存(node:test で検証する)。
// 速度の推移グラフと下バーの背景の塗り分けに使う。走種は推定風軸に対する進路から求める推定値。
import { bearingDeg, windDirAt } from './windaxis.js';
import { classifyPointOfSail } from './vmg.js';
import { haversineMeters } from './gps.js';
import { positionAt } from './interpolate.js';

export const BAND_DEFAULTS = Object.freeze({
  stepMs: 2000, // この間隔で走種を判定する
  courseHalfMs: 3000, // 進路は前後3秒の両端点を結ぶ方位
  minChordM: 4, // 前後3秒の移動がこれ未満(ほぼ止まっている)なら走種は不定
  minBandMs: 10000, // これより短い帯は捨て、間の短い切れ目はつなぐ(マニューバ・回航でちらつかない)
});

// 時刻 absT の1艇の走種('upwind' | 'downwind' | null)。リーチ(風軸に対して 90°±12°)・不定は null。
export function pointOfSailAt(points, windSeries, absT, opts = {}) {
  const o = { ...BAND_DEFAULTS, ...opts };
  const a = positionAt(points, absT - o.courseHalfMs);
  const b = positionAt(points, absT + o.courseHalfMs);
  if (!a || !b || haversineMeters(a, b) < o.minChordM) return null;
  const wind = windDirAt(windSeries, absT);
  if (wind == null) return null;
  const kind = classifyPointOfSail(bearingDeg(a, b), wind);
  return kind === 'reach' ? null : kind;
}

// 軸範囲 range のクローズ/ランニングの帯 [{start, end, kind}](軸時刻)。
// 表示中の艇の多数決(同数・判定できる艇なしは帯なし)。elapsed は各艇自身の開始を0とする(マップと同じ規約)。
export function pointOfSailBands(tracks, windSeriesByTrack, { range, mode, ...opts } = {}) {
  const o = { ...BAND_DEFAULTS, ...opts };
  const boats = (tracks || []).filter((t) => t.visible && Array.isArray(t.points) && t.points.length > 1
    && (windSeriesByTrack?.get(t) || []).length);
  if (!boats.length || !(range?.end > range?.start)) return [];
  // 1) 刻みごとの多数決
  const steps = [];
  for (let t = range.start; t <= range.end; t += o.stepMs) {
    let up = 0, down = 0;
    for (const tr of boats) {
      const off = mode === 'elapsed' ? (tr.tRange?.start ?? 0) : 0;
      const k = pointOfSailAt(tr.points, windSeriesByTrack.get(tr), t + off, o);
      if (k === 'upwind') up++; else if (k === 'downwind') down++;
    }
    steps.push({ t, kind: up > down ? 'upwind' : down > up ? 'downwind' : null });
  }
  // 2) 同じ走種の連続を帯にする
  let bands = [];
  for (const s of steps) {
    const last = bands.at(-1);
    if (s.kind && last && last.kind === s.kind && s.t - last.end <= o.stepMs) last.end = s.t;
    else if (s.kind) bands.push({ start: s.t, end: s.t, kind: s.kind });
  }
  // 3) 短い帯を捨て、同じ走種で切れ目が短いものをつなぐ
  bands = bands.filter((b) => b.end - b.start >= o.minBandMs);
  const out = [];
  for (const b of bands) {
    const last = out.at(-1);
    if (last && last.kind === b.kind && b.start - last.end < o.minBandMs) last.end = b.end;
    else out.push({ ...b });
  }
  // 帯の端を刻みの半分だけ広げ、隣り合う刻みの間を埋める(範囲内に収める)
  return out.map((b) => ({
    kind: b.kind,
    start: Math.max(range.start, b.start - o.stepMs / 2),
    end: Math.min(range.end, b.end + o.stepMs / 2),
  }));
}
