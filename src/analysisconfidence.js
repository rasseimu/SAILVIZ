// src/analysisconfidence.js
// GPS から推定した分析結果(風軸・VMG 艇間比較)の信頼度を判定する純関数群。DOM/副作用なし。
// 信頼度は 'high' / 'medium' / 'low' / 'unavailable' の4段階で、必ず理由 {code, message} の配列を伴う。
// 艇間比較は次の条件をすべて満たす「実時刻の区間(ms)」だけで行う(Issue #30)。
//   1. 2艇以上の GPS 時刻が実際に重なっている(バケットに点があるかではなく、有効区間の積集合)
//   2. 同じ走種(boatMinuteVmg の upwind / downwind)
//   3. 推定風軸がある(系列が空でなく、時刻が系列端から windTolMs 以内)
//   4. GPS 精度が maxAccuracyM 以内(精度の記録がない点は「以内と確認できない」ので除外)
//   5. 連続する比較区間が minCompareMs 以上(未満の区間は比較区間から除外)
//   6. 異常速度(記録 speed 列・点間移動速度が maxSpeedMps 超)を除外済み
// 読込時に除いた点の時間帯(track.excludedIntervals。旧データは記録間隔の穴)も比較区間に含めない。
// 加えて高さ調整局面(detectHeightAdjustWindowsFromSamples。各艇の有効区間内サンプルで検出)は比較時間に含めない。
// 保存データは増やさず、呼び出しのたびにその場で計算する。
import { ACCURACY_FILTER_M, haversineMeters } from './gps.js';
import { boatMinuteVmg, cogSamplesByIntervals, subtractIntervals } from './vmgminute.js';
import { detectHeightAdjustWindowsFromSamples } from './vmg.js';

// 低い順。minLevel などの比較に使う。
export const CONFIDENCE_LEVELS = Object.freeze(['unavailable', 'low', 'medium', 'high']);

// 分析(比較)用の異常速度上限[m/s]。読込時の外れ値除去(gps.js MAX_SPEED_MPS=25)とは別に、
// 小型艇の比較では 15 m/s(約29ノット)超を異常値として扱う。
export const ANALYSIS_MAX_SPEED_MPS = 15;

// vmgminute.js の BUCKET_MS と同じ値。boatMinuteVmg へは bucketMs を明示して渡し、境界を一致させる。
const DEFAULT_BUCKET_MS = 30_000;

// 閾値はここ1か所にまとめる(後で調整できるように)。opts で個別に上書き可。
export const DEFAULT_CONFIDENCE_OPTS = Object.freeze({
  maxAccuracyM: ACCURACY_FILTER_M, // GPS 水平精度の上限[m]。分析時は読込時フィルタのオン/オフに関係なく常にこの値で判定
  maxSpeedMps: ANALYSIS_MAX_SPEED_MPS, // 異常速度の上限[m/s]
  maxGapMs: 5000, // 点間隔がこれを超えたら欠損(1Hz 記録で5点以上欠け)
  recordGapFactor: 1.5, // excludedIntervals のない旧データで、点間隔が中央値のこの倍を超えたら記録の穴(record-gap)
  windTolMs: 300_000, // 風軸系列の端からこの時間以内なら風軸あり(平滑化10分窓の半分)
  minCompareMs: 60_000, // 連続する比較区間ごとの最低長。これ未満の区間は比較から除外
  mediumCompareMs: 180_000, // 60秒以上180秒未満は low
  highCompareMs: 600_000, // 180秒以上600秒未満は medium、以上は high
  windLowMaxAnchors: 1, // 風軸アンカーがこの数以下なら low
  windMediumMaxAnchors: 3, // この数以下なら medium
  windMinCoverage: 0.5, // 風軸の被覆率がこれ未満なら medium
  minBoats: 2, // 比較に必要な艇数
});

const LEVEL_LABEL = { high: '高', medium: '中', low: '低' };

const rankOf = (level) => {
  const i = CONFIDENCE_LEVELS.indexOf(level);
  return i < 0 ? CONFIDENCE_LEVELS.length - 1 : i;
};

// 与えた信頼度のうち最も低いものを返す(null/undefined は無視。何もなければ 'high')。
export function minLevel(...levels) {
  let best = 'high';
  for (const lv of levels.flat()) {
    if (lv == null) continue;
    if (rankOf(lv) < rankOf(best)) best = lv;
  }
  return best;
}

