// 練習の動画一覧(videos: [{ id, t, name, durationMs }])の突き合わせ。DOM 非依存(サーバーからも import する)。
// 練習内の動画は name + t(録画開始の絶対ms)の組で同一とみなす(iPhone の IMG_0001.MOV のように別人の動画と名前が重なるため)。
// id(vid0 等)は各画面のローカル連番。重なったときだけ振り直す(既存の項目の id は変えない)。

export const MAX_VIDEO_APPEND = 100;
const MAX_NAME = 255;
const MAX_ID = 64;
const VID_RE = /^vid(\d+)$/;

// 動画の同一判定キー。t は ms に丸める(保存・往復で小数がずれても同じ動画とみなす)。
export function videoKey(v) {
  return JSON.stringify([v.name, Math.round(v.t)]);
}

// 保存形式 { id, t, name, durationMs } にそろえる(url などローカルの項目は落とす)。
export function normalizeVideoEntry(v) {
  return {
    id: typeof v.id === 'string' && v.id ? v.id : null,
    t: v.t,
    name: v.name,
    durationMs: v.durationMs ?? null,
  };
}

const isValidEntry = (v) => v && typeof v === 'object'
  && typeof v.name === 'string' && v.name.length >= 1 && v.name.length <= MAX_NAME
  && typeof v.t === 'number' && Number.isFinite(v.t);

// 追記 API の本文 videos を検証する。問題があれば理由の文字列、なければ null。
export function validateVideoAppend(list) {
  if (!Array.isArray(list)) return 'videos が必要';
  if (list.length > MAX_VIDEO_APPEND) return `videos は1回${MAX_VIDEO_APPEND}件まで`;
  for (const v of list) {
    if (!isValidEntry(v)) return 'name(1〜255字)と t(数値)が必要';
    if (v.durationMs != null && !(typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) && v.durationMs >= 0)) {
      return 'durationMs は null か 0 以上の数値';
    }
    if (v.id != null && !(typeof v.id === 'string' && v.id.length <= MAX_ID)) return 'id は64字までの文字列';
  }
  return null;
}

// 一覧の vidN の最大 N + 1(画面の連番 videoSeq をこれより小さくしない)。vidN が無ければ 0。
export function nextVideoSeq(list) {
  let n = 0;
  for (const v of Array.isArray(list) ? list : []) {
    const m = typeof v?.id === 'string' ? v.id.match(VID_RE) : null;
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return n;
}

// 既存の id と重ならない id を付けて返す関数(重ならなければ元の id のまま)。
function idAssigner(list) {
  const ids = new Set(list.map((v) => v?.id).filter((id) => typeof id === 'string'));
  let seq = nextVideoSeq(list);
  return (id) => {
    let out = id;
    if (!out || ids.has(out)) {
      while (ids.has(`vid${seq}`)) seq++;
      out = `vid${seq++}`;
    }
    ids.add(out);
    return out;
  };
}

// current に、name + t が未登録の incoming だけを末尾へ足す。既存の項目と順序は変えない。
// incoming 同士の重複も1本にする。返り値 { videos, added: 足した本数 }。
export function appendVideos(current, incoming) {
  const base = Array.isArray(current) ? current : [];
  const keys = new Set(base.filter(isValidEntry).map(videoKey));
  const assignId = idAssigner(base);
  const videos = [...base];
  let added = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!isValidEntry(raw)) continue;
    const v = normalizeVideoEntry(raw);
    const key = videoKey(v);
    if (keys.has(key)) continue;
    keys.add(key);
    videos.push({ ...v, id: assignId(v.id) });
    added++;
  }
  return { videos, added };
}

// サーバーの動画一覧 remote のうち、この画面が知らない(knownKeys に無く、local にも無い)ものを
// 未リンク動画(url なし)として local の末尾へ足す。自分で消した動画は knownKeys にあるので戻さない。
// 返り値 { videos, added: 足した項目 }。local は変更しない。
export function mergeUnknownRemote(local, remote, knownKeys) {
  const base = Array.isArray(local) ? local : [];
  const keys = new Set(base.filter(isValidEntry).map(videoKey));
  const assignId = idAssigner(base);
  const added = [];
  for (const raw of Array.isArray(remote) ? remote : []) {
    if (!isValidEntry(raw)) continue;
    const key = videoKey(raw);
    if (keys.has(key) || knownKeys?.has(key)) continue;
    keys.add(key);
    const v = normalizeVideoEntry(raw);
    added.push({ ...v, id: assignId(v.id) });
  }
  return { videos: [...base, ...added], added };
}

// 再リンクの候補(同名のローカルファイル [{ file, t }])から、撮影時刻 t が targetT に最も近い1つを選ぶ。
// tolMs(既定 ±2秒)を超えるもの・時刻不明のものは選ばない。無ければ null。
export function pickRelinkFile(candidates, targetT, tolMs = 2000) {
  if (typeof targetT !== 'number' || !Number.isFinite(targetT)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (typeof c?.t !== 'number' || !Number.isFinite(c.t)) continue;
    const diff = Math.abs(c.t - targetT);
    if (diff <= tolMs && diff < bestDiff) { best = c; bestDiff = diff; }
  }
  return best;
}
