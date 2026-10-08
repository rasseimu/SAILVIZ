#!/usr/bin/env node
// scripts/windaxis-measure.mjs
// 風軸推定の物差し（測定ハーネス）
// 現行実装・旧版 d136a90 相当・新実装 B5 を並べて比較する。
// 実位置データには焼き込まない（合成データと sample-data の統計量のみ出力）。
//
// 使い方:
//   node scripts/windaxis-measure.mjs [--csv <path1> [<path2>]]
//   --csv なしの場合は合成データで計測する。
//
// 出力:
//   各実装ごとに: アンカー数・カバー率・艇間一致（複数艇のとき）

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/csv.js';
import { parseGpsPoints, rejectOutliers } from '../src/gps.js';
import {
  estimateWindAxisSeries,
  circDiffDeg, circMedianDeg, normalizeDeg,
} from '../src/windaxis.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ───────────────────────────────────────────────
// 合成データ生成
// ───────────────────────────────────────────────

function makeBeatTrack(opts = {}) {
  const {
    t0 = 1_787_000_000_000,
    legSec = 60,
    tackSec = 6,
    dtMs = 500,
    legSpeed = 4,
    tackSpeed = 1.2,
    windDeg = 0,     // 風上方向
    closeDeg = 45,   // クローズ角
    extraNoise = 0,  // GPS ふらつき [m]
  } = opts;

  const mLat = 111_320;
  const refLat = 35.30;
  const mLon = 111_320 * Math.cos(refLat * Math.PI / 180);

  // タックのレグ方位: 風上 ± closeDeg
  const legHeadings = [
    normalizeDeg(windDeg - closeDeg),
    normalizeDeg(windDeg + closeDeg),
  ];

  const pts = [];
  let t = t0;
  let lat = refLat, lon = 139.48;

  for (let cycle = 0; cycle < 4; cycle++) {
    const headDeg = legHeadings[cycle % 2];
    const rad = headDeg * Math.PI / 180;
    const n = Math.floor((legSec * 1000) / dtMs);
    for (let i = 0; i < n; i++) {
      const noise = extraNoise > 0
        ? { dlat: (Math.random() - 0.5) * 2 * extraNoise / mLat, dlon: (Math.random() - 0.5) * 2 * extraNoise / mLon }
        : { dlat: 0, dlon: 0 };
      pts.push({
        t, lat: lat + noise.dlat, lon: lon + noise.dlon,
        speed: legSpeed, bearing: -1, accuracy: 5,
      });
      lat += (Math.cos(rad) * legSpeed * (dtMs / 1000)) / mLat;
      lon += (Math.sin(rad) * legSpeed * (dtMs / 1000)) / mLon;
      t += dtMs;
    }
    // タック
    const nTack = Math.floor((tackSec * 1000) / dtMs);
    const fromDeg = legHeadings[cycle % 2];
    const toDeg = legHeadings[(cycle + 1) % 2];
    for (let j = 0; j < nTack; j++) {
      const frac = nTack > 1 ? j / (nTack - 1) : 0;
      const interpDeg = fromDeg + circDiffDeg(toDeg, fromDeg) * frac;
      const irad = interpDeg * Math.PI / 180;
      pts.push({ t, lat, lon, speed: tackSpeed, bearing: -1, accuracy: 5 });
      lat += (Math.cos(irad) * tackSpeed * (dtMs / 1000)) / mLat;
      lon += (Math.sin(irad) * tackSpeed * (dtMs / 1000)) / mLon;
      t += dtMs;
    }
  }
  return { points: pts, name: 'synth-beat' };
}

