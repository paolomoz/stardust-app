-- Publishing: a public token -> a specific run artifact. Published artifacts
-- (and their shared assets) are servable without auth; the run itself stays private.
CREATE TABLE IF NOT EXISTS published (
  token TEXT PRIMARY KEY,     -- short random public id (the /p/<token> link)
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,         -- artifact path relative to the run, e.g. home-C-cinematic.html
  user_id TEXT,               -- publisher
  title TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_published_run ON published(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_published_runpath ON published(run_id, path);
