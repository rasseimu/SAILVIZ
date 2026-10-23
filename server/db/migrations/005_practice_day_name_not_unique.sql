-- practice_days.legacy_name の UNIQUE を外す(練習名の重複を許し、練習は id で見分ける)。
-- SQLite は UNIQUE 制約を ALTER で外せないので表を作り直す。
-- practice_days を参照する外部キーは無い(001〜004 を確認済み)。

CREATE TABLE practice_days_new (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  owner_user_id TEXT,              -- org_id / owner_user_id はどちらか一方
  date TEXT NOT NULL,             -- JST 'YYYY-MM-DD'
  legacy_name TEXT,               -- 旧ファイル名(互換 API の :name)。重複可
  web_state TEXT,                 -- mode, accuracyFilter, crop, events, marks, pins, videos, extra
  saved_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

INSERT INTO practice_days_new (id, org_id, owner_user_id, date, legacy_name, web_state, saved_at, rev, created_at, updated_at)
  SELECT id, org_id, owner_user_id, date, legacy_name, web_state, saved_at, rev, created_at, updated_at FROM practice_days;

DROP TABLE practice_days;
ALTER TABLE practice_days_new RENAME TO practice_days;

CREATE INDEX idx_practice_days_legacy_name ON practice_days(legacy_name);
