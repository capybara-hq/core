-- The exact JSON text of a tool definition as the runtime sent it. `spec` is jsonb, which reorders
-- object keys (shorter keys first), so a request rebuilt from it (an eval replay, the prompt
-- suggestion's side request) serialized its input schemas in another key order than the original
-- request: a provider renders the tools from that JSON, so the rebuilt prompt differed and missed
-- the prompt cache from the tools on. Readers prefer `spec_text`; null on rows written before it
-- (filled by the next write of the same fingerprint).

ALTER TABLE tool_specs ADD COLUMN IF NOT EXISTS spec_text text;
