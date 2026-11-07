---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

A sub-agent that handed back its report and then completed no longer sends its parent a separate
"completed; its report was already delivered" notice: the finish is only logged, so it neither
wakes an idle parent for an empty run nor pushes the report away from the end of the request. The
conversation still shows the agent's "completed" entry.
