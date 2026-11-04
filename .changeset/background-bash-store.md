---
"@capybara-hq/kernel": minor
---

Background Bash foundation: the `capybara.background_tasks` table and its store, the
`sandbox.background.*` and `runtime.wakeOnBackgroundTask` config, the org setting
`wakeOnBackgroundTask` and the `background_task_finished` conversation event. `Bash` takes
`run_in_background`: the call starts the command in a session of its own in the sandbox, records a
`running` task and returns at once.
The builtins `TaskOutput` (a task's status and its new output, optionally waiting for it to end)
and `TaskStop` (SIGTERM, then SIGKILL after 5 s) read and stop those tasks; the Claude Code tool map
names them as themselves.
