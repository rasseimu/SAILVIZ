// src/vmgminute.js
// 複数艇のGPS軌跡を新風軸(windaxis)基準で「集計バケット(既定30秒、opts.bucketMs)」ごとに
// VMG比較し、そのバケットの勝者(最良VMG艇)区間を返す純関数群。DOM/副作用なし。
// マップのネオンハイライト(renderer)へ渡す前段の集計に使う。
// (歴史的経緯で関数名は minute/Minute のままだが、実際のバケット幅は BUCKET_MS)
import { circDiffDeg, computeCog, windDirAt } from './windaxis.js';
import { detectHeightAdjustWindowsByTrack } from './vmg.js';

const DEG = Math.PI / 180;
// VMG集計バケット(既定30秒=旧1分の半分)。opts.bucketMs で上書き可。
// boatMinuteVmg と minuteWinners で必ず同じ値を使うこと(バケット境界を一致させるため)。
const BUCKET_MS = 30_000;

// [lo,hi) から exclude 区間群を差し引き、残った断片 [[a,b],...] を返す(重なりで分割されうる)。
export function subtractIntervals(lo, hi, exclude) {
  let pieces = [[lo, hi]];
  for (const e of exclude) {
    const next = [];
    for (const [a, b] of pieces) {
      if (e.hi <= a || e.lo >= b) { next.push([a, b]); continue; } // 重なりなし
      if (e.lo > a) next.push([a, Math.min(e.lo, b)]);            // 除外前の断片
      if (e.hi < b) next.push([Math.max(e.hi, a), b]);            // 除外後の断片
    }
    pieces = next;
  }
  return pieces.filter(([a, b]) => b > a);
}

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

// validIntervals([[lo, hi], ...])で点を切り出す。区間ごとに t が [lo, hi] に入る点の配列を返す。
// 区間は t 昇順に並べ替え、不正な区間(非数・lo > hi)は無視する。points は t 昇順が前提。
// 同時刻の重複点は1点だけ残す(COG 計算に dt=0 の点を入れない)。analysisconfidence.validIntervals は
// 同時刻の2点の組を判定しないため、区間の始端 lo では後ろの点(次の点との組で有効と判定された側)、
// それ以外(終端 hi・区間内)では前の点(直前の点との組で有効と判定された側)を残す。
function slicePointsByIntervals(points, intervals) {
  const ivs = intervals
    .filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[0] <= iv[1])
    .slice()
    .sort((a, b) => a[0] - b[0]);
  return ivs.map(([lo, hi]) => {
    const out = [];
    for (const p of points) {
      if (!p || !(p.t >= lo && p.t <= hi)) continue;
      const last = out[out.length - 1];
      if (last && last.t === p.t) {
        if (p.t === lo) out[out.length - 1] = p; // 始端は後ろの点を残す
        continue; // それ以外は前の点を残す
      }
      out.push(p);
    }
    return out;
  });
}

// 有効区間ごとに点を切り出して computeCog したサンプル列の配列を返す(区間の順、各列は t 昇順)。
// 除外した点や、区間をまたぐ COG を作らない。高さ調整局面の検出などで区間内サンプルだけを使うときに使う。
export function cogSamplesByIntervals(points, intervals, cogOpts = {}) {
  const pts = Array.isArray(points) ? points : [];
  const ivs = Array.isArray(intervals) ? intervals : [];
  return slicePointsByIntervals(pts, ivs).map((sub) => computeCog(sub, cogOpts));
}

