// チューニングダッシュボードのデモ用練習データ生成スクリプト。
// 6艇 × 5練習日の .sailviz.json を demo-data/ 直下に書き出す。
// 各反省に艇セッティング(rig)を入れ、艇差＋季節トレンドで見分けやすい推移にする。
// 使い方: node demo-data/gen-demo-tuning.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const BOATS = [4899, 4859, 4807, 4677, 4519, 4304];

// 4899 のユーザー実測をベースライン(他艇・他日はここからの相対で振る)。
const BASE = {
  gear: 1, prebend: 75, rake: 6750, sideTension: 310, foreTension: 140,
  puller: 1, peakRope: 7, bridleHeight: 2, jibLeader: 1.5, jibPull: 3, vangPull: 0,
};

// 練習日(JST 09:00 = UTC 00:00)。1シーズン分。
const DATES = [
  [2026, 6, 15], [2026, 6, 29], [2026, 7, 13], [2026, 7, 27], [2026, 8, 10],
];

const pad = (n) => String(n).padStart(2, '0');
const round1 = (n) => Math.round(n * 10) / 10;

// 艇index bi(0..5)・日index di(0..4) の rig を作る。艇差＋トレンドで散らす。
function rigFor(boat, bi, di) {
  return {
    boatNo: boat,
    gear: BASE.gear + (bi % 3),                    // 1..3
    prebend: BASE.prebend + bi * 2 + di,           // 75..~91
    rake: BASE.rake + bi * 15 - di * 10,           // 艇差＋季節で微減
    sideTension: BASE.sideTension + bi * 8 + di * 3,
    foreTension: BASE.foreTension + bi * 5 - di * 2,
    puller: BASE.puller + (di % 2),                // 1↔2
    peakRope: BASE.peakRope + (bi % 2),            // 7↔8
    bridleHeight: round1(BASE.bridleHeight + (bi % 3) * 0.5),
    jibLeader: round1(BASE.jibLeader + bi * 0.1),
    jibPull: round1(BASE.jibPull + (di - 2) * 0.2), // トレンド
    vangPull: round1(BASE.vangPull + di * 0.5),      // 0 から増加
  };
}

const NOTE_EMPTY = { goal: '', issue: '', discovery: '', slowFactor: '', fastFactor: '' };

let wrote = 0;
for (let di = 0; di < DATES.length; di++) {
  const [y, m, d] = DATES[di];
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0); // 09:00 JST
  const endMs = startMs + 2 * 60 * 60 * 1000;
  const dateLabel = `${y}/${pad(m)}/${pad(d)}`;

  const reflections = BOATS.map((boat, bi) => ({
    id: `demo-${y}${pad(m)}${pad(d)}-${boat}`,
    createdAt: startMs + bi * 1000,
    text: `デモ: ${boat} の艇セッティング (${dateLabel})`,
    people: [],
    videos: [],
    wind: bi === 0 ? { dir: '南西', speed: round1(3 + di * 0.4), source: 'manual' } : null,
    practice: { date: dateLabel, startMs, endMs },
    rig: rigFor(boat, bi, di),
    waveHeight: round1(0.3 + di * 0.05),
    notes: NOTE_EMPTY,
  }));

  const project = {
    version: 1,
    savedAt: new Date(startMs).toISOString(),
    mode: 'absolute',
    accuracyFilter: true,
    crop: { start: startMs, end: endMs },
    tracks: [],
    events: [],
    marks: [],
    pins: [],
    videos: [],
    reflections,
  };

  const name = `sailviz-${y}${pad(m)}${pad(d)}-0900.sailviz.json`;
  writeFileSync(join(OUT_DIR, name), JSON.stringify(project));
  wrote++;
  console.log(`wrote ${name} (${reflections.length} reflections)`);
}
console.log(`done: ${wrote} practice files, ${wrote * BOATS.length} reflections total`);
