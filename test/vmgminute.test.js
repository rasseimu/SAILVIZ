import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPointOfSail, vmgComponents, minuteWinners, minuteWinnersDetailed, boatMinuteVmg, boatVmgSamples,
  cogSamplesByIntervals,
} from '../src/vmgminute.js';
import { computeCog } from '../src/windaxis.js';
import { assessComparison } from '../src/analysisconfidence.js';
import { summarizeNeonShare } from '../src/vmg.js';

const DEG = Math.PI / 180;

// --- 純関数: 走種判定 ---
test('classifyPointOfSail: 風正面付近は upwind', () => {
  assert.equal(classifyPointOfSail(0, 0), 'upwind'); // 風向と一致(真っ向)
  assert.equal(classifyPointOfSail(40, 0), 'upwind');
});

test('classifyPointOfSail: 風後方は downwind', () => {
  assert.equal(classifyPointOfSail(180, 0), 'downwind');
  assert.equal(classifyPointOfSail(140, 0), 'downwind');
});

test('classifyPointOfSail: 90°±deadband はリーチ', () => {
  assert.equal(classifyPointOfSail(90, 0), 'reach');
  assert.equal(classifyPointOfSail(85, 0), 'reach'); // 既定deadband=12
});

// --- 純関数: VMG成分 ---
test('vmgComponents: 真っ向は upwind=speed, downwind=-speed', () => {
  const c = vmgComponents(0, 5, 0);
  assert.equal(Math.round(c.delta), 0);
  assert.ok(Math.abs(c.upwind - 5) < 1e-9);
  assert.ok(Math.abs(c.downwind + 5) < 1e-9);
});

test('vmgComponents: 45°では upwind=speed*cos45', () => {
  const c = vmgComponents(45, 5, 0);
  assert.ok(Math.abs(c.upwind - 5 * Math.cos(45 * DEG)) < 1e-9);
});

// --- テスト用: 一定針路・一定速度の直線トラックを生成 ---
// bearing方向へ speed[m/s] で dt[s] 刻み、duration[s] 分の点列(各点に speed を持たせる)。
function straightTrack(id, color, { lat0 = 35, lon0 = 139, bearing, speed, startT, durationSec, dtSec = 1 }) {
  const points = [];
  let lat = lat0, lon = lon0;
  const n = Math.floor(durationSec / dtSec);
  for (let i = 0; i <= n; i++) {
    const t = startT + i * dtSec * 1000;
    points.push({ t, lat, lon, speed, accuracy: 5 });
    const dNorth = speed * Math.cos(bearing * DEG) * dtSec;
    const dEast = speed * Math.sin(bearing * DEG) * dtSec;
    lat += dNorth / 111320;
    lon += dEast / (111320 * Math.cos(lat * DEG));
  }
  return { id, color, visible: true, points };
}

// segments: [{bearing, speed, durationSec}] を連続位置で繋いだトラック(各点に speed)。
function segmentedTrack(id, color, segments, { lat0 = 35, lon0 = 139, startT = 0, dtSec = 1 } = {}) {
  const points = [];
  let lat = lat0, lon = lon0, t = startT;
  points.push({ t, lat, lon, speed: segments[0].speed, accuracy: 5 });
  for (const seg of segments) {
    const n = Math.floor(seg.durationSec / dtSec);
    for (let i = 0; i < n; i++) {
      const dNorth = seg.speed * Math.cos(seg.bearing * DEG) * dtSec;
      const dEast = seg.speed * Math.sin(seg.bearing * DEG) * dtSec;
      lat += dNorth / 111320;
      lon += dEast / (111320 * Math.cos(lat * DEG));
      t += dtSec * 1000;
      points.push({ t, lat, lon, speed: seg.speed, accuracy: 5 });
    }
  }
  return { id, color, visible: true, points };
}

const wideWind = (deg = 0) => [{ tMs: 0, windFromDeg: deg }, { tMs: 10_000_000, windFromDeg: deg }];
const sails = (mv) => [...mv.values()].map((v) => v.pointOfSail);

