-- Run mode: 'scripted' (M2 demo) or 'agent' (real Managed Agents session).
ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'scripted';