// 1艇の VMG サンプル列(走種分類・リーチ除外・短いラン除外の済んだもの)を t 昇順で返す。
// opts.validIntervals([[lo, hi], ...])を指定すると、有効区間ごとに点を切り出してから COG を計算する
// (除外した点や、区間をまたぐ COG を作らない)。区間外の時刻のサンプルは走種判定・短いラン判定・
// 平均のいずれにも使わない。短いラン判定は有効区間の境目で途切れる(区間をまたいで1本のランにしない)。
// 未指定なら従来どおり全点から計算する。
// 返り値: [{t, pointOfSail: 'upwind'|'downwind', vmg}]
export function boatVmgSamples(track, windSeries, opts = {}) {
  const deadband = opts.deadband ?? 12;
  const excursionMaxSec = opts.excursionMaxSec ?? 60; // これ以下の風下ランは除外(クローズ中の10秒〜1分ぐらいの下り)
  const upwindExcursionMaxSec = opts.upwindExcursionMaxSec ?? 30; // これ以下のクローズは除外(ランニング中の5〜30秒の登り)
  const cogOpts = opts.cogOpts ?? {};

  // 各サンプルを分類(風向欠損=null、リーチ=drop)。
  const classify = (s) => {
    const wind = windDirAt(windSeries, s.t);
    if (wind == null) return null;
    const pos = classifyPointOfSail(s.cog, wind, deadband);
    const c = vmgComponents(s.cog, s.speed, wind);
    return { t: s.t, pos, value: pos === 'upwind' ? c.upwind : c.downwind, drop: pos === 'reach' };
  };

  let items;
  if (Array.isArray(opts.validIntervals)) {
    // 有効区間ごとに COG を計算し、区間の境目に null を挟んでランを途切れさせる。
    // 境目でランを切るのは意図的(除外した点・欠損をまたいだランを作らない。短いラン判定は安全側に倒れる)。
    items = [];
    for (const samples of cogSamplesByIntervals(track?.points, opts.validIntervals, cogOpts)) {
      if (items.length) items.push(null);
      for (const s of samples) items.push(classify(s));
    }
  } else {
    items = computeCog(track.points, cogOpts).map(classify);
  }

  // 短い風下(ランニング)ランと短い風上(クローズ)ランを除外。
  // 前者=クローズ間の一時的な下り、後者=ランニング中の一時的な登り(いずれもVMG狙いでない)。
  // リーチ(横移動)は上で drop 済み。長いレグ(>閾値)は本物の走りとして残る。
  markShortRuns(items, 'downwind', excursionMaxSec);
  markShortRuns(items, 'upwind', upwindExcursionMaxSec);

  const out = [];
  for (const it of items) {
    if (!it || it.drop || it.pos === 'reach') continue;
    out.push({ t: it.t, pointOfSail: it.pos, vmg: it.value });
  }
  return out;
}