// --- 除外: クローズ間の短いランニング / 風上中の一時的な下り ---
test('boatMinuteVmg: 短い風下(ランニング)区間はVMGから除外する', () => {
  // 45秒だけ真下り(bearing180, 風向0)。短いラン→除外され、バケットは空。
  const tr = segmentedTrack('X', '#f00', [{ bearing: 180, speed: 5, durationSec: 45 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.equal(mv.size, 0, '短いランは除外され集計に残らない');
});

test('boatMinuteVmg: excursionMaxSec=0 なら短い風下も残る(除外の効果を確認)', () => {
  const tr = segmentedTrack('X', '#f00', [{ bearing: 180, speed: 5, durationSec: 45 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), { excursionMaxSec: 0 });
  assert.ok(mv.size >= 1 && sails(mv).includes('downwind'), '除外を切ると風下が残る');
});

test('boatMinuteVmg: 長い風下レグ(180秒)は本物の下りとして残す', () => {
  const tr = segmentedTrack('X', '#f00', [{ bearing: 180, speed: 5, durationSec: 180 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.ok(sails(mv).includes('downwind'), '長い風下レグは残る');
});

test('boatMinuteVmg: 風上レグの間に挟まれた短い下りは除外され、風上のみになる', () => {
  // クローズ(90s) → 短いラン(45s) → クローズ(90s)
  const tr = segmentedTrack('X', '#f00', [
    { bearing: 0, speed: 5, durationSec: 90 },
    { bearing: 180, speed: 6, durationSec: 45 },
    { bearing: 0, speed: 5, durationSec: 90 },
  ]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.ok(mv.size >= 1);
  assert.ok(sails(mv).every((p) => p === 'upwind'), '挟まれた短い下りは消えて全て風上');
});

test('boatMinuteVmg: 短いクローズ(登り)区間はVMGから除外する', () => {
  // 20秒だけクローズ(bearing0, 風向0)。短い登り→除外され、バケットは空。
  const tr = segmentedTrack('X', '#f00', [{ bearing: 0, speed: 5, durationSec: 20 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.equal(mv.size, 0, '短いクローズは除外され集計に残らない');
});

test('boatMinuteVmg: upwindExcursionMaxSec=0 なら短いクローズも残る(除外の効果を確認)', () => {
  const tr = segmentedTrack('X', '#f00', [{ bearing: 0, speed: 5, durationSec: 20 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), { upwindExcursionMaxSec: 0 });
  assert.ok(mv.size >= 1 && sails(mv).includes('upwind'), '除外を切ると登りが残る');
});

test('boatMinuteVmg: ランニングレグの間に挟まれた短いクローズは除外され、風下のみになる', () => {
  // ランニング(90s) → 短いクローズ(20s) → ランニング(90s)
  const tr = segmentedTrack('X', '#f00', [
    { bearing: 180, speed: 5, durationSec: 90 },
    { bearing: 0, speed: 6, durationSec: 20 },
    { bearing: 180, speed: 5, durationSec: 90 },
  ]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.ok(mv.size >= 1);
  assert.ok(sails(mv).every((p) => p === 'downwind'), '挟まれた短いクローズは消えて全て風下');
});

const T0 = 1_700_000_000_000; // 60秒境界に揃った適当な絶対時刻
const END = T0 + 180_000; // 3分

// 風向系列は「トラックオブジェクト」をキーにしたMapで渡す(idはボート間で重複しうるため)。
const windMap = (tracks, deg = 0) => new Map(tracks.map((t) => [t, [
  { tMs: T0, windFromDeg: deg }, { tMs: END, windFromDeg: deg },
]]));

// assessComparison の比較区間と有効区間を渡して勝者を求める(アプリと同じ経路)。
function comparedWinners(tracks, ws, opts = {}) {
  const ac = assessComparison(tracks, ws, opts);
  return minuteWinnersDetailed(tracks, ws, { ...opts, comparable: ac.segments, validIntervalsByTrack: ac.validIntervalsByTrack });
}
const cmpWinners = (tracks, ws, opts = {}) => comparedWinners(tracks, ws, opts).winners;

test('minuteWinners: 風上を速く詰める艇(真っ向)が毎分の勝者', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),   // delta=0, vmg=5
    straightTrack('B', '#00f', { bearing: 45, speed: 5, startT: T0, durationSec: 180 }),  // delta=45, vmg≈3.5
  ];
  const segs = cmpWinners(tracks, windMap(tracks), {});
  assert.ok(segs.length >= 1);
  assert.ok(segs.every(s => s.track === tracks[0]), 'すべての勝者区間がA');
  assert.ok(segs.every(s => s.color === '#f00'), '色はAのトラック色');
  // 隣接する同一勝者は結合され、全域(約3分)を覆う
  assert.equal(segs[0].pointOfSail, 'upwind');
});

test('minuteWinners(legacyCrossPointOfSail): 走種をまたいでVMG大の艇が勝者(風下艇が上回る)', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 4, startT: T0, durationSec: 180 }),    // upwind vmg=4
    straightTrack('B', '#00f', { bearing: 180, speed: 5, startT: T0, durationSec: 180 }),  // downwind vmg=5
  ];
  // 旧挙動(走種をまたいだ比較)は互換オプションを明示したときだけ
  const segs = minuteWinners(tracks, windMap(tracks), { legacyCrossPointOfSail: true });
  assert.ok(segs.length >= 1);
  assert.ok(segs.every(s => s.track === tracks[1]), '風下でVMG大のBが勝者');
  assert.equal(segs[0].pointOfSail, 'downwind');
});

test('minuteWinners: 対象が2艇未満の分は勝者なし', () => {
  const tracks = [straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 })];
  const segs = cmpWinners(tracks, windMap(tracks), {});
  assert.deepEqual(segs, []);
});

test('minuteWinners: リーチ艇は対象外(2艇ともリーチなら勝者なし)', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 90, speed: 5, startT: T0, durationSec: 180 }),  // reach
    straightTrack('B', '#00f', { bearing: 90, speed: 6, startT: T0, durationSec: 180 }),  // reach
  ];
  const segs = cmpWinners(tracks, windMap(tracks), {});
  assert.deepEqual(segs, []);
});

