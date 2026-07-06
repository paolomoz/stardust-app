-- The user's optional free-text design directions, captured with the URL at
-- run creation and injected into the uplift prompt (all variants honor them).
ALTER TABLE runs ADD COLUMN directions TEXT;
