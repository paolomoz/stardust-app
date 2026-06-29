-- M5 polish: snapshot of the real uplift result (brand + variants) so a finished
-- run can be reopened (/?run=<id>) and its brand/variants screens rebuilt without
-- re-running the agent.
ALTER TABLE runs ADD COLUMN result_json TEXT;