// 勝者の lo/hi は「集計バケット ∩ 比較区間」の断片の端(バケット境界か比較区間の端)に揃う。
const onEdge = (t, bucket, segments) => t % bucket === 0 || segments.some((g) => g.lo === t || g.hi === t);

test('minuteWinners: 区間は集計バケット(30秒)境界か比較区間の端に揃う', () => {
  // 異なる勝者が交互に出るよう、B は途中から真っ向(A より速い)に切り替える
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),
    segmentedTrack('B', '#00f', [
      { bearing: 45, speed: 5, durationSec: 95 }, { bearing: 0, speed: 6, durationSec: 85 },
    ], { lon0: 139.001, startT: T0 }),
  ];
  const ws = windMap(tracks);
  const ac = assessComparison(tracks, ws);
  const segs = minuteWinners(tracks, ws, { comparable: ac.segments, validIntervalsByTrack: ac.validIntervalsByTrack });
  assert.ok(segs.length >= 2, '勝者が入れ替わる');
  for (const w of segs) {
    assert.ok(onEdge(w.lo, 30000, ac.segments), 'loがバケット境界か比較区間の端');
    assert.ok(onEdge(w.hi, 30000, ac.segments), 'hiがバケット境界か比較区間の端');
  }
});

test('minuteWinners: bucketMs で集計バケット幅を上書きできる', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),
    straightTrack('B', '#00f', { bearing: 45, speed: 5, startT: T0, durationSec: 180 }),
  ];
  const ws = windMap(tracks);
  const ac = assessComparison(tracks, ws, { bucketMs: 60000 });
  const d = minuteWinnersDetailed(tracks, ws, { bucketMs: 60000, comparable: ac.segments, validIntervalsByTrack: ac.validIntervalsByTrack });
  assert.ok(d.winners.length >= 1);
  for (const w of d.winners) {
    assert.ok(onEdge(w.lo, 60000, ac.segments), '60秒指定なら60秒境界か比較区間の端');
    assert.ok(onEdge(w.hi, 60000, ac.segments));
  }
});

