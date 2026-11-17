-- The authenticated owner report of a local machine (permission runtime cutover B2): the strict
-- `{version: 2, revision, sequence, fullAccess, restrictedProjectReach, restrictedAllowedDomains}`
-- its program issued, with the connection it arrived on, when, and through which message; a
-- report that arrived out of order (a lower sequence, or the same sequence with other bytes)
-- marks it `blocked` (no new authority until a valid current report). Per machine row: a new
-- machine credential never adopts an old machine's sequence. NULL: no report yet (protocol 2).
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS owner_report jsonb;