// 比較可能時間[ms]から時間面の信頼度を返す。
export function levelForComparableMs(ms, opts = {}) {
  const o = { ...DEFAULT_CONFIDENCE_OPTS, ...opts };
  const v = Number.isFinite(ms) ? ms : 0;
  if (v < o.minCompareMs) return 'unavailable';
  if (v < o.mediumCompareMs) return 'low';
  if (v < o.highCompareMs) return 'medium';
  return 'high';
}

// 内部用の理由。cap はその理由が課す信頼度の上限(情報のみの理由は 'high')。
const reason = (code, message, cap = 'high') => ({ code, message, cap });

// cap の低い順(同順位は追加順)に並べ、公開形 {code, message} にする。
// reasons[0] が信頼度を決めた主な理由になる(formatConfidenceLabel が使う)。
function finalizeReasons(list) {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rankOf(a.r.cap) - rankOf(b.r.cap) || a.i - b.i)
    .map(({ r }) => ({ code: r.code, message: r.message }));
}

const pointsOf = (track) => (Array.isArray(track?.points) ? track.points : []);
const sumMs = (ivs) => ivs.reduce((a, iv) => a + (iv[1] - iv[0]), 0);
const secText = (ms) => `${Math.floor(ms / 1000)}秒`;

// トラックの記録時刻範囲。tRange がなければ points の先頭・末尾から求める。なければ null。
function timeRangeOf(track) {
  const r = track?.tRange;
  if (r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start) {
    return { start: r.start, end: r.end };
  }
  const pts = pointsOf(track);
  if (pts.length === 0) return null;
  const a = pts[0]?.t, b = pts[pts.length - 1]?.t;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return { start: a, end: b };
}

const trackName = (track) => String(track?.name ?? track?.id ?? '不明な艇');

