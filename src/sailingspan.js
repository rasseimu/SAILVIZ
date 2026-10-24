// src/sailingspan.js
// 練習の最初と最後(出艇前・着艇後)を除いた「帆走中」の時間帯を求める純関数群。DOM 非依存(node:test で検証する)。
// 記録の始めと終わりは陸上・ハーバーで止まっていることが多く、GPS が測位し始めた直後や電波の悪い所では
// 精度が落ちて、ありえない速度(10kt 超など)や乱れた進路が出る。帆走を始めてから終えるまでだけを速度・タック判定に使う。

const MPS_TO_KT = 1.943844;

export const SAILING_SPAN_DEFAULTS = Object.freeze({
  minKt: 2, // これ以上で動いている点を「帆走している点」とする
  maxAccM: 20, // 精度がこれより悪い点は数えない(測位直後の飛びを帆走と見誤らない)
  halfMs: 60000, // 前後60秒(2分)の窓で、帆走している点が半分以上なら帆走中
});

// 帆走中の時間帯 {start, end}(絶対 epoch ms)。最初に帆走中になった点〜最後に帆走中だった点。
// 一度も帆走中にならない(微風で 2kt に届かない等)なら null(このときは何も除かない)。
// speeds は points と同じ並びの点ごとの速度(m/s)。
export function sailingSpan(points, speeds, opts = {}) {
  const o = { ...SAILING_SPAN_DEFAULTS, ...opts };
  const n = (points || []).length;
  if (!n) return null;
  const pre = [0];
  for (let i = 0; i < n; i++) {
    const v = speeds[i], acc = points[i].accuracy;
    pre.push(pre[i] + (v != null && v * MPS_TO_KT >= o.minKt && !(acc > o.maxAccM) ? 1 : 0));
  }
  let lo = 0, hi = 0, first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    const t = points[i].t;
    while (points[lo].t < t - o.halfMs) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && points[hi + 1].t <= t + o.halfMs) hi++;
    if ((pre[hi + 1] - pre[lo]) * 2 >= hi - lo + 1) { if (first < 0) first = i; last = i; }
  }
  return first < 0 ? null : { start: points[first].t, end: points[last].t };
}

// points 配列ごとにキャッシュ(トラックの点列は差し替えで更新され、中身は変更されない)。
// speedsOf は初回だけ呼ぶ点ごとの速度(m/s)の計算(speedchart.js の sailingSpanOf が座標±5秒を渡す)。
const cache = new WeakMap();
export function cachedSailingSpan(points, speedsOf) {
  if (!Array.isArray(points)) return null;
  if (!cache.has(points)) cache.set(points, sailingSpan(points, speedsOf(points)));
  return cache.get(points);
}

// 時刻 t が帆走中の時間帯の外か(span が null なら何も除かない)。
export function outsideSpan(t, span) {
  return span != null && (t < span.start || t > span.end);
}
