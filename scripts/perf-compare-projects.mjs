// scripts/perf-compare-projects.mjs
// 移行計画 §6「性能」: GET /api/projects/:name の応答時間を STORAGE=file と STORAGE=db で比べる。
// Node 24(node:sqlite)で実行する。
//
// 使い方: node scripts/perf-compare-projects.mjs [--file <project.json>] [--runs 30] [--warmup 3]
//          [--synthetic-tracks 15] [--synthetic-points 3000] [--json <out>]
// 対象は2つ:
//   (a) demo-data/ の最大の *.sailviz.json(デモデータ。実データではない。--file で差し替え可)
//   (b) スクリプト内で合成した多トラックの練習(座標は赤道・本初子午線付近の架空の値。実位置ではない)
// 計測順は固定しない: 各対象を「file→db」「db→file」の2周で測り、周ごとの結果を出す(順序効果の確認)。
// 一時ディレクトリにデータを作り、サーバを子プロセスで起動する。本番・実データには触れない。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { importFromFiles } from '../server/db/importFromFiles.js';
import { migrate, loadMigrations } from '../server/db/migrate.js';
import { openDb } from '../server/db/connection.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt('--runs', 30));
const WARMUP = Number(opt('--warmup', 3));
const SYN_TRACKS = Number(opt('--synthetic-tracks', 15));
const SYN_POINTS = Number(opt('--synthetic-points', 3000));
const JSON_OUT = opt('--json', null);

function largestDemo() {
  const dir = join(ROOT, 'demo-data');
  const fs = readdirSync(dir).filter((f) => /\.sailviz\.json$/.test(f))
    .map((f) => ({ f, size: statSync(join(dir, f)).size })).sort((a, b) => b.size - a.size);
  return join(dir, fs[0].f);
}

// 合成練習: 決定的な疑似乱数で、赤道付近の架空の座標を作る(実位置ではない)。
function writeSyntheticProject(path, nTracks, nPoints) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const tracks = [];
  for (let k = 0; k < nTracks; k++) {
    let lat = 0.001 * k; let lon = 0.001 * k;
    const points = [];
    for (let i = 0; i < nPoints; i++) {
      lat += (rnd() - 0.5) * 1e-5; lon += (rnd() - 0.5) * 1e-5;
      points.push({ t: t0 + i * 1000 + rnd(), lat, lon, speed: -1, bearing: -1, accuracy: 5 + rnd() * 30 });
    }
    const lats = points.map((p) => p.lat); const lons = points.map((p) => p.lon);
    tracks.push({
      id: `syn-${k}`, name: `synthetic-${k}`, color: '#3388ff', visible: true, points,
      bounds: { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) },
      tRange: { start: points[0].t, end: points[points.length - 1].t },
    });
  }
  const proj = {
    version: 1, savedAt: new Date(t0).toISOString(), mode: 'absolute', accuracyFilter: false,
    crop: { start: 0, end: 1 }, tracks, events: [], marks: [], pins: [], videos: [], reflections: [],
  };
  writeFileSync(path, JSON.stringify(proj));
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(port, exited) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/session`); return; } catch { /* 起動待ち */ }
    // 子が先に終了していたら待たずに失敗させる
    if (await Promise.race([exited.then(() => true), sleep(100).then(() => false)])) {
      throw new Error('server exited before it was ready');
    }
  }
  throw new Error('server did not start');
}

function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], median: q(0.5), mean, p95: q(0.95), max: s[s.length - 1] };
}

async function measure(storage, dataDir, name) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, STORAGE: storage };
  delete env.NODE_ENV; delete env.SAILVIZ_VIEW_USER; delete env.SAILVIZ_VIEW_PASSWORD;
  delete env.SAILVIZ_WRITE_TOKEN; delete env.GEMINI_API_KEY;
  // stderr は継承して、子の失敗理由が見えるようにする
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  // 起動直後に exited を用意する(後から once('exit') すると、先に終わった子では永久に待つ)
  const exited = new Promise((r) => { child.once('exit', r); child.once('error', r); });
  try {
    await waitUp(port, exited);
    const url = `http://127.0.0.1:${port}/api/projects/${encodeURIComponent(name)}`;
    const times = []; let body = null; let status = 0;
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const t0 = performance.now();
      const r = await fetch(url);
      const text = await r.text();
      const dt = performance.now() - t0;
      status = r.status; body = text;
      if (i >= WARMUP) times.push(dt);
    }
    return { storage, status, bytes: Buffer.byteLength(body), body, ...stats(times) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
}

