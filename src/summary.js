// 練習(保存JSON)から、ホームのカード表示用の軽量サマリを作る純関数。
// 大きな points 配列には触れず、件数と代表値だけ拾う(localStorage にキャッシュ可能)。
import { projectLabel } from './projectfs.js';

// 風 {dir,speed} を短い1行に。無ければ null。
function windText(w) {
  if (!w) return null;
  const dir = w.dir || '';
  const speed = w.speed != null ? `${w.speed}m/s` : '';
  const s = `${dir} ${speed}`.trim();
  return s || null;
}

// 練習の「最古の実データ時刻」(絶対ms)。トラックのGPS開始と動画の配置時刻の両方を見る。
// 保存日ではなく“いつ練習したか”を表すため。トラックが無く動画だけでも動画時刻を使う。無ければ null。
function earliestContentMs(project) {
  let min = null;
  const consider = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && (min == null || v < min)) min = v;
  };
  if (Array.isArray(project.tracks)) for (const t of project.tracks) consider(t?.tRange?.start);
  if (Array.isArray(project.videos)) for (const v of project.videos) consider(v?.t);
  return min;
}

// 絶対ms → "YYYY-MM-DD HH:MM"(JST固定)。GPS時刻はUTC epoch なので日本時間で表示する。
function formatTrackingLabel(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

// project: readProject が返す保存JSON(またはそれ相当)。name: ファイル名(フォールバック用)。
export function practiceSummary(project, { name } = {}) {
  const p = project || {};
  const reflections = Array.isArray(p.reflections) ? p.reflections : [];
  const firstWind = reflections.find((r) => r && r.wind)?.wind ?? null;
  const trackedAt = earliestContentMs(p);
  return {
    name: name ?? null,
    // 表示日時は練習の実データ時刻を優先。無ければファイル名/savedAt にフォールバック。
    label: trackedAt != null ? formatTrackingLabel(trackedAt)
      : (name ? projectLabel(name) : (p.savedAt ?? '')),
    trackedAt: trackedAt ?? null,
    savedAt: p.savedAt ?? null,
    trackCount: Array.isArray(p.tracks) ? p.tracks.length : 0,
    reflectionCount: reflections.length,
    videoCount: Array.isArray(p.videos) ? p.videos.length : 0,
    eventCount: Array.isArray(p.events) ? p.events.length : 0,
    wind: windText(firstWind),
  };
}
