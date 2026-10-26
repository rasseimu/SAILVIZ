-- 006_sessions.sql — 記録セッション API(Phase 3。設計書 v2 §5.3・§7・§10.4)。
-- 表(rec_sessions・session_crew・chunks・tracks・race_records)は 001 にある。ここでは
-- 記録した時の組織(練習日の器を決める。アプリは X-Sailviz-Org で送る)と、一覧・照合の索引だけを足す。
-- 移行計画の「sessions は 005」は、005 を練習名の重複許可が使ったため 006 にずらした。

ALTER TABLE rec_sessions ADD COLUMN org_id TEXT;

CREATE INDEX idx_rec_sessions_owner ON rec_sessions (owner_user_id, started_ms);
CREATE INDEX idx_rec_sessions_day ON rec_sessions (practice_day_id);
CREATE INDEX idx_session_crew_user ON session_crew (user_id);
CREATE INDEX idx_practice_days_date ON practice_days (date);
