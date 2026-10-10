// scripts/perf-compare-projects.mjs
// 移行計画 §6「性能」: 最大の練習ファイルで GET /api/projects/:name の応答時間を
// STORAGE=file と STORAGE=db で比べる。Node 24(node:sqlite)で実行する。
//
// 使い方: node scripts/perf-compare-projects.mjs [--file <project.json>] [--runs 30] [--warmup 3] [--json <out>]
// 既定の対象は demo-data/ の最大の *.sailviz.json(デモデータ。実データではない)。
// 一時ディレクトリにデータを作り、サーバを子プロセスで起動する。本番・実データには触れない。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
const JSON_OUT = opt('--json', null);

function largestDemo() {
  const dir = join(ROOT, 'demo-data');
  const fs = readdirSync(dir).filter((f) => /\.sailviz\.json$/.test(f))
    .map((f) => ({ f, size: statSync(join(dir, f)).size })).sort((a, b) => b.size - a.size);
  return join(dir, fs[0].f);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(port) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/session`); return; } catch { await sleep(100); }
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
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' });
  try {
    await waitUp(port);
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
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
}

const src = opt('--file', largestDemo());
const tmp = mkdtempSync(join(tmpdir(), 'sailviz-perf-'));
try {
  const name = basename(src);
  const fileDir = join(tmp, 'file'); const dbDir = join(tmp, 'db');
  for (const d of [fileDir, dbDir]) { mkdirSync(join(d, 'projects'), { recursive: true }); copyFileSync(src, join(d, 'projects', name)); }
  // DB 版: 移行スクリプトと同じ関数でファイルから取り込む
  const db = openDb(join(dbDir, 'sailviz.db'));
  migrate(db, loadMigrations(join(ROOT, 'server', 'db', 'migrations')));
  const rep = importFromFiles({ db, dataDir: dbDir });
  db.close();

  const results = [];
  results.push(await measure('file', fileDir, name));
  results.push(await measure('db', dbDir, name));

  // JSON の意味的一致(キー順は問わない)
  const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  const hash = (t) => createHash('sha256').update(JSON.stringify(canon(JSON.parse(t)))).digest('hex').slice(0, 16);
  const [f, d] = results;
  // DB 版は互換 PUT 用に最上位へ `_rev` を足す仕様(Phase 1)。それだけは差として許す。
  const stripRev = (t) => { const o = JSON.parse(t); delete o._rev; return JSON.stringify(o); };
  const identical = f.status === 200 && d.status === 200 && hash(stripRev(f.body)) === hash(stripRev(d.body));
  const exactBytes = f.body === d.body;
  // 差分の場所(最大10件)を出す
  const diffs = [];
  (function walk(a, b, p) {
    if (diffs.length >= 10) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${p}.${k}`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`${p}: file=${JSON.stringify(a)?.slice(0, 60)} db=${JSON.stringify(b)?.slice(0, 60)}`);
    }
  })(JSON.parse(f.body), JSON.parse(d.body), '$');
  const fmt =(r) => `${r.storage.padEnd(4)} status=${r.status} bytes=${r.bytes} n=${r.n} min=${r.min.toFixed(1)} median=${r.median.toFixed(1)} mean=${r.mean.toFixed(1)} p95=${r.p95.toFixed(1)} max=${r.max.toFixed(1)} (ms)`;
  const out = {
    node: process.version, platform: `${process.platform}-${process.arch}`, file: name, fileBytes: statSync(src).size,
    runs: RUNS, warmup: WARMUP, import: rep,
    results: results.map(({ body, ...r }) => r), jsonSemanticallyEqual: identical, jsonByteEqual: exactBytes,
    ratioDbOverFileMedian: d.median / f.median,
  };
  console.log(`node ${process.version} ${out.platform}  file=${name} (${out.fileBytes} bytes)  runs=${RUNS} warmup=${WARMUP}`);
  console.log(`import: sessions=${rep.sessions} tracks=${rep.tracks} reflections=${rep.reflections}`);
  results.forEach((r) => console.log(fmt(r)));
  console.log(`db/file median ratio = ${out.ratioDbOverFileMedian.toFixed(2)}`);
  console.log(`JSON equal (最上位 _rev を除く, キー順不問): ${identical}  byte equal: ${exactBytes}`);
  diffs.forEach((x) => console.log(`  diff ${x}`));
  out.diffs = diffs;
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  process.exitCode = identical ? 0 : 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