// 区間列 [[lo, hi], ...] 同士の積集合(長さ0の断片は含めない)。入力の順序は問わない。
// 前提: 各入力リスト内の区間は互いに重ならない(validIntervals・sweepCoverage の出力はこれを満たす)。
// リスト内で区間が重なっていると、結果に重複した区間が含まれうる。
export function intersectIntervals(a, b) {
  const norm = (list) => (Array.isArray(list) ? list : [])
    .filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
    .slice()
    .sort((x, y) => x[0] - y[0]);
  const A = norm(a), B = norm(b);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const lo = Math.max(A[i][0], B[j][0]);
    const hi = Math.min(A[i][1], B[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (A[i][1] < B[j][1]) i++; else j++;
  }
  return out;
}

// 区間列の和集合の長さ[ms]。
function unionMs(ivs) {
  const s = ivs.filter((iv) => iv[1] > iv[0]).slice().sort((x, y) => x[0] - y[0]);
  let total = 0, curLo = null, curHi = null;
  for (const [lo, hi] of s) {
    if (curHi == null || lo > curHi) {
      if (curHi != null) total += curHi - curLo;
      curLo = lo; curHi = hi;
    } else if (hi > curHi) curHi = hi;
  }
  if (curHi != null) total += curHi - curLo;
  return total;
}

// entries [{track, lo, hi}] について、minBoats 艇以上が同時に入っている時間を求める。
// 参加艇の集合が同じで隣接する(hi === 次の lo)区間は結合し、集合が変わればそこで区間を切る。
// order は艇の並び順(返す tracks の順序と集合の同一判定に使う)。
// 返り値: [{lo, hi, tracks: [track]}](lo 昇順)
function sweepCoverage(entries, minBoats, order) {
  const idx = new Map(order.map((t, i) => [t, i]));
  const ev = [];
  for (const e of entries) {
    if (!(e.hi > e.lo)) continue;
    ev.push([e.lo, 1, e.track]);
    ev.push([e.hi, -1, e.track]);
  }
  ev.sort((a, b) => a[0] - b[0]);
  const count = new Map();
  const out = [];
  let prevT = null, i = 0;
  while (i < ev.length) {
    const t = ev[i][0];
    if (prevT != null && t > prevT) {
      const active = [...count.keys()].sort((x, y) => idx.get(x) - idx.get(y));
      if (active.length >= minBoats) {
        const key = active.map((x) => idx.get(x)).join(',');
        const last = out[out.length - 1];
        if (last && last.hi === prevT && last._key === key) last.hi = t;
        else out.push({ lo: prevT, hi: t, tracks: active, _key: key });
      }
    }
    while (i < ev.length && ev[i][0] === t) {
      const [, d, tr] = ev[i];
      const c = (count.get(tr) ?? 0) + d;
      if (c > 0) count.set(tr, c); else count.delete(tr);
      i++;
    }
    prevT = t;
  }
  return out.map(({ _key, ...s }) => s);
}

// 風軸信頼度の内部版(理由に cap 付き)。
function assessWindAxisRaw(series, track, opts = {}) {
  const o = { ...DEFAULT_CONFIDENCE_OPTS, ...opts };
  const s = Array.isArray(series) ? series.filter((x) => x && Number.isFinite(x.tMs)) : [];
  if (s.length === 0) {
    return {
      level: 'unavailable',
      reasons: [reason('no-wind-axis', '推定の根拠となるタック/ジャイブが見つかりません', 'unavailable')],
      anchors: 0, manual: false, source: null, coverage: null,
    };
  }
  const manualCount = s.filter((x) => x.source === 'manual').length;
  const anchors = s.length - manualCount;
  const source = manualCount === 0 ? 'estimated' : anchors === 0 ? 'manual' : 'mixed';
  const reasons = [];
  let level = 'high';

  if (anchors === 0) {
    level = 'medium'; // 手動設定のみ(下で理由を付ける)
  } else if (anchors <= o.windLowMaxAnchors) {
    level = 'low';
    reasons.push(reason('wind-few-anchors', `推定の根拠となるタック/ジャイブが${anchors}回と少ないため参考値`, 'low'));
  } else if (anchors <= o.windMediumMaxAnchors) {
    level = 'medium';
    reasons.push(reason('wind-few-anchors', `推定の根拠となるタック/ジャイブが${anchors}回と少ないため参考値`, 'medium'));
  } else if (anchors > 0) {
    // 肯定的な理由(cap 'high' なので並べ替えで後ろに回り、中・低の主な理由は変わらない)
    reasons.push(reason('wind-anchors', `タック/ジャイブ${anchors}回から推定`));
  }

  // 被覆率: 記録時刻範囲のうち、系列端から windTolMs 以内に入る割合(比較の時刻判定と同じ基準)。
  let coverage = null;
  const range = timeRangeOf(track);
  if (range && range.end > range.start) {
    let sMin = Infinity, sMax = -Infinity;
    for (const x of s) { sMin = Math.min(sMin, x.tMs); sMax = Math.max(sMax, x.tMs); }
    const lo = Math.max(range.start, sMin - o.windTolMs);
    const hi = Math.min(range.end, sMax + o.windTolMs);
    coverage = Math.max(0, hi - lo) / (range.end - range.start);
    if (coverage < o.windMinCoverage) {
      level = minLevel(level, 'medium');
      const pct = Math.floor(coverage * 1000) / 10;
      reasons.push(reason('wind-low-coverage', `推定が記録時間の${pct}%しか覆っていないため参考値`, 'medium'));
    } else {
      reasons.push(reason('wind-coverage', `記録時間の${Math.floor(coverage * 1000) / 10}%を覆う`));
    }
  }

  if (manualCount > 0) {
    // 手動固定は利用者の指定で GPS 推定ではないが、実測値でもないため最高 medium。
    level = minLevel(level, 'medium');
    reasons.push(reason('manual', '手動設定', 'medium'));
  }
  return { level, reasons, anchors, manual: manualCount > 0, source, coverage };
}

// 風軸系列の信頼度。series は estimateWindAxisSeries / applyWindAxisOverrides の結果。
// track は被覆率の計算に使う(省略可。省略時・記録時間0のときは被覆率を判定しない)。
// 返り値: {level, reasons: [{code, message}], anchors, manual, source, coverage}
//   anchors = 手動設定以外の系列点数、manual = 手動設定を含むか、
//   source = 'estimated'(GPS推定のみ) | 'manual'(手動設定のみ) | 'mixed'(両方) | null(系列なし)、
//   coverage = 0..1 または null
export function assessWindAxis(series, track, opts = {}) {
  const raw = assessWindAxisRaw(series, track, opts);
  return { ...raw, reasons: finalizeReasons(raw.reasons) };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 隣り合う2点の小区間が無効な理由(有効なら null)。優先順は 欠損 → 位置不正 → 精度不明 → 精度超過 → 異常速度。
function subIntervalFailure(a, b, dt, o) {
  if (dt > o.maxGapMs) return 'gps-gap';
  if (!isNum(a.lat) || !isNum(a.lon) || !isNum(b.lat) || !isNum(b.lon)) return 'invalid-position';
  // 精度は0以上の数値だけを記録ありとみなす(負値は「精度不明」を表す機器があるため不明扱い)。
  if (!(isNum(a.accuracy) && a.accuracy >= 0) || !(isNum(b.accuracy) && b.accuracy >= 0)) return 'accuracy-unknown';
  if (a.accuracy > o.maxAccuracyM || b.accuracy > o.maxAccuracyM) return 'accuracy';
  if ((isNum(a.speed) && a.speed > o.maxSpeedMps) || (isNum(b.speed) && b.speed > o.maxSpeedMps)) return 'speed';
  if (haversineMeters(a, b) / (dt / 1000) > o.maxSpeedMps) return 'speed';
  return null;
}

// 正の点間隔の中央値[ms](正の間隔がなければ Infinity = 穴の判定をしない)。
function medianPositiveGap(pts) {
  const gaps = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dt = pts[i + 1].t - pts[i].t;
    if (dt > 0) gaps.push(dt);
  }
  if (gaps.length === 0) return Infinity;
  gaps.sort((a, b) => a - b);
  const m = gaps.length >> 1;
  return gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
}

// 艇ごとの有効区間と、除外した区間(理由コード付き)。
// 返り値: {intervals: [[lo, hi]], excluded: [{lo, hi, code}]}
function validIntervalsDetailed(track, windSeries, o) {
  const pts = pointsOf(track).filter((p) => p && isNum(p.t));
  const intervals = [], excluded = [];
  if (pts.length < 2) return { intervals, excluded };
  const ws = Array.isArray(windSeries) ? windSeries.filter((x) => x && isNum(x.tMs)) : [];
  if (ws.length === 0) {
    excluded.push({ lo: pts[0].t, hi: pts[pts.length - 1].t, code: 'no-wind-axis' });
    return { intervals, excluded };
  }
  let wLo = Infinity, wHi = -Infinity;
  for (const x of ws) { wLo = Math.min(wLo, x.tMs); wHi = Math.max(wHi, x.tMs); }
  wLo -= o.windTolMs;
  wHi += o.windTolMs;

  const keep = (lo, hi) => {
    const last = intervals[intervals.length - 1];
    if (last && last[1] === lo) last[1] = hi; else intervals.push([lo, hi]);
  };
  const drop = (lo, hi, code) => {
    if (!(hi > lo)) return;
    const last = excluded[excluded.length - 1];
    if (last && last.hi === lo && last.code === code) last.hi = hi; else excluded.push({ lo, hi, code });
  };

  // 読込時に点を除いた時間帯(track.excludedIntervals)。項目のない旧データは、除いた点の跡を
  // 記録間隔の穴として扱う: 正の点間隔の中央値の recordGapFactor 倍を超える小区間を record-gap で除外する。
  const recorded = Array.isArray(track?.excludedIntervals)
    ? track.excludedIntervals.filter((e) => e && isNum(e.lo) && isNum(e.hi) && e.hi > e.lo)
    : null;
  const gapLimit = recorded ? Infinity : o.recordGapFactor * medianPositiveGap(pts);

  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dt = b.t - a.t;
    if (!(dt > 0)) continue; // 同時刻・逆順は区間を作らない
    const code = subIntervalFailure(a, b, dt, o) ?? (dt > gapLimit ? 'record-gap' : null);
    if (code) { drop(a.t, b.t, code); continue; }
    // B3方針: wind-out-of-range は「明らかな異常」でないため比較区間から除外しない。
    // 信頼度情報としてのみ記録する(excludedMs に加算しないよう _infoOnly フラグを付ける)。
    // 風向はクランプ値(windFromAt の端点クランプ)を使うため VMG 計算は動作する。
    keep(a.t, b.t);
    const roLo = Math.max(a.t, wLo), roHi = Math.min(b.t, wHi);
    if (roLo > a.t) excluded.push({ lo: a.t, hi: Math.min(roLo, b.t), code: 'wind-out-of-range', _infoOnly: true });
    if (roHi < b.t) excluded.push({ lo: Math.max(roHi, a.t), hi: b.t, code: 'wind-out-of-range', _infoOnly: true });
  }
  if (!recorded || recorded.length === 0) return { intervals, excluded };

  // 記録済みの除外区間を有効区間から差し引き、差し引いた部分をそのコードで excluded に記録する。
  for (const e of recorded) {
    for (const [lo, hi] of intersectIntervals(intervals, [[e.lo, e.hi]])) {
      excluded.push({ lo, hi, code: String(e.code) });
    }
  }
  const remaining = intervals.flatMap(([lo, hi]) => subtractIntervals(lo, hi, recorded));
  return { intervals: remaining, excluded };
}

