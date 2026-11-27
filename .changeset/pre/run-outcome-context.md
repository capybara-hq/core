---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

After a run that failed or was stopped, the next request tells the model, at that run's place in
history, that the run ended before it finished and why (a neutral category of the recorded reason,
never the raw provider text; new `run_outcome_note` drift reason). The compaction summary's framing
now says plainly that the earlier conversation was compacted into it. A manual compaction with
nothing to summarize records `compaction_skipped`, and one whose model or attachment storage is
unavailable records `compaction_failed`. The thread draws one divider per manual compaction and no
run row for it (compacted, nothing to compact, failed, stopped), a divider for a person's model
switch, and one line for a sub-agent that hands back a report and then finishes.
