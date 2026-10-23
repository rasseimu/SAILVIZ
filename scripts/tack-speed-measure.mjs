#!/usr/bin/env node
// scripts/tack-speed-measure.mjs
// タック検出(src/maneuverdetect.js)と前後3秒の減速(src/maneuverspeed.js)の物差し(測定ハーネス)。
// 合成データのみで、実データは使わない。
// 1) 検出: 旋回の速さ・レグの長さ・位置誤差を変えた合成トラックで、風軸からの検出(新)と
//    detectManeuvers 経由(旧・風軸が無い艇の代わりの経路)の検出数・誤検出数を比べる。
// 2) 減速: 減速の深さが既知のタックを並べた合成トラックに位置誤差を足し、速度の窓幅ごとに
//    「測った減速」と「真の減速」の相関と、減速が小さい上位3本が真の上位5本に入った数を出す。
//
// 使い方:
//   node scripts/tack-speed-measure.mjs
//
// 合成トラック: 北風、1Hz・30分。60秒ごとにクローズ同士のタック(6秒で旋回)。減速は旋回中の6秒で深くなり、
// その後10秒で回復する。深さは 15〜65% の一様乱数(固定シード)。位置誤差は各点独立の一様乱数。
// 実際の GPS の誤差は時間的に相関するため、ここでの誤差は悲観的な見積もり。

import { maneuverSpeedRows } from '../src/maneuverspeed.js';
import { detectManeuversByWind, legacyManeuverEvents } from '../src/maneuverdetect.js';
import { detectManeuvers } from '../src/windaxis.js';

const DEG_PER_M = 1 / 111200;
const COS_LAT = Math.cos((10 * Math.PI) / 180);

function makeTrack(noiseM, seed0 = 1) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const points = [], truth = [];
  let lat = 10, lon = 10, side = 1;
  for (let i = 0; i < 1800; i++) {
    const k = i % 60;
    if (k === 0 && i > 0) { side = -side; truth.push({ t: i * 1000, depth: 0.15 + 0.5 * rnd() }); }
    const tk = truth.at(-1);
    const target = (45 * side + 360) % 360, from = (-45 * side + 360) % 360;
    let hdg = target;
    if (tk && k < 6) hdg = (from + (((target - from + 540) % 360) - 180) * ((k + 1) / 6) + 360) % 360;
    const drop = !tk ? 0 : k < 6 ? (tk.depth * (k + 1)) / 6 : k < 16 ? tk.depth * (1 - (k - 5) / 10) : 0;
    const v = 3 * (1 - drop);
    const r = (hdg * Math.PI) / 180;
    lat += v * Math.cos(r) * DEG_PER_M;
    lon += (v * Math.sin(r) * DEG_PER_M) / COS_LAT;
    points.push({
      t: i * 1000,
      lat: lat + (rnd() - 0.5) * 2 * noiseM * DEG_PER_M,
      lon: lon + ((rnd() - 0.5) * 2 * noiseM * DEG_PER_M) / COS_LAT,
      speed: null,
    });
  }
  return { points, truth };
}

function correlation(pairs) {
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (const [x, y] of pairs) { cov += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; }
  return vx && vy ? cov / Math.sqrt(vx * vy) : NaN;
}

const wind = [{ tMs: 0, windFromDeg: 0 }];