// ───────────────────────────────────────────────
// CSV ファイルからトラック読み込み
// ───────────────────────────────────────────────
function loadCsvTrack(csvPath) {
  const text = readFileSync(csvPath, 'utf-8');
  const { header, rows } = parseCsv(text);
  const raw = parseGpsPoints(header, rows);
  const { points } = rejectOutliers(raw);
  return { points, name: csvPath.replace(/.*\//, '') };
}

// ───────────────────────────────────────────────
// 実装の設定
// ───────────────────────────────────────────────
const CONFIGS = [
  {
    name: '旧版相当(d136a90 minSpeedMps=1.5, minTurnDeg=45)',
    opts: { minSpeedMps: 1.5, minManeuverTurnDeg: 45, windowMs: 3000, minLegSec: 8, settleSec: 12 },
  },
  {
    name: '現行(B5前: minSpeedMps=1.5, minTurnDeg=45)',
    opts: { minSpeedMps: 1.5, minManeuverTurnDeg: 45, windowMs: 3000, minLegSec: 8, settleSec: 12 },
  },
  {
    name: '新実装B5(minSpeedMps=0, minTurnDeg=75)',
    opts: { minSpeedMps: 0, minManeuverTurnDeg: 75, windowMs: 3000, minLegSec: 8, settleSec: 12 },
  },
];

// ───────────────────────────────────────────────
// 物差し計算
// ───────────────────────────────────────────────

function calcCoverage(series, track) {
  if (!series || series.length === 0 || !track.points || track.points.length === 0) return 0;
  const pts = track.points;
  const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
  const dur = tMax - tMin;
  if (dur <= 0) return 0;
  const sMin = Math.min(...series.map((s) => s.tMs));
  const sMax = Math.max(...series.map((s) => s.tMs));
  const lo = Math.max(tMin, sMin - 300_000);
  const hi = Math.min(tMax, sMax + 300_000);
  return Math.max(0, hi - lo) / dur;
}

function calcAgreement(seriesList) {
  // 複数艇の風軸の平均円周偏差（小さいほど一致）
  if (seriesList.length < 2) return null;
  const allDegs = seriesList
    .filter((s) => s.length > 0)
    .map((s) => circMedianDeg(s.map((p) => p.windFromDeg)));
  if (allDegs.length < 2) return null;
  const global = circMedianDeg(allDegs);
  const diffs = allDegs.map((d) => Math.abs(circDiffDeg(d, global)));
  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

function measure(tracks, cfgOpts) {
  const seriesList = tracks.map((track) =>
    estimateWindAxisSeries(track, { opts: cfgOpts }),
  );
  const coverages = seriesList.map((s, i) => calcCoverage(s, tracks[i]));
  const avgCoverage = coverages.reduce((a, b) => a + b, 0) / coverages.length;
  const anchorCounts = seriesList.map((s) => s.filter((p) => p.source === 'anchor').length);
  const avgAnchors = anchorCounts.reduce((a, b) => a + b, 0) / anchorCounts.length;
  const agreement = calcAgreement(seriesList);
  return { avgCoverage, avgAnchors, anchorCounts, agreement };
}

// ───────────────────────────────────────────────
// メイン
// ───────────────────────────────────────────────

const args = process.argv.slice(2);
const csvIdx = args.indexOf('--csv');
let tracks;
let dataLabel;

if (csvIdx >= 0) {
  const csvPaths = [];
  for (let i = csvIdx + 1; i < args.length && !args[i].startsWith('--'); i++) {
    csvPaths.push(args[i]);
  }
  if (csvPaths.length === 0) {
    console.error('--csv の後にファイルパスを指定してください');
    process.exit(1);
  }
  tracks = csvPaths.map((p) => loadCsvTrack(resolve(p)));
  dataLabel = `CSV ${csvPaths.length}艇(ファイル名のみ: ${csvPaths.map((p) => p.replace(/.*\//, '')).join(', ')})`;
} else {
  // 合成データ: 風上0°の2艇（少しずらす）
  tracks = [
    makeBeatTrack({ windDeg: 0, closeDeg: 45, legSpeed: 4, tackSpeed: 1.2 }),
    makeBeatTrack({ windDeg: 0, closeDeg: 40, legSpeed: 3.5, tackSpeed: 1.0, t0: 1_787_000_000_500 }),
  ];
  dataLabel = '合成データ2艇(風上0°)';
}

console.log(`\n=== 風軸推定 物差し (B5) ===`);
console.log(`データ: ${dataLabel}`);
console.log(`艇数: ${tracks.length}、各艇点数: ${tracks.map((t) => t.points.length).join(', ')}`);
console.log('');

const rows = [];
for (const cfg of CONFIGS) {
  const r = measure(tracks, cfg.opts);
  rows.push({
    name: cfg.name,
    avgAnchors: r.avgAnchors.toFixed(1),
    coverageStr: (r.avgCoverage * 100).toFixed(1) + '%',
    agreement: r.agreement != null ? r.agreement.toFixed(1) + '°' : 'N/A',
    anchorCounts: r.anchorCounts.join(', '),
  });
}

// 表形式で出力
const col1w = Math.max(20, ...rows.map((r) => r.name.length));
console.log('設定'.padEnd(col1w) + '  平均アンカー  カバー率  艇間一致  各艇アンカー数');
console.log('-'.repeat(col1w + 50));
for (const r of rows) {
  const line = [
    r.name.padEnd(col1w),
    r.avgAnchors.padStart(12),
    r.coverageStr.padStart(8),
    r.agreement.padStart(8),
    '  [' + r.anchorCounts + ']',
  ].join('  ');
  console.log(line);
}
console.log('');
console.log('【判定基準】カバー率と艇間一致が現行より改善していれば B5 採用。');
console.log('           艇間一致(deg)が小さいほど一致している。');
console.log('           足切り(minSpeedMps)を外した影響で悪化した場合は作業を中断して報告。');