// 1艇の、集計バケット(既定30秒)ごとの (走種, 平均VMG)。リーチ主体のバケットは載せない。
// リーチ(横移動)はサンプル単位で除外し、短い風下ラン(クローズ間の一時的な下り)は
// markShortRuns で除外してから集計する(概算=残りのクリーン区間だけで平均)。
// opts.validIntervals を指定すると有効区間内のサンプルだけで集計する(boatVmgSamples 参照)。
// 返り値: Map<bucketIndex, {pointOfSail, vmg, n}>
export function boatMinuteVmg(track, windSeries, opts = {}) {
  const minSamples = opts.minSamples ?? 3;
  const bucketMs = opts.bucketMs ?? BUCKET_MS;

  const buckets = new Map(); // minuteIndex -> {up:[], down:[]}
  for (const s of boatVmgSamples(track, windSeries, opts)) {
    const mi = Math.floor(s.t / bucketMs);
    let b = buckets.get(mi);
    if (!b) { b = { up: [], down: [] }; buckets.set(mi, b); }
    (s.pointOfSail === 'upwind' ? b.up : b.down).push(s.vmg);
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

// 【旧挙動・互換用】全艇×集計バケット(既定30秒)から、各バケットの最良VMG艇(勝者)区間を返す。
// opts.legacyCrossPointOfSail: true を明示したときだけ minuteWinners から使う(Issue #30 以前の挙動)。
// - windSeriesByTrack は「トラックオブジェクト」をキーにしたMap。
//   各艇のGPSファイルが同名(例 Location.csv)でidが重複しうるため、idでは区別しない。
// - 対象は風上/風下の艇のみ(リーチは boatMinuteVmg で除外済み)
// - その分に対象艇が minBoats 未満なら勝者なし
// - 走種をまたいでVMG(風軸方向の前進成分の大きさ)最大の1艇を勝者に
// - 隣接する同一(トラック,走種)のバケットは1区間に結合
// 返り値: [{track, boatId, color, lo, hi, pointOfSail, vmg}]（lo/hi は絶対epoch ms・バケット境界）
function legacyMinuteWinners(tracks, windSeriesByTrack, opts = {}) {
  const minBoats = opts.minBoats ?? 2;
  const bucketMs = opts.bucketMs ?? BUCKET_MS; // boatMinuteVmg と同じバケット幅を使う

  // 高さ調整局面(1艇クローズ・他艇過半数が下り)を全艇まとめてネオンから除外する。
  const exclude = opts.excludeHeightAdjust === false
    ? [] : detectHeightAdjustWindowsByTrack(tracks, windSeriesByTrack, opts);

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
      last.hi = (m.mi + 1) * bucketMs;
      last._mi = m.mi;
      last.vmg = Math.max(last.vmg, m.vmg);
    } else {
      segs.push({
        track: m.track, boatId: m.track.id, color: m.track.color || '#888',
        lo: m.mi * bucketMs, hi: (m.mi + 1) * bucketMs,
        pointOfSail: m.pointOfSail, vmg: m.vmg, _mi: m.mi,
      });
    }
  }
  const result = segs.map(({ _mi, ...s }) => s);
  if (exclude.length === 0) return result;
  // 除外区間で各勝者帯をクリップ(帯が分割されうる)。
  const clipped = [];
  for (const s of result) {
    for (const [lo, hi] of subtractIntervals(s.lo, s.hi, exclude)) clipped.push({ ...s, lo, hi });
  }
  return clipped;
}

