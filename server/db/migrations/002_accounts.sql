-- 002_accounts.sql — Phase 2「アカウント・組織」の表(設計書 v2 §5.1「アカウント・組織」)。
-- 時刻は epoch ms(INTEGER)。トークンは平文を保存せず token_hash(SHA-256 の hex 等)だけを持つ。
-- 001 と同じく外部キー制約は付けない(設計書の DDL に無い)。
-- 招待(org_invites)は S2.9 の 004、用語集(org_glossary)は声の反省の Phase で足す。

CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- 'u_' + ランダム
  email TEXT NOT NULL UNIQUE,         -- ログイン ID(小文字に正規化して保存する)
  email_verified_at INTEGER,
  password_hash TEXT,                 -- scrypt の結果(ソルト・パラメータ込みの文字列)。生成は S2.2
  name TEXT,
  affiliation_text TEXT,
  default_visibility TEXT,            -- private | org | public
  agreed_at INTEGER,
  created_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,    -- 平文トークンは保存しない
  created_at INTEGER,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX auth_tokens_user ON auth_tokens (user_id);

CREATE TABLE email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,              -- verify | reset | change
  token_hash TEXT NOT NULL UNIQUE,
  new_email TEXT,                     -- verify・change で使う(reset は NULL)
  expires_at INTEGER,
  used_at INTEGER
);
-- 索引の追加のみ。002 は develop にマージ直後で本番未適用のため直接編集する
-- (適用済みの DB が既にある場合は別途 003 で足すこと)。
CREATE INDEX email_tokens_user ON email_tokens (user_id);

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,                -- 'o_' + ランダム
  name TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE org_admins (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE org_roster (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT,
  email TEXT,                         -- 照合用(小文字に正規化して保存する)
  legacy_name TEXT,                   -- 旧名簿の氏名(任意。§11 の移行用)
  updated_at INTEGER
);
CREATE INDEX org_roster_org ON org_roster (org_id);
CREATE INDEX org_roster_email ON org_roster (email);

CREATE TABLE org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  roster_id TEXT,
  linked_at INTEGER,
  PRIMARY KEY (org_id, user_id)
);
