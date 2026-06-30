-- Auth: users + opaque sessions, and run ownership.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,        -- canonical id = lowercased email (link-by-email)
  email TEXT,
  name TEXT,
  avatar TEXT,
  providers TEXT,             -- JSON array of linked providers, e.g. ["google","github"]
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,        -- random, = the sd_session cookie value
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Run ownership (sets up per-user discovery / visibility).
ALTER TABLE runs ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, created_at);
