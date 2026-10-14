-- 004_invites.sql — 組織の招待コード(設計書 v2 §5.1 org_invites / H13)。
-- 時刻は epoch ms。NULL の expires_at / max_uses は無期限 / 無制限。revoked_at NULL = 未失効。
-- 003 は PR #108(003_meta.sql)が使うため飛ばす(migrate.js は番号の欠けを許す)。

CREATE TABLE org_invites (
  id TEXT PRIMARY KEY,                -- 'inv_' + ランダム
  org_id TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,          -- 招待リンクの URL-safe 文字列
  created_by_user_id TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  expires_at INTEGER,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  created_at INTEGER
);
CREATE INDEX org_invites_org ON org_invites (org_id);
