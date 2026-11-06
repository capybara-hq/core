---
"@capybara-hq/kernel": minor
---

A sub-agent's delivery wakes its idle parent under the background task rules (the 60 s window,
the paused queue, the trigger account's access), and a sub-agent is woken by its own background
tasks and by deliveries from its own sub-agents; for a sub-agent the queue and the access checks
are read on the root conversation. A wake run runs as the trigger account of the child run that
delivered (or the task's), records `run_started.trigger: "subagent"` for a delivery and counts
against the tree's budget window. A finished background sub-agent no longer stops its running
background tasks. `runtime.wakeOnBackgroundTask` covers both kinds of wake.
