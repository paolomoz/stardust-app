-- M5: per-run bearer token. The sandbox agent pushes milestones + artifacts to
-- the Worker ingest endpoints; the Worker authorizes each call against this.
ALTER TABLE runs ADD COLUMN ingest_token TEXT;
