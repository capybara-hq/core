-- Phase A1: the git tree oid of a marketplace entry's plugin directory (spec §5.3 "content
-- changed at the same version"). A path entry gets it at each refresh of its git marketplace; an
-- imported git entry with a path gets it with its branch head. Compared with the tree recorded on
-- the imported version, so a monorepo commit that leaves a plugin's directory alone does not mark
-- that plugin changed. NULL when unknown (then commits are compared).
-- Repeatable: the column is added with IF NOT EXISTS.

ALTER TABLE marketplace_entries ADD COLUMN IF NOT EXISTS tree_oid text NULL;