// 艇ごとの有効区間 [[lo, hi], ...](t 昇順、隣接する有効小区間は結合済み)。
// 隣り合う2点 [p_i.t, p_{i+1}.t] が次をすべて満たすときだけ有効とする。
//   - 点間隔が maxGapMs 以下
//   - 両端の点の accuracy が数値かつ maxAccuracyM 以下(null・列なしは除外)
//   - 両端の点の speed(あれば)と点間移動速度が maxSpeedMps 以下
//   - 風軸系列が空でなく、時刻が系列端から windTolMs 以内(範囲外の部分は切り落とす)
//   - track.excludedIntervals(読込時に点を除いた時間帯)に入らない。項目のない旧データは、
//     点間隔が正の点間隔の中央値の recordGapFactor 倍以下(超えた小区間は除いた点の跡とみなす)
// boatMinuteVmg の opts.validIntervals にそのまま渡せる。
export function validIntervals(track, windSeries, opts = {}) {
  const o = { ...DEFAULT_CONFIDENCE_OPTS, ...opts };
  return validIntervalsDetailed(track, windSeries, o).intervals;
}

// 除外理由の文言。none=true は比較区間が0になった主な原因として出すとき。
const EXCLUSION_MESSAGES = {
  'gps-gap': (o, none) => (none
    ? `GPS の記録が${o.maxGapMs / 1000}秒を超えて途切れていて、比較できる時間が重なりません`
    : `GPS の記録が${o.maxGapMs / 1000}秒を超えて途切れた時間帯を除外しました`),
  'invalid-position': (o, none) => (none
    ? '位置の記録が不正で比較できません'
    : '位置の記録が不正な時間帯を除外しました'),
  'accuracy-unknown': (o, none) => (none
    ? 'GPS 精度の記録がないため比較できません'
    : 'GPS 精度の記録がない時間帯を除外しました'),
  accuracy: (o, none) => (none
    ? `GPS 精度が${o.maxAccuracyM}mを超えていて比較できません`
    : `GPS 精度が${o.maxAccuracyM}mを超える時間帯を除外しました`),
  speed: (o, none) => (none
    ? `速度が${o.maxSpeedMps}m/sを超える異常値が多く比較できません`
    : `速度が${o.maxSpeedMps}m/sを超える異常値を含む時間帯を除外しました`),
  'record-gap': (o, none) => (none
    ? '記録間隔が普段より長い時間帯が多く、比較できる時間が重なりません'
    : '記録間隔が普段より長い時間帯(読込時に除外された点の可能性)を除外しました'),
  'wind-out-of-range': (o, none) => (none
    ? '風軸の推定範囲外のため比較できません'
    : '風軸の推定範囲から外れた時間帯を除外しました'),
};

