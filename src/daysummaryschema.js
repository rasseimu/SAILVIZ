// src/daysummaryschema.js
// 今日の練習サマリ(daySummary)の保存形式の定義。計算(daysummary.js)・保存(project.js)・一覧(summary.js)が共有する。
// 保存形式のバージョン。フィールドの意味を変えたら上げる(古い版は読込時に null → 黙って再計算)。
export const DAY_SUMMARY_VERSION = 1;

// 算出不能の理由コード。表示側(daysummaryview.js の REASON_TEXT)と一致させる。
export const DAY_SUMMARY_REASONS = [
  'tacks-insufficient', 'gps-poor', 'no-overlap', 'wind-unavailable', 'not-moving',
];
const QUALITY_LEVELS = ['good', 'caution', 'poor'];

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isNumOrNull = (x) => x === null || isNum(x);
const isStr = (x) => typeof x === 'string';
const isCount = (x) => Number.isInteger(x) && x >= 0;

// Est 型: ok:true なら value が valueOk を満たし、ok:false なら reason が既知のコード。
function isEst(e, valueOk) {
  if (!isObj(e)) return false;
  if (e.ok === true) return valueOk(e.value);
  if (e.ok === false) return DAY_SUMMARY_REASONS.includes(e.reason);
  return false;
}
const isBoatQuality = (q) => isObj(q) && QUALITY_LEVELS.includes(q.level) && isStr(q.note);
const isBoatRef = (v) => isObj(v) && isCount(v.index) && isStr(v.name) && isStr(v.color) && isNum(v.vmgMps);

function isOverall(o, boatCount) {
  return isObj(o)
    && isNumOrNull(o.startMs) && isNumOrNull(o.endMs) && isNumOrNull(o.durationMs)
    && o.boatCount === boatCount
    && isBoatQuality(o.quality)
    && (o.quality.boatIndex === null || (isCount(o.quality.boatIndex) && o.quality.boatIndex < boatCount))
    && isEst(o.windAxis, (v) => isObj(v) && isNum(v.deg) && v.deg >= 0 && v.deg < 360)
    && isEst(o.windRange, (v) => isObj(v) && isNum(v.minDeg) && isNum(v.maxDeg));
}

function isBoat(b) {
  return isObj(b) && isCount(b.index) && isStr(b.name) && isStr(b.color)
    && isNum(b.distanceM) && isNum(b.durationMs)
    && isEst(b.avgSpeedMps, isNum) && isEst(b.maxSpeedMps, isNum)
    && isEst(b.tacks, isCount) && isEst(b.gybes, isCount)
    && isBoatQuality(b.quality);
}

function isComparison(c) {
  return c === null || (isObj(c)
    && isEst(c.comparableMs, isNum)
    && isEst(c.bestUpwind, isBoatRef) && isEst(c.bestDownwind, isBoatRef));
}

// daySummary の形チェック。表示側(renderDaySummaryHtml)が触る全フィールドを見る。
// 壊れていれば読込・一覧の側で null に落とし、次に練習を開いたとき黙って再計算させる。
export function isDaySummaryShape(x) {
  return isObj(x) && x.version === DAY_SUMMARY_VERSION
    && isStr(x.sourceKey) && isNum(x.computedAt)
    && Array.isArray(x.boats) && x.boats.every(isBoat)
    && isOverall(x.overall, x.boats.length)
    && isComparison(x.comparison);
}
