-- 003_meta.sql — 運用メタ情報の key/value 表(S2.6-P8)。
-- 取込み済みの印('import_completed')を置く。値は JSON 文字列 {"at":<ms>,"orgId":<string|null>}。
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
);