// 艇間比較の信頼度と比較区間。
// tracks: 比較対象のトラック配列、windSeriesByTrack: Map<track, 風軸系列>(minuteWinners と同じ)
// opts: DEFAULT_CONFIDENCE_OPTS の上書きに加え、bucketMs / excludeHeightAdjust と
//       boatMinuteVmg・detectHeightAdjustWindowsFromSamples(有効区間内サンプルで検出)の各オプションを受け付ける。
// 返り値:
//   {level, reasons: [{code, message}], comparableMs, byPointOfSail: {upwind, downwind}, overlapMs,
//    segments: [{lo, hi, pointOfSail, tracks: [track]}],
//    perTrack: Map<track, {comparableMs, byPointOfSail: {upwind, downwind}, windAxis}>,
//    validIntervalsByTrack: Map<track, [[lo, hi]]>}
//   - overlapMs: 条件判定前の生の記録時刻の重なり(2艇以上)。「重なっていない」と「重なっているが条件不足」の区別用
//   - segments: 最低比較時間を満たした比較区間のみ(lo 昇順)。参加艇は tracks に入っている艇だけ
//   - comparableMs: segments の和集合の長さ。byPointOfSail は走種別の合計
//   - perTrack[track].byPointOfSail: その艇が参加している比較区間の走種別合計
//   - validIntervalsByTrack: 風軸のある艇ごとの有効区間(minuteWinnersDetailed の opts.validIntervalsByTrack に渡す)。
//     記録が重ならないなど早期に比較不能と判定したときは空の Map
export function assessComparison(tracks, windSeriesByTrack, opts = {}) {
  const o = { ...DEFAULT_CONFIDENCE_OPTS, ...opts };
  const bucketMs = opts.bucketMs ?? DEFAULT_BUCKET_MS;
  const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
  const wsOf = (t) => {
    const ws = windSeriesByTrack && typeof windSeriesByTrack.get === 'function' ? windSeriesByTrack.get(t) : null;
    // tMs が非数の要素は除く(全部非数なら風軸なし扱い)。
    return Array.isArray(ws) ? ws.filter((x) => x && Number.isFinite(x.tMs)) : [];
  };

  const perTrack = new Map();
  const windRaw = new Map();
  for (const t of list) {
    const w = assessWindAxisRaw(wsOf(t), t, o);
    windRaw.set(t, w);
    perTrack.set(t, {
      comparableMs: 0,
      byPointOfSail: { upwind: 0, downwind: 0 },
      windAxis: { ...w, reasons: finalizeReasons(w.reasons) },
    });
  }

  const unavailable = (reasons, overlapMs = 0) => ({
    level: 'unavailable',
    reasons: finalizeReasons(reasons),
    comparableMs: 0,
    byPointOfSail: { upwind: 0, downwind: 0 },
    overlapMs,
    segments: [],
    perTrack,
    validIntervalsByTrack: new Map(),
  });

  // 条件1(大域): 記録のある艇が minBoats 以上、かつ記録時刻が重なる
  const withData = list.filter((t) => pointsOf(t).length > 0 && timeRangeOf(t));
  if (withData.length < o.minBoats) {
    return unavailable([reason('need-two-boats', `比較には${o.minBoats}艇以上の記録が必要です`, 'unavailable')]);
  }
  const rawCover = sweepCoverage(
    withData.map((t) => { const r = timeRangeOf(t); return { track: t, lo: r.start, hi: r.end }; }),
    o.minBoats, withData,
  );
  const rawOverlapIvs = rawCover.map((c) => [c.lo, c.hi]);
  const overlapMs = sumMs(rawOverlapIvs);
  if (overlapMs <= 0) {
    const msg = withData.length === 2 ? '2艇の記録時刻が重なっていません' : '記録時刻が重なっている艇がありません';
    return unavailable([reason('no-overlap', msg, 'unavailable')], 0);
  }

  // 艇ごとの有効区間(条件 1・3・4・6)
  const reasons = [];
  const withWind = [];
  const noWind = [];
  const validByTrack = new Map();
  const excludedMs = new Map(); // code -> 生の重なり時間内で除外された ms
  const infoOnlyMs = new Map(); // _infoOnly な理由(wind-out-of-range 等) → 主理由選択に使わず信頼度情報として添える
  for (const t of withData) {
    const ws = wsOf(t);
    if (ws.length === 0) { noWind.push(t); continue; }
    withWind.push(t);
    const d = validIntervalsDetailed(t, ws, o);
    validByTrack.set(t, d.intervals);
    for (const e of d.excluded) {
      const ms = sumMs(intersectIntervals([[e.lo, e.hi]], rawOverlapIvs));
      if (ms <= 0) continue;
      if (e._infoOnly) {
        // wind-out-of-range 等の情報のみ理由: 主理由の選択には使わず、情報として reasons に添える
        infoOnlyMs.set(e.code, (infoOnlyMs.get(e.code) ?? 0) + ms);
      } else {
        excludedMs.set(e.code, (excludedMs.get(e.code) ?? 0) + ms);
      }
    }
  }

  // 走種の付与(条件2): 有効区間をバケット境界で分割し、有効サンプルだけで求めたバケットの走種を付ける。
  const frags = { upwind: [], downwind: [] };
  const anyFrags = [];
  for (const t of withWind) {
    const ivs = validByTrack.get(t);
    if (!ivs.length) continue;
    const mv = boatMinuteVmg(t, wsOf(t), { ...opts, bucketMs, validIntervals: ivs });
    for (const [lo, hi] of ivs) {
      for (let b = Math.floor(lo / bucketMs); b * bucketMs < hi; b++) {
        const a = Math.max(lo, b * bucketMs), c = Math.min(hi, (b + 1) * bucketMs);
        if (!(c > a)) continue;
        const rec = mv.get(b);
        if (!rec || (rec.pointOfSail !== 'upwind' && rec.pointOfSail !== 'downwind')) continue;
        const f = { track: t, lo: a, hi: c };
        frags[rec.pointOfSail].push(f);
        anyFrags.push(f);
      }
    }
  }

  // 高さ調整局面の除外。検出には各艇の有効区間内の COG サンプルだけを使う(除外点・区間外の点を混ぜない)。
  // 連結したサンプル列では cogAt の許容幅(2秒)により、区間の境目から最大約0.5秒外まで参加扱いになりうるが、
  // computeCog が切り出し両端の約1.5秒にサンプルを作らないため、比較区間を増やす方向には働かない。
  const exclude = opts.excludeHeightAdjust === false || withWind.length < o.minBoats
    ? [] : detectHeightAdjustWindowsFromSamples(withWind.map((t) => ({
      samples: cogSamplesByIntervals(pointsOf(t), validByTrack.get(t), opts.cogOpts ?? {}).flat(),
      windSeries: wsOf(t),
    })), opts);
  const cut = (entries) => entries.flatMap((e) => subtractIntervals(e.lo, e.hi, exclude).map(([a, b]) => ({ ...e, lo: a, hi: b })));

  // 艇間の積集合(条件1・2): 走種ごとに、同じ走種の断片が2艇以上で実際に交差する時間
  const POS = ['upwind', 'downwind'];
  const pre = {}, post = {};
  for (const pos of POS) {
    pre[pos] = sweepCoverage(frags[pos], o.minBoats, withWind);
    post[pos] = sweepCoverage(cut(frags[pos]), o.minBoats, withWind);
  }

  // 最低比較時間(条件5): 走種・参加艇集合が同じ隣接区間は結合済み。未満の区間は除外。
  const segments = [];
  const tooShort = [];
  for (const pos of POS) {
    for (const c of post[pos]) {
      const s = { lo: c.lo, hi: c.hi, pointOfSail: pos, tracks: c.tracks };
      (c.hi - c.lo >= o.minCompareMs ? segments : tooShort).push(s);
    }
  }
  segments.sort((a, b) => a.lo - b.lo || POS.indexOf(a.pointOfSail) - POS.indexOf(b.pointOfSail));

  const byPointOfSail = { upwind: 0, downwind: 0 };
  for (const s of segments) {
    const len = s.hi - s.lo;
    byPointOfSail[s.pointOfSail] += len;
    for (const t of s.tracks) {
      const pt = perTrack.get(t);
      pt.comparableMs += len;
      pt.byPointOfSail[s.pointOfSail] += len;
    }
  }
  const comparableMs = unionMs(segments.map((s) => [s.lo, s.hi]));

  // 各段階で残った時間(比較区間が0になったときの主な原因の特定に使う)
  const validOverlapMs = sumMs(sweepCoverage(
    withWind.flatMap((t) => validByTrack.get(t).map(([lo, hi]) => ({ track: t, lo, hi }))),
    o.minBoats, withWind,
  ).map((c) => [c.lo, c.hi]));
  const anyPosMs = sumMs(sweepCoverage(anyFrags, o.minBoats, withWind).map((c) => [c.lo, c.hi]));
  const samePosPreMs = unionMs(POS.flatMap((p) => pre[p].map((c) => [c.lo, c.hi])));
  const samePosPostMs = unionMs(POS.flatMap((p) => post[p].map((c) => [c.lo, c.hi])));
  // 高さ調整局面を差し引く前に、最低比較時間を満たす区間があったか
  const preQualified = POS.some((p) => pre[p].some((c) => c.hi - c.lo >= o.minCompareMs));

  const none = segments.length === 0;
  let primary = null;
  if (none) {
    if (withWind.length < o.minBoats) {
      const names = noWind.map(trackName).join('・');
      primary = reason('no-wind-axis', `${names}の風軸を推定できないため比較できません`, 'unavailable');
    } else if (validOverlapMs <= 0) {
      const top = [...excludedMs.entries()].sort((a, b) => b[1] - a[1])[0];
      primary = top && EXCLUSION_MESSAGES[top[0]]
        ? reason(top[0], EXCLUSION_MESSAGES[top[0]](o, true), 'unavailable')
        : reason('no-overlap', '条件を満たす記録時刻が重なっていません', 'unavailable');
    } else if (anyPosMs <= 0) {
      primary = reason('no-point-of-sail', '風上・風下を走っている時間が重なっていません', 'unavailable');
    } else if (samePosPreMs <= 0) {
      primary = reason('no-same-point-of-sail', '同じ走種で重なっている時間がありません', 'unavailable');
    } else if (samePosPostMs <= 0) {
      // 同じ走種の重なりが高さ調整局面ですべて消えた
      primary = reason('height-adjust', '高さ調整の局面を除くと比較できる時間がありません', 'unavailable');
    } else if (preQualified) {
      // 高さ調整局面を差し引く前は最低比較時間を満たしていた
      primary = reason('height-adjust',
        `高さ調整の局面を除くと、連続して比較できる時間が最低${secText(o.minCompareMs)}に届きません`, 'unavailable');
    } else {
      // ここに来るのは samePosPostMs > 0 かつ segments 空のときだけなので、tooShort は1件以上ある。
      const longest = Math.max(0, ...tooShort.map((s) => s.hi - s.lo));
      const longestText = longest < 1000 ? '1秒未満' : secText(longest);
      primary = reason('too-short',
        `連続して比較できる時間が最長${longestText}で、最低${secText(o.minCompareMs)}に届きません`, 'unavailable');
    }
    reasons.push(primary);
  }

  // 時間面の信頼度(条件5)
  const timeLevel = none ? 'unavailable' : levelForComparableMs(comparableMs, o);
  if (!none && timeLevel !== 'high') {
    reasons.push(reason('short-compare', '比較可能時間が短いため参考値', timeLevel));
  }
  if (!none) {
    // 肯定的な理由(信頼度が高でも判定の根拠を示す。cap 'high' なので主な理由にはならない)
    reasons.push(reason('compare-time',
      `連続して比較できる区間${segments.length}件・合計${secText(comparableMs)}（最低${secText(o.minCompareMs)}以上）`));
  }

  // 風軸面の信頼度(比較に参加した艇のみ)
  const levels = [timeLevel];
  for (const t of withWind) {
    if (perTrack.get(t).comparableMs <= 0) continue;
    const w = windRaw.get(t);
    levels.push(w.level);
    for (const r of w.reasons) {
      const msg = r.code === 'manual' ? `${trackName(t)}の風軸は手動設定` : `${trackName(t)}の風軸は${r.message}`;
      reasons.push(reason(r.code, msg, r.cap));
    }
  }

  // 情報としての除外理由(主な原因と同じコードは重ねない)
  const primaryCode = primary?.code;
  if (primaryCode !== 'no-wind-axis') {
    for (const t of noWind) {
      reasons.push(reason('no-wind-axis', `${trackName(t)}の風軸を推定できないため比較から除外しました`));
    }
  }
  for (const [code, fmt] of Object.entries(EXCLUSION_MESSAGES)) {
    const hasExcluded = excludedMs.get(code) > 0 || infoOnlyMs.get(code) > 0;
    if (code !== primaryCode && hasExcluded) reasons.push(reason(code, fmt(o, false)));
  }
  if (primaryCode !== 'no-same-point-of-sail' && anyPosMs > samePosPreMs) {
    reasons.push(reason('no-same-point-of-sail', '走種が異なる時間帯は比較から除外しました'));
  }
  if (primaryCode !== 'height-adjust' && samePosPreMs > samePosPostMs) {
    reasons.push(reason('height-adjust', '高さ調整の局面を比較から除外しました'));
  }
  if (primaryCode !== 'too-short' && tooShort.length > 0) {
    reasons.push(reason('too-short', `連続${secText(o.minCompareMs)}未満の比較区間を除外しました`));
  }

  return {
    level: minLevel(levels),
    reasons: finalizeReasons(reasons),
    comparableMs,
    byPointOfSail,
    overlapMs,
    segments,
    perTrack,
    validIntervalsByTrack: validByTrack,
  };
}

