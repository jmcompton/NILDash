-- 018_queue_expire_from.sql
-- When a queued card's seven days start (NULL = created_at). A dormant
-- account's cards do not age; on the agent's return every queued card restarts
-- its clock here. See server/jobs/outreachQueue.js (expireStaleCards,
-- restartCardClock). Also added by server/store.js at boot.
ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS expire_from TIMESTAMPTZ;
