#!/usr/bin/env node
// scripts/speed-compare.mjs
// 速度の取り方の比較(測定ハーネス)。同じ GPS CSV について、
//   csv    : CSV の speed 列(有効値のみ)
//   diff1  : 直前の点との距離 / 時間(1点差分)
//   win±Ns : 前後 N 秒の両端点の直線距離 / 時間(src/speedchart.js の windowedSpeedsMps)
// を並べ、平均・ガタつき・CSV との差を出す。統計量のみ出力し、座標は出さない。
//
// 使い方:
//   node scripts/speed-compare.mjs [--no-accuracy] <csv1> [<csv2> ...]
//   --no-accuracy: 精度フィルタを外す(既定はアプリと同じく ON)
//
// 見方:
//   ガタつき = 連続する点(間隔 2 秒以内)の速度差の中央値[kt]。小さいほど滑らか
//   CSV差    = CSV の有効 speed がある点での |値 - csv| の平均[kt]、偏り = (値 - csv) の平均[kt]

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseCsv } from '../src/csv.js';
import { prepareTrackPoints } from '../src/gps.js';
import { MPS_TO_KT, windowedSpeedsMps, diffSpeedsMps } from '../src/speedchart.js';

const args = process.argv.slice(2);
const accuracyFilter = !args.includes('--no-accuracy');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('使い方: node scripts/speed-compare.mjs [--no-accuracy] <csv1> [<csv2> ...]');
  process.exit(1);
}

const validSpeed = (v) => Number.isFinite(v) && v >= 0;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stats(points, speeds, csv) {
  const kt = speeds.map((v) => (v == null ? null : v * MPS_TO_KT));
  const vals = kt.filter((v) => v != null);
  const steps = [];
  for (let i = 1; i < kt.length; i++) {
    if (kt[i] == null || kt[i - 1] == null || points[i].t - points[i - 1].t > 2000) continue;
    steps.push(Math.abs(kt[i] - kt[i - 1]));
  }
  let absSum = 0, biasSum = 0, n = 0;
  for (let i = 0; i < kt.length; i++) {
    if (kt[i] == null || !validSpeed(csv[i])) continue;
    const d = kt[i] - csv[i] * MPS_TO_KT;
    absSum += Math.abs(d); biasSum += d; n++;
  }
  return {
    count: vals.length,
    mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    rough: median(steps),
    absDiff: n ? absSum / n : null,
    bias: n ? biasSum / n : null,
  };
}

const f = (v, d = 2) => (v == null ? '—' : v.toFixed(d));

for (const file of files) {
  const { header, rows } = parseCsv(readFileSync(file, 'utf8'));
  const { points } = prepareTrackPoints(header, rows, { accuracyFilter });
  if (points.length < 2) { console.log(`\n${basename(file)}: 点が足りません(${points.length}点)`); continue; }
  const csv = points.map((p) => p.speed);
  const valid = csv.filter(validSpeed).length;
  const dts = points.slice(1).map((p, i) => (p.t - points[i].t) / 1000);
  console.log(`\n${basename(file)}: ${points.length}点  記録間隔(中央値) ${f(median(dts), 1)}秒`
    + `  有効な CSV speed ${valid}点(${f((valid / points.length) * 100, 0)}%)  精度フィルタ ${accuracyFilter ? 'ON' : 'OFF'}`);
  const sources = [
    ['csv', csv.map((v) => (validSpeed(v) ? v : null))],
    ['diff1', diffSpeedsMps(points)],
    ['win±3s', windowedSpeedsMps(points, { halfWindowMs: 3000 })],
    ['win±5s', windowedSpeedsMps(points, { halfWindowMs: 5000 })],
    ['win±10s', windowedSpeedsMps(points, { halfWindowMs: 10000 })],
  ];
  console.log('  方式      点数   平均[kt]  ガタつき[kt]  CSV差[kt]  偏り[kt]');
  for (const [name, speeds] of sources) {
    const s = stats(points, speeds, csv);
    console.log(`  ${name.padEnd(8)} ${String(s.count).padStart(6)}  ${f(s.mean).padStart(8)}  ${f(s.rough).padStart(12)}`
      + `  ${f(s.absDiff).padStart(9)}  ${f(s.bias).padStart(8)}`);
  }
}