// 信頼度の表示文言。例: 「信頼度 高」「信頼度 中：比較可能時間が短いため参考値」
// 「比較不能：2艇の記録時刻が重なっていません」。reasons[0] を主な理由として使う。
// opts.unavailableLabel で unavailable 時の見出しを変えられる(風軸なら '推定不可' など)。
export function formatConfidenceLabel(result, opts = {}) {
  if (!result || !result.level) return '';
  const unavailableLabel = opts.unavailableLabel ?? '比較不能';
  const primary = Array.isArray(result.reasons) ? result.reasons[0] : null;
  if (result.level === 'unavailable') {
    return primary ? `${unavailableLabel}：${primary.message}` : unavailableLabel;
  }
  const head = `信頼度 ${LEVEL_LABEL[result.level] ?? result.level}`;
  if (result.level === 'high' || !primary) return head;
  return `${head}：${primary.message}`;
}

// 各艇の風軸の判定理由(凡例の一覧表示用)。比較に参加していない艇も含め、tracks の順に返す。
// assessComparison().reasons には比較に参加した艇の風軸理由しか入らないため、全艇分はこちらで組み立てる。
// perTrack: assessComparison().perTrack(なければ全艇を推定不可として扱う)
// 返り値: [{track, level, head, reasons: [message], participating}]
//   head = 「信頼度 高」など(推定不可は「風軸推定不可」)、participating = 比較区間に参加したか
export function windAxisReasonRows(tracks, perTrack) {
  const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
  return list.map((t) => {
    const p = perTrack && typeof perTrack.get === 'function' ? perTrack.get(t) : null;
    const w = p?.windAxis;
    const level = w?.level ?? 'unavailable';
    return {
      track: t,
      level,
      head: level === 'unavailable' ? '風軸推定不可' : `信頼度 ${LEVEL_LABEL[level] ?? level}`,
      reasons: Array.isArray(w?.reasons) ? w.reasons.map((r) => r.message) : [],
      participating: (p?.comparableMs ?? 0) > 0,
    };
  });
}
