// src/vmgminute.js
// 複数艇のGPS軌跡を新風軸(windaxis)基準で「時計の毎分」ごとにVMG比較し、
// その分の勝者(最良VMG艇)区間を返す純関数群。DOM/副作用なし。
// マップのネオンハイライト(renderer)へ渡す前段の集計に使う。
import { circDiffDeg, computeCog, windDirAt } from './windaxis.js';

const DEG = Math.PI / 180;
const MINUTE = 60_000;

// レグ代表方位/瞬時COGと風向から走種を判定。90°±deadband をリーチとして除外。
export function classifyPointOfSail(headingDeg, windDeg, deadband = 12) {
  const absD = Math.abs(circDiffDeg(headingDeg, windDeg));
  if (absD < 90 - deadband) return 'upwind';
  if (absD > 90 + deadband) return 'downwind';
  return 'reach';
}

// 1サンプルのVMG成分。upwind=風上前進成分、downwind=風下前進成分(符号反転)。
export function vmgComponents(cog, speed, windDeg) {
  const delta = circDiffDeg(cog, windDeg);
  const upwind = speed * Math.cos(delta * DEG);
  return { delta, upwind, downwind: -upwind };
}

// items 上で、走種 pos の連続ラン(nullで途切れる)を検出し、継続時間 <= maxSec のものを drop。
// 「クローズ→短いラン→クローズ」の間の下りや、風上中の一時的な横流し(下り)を落とす狙い。
// 長いラン(本物の風下レグ)は残す。
function markShortRuns(items, pos, maxSec) {
  const maxMs = maxSec * 1000;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (!it || it.pos !== pos || it.drop) { i++; continue; }
    let j = i;
    while (j < items.length && items[j] && items[j].pos === pos && !items[j].drop) j++;
    if (items[j - 1].t - items[i].t <= maxMs) {
      for (let k = i; k < j; k++) items[k].drop = true;
    }
    i = j;
  }
}

// 1艇の、時計の毎分バケットごとの (走種, 平均VMG)。リーチ主体の分は載せない。
// リーチ(横移動)はサンプル単位で除外し、短い風下ラン(クローズ間の一時的な下り)は
// markShortRuns で除外してから集計する(概算=残りのクリーン区間だけで平均)。
// 返り値: Map<minuteIndex, {pointOfSail, vmg, n}>
export function boatMinuteVmg(track, windSeries, opts = {}) {
  const deadband = opts.deadband ?? 12;
  const minSamples = opts.minSamples ?? 3;
  const excursionMaxSec = opts.excursionMaxSec ?? 60; // これ以下の風下ランは除外(クローズ中の10秒〜1分ぐらいの下り)
  const upwindExcursionMaxSec = opts.upwindExcursionMaxSec ?? 30; // これ以下のクローズは除外(ランニング中の5〜30秒の登り)
  const samples = computeCog(track.points, opts.cogOpts ?? {});

  // 各サンプルを分類(風向欠損=null、リーチ=drop)。
  const items = samples.map((s) => {
    const wind = windDirAt(windSeries, s.t);
    if (wind == null) return null;
    const pos = classifyPointOfSail(s.cog, wind, deadband);
    const c = vmgComponents(s.cog, s.speed, wind);
    return { t: s.t, pos, value: pos === 'upwind' ? c.upwind : c.downwind, drop: pos === 'reach' };
  });

  // 短い風下(ランニング)ランと短い風上(クローズ)ランを除外。
  // 前者=クローズ間の一時的な下り、後者=ランニング中の一時的な登り(いずれもVMG狙いでない)。
  // リーチ(横移動)は上で drop 済み。長いレグ(>閾値)は本物の走りとして残る。
  markShortRuns(items, 'downwind', excursionMaxSec);
  markShortRuns(items, 'upwind', upwindExcursionMaxSec);

  const buckets = new Map(); // minuteIndex -> {up:[], down:[]}
  for (const it of items) {
    if (!it || it.drop || it.pos === 'reach') continue;
    const mi = Math.floor(it.t / MINUTE);
    let b = buckets.get(mi);
    if (!b) { b = { up: [], down: [] }; buckets.set(mi, b); }
    (it.pos === 'upwind' ? b.up : b.down).push(it.value);
  }
  const out = new Map();
  for (const [mi, b] of buckets) {
    // その分の支配的な走種(サンプル数が多い方)を採用。両走種が拮抗しても多数側で代表。
    const [pos, arr] = b.up.length >= b.down.length ? ['upwind', b.up] : ['downwind', b.down];
    if (arr.length < minSamples) continue;
    const vmg = arr.reduce((a, x) => a + x, 0) / arr.length;
    out.set(mi, { pointOfSail: pos, vmg, n: arr.length });
  }
  return out;
}

// 全艇×毎分バケットから、各分の最良VMG艇(勝者)区間を返す。
// - windSeriesByTrack は「トラックオブジェクト」をキーにしたMap。
//   各艇のGPSファイルが同名(例 Location.csv)でidが重複しうるため、idでは区別しない。
// - 対象は風上/風下の艇のみ(リーチは boatMinuteVmg で除外済み)
// - その分に対象艇が minBoats 未満なら勝者なし
// - 走種をまたいでVMG(風軸方向の前進成分の大きさ)最大の1艇を勝者に
// - 隣接する同一(トラック,走種)の分は1区間に結合
// 返り値: [{track, boatId, color, lo, hi, pointOfSail, vmg}]（lo/hi は絶対epoch ms・分境界）
export function minuteWinners(tracks, windSeriesByTrack, opts = {}) {
  const minBoats = opts.minBoats ?? 2;

  // minuteIndex -> [{track, pointOfSail, vmg}]
  const byMinute = new Map();
  for (const track of tracks) {
    const ws = windSeriesByTrack.get(track) || [];
    if (!ws.length) continue;
    const mv = boatMinuteVmg(track, ws, opts);
    for (const [mi, rec] of mv) {
      let list = byMinute.get(mi);
      if (!list) { list = []; byMinute.set(mi, list); }
      list.push({ track, pointOfSail: rec.pointOfSail, vmg: rec.vmg });
    }
  }

  // 各分の勝者を決定(対象2艇以上のときのみ)
  const perMinute = []; // {mi, track, pointOfSail, vmg}
  for (const [mi, list] of byMinute) {
    if (list.length < minBoats) continue;
    const win = list.reduce((a, b) => (b.vmg > a.vmg ? b : a));
    perMinute.push({ mi, ...win });
  }
  perMinute.sort((a, b) => a.mi - b.mi);

  // 隣接する同一(トラック,走種)の分を結合
  const segs = [];
  for (const m of perMinute) {
    const last = segs[segs.length - 1];
    if (last && last.track === m.track && last.pointOfSail === m.pointOfSail && last._mi + 1 === m.mi) {
      last.hi = (m.mi + 1) * MINUTE;
      last._mi = m.mi;
      last.vmg = Math.max(last.vmg, m.vmg);
    } else {
      segs.push({
        track: m.track, boatId: m.track.id, color: m.track.color || '#888',
        lo: m.mi * MINUTE, hi: (m.mi + 1) * MINUTE,
        pointOfSail: m.pointOfSail, vmg: m.vmg, _mi: m.mi,
      });
    }
  }
  return segs.map(({ _mi, ...s }) => s);
}
