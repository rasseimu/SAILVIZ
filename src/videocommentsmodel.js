// 動画の瞬間コメントの表示用の純関数(DOM 非依存)。②練習動画と③勉強動画で共用する。
// コメントはサーバの形 { id, videoName, videoT?, videoSize?, positionMs, text, authorName, createdAt, canEdit, canDelete }。
import { msToJstWall } from './time.js';

export const COMMENT_SHOW_MS = 4000; // 再生中、位置からこの長さだけ動画の上に出す
export const MAX_COMMENT_TEXT = 1000; // サーバと同じ(server/domain/videoComments.js)

// 練習動画({ name, t })のコメントか。t は ms に丸めて比べる(①の videoKey と同じ)。
export function practiceVideoMatch(video) {
  const name = video?.name;
  const t = Math.round(Number(video?.t));
  return (c) => !!c && c.videoName === name && c.videoT === t;
}

// 位置順(同じ位置は元の順のまま。Array.prototype.sort は安定)。元の配列は変えない。
export function sortByPosition(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => a.positionMs - b.positionMs);
}

// 開いている動画のコメントだけを位置順に。
export function commentsForVideo(list, match) {
  if (typeof match !== 'function') return [];
  return sortByPosition((Array.isArray(list) ? list : []).filter(match));
}

// 再生位置 posMs で表示するコメント(位置が [positionMs, positionMs + windowMs) に入るもの)。位置順。
export function activeCommentsAt(list, posMs, windowMs = COMMENT_SHOW_MS) {
  if (!Number.isFinite(posMs)) return [];
  return sortByPosition(list).filter((c) => posMs >= c.positionMs && posMs < c.positionMs + windowMs);
}

// 入力中の本文の検証。問題があれば理由の文字列、なければ null(サーバの検証と同じ範囲)。
export function validateDraft(text) {
  if (typeof text !== 'string' || !text.trim()) return 'コメントを入力してください';
  if (text.length > MAX_COMMENT_TEXT) return `コメントは${MAX_COMMENT_TEXT}字までです`;
  return null;
}

// 動画の currentTime(秒)を保存する位置(整数 ms)に。負・NaN は 0。
export function positionMsOf(currentTimeSec) {
  const ms = Math.round(Number(currentTimeSec) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// コメントの位置へシークするときの currentTime(秒)。動画の長さが分かればそこで丸める。
export function seekTimeFor(positionMs, durationSec) {
  const t = Math.max(0, Number(positionMs) / 1000 || 0);
  return Number.isFinite(durationSec) && durationSec >= 0 ? Math.min(t, durationSec) : t;
}

// 書いた日時の表示(日本時間 'YYYY/MM/DD HH:MM')。不正値は空文字。
export function formatCommentDate(ms) {
  const wall = msToJstWall(Number(ms));
  return wall ? wall.replace('T', ' ').replace(/-/g, '/') : '';
}
