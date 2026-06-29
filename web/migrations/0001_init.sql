-- stardust-web — runs and their streamed timeline.

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  project     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  created_at  INTEGER NOT NULL
);

-- Append-only event log per run (the streamed ServerEvents). Enables resume /
-- catch-up on reconnect and a history of every run.
CREATE TABLE IF NOT EXISTS run_events (
  run_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  payload  TEXT NOT NULL,        -- JSON-encoded ServerEvent
  ts       INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
