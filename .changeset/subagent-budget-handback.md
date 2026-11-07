---
"@capybara-hq/capybara": patch
---

A sub-agent stopped by its tree's token budget hands back what it found in one final tool-less
call instead of ending with nothing. `subagents.maxTokensPerRun` and `subagents.maxDispatchesPerRun`
accept 0 for no limit (deployment config and org override), and `GET /api/v1/admin/orgs` returns the
deployment's defaults of the per-org limits (`limitDefaults`).