const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object')
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const hash = (t) => createHash('sha256').update(JSON.stringify(canon(JSON.parse(t)))).digest('hex').slice(0, 16);
// DB 版は互換 PUT 用に最上位へ `_rev` を足す仕様(Phase 1)。それだけは差として許す。
const stripRev = (t) => { const o = JSON.parse(t); delete o._rev; return JSON.stringify(o); };
const fmt = (r) => `${r.storage.padEnd(4)} status=${r.status} bytes=${r.bytes} n=${r.n} min=${r.min.toFixed(1)} median=${r.median.toFixed(1)} mean=${r.mean.toFixed(1)} p95=${r.p95.toFixed(1)} max=${r.max.toFixed(1)} (ms)`;

function diffsOf(fBody, dBody) {
  const diffs = [];
  (function walk(a, b, p) {
    if (diffs.length >= 10) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${p}.${k}`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`${p}: file=${JSON.stringify(a)?.slice(0, 60)} db=${JSON.stringify(b)?.slice(0, 60)}`);
    }
  })(JSON.parse(fBody), JSON.parse(dBody), '$');
  return diffs;
}

async function runTarget(label, src, tmp) {
  const name = basename(src);
  const root = join(tmp, label);
  const fileDir = join(root, 'file'); const dbDir = join(root, 'db');
  for (const d of [fileDir, dbDir]) { mkdirSync(join(d, 'projects'), { recursive: true }); copyFileSync(src, join(d, 'projects', name)); }
  // DB 版: 移行スクリプトと同じ関数でファイルから取り込む
  const db = openDb(join(dbDir, 'sailviz.db'));
  migrate(db, loadMigrations(join(ROOT, 'server', 'db', 'migrations')));
  const rep = importFromFiles({ db, dataDir: dbDir });
  db.close();

  const run = (storage) => measure(storage, storage === 'file' ? fileDir : dbDir, name);
  // 周1: file→db、周2: db→file(順序効果を見る)
  const rounds = [];
  for (const order of [['file', 'db'], ['db', 'file']]) {
    const rs = {};
    for (const st of order) rs[st] = await run(st);
    rounds.push({ order: order.join('->'), file: rs.file, db: rs.db });
  }
  const { file: f, db: d } = rounds[0];
  const identical = rounds.every((r) => r.file.status === 200 && r.db.status === 200
    && hash(stripRev(r.file.body)) === hash(stripRev(r.db.body)));
  const diffs = diffsOf(f.body, d.body);
  const ratios = rounds.map((r) => r.db.median / r.file.median);
  const out = {
    label, file: name, fileBytes: statSync(src).size, import: rep,
    rounds: rounds.map((r) => ({ order: r.order, file: strip(r.file), db: strip(r.db) })),
    ratioDbOverFileMedianByRound: ratios,
    ratioDbOverFileMedian: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    jsonSemanticallyEqual: identical, jsonByteEqual: f.body === d.body, diffs,
  };
  console.log(`\n== ${label}: ${name} (${out.fileBytes} bytes)  tracks/sessions: sessions=${rep.sessions} tracks=${rep.tracks} reflections=${rep.reflections}`);
  rounds.forEach((r, i) => {
    console.log(`round ${i + 1} (${r.order})`);
    const pair = r.order.startsWith('file') ? [r.file, r.db] : [r.db, r.file];
    pair.forEach((x) => console.log('  ' + fmt(x)));
  });
  console.log(`db/file median ratio by round = ${ratios.map((x) => x.toFixed(2)).join(', ')}  (mean ${out.ratioDbOverFileMedian.toFixed(2)})`);
  console.log(`JSON equal (最上位 _rev を除く, キー順不問): ${identical}  byte equal: ${out.jsonByteEqual}`);
  diffs.forEach((x) => console.log(`  diff ${x}`));
  return out;
}
const strip = ({ body, ...r }) => r;

const tmp = mkdtempSync(join(tmpdir(), 'sailviz-perf-'));
try {
  const synPath = join(tmp, 'sailviz-20260101-0900.sailviz.json'); // 取込が日付をファイル名から読むため、この形式にする
  writeSyntheticProject(synPath, SYN_TRACKS, SYN_POINTS);
  console.log(`node ${process.version} ${process.platform}-${process.arch}  runs=${RUNS} warmup=${WARMUP}`);
  const targets = [];
  targets.push(await runTarget('demo-largest', opt('--file', largestDemo()), tmp));
  targets.push(await runTarget('synthetic-multitrack', synPath, tmp));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ node: process.version, runs: RUNS, warmup: WARMUP, targets }, null, 2));
  process.exitCode = targets.every((t) => t.jsonSemanticallyEqual) ? 0 : 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
