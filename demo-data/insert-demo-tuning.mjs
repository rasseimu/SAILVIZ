// 保存済み練習日(data/projects)にデモ用チューニングを挿入するスクリプト。
// 各練習日ごとに 6 艇ぶんの rig 付きデモ反省を追記し、全艇チューニング
// ダッシュボードで見比べられるようにする。
//
// 方針(ユーザー指定):
//  - 4899 のユーザー実測を N12 基準にする(gen-demo-tuning.mjs の BASE と同じ値)。
//  - N12 艇: 4899 / 4859 / 4807、N9 艇: 4677 / 4519 / 4304。
//  - N9 は N12 との違い「プリベンド −15」だけを効かせる(他は同基準)。
//  - 各パラメータはその日の風速で現実的にトレンドさせ、同型内は艇差で少しずらす。
//  - 既存の部員反省(rig=null)は残し、デモ反省(id: demo-tuning-*)だけを入れ替える(冪等)。
//
// 使い方: node demo-data/insert-demo-tuning.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(HERE, '..', 'data', 'projects');
const BACKUP_DIR = join(HERE, 'backups');

// 練習日ごとに 1 ファイルだけを対象にする(同一日が複数ファイルある場合は実練習ファイル)。
// startMs は x 軸(=練習開始)。風速はその日の代表値(amedas 実測、08/23 のみデータ無しで想定値)。
const TARGETS = [
  { file: 'sailviz-20260823-1321.sailviz.json', date: '2026/08/23', startMs: 1787458905999.2031, wind: 3.5, windNote: 'データ無し・想定値' },
  { file: 'sailviz-20260826-0907.sailviz.json', date: '2026/08/26', startMs: 1787702855999.5967, wind: 1.8 },
  { file: 'sailviz-20260827-0906.sailviz.json', date: '2026/08/27', startMs: 1787789204998.957,  wind: 1.3 },
  { file: 'sailviz-20260828-0909.sailviz.json', date: '2026/08/28', startMs: 1787875773974.689,  wind: 3.0 },
  { file: 'sailviz-20260903-0844.sailviz.json', date: '2026/09/03', startMs: 1788392687181.2979, wind: 4.9 },
];

// 艇 → セール型。順序は FOCUS_BOATS に合わせる。
const N12 = [4899, 4859, 4807];
const N9 = [4677, 4519, 4304];
const BOATS = [...N12, ...N9];

// 4899 実測ベースライン(= N12 基準)。gen-demo-tuning.mjs の BASE と同一。
const BASE = {
  gear: 1, prebend: 75, rake: 6750, sideTension: 310, foreTension: 140,
  puller: 1, peakRope: 7, bridleHeight: 2, jibLeader: 1.5, jibPull: 3, vangPull: 0,
};

const round1 = (n) => Math.round(n * 10) / 10;

// 艇 1 隻ぶんの rig を作る。
// model: 'N12' | 'N9'、k: 同型内の艇インデックス(0..2)、wind: その日の風速[m/s]。
function rigFor(boat, model, k, wind) {
  const dw = wind - 3.0;                       // 基準風 3.0m/s からの差
  const prebendBase = model === 'N12' ? BASE.prebend : BASE.prebend - 15; // N9 は −15
  const gear = wind < 2 ? 1 : wind < 4 ? 2 : 3; // 風でギアを上げる
  return {
    boatNo: boat,
    gear,
    prebend: round1(prebendBase + k * 1.5 + dw * 2),      // 風で増・同型内で微差
    rake: Math.round(BASE.rake + dw * 15 + k * 8),         // 風でレーキを寝かす
    sideTension: Math.round(BASE.sideTension + dw * 12 + k * 5),
    foreTension: Math.round(BASE.foreTension + dw * 6 + k * 3),
    puller: round1(Math.max(1, BASE.puller + dw * 0.3)),
    peakRope: BASE.peakRope + (k % 2),                     // 7↔8
    bridleHeight: round1(BASE.bridleHeight + (k % 3) * 0.5),
    jibLeader: round1(BASE.jibLeader + k * 0.1),
    jibPull: round1(BASE.jibPull + dw * 0.3 + k * 0.1),
    vangPull: round1(Math.max(0, (wind - 1.0) * 0.6)),     // 風でバングを引く
  };
}

const NOTE_EMPTY = { goal: '', issue: '', discovery: '', slowFactor: '', fastFactor: '' };

function modelOf(boat) { return N12.includes(boat) ? 'N12' : 'N9'; }

if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

let files = 0; let added = 0;
for (const t of TARGETS) {
  const path = join(PROJECTS_DIR, t.file);
  if (!existsSync(path)) { console.warn(`skip (not found): ${t.file}`); continue; }

  // 初回のみ元ファイルをバックアップ(再実行しても pristine を上書きしない)。
  const bak = join(BACKUP_DIR, `${t.file}.pre-demo-tuning.bak`);
  if (!existsSync(bak)) copyFileSync(path, bak);

  const project = JSON.parse(readFileSync(path, 'utf8'));
  const existing = Array.isArray(project.reflections) ? project.reflections : [];
  // 既存デモ反省を除去(冪等) + 元の部員反省は保持。
  const kept = existing.filter((r) => !String(r?.id || '').startsWith('demo-tuning-'));

  const endMs = t.startMs + 2 * 60 * 60 * 1000;
  const ymd = t.date.replace(/\//g, '');
  const demo = BOATS.map((boat, idx) => {
    const model = modelOf(boat);
    const k = (model === 'N12' ? N12 : N9).indexOf(boat);
    return {
      id: `demo-tuning-${ymd}-${boat}`,
      createdAt: t.startMs + idx * 1000,
      text: `デモ: ${boat}(${model}) チューニング ${t.date} 風${t.wind}m/s`,
      people: [],
      videos: [],
      wind: { speed: t.wind, source: 'demo' },
      practice: { date: t.date, startMs: t.startMs, endMs },
      rig: rigFor(boat, model, k, t.wind),
      waveHeight: null,
      notes: NOTE_EMPTY,
    };
  });

  project.reflections = [...kept, ...demo];
  writeFileSync(path, JSON.stringify(project));
  files++; added += demo.length;
  const note = t.windNote ? ` (${t.windNote})` : '';
  console.log(`updated ${t.file}: +${demo.length} demo reflections  [${t.date} 風${t.wind}m/s${note}]`);
}
console.log(`done: ${files} files, ${added} demo reflections. backups in demo-data/backups/`);
