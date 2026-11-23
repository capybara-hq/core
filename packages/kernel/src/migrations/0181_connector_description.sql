-- Issue #777: a connector's own description, entered by an org admin (plain text, one language).
-- NULL: none; the pages then show its connector template's description, if it has one.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS description text;
