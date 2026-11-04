---
"@capybara-hq/kernel": patch
---

Full-run replay of recordings made under the release-candidate tool names: the recorded side is
read in the current names (builtin keys and parameters, `<x>__<tool>` keys of connectors and
extensions) before matching, so an old run replays with its recorded results and no tool-call
difference; the result carries `legacyKeyMatch: true`.