// 回帰: 各艇のGPSファイルが同名(例 Location.csv)でidが重複しても、
// 別トラックとして正しく区別し、勝者を取り違えない(色・帰属が混ざらない)。
test('minuteWinners: 同名idの別艇を取り違えない', () => {
  const tracks = [
    straightTrack('Location.csv', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),  // 真っ向・勝者
    straightTrack('Location.csv', '#00f', { bearing: 45, speed: 5, startT: T0, durationSec: 180 }), // 遅い
  ];
  const segs = cmpWinners(tracks, windMap(tracks), {});
  assert.ok(segs.length >= 1);
  assert.ok(segs.every(s => s.track === tracks[0]), '勝者は真っ向のトラックだけ');
  assert.ok(segs.every(s => s.color === '#f00'), '色が最後の艇に潰れない');
});

// --- 高さ調整局面フィルタ(neon): 1艇クローズ・他艇過半数が下った時間帯を除外 ---
const totalDur = (ss) => ss.reduce((a, s) => a + (s.hi - s.lo), 0);

test('minuteWinners: 1艇クローズ・他艇過半数が下った局面はネオンから除外', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),   // クローズ継続
    straightTrack('B', '#0f0', { bearing: 75, speed: 5, startT: T0, durationSec: 180 }),  // フット(|Δ|=75)
    straightTrack('C', '#00f', { bearing: 75, speed: 5, startT: T0, durationSec: 180 }),  // フット
  ];
  const off = cmpWinners(tracks, windMap(tracks), { excludeHeightAdjust: false });
  const on = cmpWinners(tracks, windMap(tracks), {});
  assert.ok(off.every(s => s.track === tracks[0]), 'フィルタ無しではクローズのAが勝者');
  assert.ok(totalDur(off) > 150_000, 'フィルタ無しはほぼ全域が勝者');
  // 高さ調整局面(≈全域)が除外され、勝者時間は大きく削られる(残りは分境界の端数のみ)。
  assert.ok(totalDur(off) - totalDur(on) > 150_000, '高さ調整局面が除外されて勝者時間が大幅減');
});

// --- boatVmgSamples / boatMinuteVmg の validIntervals(Issue #30: 除外点を VMG に混ぜない) ---
test('boatVmgSamples: boatMinuteVmg の集計元サンプルを t 昇順で返す', () => {
  const tr = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 });
  const ws = windMap([tr]).get(tr);
  const ss = boatVmgSamples(tr, ws, {});
  assert.ok(ss.length > 100);
  assert.ok(ss.every((s, i) => i === 0 || s.t > ss[i - 1].t));
  assert.ok(ss.every((s) => s.pointOfSail === 'upwind' && Math.abs(s.vmg - 5) < 0.05));
  // boatMinuteVmg はこのサンプルのバケット平均
  const mv = boatMinuteVmg(tr, ws, {});
  const n = [...mv.values()].reduce((a, v) => a + v.n, 0);
  assert.equal(n, ss.length);
});

test('boatMinuteVmg: validIntervals 未指定は従来と同じ・全域1区間の指定とも同じ', () => {
  const tr = segmentedTrack('X', '#f00', [
    { bearing: 0, speed: 5, durationSec: 90 },
    { bearing: 180, speed: 6, durationSec: 45 },
    { bearing: 0, speed: 5, durationSec: 90 },
  ]);
  const base = boatMinuteVmg(tr, wideWind(0), {});
  assert.deepEqual(boatMinuteVmg(tr, wideWind(0), { validIntervals: undefined }), base);
  const all = [[tr.points[0].t, tr.points[tr.points.length - 1].t]];
  assert.deepEqual(boatMinuteVmg(tr, wideWind(0), { validIntervals: all }), base);
  // 既存テストと同じ結果(挟まれた短い下りは除外され全て風上)
  assert.ok(sails(base).every((p) => p === 'upwind'));
});