// ===== 1) 検出 =====
// n 本のレグ(各 legSec 秒・3 m/s)を交互に hdgA/hdgB で走り、間で turnSec 秒かけて旋回(旋回中は半分の速度)
function zigzag({ n = 20, legSec = 60, turnSec = 6, hdgA = 315, hdgB = 45, noiseM = 0, seed = 1 }) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const points = [], truth = [];
  let lat = 10, lon = 10, t = 0;
  const step = (hdg, v) => {
    const r = (hdg * Math.PI) / 180;
    lat += v * Math.cos(r) * DEG_PER_M; lon += (v * Math.sin(r) * DEG_PER_M) / COS_LAT;
    points.push({
      t: t * 1000, speed: null,
      lat: lat + (rnd() - 0.5) * 2 * noiseM * DEG_PER_M,
      lon: lon + ((rnd() - 0.5) * 2 * noiseM * DEG_PER_M) / COS_LAT,
    });
    t++;
  };
  for (let k = 0; k < n; k++) {
    const to = k % 2 ? hdgB : hdgA;
    if (k > 0) {
      const from = k % 2 ? hdgA : hdgB, d = ((to - from + 540) % 360) - 180;
      truth.push((t + turnSec / 2) * 1000);
      for (let j = 0; j < turnSec; j++) step(from + d * ((j + 1) / turnSec), 1.5);
    }
    for (let j = 0; j < legSec; j++) step(to, 3);
  }
  return { points, truth };
}
function detectionScore(found, truth) {
  const used = new Set();
  let hit = 0;
  for (const t of truth) {
    const i = found.findIndex((f, j) => !used.has(j) && Math.abs(f.tMs - t) <= 6000);
    if (i >= 0) { hit++; used.add(i); }
  }
  return `${hit}/${truth.length} 誤${found.length - hit}`;
}
const scenarios = [
  ['通常のタック(60秒レグ・6秒旋回)', {}],
  ['ゆっくりのタック(12秒旋回)', { turnSec: 12 }],
  ['短いレグ(15秒)', { n: 30, legSec: 15 }],
  ['ジャイブ(60秒レグ)', { hdgA: 135, hdgB: 225 }],
];
console.log('1) 検出(風軸は真値) — 検出数/真の数 誤検出数');
console.log('シナリオ                          位置誤差  旧(detectManeuvers)  新(風軸から)');
for (const [name, opt] of scenarios) {
  for (const noiseM of [0, 1.5, 3]) {
    const { points, truth } = zigzag({ ...opt, noiseM });
    const legacy = legacyManeuverEvents(points, detectManeuvers({ points }, {}), wind);
    const byWind = detectManeuversByWind(points, wind);
    console.log(`${name.padEnd(24)}  ±${String(noiseM).padEnd(5)}m  ${detectionScore(legacy, truth).padEnd(19)}  ${detectionScore(byWind, truth)}`);
  }
}

// ===== 2) 減速 =====
console.log('\n2) 減速(風軸からの検出)');
console.log('位置誤差  速度の窓  検出/真のタック  相関  top3が真の上位5に入った数');
for (const noiseM of [0, 1, 1.5, 3]) {
  const { points, truth } = makeTrack(noiseM);
  const track = { points };
  const events = detectManeuversByWind(points, wind);
  for (const speedHalfWindowMs of [1000, 2000, 3000, 5000]) {
    const rows = maneuverSpeedRows(track, events, { speedHalfWindowMs }).filter((r) => r.kind === 'tack');
    const label = `±${noiseM}m`.padEnd(8) + `±${speedHalfWindowMs / 1000}秒`.padEnd(8);
    if (rows.length < 3) { console.log(`${label}  ${String(rows.length).padStart(3)}/${truth.length}  (検出不足)`); continue; }
    const pairs = rows.map((r) => {
      const tk = truth.reduce((a, b) => (Math.abs(b.t - r.tMs) < Math.abs(a.t - r.tMs) ? b : a));
      return [tk.depth, r.dropKt];
    });
    const trueTop = new Set([...pairs].sort((a, b) => a[0] - b[0]).slice(0, 5).map((p) => p[0]));
    const hit = [...pairs].sort((a, b) => a[1] - b[1]).slice(0, 3).filter((p) => trueTop.has(p[0])).length;
    console.log(`${label}  ${String(rows.length).padStart(3)}/${truth.length}  ${correlation(pairs).toFixed(2).padStart(5)}  ${hit}/3`);
  }
}
