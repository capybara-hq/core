---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

No compatibility with release-candidate data before 0.1.0: migration 0139 rewrites the old tool
keys left in agent versions and templates, deletes the tool grants migration 0063 could not map and
renames the pre-rename connector audit actions (`app.created` and so on), and the kernel drops the
readers that mapped them on every load (in-flight old tool keys, the eval replay mapping and
`legacyKeyMatch`, the `tools.legacy_key_unmapped` startup notice, the audit action aliases). Also
removed: the removal of retired BullMQ job schedulers at worker start, the reading of a second
`cap_rt` cookie (the one on the old `/api/v1/auth` path is only cleared), the warning about the retired `CAPYBARA_SUBAGENTS__MAX_CONCURRENT_PER_RUN`
variable, `aliasOf` in `GET …/conversations/:id/tools`, and the run context's fallback for messages
that recorded no zone or language.
