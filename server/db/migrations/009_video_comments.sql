-- 009_video_comments.sql — 動画の瞬間コメント(②練習動画 / ③勉強動画で共用)。
-- 練習の削除(一時保管から復元されうる)でコメントを消さないため、practice_days への FK は張らない。
-- video_key: 練習は JSON 配列 [name, t](t は整数 ms。src/videolink.js の videoKey と同じ)。名前に何が入っても衝突しない。
CREATE TABLE video_comments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('practice', 'study')),
  practice_day_id TEXT,
  video_key TEXT NOT NULL,
  video_name TEXT NOT NULL,
  position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
  text TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope = 'practice') = (practice_day_id IS NOT NULL))
);
CREATE INDEX idx_video_comments_day ON video_comments (practice_day_id, video_key);
CREATE INDEX idx_video_comments_org ON video_comments (org_id, scope, video_key);
