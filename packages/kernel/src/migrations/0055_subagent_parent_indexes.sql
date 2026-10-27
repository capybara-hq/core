-- Final review I2: the ON DELETE CASCADE of conversations.parent_conversation_id and of
-- subagent_dispatches.parent_conversation_id runs `... WHERE $1 = parent_conversation_id` with no
-- `kind` predicate, so the partial index conversations_parent_idx (WHERE kind = 'subagent') cannot
-- serve it and every conversation delete scanned both tables. These indexes carry no kind
-- predicate; the app's `parent = $x AND kind = 'subagent'` queries can use the first one too, so
-- conversations_parent_idx can be dropped in a later release. Additive: older versions ignore them.
CREATE INDEX IF NOT EXISTS conversations_parent_conv_idx ON conversations (parent_conversation_id)
  WHERE parent_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subagent_dispatches_parent_conv_idx
  ON subagent_dispatches (parent_conversation_id);
