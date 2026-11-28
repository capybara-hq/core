---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Compaction summaries reuse the prompt cache: every compaction first summarizes from the
conversation's last request (its cached prefix) plus a summary instruction, for models that pass
the in-context quality gate, and otherwise summarizes the transcript as before;
`compaction_summary.method` records which path ran.