test('boatMinuteVmg: 有効区間外の点を極端な値にしても結果が変わらない', () => {
  const mk = (extreme) => {
    const tr = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: 0, durationSec: 180 });
    if (extreme) {
      // 100〜110秒の点を逆向き 14 m/s で動いたように置き換え、精度 500m にする
      const base = tr.points[100];
      for (let i = 101; i < 110; i++) {
        tr.points[i] = { ...tr.points[i], lat: base.lat - ((i - 100) * 14) / 111320, speed: 14, accuracy: 500 };
      }
    }
    return tr;
  };
  const ivs = [[0, 100_000], [110_000, 180_000]];
  const clean = boatMinuteVmg(mk(false), wideWind(0), { validIntervals: ivs });
  const dirty = boatMinuteVmg(mk(true), wideWind(0), { validIntervals: ivs });
  assert.deepEqual(dirty, clean);
  assert.notDeepEqual(boatMinuteVmg(mk(true), wideWind(0), {}), boatMinuteVmg(mk(false), wideWind(0), {}),
    '区間を指定しなければ極端値が平均に混ざる');
});

test('boatMinuteVmg: 有効区間外の点で走種が変わるように細工しても断片の走種判定は変わらない', () => {
  // 風上70秒 → 風下70秒 → 風上100秒。バケット2(60〜90秒)は風上10秒・風下20秒で、全点なら風下が多数。
  const tr = segmentedTrack('X', '#f00', [
    { bearing: 0, speed: 5, durationSec: 70 },
    { bearing: 180, speed: 5, durationSec: 70 },
    { bearing: 0, speed: 5, durationSec: 100 },
  ]);
  const all = boatMinuteVmg(tr, wideWind(0), {});
  assert.equal(all.get(2).pointOfSail, 'downwind', '全点ではバケット2は風下');
  const mv = boatMinuteVmg(tr, wideWind(0), { validIntervals: [[0, 70_000], [140_000, 240_000]] });
  assert.equal(mv.get(2).pointOfSail, 'upwind', '区間外の風下サンプルは走種判定に使わない');
  assert.ok(!mv.has(3), '有効区間のないバケットは載らない');
  assert.ok([...mv.values()].every((v) => v.pointOfSail === 'upwind'));
});

test('boatVmgSamples: 有効区間の境目で短いラン判定が途切れる(区間をまたいで1本にしない)', () => {
  // 風上 60秒の直線を 20秒ずつの有効区間3つに分けると、各ランは 30秒以下なので除外される。
  const tr = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: 0, durationSec: 60 });
  const ivs = [[0, 20_000], [20_000, 40_000], [40_000, 60_000]];
  assert.equal(boatVmgSamples(tr, wideWind(0), { validIntervals: ivs }).length, 0);
  assert.ok(boatVmgSamples(tr, wideWind(0), { validIntervals: [[0, 60_000]] }).length > 0);
});

test('cogSamplesByIntervals: 同時刻の重複点は有効側だけを COG 計算に使う', () => {
  const clean = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: 0, durationSec: 180 });
  const far = (p) => ({ ...p, lat: p.lat + 50 / 111320, lon: p.lon + 50 / 111320, accuracy: 500 }); // 50m 離れた無効点
  const pts = [...clean.points];
  // 区間2の始端(100秒)は無効点が先、区間1の終端(99秒)は無効点が後ろに並ぶ
  pts.splice(100, 0, far(clean.points[100]));
  pts.splice(100, 0, far(clean.points[99]));
  const dup = { ...clean, points: pts };
  const ivs = [[0, 99_000], [100_000, 180_000]];
  const cogOpts = { windowMs: 2000 }; // 始端の点が COG 窓に入る幅
  assert.deepEqual(cogSamplesByIntervals(dup.points, ivs, cogOpts), cogSamplesByIntervals(clean.points, ivs, cogOpts));
  assert.deepEqual(
    boatVmgSamples(dup, wideWind(0), { validIntervals: ivs, cogOpts }),
    boatVmgSamples(clean, wideWind(0), { validIntervals: ivs, cogOpts }),
  );
  // 重複点を落とさずに切り出すと無効点が COG に混ざる(このテストが意味を持つことの確認)
  const naive = computeCog(dup.points.filter((p) => p.t >= 100_000 && p.t <= 180_000), cogOpts);
  assert.notDeepEqual(naive, cogSamplesByIntervals(clean.points, ivs, cogOpts)[1]);
});

