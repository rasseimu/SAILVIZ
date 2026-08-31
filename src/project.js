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
  };
}
