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

// project: readProject が返す保存JSON(またはそれ相当)。name: ファイル名(ラベル生成用)。
export function practiceSummary(project, { name } = {}) {
  const p = project || {};
  const reflections = Array.isArray(p.reflections) ? p.reflections : [];
  const firstWind = reflections.find((r) => r && r.wind)?.wind ?? null;
  return {
    name: name ?? null,
    label: name ? projectLabel(name) : (p.savedAt ?? ''),
    savedAt: p.savedAt ?? null,
    trackCount: Array.isArray(p.tracks) ? p.tracks.length : 0,
    reflectionCount: reflections.length,
    videoCount: Array.isArray(p.videos) ? p.videos.length : 0,
    eventCount: Array.isArray(p.events) ? p.events.length : 0,
    wind: windText(firstWind),
  };
}