// --- 段階B: 比較区間の中だけで勝者を決める(Issue #30) ---
test('minuteWinners: comparable 未指定なら勝者なし(安全側の既定)', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),
    straightTrack('B', '#00f', { bearing: 45, speed: 5, startT: T0, durationSec: 180 }),
  ];
  assert.deepEqual(minuteWinners(tracks, windMap(tracks), {}), []);
  const d = minuteWinnersDetailed(tracks, windMap(tracks), { comparable: [] });
  assert.deepEqual(d.winners, []);
  assert.deepEqual(d.participation.get(tracks[0]), { upwind: 0, downwind: 0 });
});

test('minuteWinners: comparable 指定時は走種をまたいだ勝者が出ない', () => {
  // A 風上 vmg=4、C 風上 vmg≈3.5、B 風下 vmg=5(走種をまたげば B が勝つ)
  const A = straightTrack('A', '#f00', { bearing: 0, speed: 4, startT: T0, durationSec: 180 });
  const B = straightTrack('B', '#0f0', { lon0: 139.01, bearing: 180, speed: 5, startT: T0, durationSec: 180 });
  const C = straightTrack('C', '#00f', { lon0: 139.02, bearing: 45, speed: 5, startT: T0, durationSec: 180 });
  const { winners, participation } = comparedWinners([A, B, C], windMap([A, B, C]));
  assert.ok(winners.length >= 1);
  assert.ok(winners.every((w) => w.track === A && w.pointOfSail === 'upwind'), '風上どうしで A が勝者');
  assert.deepEqual(participation.get(B), { upwind: 0, downwind: 0 }, '風下1艇は比較に参加しない');
});

test('minuteWinners: 比較区間外に勝者なし・勝者の lo/hi は比較区間内', () => {
  // B は途中(60〜150秒)だけ記録
  const A = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 240 });
  const B = straightTrack('B', '#00f', { lon0: 139.01, bearing: 20, speed: 5, startT: T0 + 60_000, durationSec: 90 });
  const ws = windMap([A, B]);
  const ac = assessComparison([A, B], ws);
  assert.ok(ac.segments.length >= 1);
  const winners = minuteWinners([A, B], ws, { comparable: ac.segments, validIntervalsByTrack: ac.validIntervalsByTrack });
  assert.ok(winners.length >= 1);
  for (const w of winners) {
    const inside = ac.segments.some((g) => g.pointOfSail === w.pointOfSail && g.lo <= w.lo && w.hi <= g.hi);
    assert.ok(inside, `勝者 [${w.lo - T0}, ${w.hi - T0}] が比較区間内`);
  }
  assert.ok(winners.every((w) => w.lo >= T0 + 60_000 && w.hi <= T0 + 150_000));
});

test('minuteWinners: 無効点(精度超過・逆向き)を極端な値にしても勝者と勝者の VMG が変わらない', () => {
  const mk = (extreme) => {
    // 無効点を持つ B が勝者(真っ向)になる配置にし、B の VMG の再計算結果を検証する
    const A = straightTrack('A', '#f00', { bearing: 30, speed: 5, startT: T0, durationSec: 240 });
    const B = straightTrack('B', '#00f', { lon0: 139.01, bearing: 0, speed: 5, startT: T0, durationSec: 240 });
    for (let i = 101; i < 110; i++) {
      B.points[i].accuracy = 500;
      if (extreme) {
        // 逆向き 14 m/s で進んだように見える位置(全点で計算すると B の VMG が大きく変わる)
        const base = B.points[100];
        B.points[i] = { ...B.points[i], lat: base.lat - ((i - 100) * 14) / 111320, speed: 14 };
      }
    }
    return [A, B];
  };
  const shape = (ws) => ws.map((w) => [w.track.id, w.lo, w.hi, w.pointOfSail, Math.round(w.vmg * 1e9)]);
  const clean = mk(false), dirty = mk(true);
  const wc = cmpWinners(clean, windMap(clean));
  const wd = cmpWinners(dirty, windMap(dirty));
  assert.ok(wc.length >= 1);
  assert.deepEqual(shape(wd), shape(wc));
  // 参加時間も変わらない
  const pc = comparedWinners(clean, windMap(clean)).participation;
  const pd = comparedWinners(dirty, windMap(dirty)).participation;
  assert.deepEqual([...pd.values()], [...pc.values()]);
});

