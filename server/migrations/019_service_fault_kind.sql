-- 019_service_fault_kind.sql
-- billing | auth | quota, set by services/ourFault.providerError; NULL for any
-- other failure. Also added by server/store.js at boot.
ALTER TABLE service_faults ADD COLUMN IF NOT EXISTS kind TEXT;
