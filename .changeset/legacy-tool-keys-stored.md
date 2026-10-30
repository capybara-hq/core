---
"@capybara-hq/kernel": patch
---

Stored release-candidate tool keys keep working. Migration 0063 rewrites the keys of tool grants,
conversation grants, pending approvals and pending questions (`sandbox_bash` -> `Bash`,
`<slug>__<tool>` -> `mcp__<slug>__<tool>`, `<extension>__<tool>` -> `plugin__<extension>__<tool>`);
a key it cannot map (both a connector slug and an extension name, or neither) stays, and the
kernel logs one `tools.legacy_key_unmapped` WARN with their count at start. Agent versions, agent
templates and eval snapshots are read with the new keys. Saving a definition with an old key is
refused with a message naming the new key. The migration also adds an index for the read-before-
write lookup of `Write` / `Edit`.