test('minuteWinners: 断片内の有効サンプルが minSamples 未満の艇は不参加、1艇だけの断片は勝者なし', () => {
  const S0 = 1_700_000_040_000; // 30秒境界
  const A = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: S0, durationSec: 60 });
  const B = straightTrack('B', '#00f', { lon0: 139.01, bearing: 20, speed: 5, startT: S0, durationSec: 60 });
  const ws = new Map([[A, [{ tMs: S0, windFromDeg: 0 }]], [B, [{ tMs: S0, windFromDeg: 0 }]]]);
  const comparable = [{ lo: S0, hi: S0 + 60_000, pointOfSail: 'upwind', tracks: [A, B] }];
  // B の有効区間は 40秒まで → 2つ目のバケット(30〜60秒)の B のサンプルは 10 未満
  const validIntervalsByTrack = new Map([[A, [[S0, S0 + 60_000]]], [B, [[S0, S0 + 40_000]]]]);
  const d = minuteWinnersDetailed([A, B], ws, { comparable, validIntervalsByTrack, minSamples: 10 });
  assert.equal(d.winners.length, 1);
  assert.deepEqual([d.winners[0].lo, d.winners[0].hi], [S0, S0 + 30_000], '2つ目の断片は参加1艇で勝者なし');
  assert.equal(d.winners[0].track, A);
  assert.deepEqual(d.participation.get(A), { upwind: 30_000, downwind: 0 }, '勝者なしの断片は参加時間に数えない');
  assert.deepEqual(d.participation.get(B), { upwind: 30_000, downwind: 0 });
});

test('minuteWinners: 交差30秒だけの assessComparison 結果を渡すと勝者なし', () => {
  const A = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 });
  const B = straightTrack('B', '#00f', { lon0: 139.01, bearing: 20, speed: 5, startT: T0 + 150_000, durationSec: 180 });
  const ws = new Map([A, B].map((t) => [t, [{ tMs: T0, windFromDeg: 0 }, { tMs: T0 + 330_000, windFromDeg: 0 }]]));
  const ac = assessComparison([A, B], ws);
  assert.equal(ac.overlapMs, 30_000);
  assert.deepEqual(ac.segments, []);
  const d = minuteWinnersDetailed([A, B], ws, { comparable: ac.segments, validIntervalsByTrack: ac.validIntervalsByTrack });
  assert.deepEqual(d.winners, []);
});

test('minuteWinners: 途中参加の艇の参加時間は記録のある時間だけ', () => {
  const A = straightTrack('A', '#f00', { bearing: 20, speed: 5, startT: T0, durationSec: 240 });
  const B = straightTrack('B', '#00f', { lon0: 139.01, bearing: 0, speed: 5, startT: T0 + 120_000, durationSec: 120 });
  const ws = new Map([A, B].map((t) => [t, [{ tMs: T0, windFromDeg: 0 }, { tMs: T0 + 240_000, windFromDeg: 0 }]]));
  const { winners, participation } = comparedWinners([A, B], ws);
  assert.ok(winners.length >= 1, '勝者が出る');
  assert.ok(winners.every((w) => w.track === B), '真っ向の B が参加中ずっと勝者');
  assert.ok(participation.get(B).upwind > 0, 'B は比較に参加している');
  assert.ok(participation.get(B).upwind <= 120_000, 'B の参加時間は記録のある時間以内');
  assert.equal(participation.get(A).upwind, participation.get(B).upwind, '2艇だけなら参加時間は同じ');
  // 参加時間中の勝率: B は参加中ずっと勝者なので 100%、A は 0%(記録のない前半は A の勝ちにも B の負けにも数えない)
  const { rows } = summarizeNeonShare(winners, [A, B], participation);
  assert.equal(rows[1].upwind, 1);
  assert.equal(rows[0].upwind, 0);
});

