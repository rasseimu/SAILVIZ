-- 007_app_api.sql — アプリ向け API(Phase 4)。振り返りの一覧(本人の振り返り・練習日ごとの振り返り)用の索引。
-- 表(reflections ほか)は 001 にある。

CREATE INDEX idx_reflections_author ON reflections (author_user_id);
CREATE INDEX idx_reflections_day ON reflections (practice_day_id);