// t 昇順の samples で samples[i].t >= t となる最小 i(なければ length)。
function lowerBoundT(samples, t) {
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// 比較区間(analysisconfidence.assessComparison().segments)の中だけで VMG 勝者を決める。
// - 判定単位は「集計バケット ∩ 比較区間」の断片。勝者の lo/hi はこの断片に切り詰める(比較していない時間を光らせない)。
// - 候補は比較区間の参加艇(segment.tracks)のうち tracks に含まれる艇だけ。走種は比較区間の走種に固定(走種をまたがない)。
// - 各艇の VMG は boatVmgSamples(track, ws, {validIntervals}) のうち、断片内の時刻 [lo, hi) で走種が一致する
//   サンプルだけから再計算する。サンプル数が minSamples 未満の艇はその断片に参加しない。
// - 参加艇が minBoats 未満の断片は勝者なしとし、どの艇の参加時間にも数えない。
// - 隣接する同一(トラック,走種)の断片は1区間に結合する。
// - 高さ調整局面は assessComparison が比較区間から差し引き済みのため、ここでは再適用しない
//   (全点で再検出すると、除外した GPS 点の影響を再び受けるため)。
// opts:
//   comparable: 比較区間 [{lo, hi, pointOfSail, tracks}]。未指定・空なら勝者なし(安全側の既定)
//   validIntervalsByTrack: Map<track, [[lo, hi]]>(assessComparison().validIntervalsByTrack)。
//     Map にない艇、または未指定のときはサンプルなし扱い(=勝者なし。除外した点を VMG に混ぜない安全側の既定)
//   legacyCrossPointOfSail: true なら旧挙動(走種をまたいだバケット単位の比較)。このとき participation は null
//   minBoats(2) / minSamples(3) / bucketMs(30秒) と boatVmgSamples のオプション
// 返り値: {winners: [{track, boatId, color, lo, hi, pointOfSail, vmg}],
//          participation: Map<track, {upwind, downwind}>(勝者が決まった断片に参加した時間 ms)}
export function minuteWinnersDetailed(tracks, windSeriesByTrack, opts = {}) {
  const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
  if (opts.legacyCrossPointOfSail === true) {
    return { winners: legacyMinuteWinners(list, windSeriesByTrack, opts), participation: null };
  }
  const minBoats = opts.minBoats ?? 2;
  const minSamples = opts.minSamples ?? 3;
  const bucketMs = opts.bucketMs ?? BUCKET_MS;
  const participation = new Map(list.map((t) => [t, { upwind: 0, downwind: 0 }]));
  const comparable = Array.isArray(opts.comparable) ? opts.comparable : [];
  if (comparable.length === 0) return { winners: [], participation };

  const vib = opts.validIntervalsByTrack;
  const hasVib = vib && typeof vib.get === 'function';
  const sampleCache = new Map();
  const samplesOf = (track) => {
    if (sampleCache.has(track)) return sampleCache.get(track);
    const ws = (windSeriesByTrack && typeof windSeriesByTrack.get === 'function' ? windSeriesByTrack.get(track) : null) || [];
    let s = [];
    if (ws.length) {
      // 有効区間が分からない艇はサンプルなし(全点から作ると除外した点の COG・速度が混ざるため)
      if (hasVib && Array.isArray(vib.get(track))) s = boatVmgSamples(track, ws, { ...opts, validIntervals: vib.get(track) });
    }
    sampleCache.set(track, s);
    return s;
  };

  const frags = { upwind: [], downwind: [] }; // {lo, hi, track, vmg}
  for (const seg of comparable) {
    const pos = seg?.pointOfSail;
    if ((pos !== 'upwind' && pos !== 'downwind') || !(seg.hi > seg.lo)) continue;
    const members = (Array.isArray(seg.tracks) ? seg.tracks : []).filter((t) => participation.has(t));
    if (members.length < minBoats) continue;
    for (let b = Math.floor(seg.lo / bucketMs); b * bucketMs < seg.hi; b++) {
      const lo = Math.max(seg.lo, b * bucketMs), hi = Math.min(seg.hi, (b + 1) * bucketMs);
      if (!(hi > lo)) continue;
      const entries = [];
      for (const track of members) {
        const ss = samplesOf(track);
        let sum = 0, n = 0;
        for (let i = lowerBoundT(ss, lo); i < ss.length && ss[i].t < hi; i++) {
          if (ss[i].pointOfSail !== pos) continue;
          sum += ss[i].vmg; n++;
        }
        if (n >= minSamples) entries.push({ track, vmg: sum / n });
      }
      if (entries.length < minBoats) continue; // 勝者なし・参加時間にも数えない
      const win = entries.reduce((a, e) => (e.vmg > a.vmg ? e : a));
      frags[pos].push({ lo, hi, track: win.track, vmg: win.vmg });
      for (const e of entries) participation.get(e.track)[pos] += hi - lo;
    }
  }

  // 走種ごとに、隣接する同一トラックの断片を結合
  const winners = [];
  for (const pos of ['upwind', 'downwind']) {
    const arr = frags[pos].sort((a, b) => a.lo - b.lo);
    let last = null;
    for (const f of arr) {
      if (last && last.track === f.track && last.hi === f.lo) {
        last.hi = f.hi;
        last.vmg = Math.max(last.vmg, f.vmg);
        continue;
      }
      last = {
        track: f.track, boatId: f.track.id, color: f.track.color || '#888',
        lo: f.lo, hi: f.hi, pointOfSail: pos, vmg: f.vmg,
      };
      winners.push(last);
    }
  }
  winners.sort((a, b) => a.lo - b.lo || (a.pointOfSail === b.pointOfSail ? 0 : a.pointOfSail === 'upwind' ? -1 : 1));
  return { winners, participation };
}

// minuteWinnersDetailed の勝者だけを返す(戻り値の形は従来どおり)。
// opts.comparable(比較区間)を渡さなければ勝者なし。旧挙動は opts.legacyCrossPointOfSail: true のときのみ。
export function minuteWinners(tracks, windSeriesByTrack, opts = {}) {
  return minuteWinnersDetailed(tracks, windSeriesByTrack, opts).winners;
}