test('minuteWinners: 無効点(精度超過)を同じ走種で高速にしても、有効区間を渡せば勝者は変わらない', () => {
  const S0 = 1_700_000_040_000; // 30秒境界
  // A: 真っ向 5 m/s(VMG 5)。B: 真っ向 4 m/s だが 60〜90秒だけ 14 m/s で走ったように見える無効点(精度 500m)
  const A = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: S0, durationSec: 180 });
  const B = segmentedTrack('B', '#00f', [
    { bearing: 0, speed: 4, durationSec: 60 }, { bearing: 0, speed: 14, durationSec: 30 }, { bearing: 0, speed: 4, durationSec: 90 },
  ], { lon0: 139.01, startT: S0 });
  for (const p of B.points) if (p.t >= S0 + 60_000 && p.t <= S0 + 90_000) p.accuracy = 500;
  const ws = new Map([A, B].map((t) => [t, [{ tMs: S0, windFromDeg: 0 }, { tMs: S0 + 180_000, windFromDeg: 0 }]]));
  // 無効点の時間も含む比較区間を直接与え、勝者計算が有効区間でサンプルを絞っているかだけを検証する
  const comparable = [{ lo: S0, hi: S0 + 180_000, pointOfSail: 'upwind', tracks: [A, B] }];
  const ac = assessComparison([A, B], ws);
  const ok = minuteWinners([A, B], ws, { comparable, validIntervalsByTrack: ac.validIntervalsByTrack });
  assert.ok(ok.length >= 1);
  assert.ok(ok.every((w) => w.track === A), '有効点だけなら A が勝者(無効点の時間は B 不参加で勝者なし)');
  // 全点を有効扱いにすると、無効点の高速サンプルで B が勝つ(退行検出の確認)
  const all = new Map([A, B].map((t) => [t, [[t.points[0].t, t.points[t.points.length - 1].t]]]));
  const bad = minuteWinners([A, B], ws, { comparable, validIntervalsByTrack: all });
  assert.ok(bad.some((w) => w.track === B && w.pointOfSail === 'upwind'), '全点なら無効点の区間で B が勝つ');
});

test('minuteWinners: comparable 指定でも validIntervalsByTrack がなければ勝者なし(安全側)', () => {
  const A = straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 });
  const B = straightTrack('B', '#00f', { lon0: 139.01, bearing: 20, speed: 5, startT: T0, durationSec: 180 });
  const ws = windMap([A, B]);
  const ac = assessComparison([A, B], ws);
  assert.ok(ac.segments.length >= 1);
  const d = minuteWinnersDetailed([A, B], ws, { comparable: ac.segments });
  assert.deepEqual(d.winners, []);
  assert.deepEqual([...d.participation.values()], [{ upwind: 0, downwind: 0 }, { upwind: 0, downwind: 0 }]);
});

test('minuteWinnersDetailed: 各艇・各走種で勝者時間 ≤ 参加時間', () => {
  const A = straightTrack('A', '#f00', { bearing: 10, speed: 5, startT: T0, durationSec: 240 });
  const B = segmentedTrack('B', '#0f0', [
    { bearing: 30, speed: 5, durationSec: 100 }, { bearing: 0, speed: 6, durationSec: 140 },
  ], { lon0: 139.001, startT: T0 });
  const C = straightTrack('C', '#00f', { lon0: 139.002, bearing: 5, speed: 5, startT: T0 + 60_000, durationSec: 120 });
  const tracks = [A, B, C];
  const ws = new Map(tracks.map((t) => [t, [{ tMs: T0, windFromDeg: 0 }, { tMs: T0 + 240_000, windFromDeg: 0 }]]));
  const { winners, participation } = comparedWinners(tracks, ws);
  assert.ok(winners.length >= 2);
  for (const t of tracks) {
    for (const pos of ['upwind', 'downwind']) {
      const won = winners.filter((w) => w.track === t && w.pointOfSail === pos).reduce((s, w) => s + (w.hi - w.lo), 0);
      assert.ok(won <= participation.get(t)[pos], `${t.id} ${pos}: 勝者時間 ${won} <= 参加時間 ${participation.get(t)[pos]}`);
    }
  }
});
