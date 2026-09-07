// state ⇄ 保存オブジェクトの直列化。DOM/ブラウザ API 非依存。
// 除外: state.transform(投影関数を含む) と video.url(一時 blob URL)。
export const PROJECT_VERSION = 1;

export function serializeProject(state, { savedAt } = {}) {
  return {
    version: PROJECT_VERSION,
    savedAt: savedAt ?? null,
    mode: state.mode,
    accuracyFilter: state.accuracyFilter,
    crop: { start: state.crop.start, end: state.crop.end },
    tracks: state.tracks.map((t) => ({
      id: t.id, name: t.name, color: t.color, visible: t.visible,
      points: t.points, bounds: t.bounds, tRange: t.tRange,
      windAxisOverrides: Array.isArray(t.windAxisOverrides) ? t.windAxisOverrides : [],
    })),
    events: state.events.map((e) => ({ ...e })),
    marks: state.marks.map((m) => ({ ...m })),
    pins: [...state.pins],
    videos: state.videos.map((v) => ({
      id: v.id, t: v.t, name: v.name, durationMs: v.durationMs ?? null,
    })),
    reflections: state.reflections.map((r) => ({ ...r })),
    practiceDate: typeof state.practiceDate === 'number' ? state.practiceDate : null,
    // 背景地図(初回CSV取込時に1枚合成した地理院タイル)。dataURL/被覆bounds/ズームのみ保存。
    basemap: serializeBasemap(state.basemap),
  };
}

// 実行時フィールド(img 等)は落とし、保存対象の image/bounds/z/seaColor のみ残す。
function serializeBasemap(bm) {
  if (!bm || typeof bm.image !== 'string' || !bm.bounds) return null;
  const b = bm.bounds;
  return {
    image: bm.image,
    bounds: { minLat: b.minLat, maxLat: b.maxLat, minLon: b.minLon, maxLon: b.maxLon },
    z: typeof bm.z === 'number' ? bm.z : null,
    seaColor: typeof bm.seaColor === 'string' ? bm.seaColor : null,
  };
}

export function deserializeProject(obj) {
  if (!obj || obj.version !== PROJECT_VERSION) {
    throw new Error(`未対応の保存形式です (version=${obj?.version})`);
  }
  const arr = (x) => (Array.isArray(x) ? x : []);
  const crop = obj.crop && typeof obj.crop.start === 'number'
    ? { start: obj.crop.start, end: obj.crop.end }
    : { start: 0, end: 0 };
  return {
    mode: obj.mode === 'elapsed' ? 'elapsed' : 'absolute',
    accuracyFilter: obj.accuracyFilter !== false,
    crop,
    tracks: arr(obj.tracks).map((t) => ({
      ...t,
      windAxisOverrides: arr(t && t.windAxisOverrides),
    })),
    events: arr(obj.events),
    marks: arr(obj.marks),
    pins: arr(obj.pins),
    videos: arr(obj.videos).map((v) => ({
      id: v.id, t: v.t, name: v.name, durationMs: v.durationMs ?? null,
    })),
    reflections: arr(obj.reflections),
    practiceDate: typeof obj.practiceDate === 'number' ? obj.practiceDate : null,
    basemap: deserializeBasemap(obj.basemap),
  };
}

function deserializeBasemap(bm) {
  if (!bm || typeof bm.image !== 'string' || !bm.bounds) return null;
  const b = bm.bounds;
  const ok = ['minLat', 'maxLat', 'minLon', 'maxLon'].every((k) => typeof b[k] === 'number');
  if (!ok) return null;
  return {
    image: bm.image,
    bounds: { minLat: b.minLat, maxLat: b.maxLat, minLon: b.minLon, maxLon: b.maxLon },
    z: typeof bm.z === 'number' ? bm.z : null,
    seaColor: typeof bm.seaColor === 'string' ? bm.seaColor : null,
  };
}
