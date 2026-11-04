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
A finished task reaches the model: its `background_task_finished` event is absorbed like an
interjection and rendered as a system message (one short line when a tool call already reported
it), and it wakes an idle conversation: a run attributed to the task's trigger account, at most one
wake per conversation every 60 s (`bg-wake` delayed job), never for a sub-agent's task, a paused
queue, an account that can no longer send, or with the wake setting off. `run_started` records
`trigger: "background_task"` for such a run; full-run replays feed recorded finishes and seed a
wake run from its finish.
