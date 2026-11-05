---
"@capybara-hq/kernel": minor
"@capybara-hq/web": patch
---

Background Bash. `Bash` takes `run_in_background`: the call reserves a task in the new
`capybara.background_tasks` table (at most `sandbox.background.maxTasks` per sandbox), starts the
command with `bash` in a session of its own in the sandbox (`setsid` plus its own
`timeout -s KILL`, output in `/workspace/.capybara/tasks/<id>.out`) and returns at once. The
builtins `TaskOutput` (a task's status and its new output, optionally waiting for it to end) and
`TaskStop` (SIGTERM, then SIGKILL after 5 s) come with `Bash` and read or stop those tasks; the
Claude Code tool map names them as themselves. The worker's `background-task-poll` finds finished
and lost tasks (`sandbox.background.pollSeconds`), a daily prune drops finished rows, a sub-agent's
tasks stop when it ends, and tasks marked lost while their process may live on are killed after the
sandbox resumes.
A finished task reaches the model: its `background_task_finished` event is absorbed like an
interjection and rendered as a system message (one short line when a tool call already reported
it), and it wakes an idle conversation: a run attributed to the task's trigger account, at most one
wake per conversation every 60 s (`bg-wake` delayed job), never for a sub-agent's task, a person's
stop, a paused queue, an account that can no longer send, or with `runtime.wakeOnBackgroundTask`
(or the org setting `wakeOnBackgroundTask`) off. `run_started` records
`trigger: "background_task"` and `triggerSeq` for such a run; full-run replays feed recorded
finishes and seed a wake run from its finish. New routes list a conversation's tasks (with its
sub-agents'), stop one (audited `background_task.stopped`) and read the end of its output; the SSE
stream gains `changed: "background"`.

The conversation page shows background Bash tasks: the properties panel's background section lists
running tasks next to the sub-agents (a sub-agent's own tasks nested under it) with stop, a task
opens its output in the right panel (`#bg-<taskId>`, read again every 2 s while it runs), a
background `Bash` row reads "In background" and links its task, `TaskOutput` / `TaskStop` rows name
the task, and a finished task is a one-line notice in the thread. Design: task rows in
`BackgroundTasks`, `TaskOutputPanel`, the `notice` divider and the tool row's link slot.
