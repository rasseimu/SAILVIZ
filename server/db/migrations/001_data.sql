-- 001_data.sql — Phase 1「練習・記録・反省」のデータ表(設計書 v2 §5.1)。
-- アカウント・組織・声の反省・jobs は後の Phase で足す。
-- JSON は TEXT 列、時刻は epoch ms(INTEGER)。表に無い旧キーは extra(JSON)で保持する。

CREATE TABLE practice_days (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  owner_user_id TEXT,              -- org_id / owner_user_id はどちらか一方
  date TEXT NOT NULL,             -- JST 'YYYY-MM-DD'
  legacy_name TEXT UNIQUE,        -- 旧ファイル名(互換 API の :name)
  web_state TEXT,                 -- mode, accuracyFilter, crop, events, marks, pins, videos, extra
  saved_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE rec_sessions (
  id TEXT PRIMARY KEY,            -- 新規 UUID / 旧 imp_…
  owner_user_id TEXT,
  legacy_owner_name TEXT,
  kind TEXT NOT NULL,            -- practice | race
  practice_day_id TEXT,
  race_record_id TEXT,
  position INTEGER,
  boat_no TEXT,
  started_ms INTEGER,
  ended_ms INTEGER,
  chunk_count INTEGER,
  point_count INTEGER,
  status TEXT,                   -- receiving | finalized
  visibility TEXT NOT NULL,      -- private | org | public(race は public 固定)
  device TEXT,
  source TEXT,
  created_at INTEGER,
  finalized_at INTEGER
);

CREATE TABLE session_crew (
  session_id TEXT,
  position INTEGER,
  role TEXT,
  user_id TEXT,
  name TEXT,
  PRIMARY KEY (session_id, position)
);

CREATE TABLE chunks (
  session_id TEXT,
  seq INTEGER,
  sha256 TEXT,
  point_count INTEGER,
  csv TEXT,
  received_at INTEGER,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE tracks (
  session_id TEXT PRIMARY KEY,
  points TEXT,
  bounds TEXT,
  t_range TEXT,
  point_count INTEGER,
  csv_name TEXT,
  view TEXT                      -- name, color, visible, windAxisOverrides, extra
);

CREATE TABLE reflections (
  id TEXT PRIMARY KEY,           -- refl…(旧 ID を保持)
  practice_day_id TEXT,
  position INTEGER,
  author_user_id TEXT,
  legacy_author_name TEXT,
  session_id TEXT,
  voice_id TEXT,
  visibility TEXT NOT NULL,
  body TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE reflection_progress (
  reflection_id TEXT PRIMARY KEY,
  issue_stage INTEGER,
  goal_done INTEGER,
  text TEXT,
  extra TEXT,
  updated_at INTEGER
);

CREATE TABLE reflection_comments (
  id TEXT PRIMARY KEY,
  reflection_id TEXT,
  field TEXT,
  text TEXT,
  ts INTEGER,
  author_user_id TEXT
);

CREATE TABLE roadmaps (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  org_id TEXT,
  legacy_name TEXT,
  goal TEXT,
  milestones TEXT,
  updated_at INTEGER
);

CREATE TABLE race_records (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  race_date TEXT,
  title TEXT,
  venue TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE (owner_user_id, race_date)
);
