# Background Bash and the conversation's background section

Status: implemented (2026-11-05). The user chose "design it the way Claude Code does". The calls
marked *my call* are open to review. Decisions made during the implementation are in the appendix.
Amends:
- `2026-10-29-tool-naming-claude-code-design.md`: §4.2 and the non-goal on `run_in_background`;
- `2026-11-04-agent-profile-and-new-chat-design.md`: §5, part 4, which this document replaces;
- `docs/design/spec.md`: the properties panel's background section.

## 0. Why

- Part 4 of the agent page work assumed that the tool rename (#56) would bring a background mode for
  `Bash`. It did not: the tool naming spec lists `run_in_background` as not accepted.
- Today an agent can't start a dev server, a long test run or a watcher and keep working. A long
  command holds the run until it times out. The default timeout is 120 s, and no command runs past
  `sandbox.limits.maxCommandSeconds`.
- Models trained on Claude Code reach for `run_in_background`, and today the parameter fails
  validation.

## 1. What Claude Code does (the model this follows)

- `Bash` takes `run_in_background: true`. The call returns at once with a task id; the command keeps
  running, and its output goes to a file.
- `TaskOutput(task_id, block?, timeout?)` reads a task's status and output. With `block`, it waits
  for the task to finish, up to `timeout`.
- `TaskStop(task_id)` stops a task.
- When a task finishes, the agent is told: a notification in its next turn. If the agent is idle,
  it is woken.

## 2. The model's surface

### 2.1 `Bash` with `run_in_background`

- **Input:** `run_in_background?: boolean`, default `false`.
  - Background or not, `command` and `description` are required, as today.
  - `timeout` is the task's own limit in milliseconds. In the background its default is
    `sandbox.background.maxSeconds` (default 7 200) rather than 120 000, and it is clamped to that
    value.
- **Result** (*my call*, English and model-visible), returned at once:

  ```
  Started background task bt_k3f9a2 ("Start the dev server").
  Output: /workspace/.capybara/tasks/bt_k3f9a2.out
  Read it with TaskOutput (or Read), stop it with TaskStop. You will be told when it finishes.
  ```

- The task's own `timeout` covers the command. The tool call ends as soon as the launch ends (one
  short exec), so it never holds the run, a lease slot, or the run deadline.
- **Refusals**, each an ordinary tool error with actionable text:
  - more than `sandbox.background.maxTasks` (default 4) tasks running in this conversation's
    sandbox: "4 background tasks are already running; stop one with TaskStop or wait for one to
    finish, then retry" (the tool design check requires the closing next step);
  - no sandbox;
  - a replay (§6).
- **Description.** The `Bash` description gains one paragraph on `run_in_background`, worded the
  way Claude Code words it (§8).

### 2.2 `TaskOutput`

- **Input:**
  - `task_id`, required;
  - `block?: boolean`, default `true`;
  - `timeout?: number` in milliseconds, default 30 000, at most 600 000, and at most the run's time
    left.
- **Result:**
  - the status: running, completed, failed, stopped, timed out or lost;
  - the exit code, when there is one;
  - the elapsed time;
  - the output.
- **The output is the new output since this conversation's last `TaskOutput` for the task**, capped
  at `tools.outputSpillChars`. Anything over the cap is archived like any large result
  (`ReadToolOutput`). The offset is kept per task in PG.
- **`block`** waits until the task is no longer running or the timeout passes, checking every 2 s.
  Each check is a short exec under a shared lease.
- **`Read`** works on the output file as well. The path is under `/workspace` on purpose: Docker
  clears `/tmp` on suspend.

### 2.3 `TaskStop`

- **Input:** `task_id`.
- **Behaviour:** sends `SIGTERM` to every process in the task's session (`pkill -TERM -s <sid>`),
  then `SIGKILL` after 5 s (§4.2 explains why the session rather than a process group). The result
  gives the final status and the last 20 lines of output.
- Stopping a task that has already finished is not an error: the result says it had already
  finished.
- **Scope:** a conversation stops only its own tasks. A sub-agent's tasks belong to its child
  conversation; the parent cannot stop them through `TaskStop`, but a person can, from the
  properties panel.

### 2.4 Notifications

- When a task leaves `running`, the kernel appends a **`background_task_finished`** event to the
  owning conversation's log. The event is model-visible and idempotent, with the key
  `background_task_finished:<taskId>`.
- It carries:
  - the task id;
  - the description;
  - the status and exit code;
  - the elapsed time;
  - the last 20 lines of output, at most 4 000 characters.
- **Rendering** (*my call*): the event is absorbed the way an interjection is. The first model
  request built after the event lands includes it, and it is placed where that request absorbed
  it: after the latest tool results, before the new model turn. That is the existing
  `model_call.request.absorbedUpToSeq` rule, extended from `user_message` to this event, so a replay
  places it the same way. It is rendered as a system message with the same shape as `reminder`:

  ```
  Background task bt_k3f9a2 ("Run the test suite") completed with exit code 1 after 4m12s.
  Last lines:
  …
  Full output: /workspace/.capybara/tasks/bt_k3f9a2.out
  ```

- A finish that `TaskOutput` or `TaskStop` already reported to the model in the same run still
  gets its event, so the log is complete, but the event is marked `reported: true` and renders as
  one short line.
- **Consumed** means that a model request absorbed the event: `consumed_seq` and
  `run_finished.consumedUpToSeq` move past it the same way as past a `user_message`. An event marked
  `reported: true` is absorbed like any other (the next model call of its run, or the next run,
  takes it), renders as the short line, and never wakes a run. A finish a person caused by stopping
  the task (`stoppedBy: "person"`) is absorbed and rendered as usual but never wakes a run either,
  and neither does the stop of a task whose conversation is being deleted (`stoppedBy:
  "deletion"`; the delete also marks the conversation deleted before it stops the tasks).
- **Effect on a run:**
  - **A run is going:** the next model call sees the event, like an interjection. If the event
    lands during the run's last model call (the run then ends without another request), it stays
    unconsumed. `ensureAfterRun` then treats it the way it treats an interjection that arrived
    late, and §3 applies.
  - **A run is waiting** (an approval, a question, sub-agents): the event waits in the log, and the
    run sees it after it resumes.
  - **No run (idle):** see §3.

## 3. Waking an idle conversation (decided with the user, 2026-11-05: wake)

Claude Code wakes the agent when a background task finishes. Here, starting a run means spending
tokens and attributing approvals without a person sending anything.

**Decision:**
- A finish on an idle chat conversation starts a run, but only when all of these hold:
  - the task was started by this conversation's agent: the parent's own tasks, not a sub-agent's;
  - the finish is neither `reported` nor a person's stop (`stoppedBy: "person"`): that person is
    looking at the conversation, and the next run sees the event; nor a deletion's stop
    (`stoppedBy: "deletion"`);
  - the conversation's queue is not paused;
  - the person who started the launching run (the task's `triggerAccountId`) can still send to it;
  - no other wake started for this conversation in the last 60 s. Finishes that land together are
    seen together. A finish that falls inside the window schedules one delayed BullMQ job,
    `bg-wake-<conversationId>-<windowEnd>[-r<n>]` on `cap-kernel-maintenance`, at the window's end
    (`-r<n>`: the job fired early and scheduled itself again). That job calls `ensureRun` if
    unconsumed background events remain.
- **The wake run** is a run whose boundary is the `background_task_finished` event, not a
  `user_message`:
  - `trigger_account_id` is the task's trigger account;
  - approvals go to that person;
  - usage counts against them;
  - its `run_started` records `trigger: "background_task"` and `triggerSeq`, the boundary event's
    seq.
- `ensureRun` gains this second kind of boundary. `consumed_seq` moves past the event as it does
  past a message. The run's job id keeps today's form, `runJobId(conversation, boundary seq)`, where
  the boundary seq is the event's seq.
- A full-run replay seeds a wake run from its boundary event, `run_started.triggerSeq` (§4.4), not
  from the last `user_message`.
- **Config:** `runtime.wakeOnBackgroundTask` (default `true`), plus an org override.

The user chose this over never waking, where the event would only be logged and shown, and the
next person message would pick it up.

## 4. Kernel

### 4.1 State

- A new table, `capybara.background_tasks`:
  - `id` (`bt_` + 6 base32), `org_id`;
  - `conversation_id`: the owner, which is the child conversation for a sub-agent;
  - `sandbox_conversation_id`: the root, which owns the sandbox;
  - `run_id` and `call_id` of the launch;
  - `trigger_account_id`;
  - `description` and `command` (the command is kept for display and audit);
  - `sid`: the session id, which is the pid that `setsid` started. It is null while a launch is
    reserved (the row is inserted, counted against `maxTasks`, before the launch exec); the poller
    and stops skip such a row, and a failed launch finishes it as `failed`;
  - `output_path`, relative to `/workspace` (`.capybara/tasks/<id>.out`);
  - `status`: `running`, `completed`, `failed`, `stopped`, `timed_out` or `lost`, plus a
    `lost_reason`;
  - `exit_code`;
  - `started_at`, `finished_at`, `deadline_at`;
  - `sandbox_created_at`: the sandbox instance the task runs in. The kernel's instance check uses
    the handle plus `created_at` (`isInstance()`). `sandboxes.generation` is a fencing counter that
    every lease bumps, so it can't tell whether the sandbox was rebuilt;
  - `kill_pending`: a task marked lost while its process may still exist (§4.3);
  - `read_offset`: the bytes `TaskOutput` has already returned.
- Indexes:
  - `(sandbox_conversation_id) WHERE status = 'running'`;
  - `(conversation_id, started_at DESC)`.
- Rows are deleted with their conversation. Finished rows are pruned after
  `tools.outputRetentionDays`.

### 4.2 Launch: no sandbox contract change

- The command must outlive the exec. sandbox@1 has no detach primitive, but `exec` waits only for
  its process and its stdio. So the launch is one short exec under the call's shared lease. It:
  1. runs with `cwd: /workspace`. Every path is relative (`.capybara/tasks/<id>.*`), so a provider
     that maps `/workspace` (sandbox-fake) needs no rewriting inside the script;
  2. writes the command to `.capybara/tasks/<id>.sh`. The command arrives base64 in the exec, so
     nothing is quoted by hand;
  3. runs `setsid nohup sh -c 'timeout -s KILL <s> bash <id>.sh; echo $? > <id>.exit' > <id>.out 2>&1 < /dev/null & echo $!`.
     The command runs in `bash`, the shell a foreground `Bash` call uses (sandbox-docker and
     sandbox-e2b run `/bin/bash -c`), so bash syntax works the same in the background. `$!` is
     written to `<id>.sid` before it is printed, so a launch that ends before its output comes back
     (aborted, timed out) still leaves the id of what it started, which the launch then kills;
  4. reads the pid. It is the session id (`sid`). GNU `timeout` without `--foreground` puts itself
     in a process group of its own, so the command does not run in the `setsid` process group.
     The session holds every process: stopping uses `pkill -s <sid>` and liveness uses
     `pgrep -s <sid>`, the same approach as sandbox-docker's `KILL_TREE`.
- This works on every provider that runs `sh` and `bash` with `setsid`, `timeout`, `pkill` and `pgrep`:
  sandbox-docker and sandbox-e2b. A provider without them fails the launch with a readable error.
- **sandbox-fake** (the test fixture, which runs on the host) changes:
  - it puts small node shims for `setsid`, `timeout`, `pkill -s` and `pgrep -s` first on its PATH,
    so the tests also run on macOS;
  - it kills a sandbox's processes on `suspend` and `destroy`, which also emulates Docker.
- **Consequences:**
  - the exec wrapper's `timeout`, abort, `killTagged` and `killAll` don't reach the task. Its
    deadline is its own `timeout -s KILL`, and stopping it is `pkill -s <sid>` (§2.3);
  - the task holds no lease slot while it runs.

### 4.3 Status: a poller on the worker

- `BackgroundTaskPollJob` is a `@LockedInterval("background-task-poll", cfg => cfg.sandbox.background.pollSeconds * 1000)`,
  default 10 s. It is provided under `WorkerModule`.
- For each sandbox with running tasks, it goes through a new `SandboxService` entry,
  `ifRunning(conversationId, fn)`. It takes a shared lease only when the row is `running` and its
  instance is the one the tasks started in, and it never creates or resumes a sandbox. Otherwise it
  returns `not_running` or `other_instance`. `withSandbox` would resume, so it doesn't fit. A
  provider whose `exec` auto-starts a stopped instance behind a `running` row does no harm: the
  tasks are then found gone (`process_gone`).
- That exec reports, for every task, whether `<id>.exit` exists, its content, and whether
  `pgrep -s <sid>` finds a process.
- **Outcomes:**
  - an exit file means `completed` (exit 0) or `failed`; exit 137 past the deadline means
    `timed_out`. A task ends when its command exits: processes it left running in its session
    (`server &`) are killed in the same exec (the looping session kill) before it finishes, and a
    task whose session could not be confirmed empty is checked again next poll;
  - no exit file and no process means `lost` (`process_gone`);
  - another instance (a rebuild) means `lost` (`sandbox_recreated`);
  - a sandbox that is suspended or gone means `lost` (`sandbox_suspended` / `sandbox_gone`).
  - a reservation (`sid` null, no live stop claim) older than 2 minutes means `failed`
    (`launch_abandoned`): the launching process died before it started the command.
- **A lost task whose process may live on** gets `kill_pending = true`. This is the case for E2B,
  whose pause keeps processes, and for a suspended sandbox. Right after any resume of that sandbox,
  `SandboxService` (under the exclusive lease, next to its existing `killAll`) runs
  `pkill -KILL -s <sid>` for each `kill_pending` task of that instance and clears the flag. A
  rebuilt instance has no such processes, so its flags are simply cleared.
- **Each change** is one transaction: the conditional update from `running` to the new status,
  and the `background_task_finished` event, appended in the same transaction (`EventLog.append`
  joins it). After the commit come the notify, the `changed: "background"` frame and, when §3
  applies, `ensureRun`. A crash between the update and the append can't lose the event.
- **Keep-alive:** each poll takes and releases a lease, so `last_used_at` stays fresh, and a
  sandbox with running tasks is never idle-suspended. `maxRunningMinutes` (120) still suspends it;
  its tasks then become `lost` (`sandbox_suspended`). The Bash description says so.
- **Stops:** a sub-agent's running tasks are stopped (`pkill -s`, while the sandbox still runs)
  when its run ends (*my call*). Nobody can read
  or stop them through the child's model after that. Deleting a conversation stops its tasks. A
  person can stop any task in the panel. Stopping or aborting a run does not stop its tasks: the
  same as Claude Code, where Esc leaves background shells running.

### 4.4 Replay and evals

- A recorded background `Bash`, `TaskOutput` or `TaskStop` result replays as recorded.
  `RecordedToolPipeline` starts nothing. `run_in_background` stays in the match key: it changes
  what the call did.
- `background_task_finished` is in the log:
  - a **step replay** renders it from there;
  - a **full-run replay** feeds it into the loop at the step where the original run absorbed it,
    through the same path it uses for interjections (`pendingUserMessages`, generalized to these
    events);
  - a wake run is seeded from its boundary event (`run_started.triggerSeq`), not from
    `findLast(user_message)`. A recording without `triggerSeq` falls back to the newest message
    after the consumed position, else the newest finish after it that could have woken the run
    (neither `reported` nor a person's stop), else the last message.
  - It is new input and no old log has one, so it needs no DriftReason.
- The zero-drift suites (`reconstruct.test.ts`, `rename-compat.test.ts`) run before and after the
  build change.
- The skills catalog's Claude Code tool map changes `TaskOutput, TaskStop -> not available` to
  `TaskOutput -> TaskOutput, TaskStop -> TaskStop`. Old snapshots keep their text (the existing
  rule), and the next run gets the change notice.

### 4.5 Policy and hooks

- `TaskOutput` and `TaskStop` are builtins with `defaultPolicy: "allow"`.
- `Bash` keeps its policy. `sandboxToolPolicy: "ask"` asks for a background launch the same way as
  for a foreground one.
- Hooks fire on the three calls as on any tool call.
- Replays include both tools in the recorded tool set, so that no `tools_changed` or
  `tool_unmatched` drift appears, but a replay never executes them: their results come from the
  recording, like every tool's. Both are given to sub-agents, which share the parent's sandbox
  but own their tasks.

### 4.6 HTTP

- `GET /orgs/:orgId/conversations/:id/background-tasks`: the conversation's tasks, plus those of its
  sub-agents' child conversations, newest first. The visibility is the conversation's own.
- `POST …/background-tasks/:taskId/stop`: a person stops a task. The same people who may stop a run
  may stop a task. The action is audited as `background_task.stopped`.
- `GET …/background-tasks/:taskId/output?tail=<bytes>`: up to 64 KiB of the end of the output, read
  through one short exec while the sandbox runs. Otherwise the response is 409
  `background_task.output_unavailable`, unless the task finished and its last lines were kept in
  the event.
- The SSE stream gains `changed: "background"`.

### 4.7 Config

- `sandbox.background.maxTasks` (4, per sandbox);
- `sandbox.background.maxSeconds` (7 200, at most `sandbox.limits.maxCommandSeconds`);
- `sandbox.background.pollSeconds` (10, hot);
- `runtime.wakeOnBackgroundTask` (§3).

## 5. The background section (web)

- The properties panel's "后台" / "Background" section lists, newest first:
  - **the conversation's background tasks:**
    - a running row: a spinner, the description, the elapsed time, a stop button, and the task's
      output on click;
    - a finished row: a status mark (done, failed, stopped, timed out, lost) instead of the spinner;
  - **sub-agents**, as today;
  - **each sub-agent's own tasks**, indented under it, while the sub-agent runs.
- "N 个已完成 ›" counts the finished tasks and sub-agents together. It opens the newest finished
  item, as it does today.
- The section shows when there is a task or a sub-agent.
- **The output panel** is a right-area panel (`#bg-<taskId>` in the URL hash):
  - the description and the command (mono);
  - the status and elapsed time;
  - the output tail in a code block, refreshed every 2 s while running;
  - stop.
  - When the output can't be read: "输出不可读（沙箱已暂停）" or the last lines from the event.
- **The tool row** of a background `Bash` call shows "后台运行" / "In background" after its
  description, and a link to the task. A `TaskOutput` or `TaskStop` row shows the task's
  description. The `background_task_finished` event renders in the thread as a quiet one-line
  notice ("后台任务「…」已完成 · 退出码 1"), which opens the task.
- **Design:** `BackgroundTasks` gains task rows (a state list `running`, `done`, `failed`,
  `stopped`, `lost`, and `nested` for a sub-agent's task), a size table, and /dev/ui blocks. The
  output panel reuses the right panel and `CodeBlock`.
- **Copy** in zh and en. The model-facing text is English.

## 6. Non-goals

- Background mode for tools other than `Bash`.
- Keeping a task alive across a Docker suspend or a sandbox rebuild.
- Streaming the output live to the model: the model reads with `TaskOutput`.
- An interactive stdin for a task.
- A sandbox@1 contract change. If a provider later needs a native detach, that is a separate
  contract change.

## 7. Tests (summary)

- **Kernel:**
  - launch, poll, finish, stop, timeout and lost on the sandbox-fake fixture;
  - the per-sandbox cap;
  - `TaskOutput` offsets and `block`;
  - the finish event is idempotent across two replicas (`createDualReplicaHarness`);
  - a sub-agent's tasks stop with its run;
  - the wake rules (§3);
  - replay starts nothing;
  - zero drift before and after.
- **Web:**
  - the section's rows from the query;
  - stop;
  - the output panel;
  - the tool row label;
  - the thread notice.
- **Design:** the state coverage, the size table and fidelity.

## Appendix: decisions made during implementation

Taken from the rulings of the implementation (`.superpowers/sdd/2026-11-05-background-bash/progress.md`),
one bullet each.

- The wake provider (`BackgroundWake`, `background/wake.ts`) was created first as a no-op and filled
  in later, so the finish code could depend on it from the start.
- The design package has its own `BackgroundTaskStatus` union (the same six values); the web maps the
  kernel's views onto it, because design depends on no `@capybara-hq/*` package.
- The migration takes the next free number at commit time.
- The org setting `wakeOnBackgroundTask` can be cleared: `null` removes the override, as for
  `sandboxEgress`.
- sandbox-fake's shims are strings in its `index.ts`, written to `<root>/bin` at start, because the
  packed fixture ships only its entry file.
- `BackgroundTaskStore` lives in its own `BackgroundStoreModule` (imported by `SandboxModule`,
  re-exported by `BackgroundModule`) to avoid a module cycle.
- `ifRunning`'s `not_running` result carries the row's status (`suspended` or `gone`), so the poll can
  name the lost reason.
- `ifRunning` takes an optional abort signal, so the poll stops at shutdown.
- The cap refusal ends with ", then retry": the spec's first text failed the tool design check
  (`tool-error-actionable`), and the check is the authority (§2.1 now has the code's text).
- The cap holds under parallel tool calls: the launch reserves its row first (`running`, `sid` null,
  counted under a per-sandbox `XactLock`), then launches, then sets `sid`; a failed launch finishes
  the row `failed`. No process ever runs without a row.
- The task file runs with the same shell as a foreground `Bash`.
- That shell is `bash` (the providers run `/bin/bash -c`), not `sh`: dash would silently break bash
  syntax. `bash` joins the programs a sandbox needs (§4.2).
- The launch refuses a call without a run, validates the task id and seconds, has a launch-failure
  test, and a command too large for one exec gets a launch error that names the size limit.
- Org limits need no background code: `sandboxLimitOverrides` covers only CPU and memory, and
  `maxCommandSeconds` is deployment-wide, so a background task is limited like a foreground command.
- The launch writes the session id to `<id>.sid` before printing it, so an abort between `setsid` and
  the echo can still kill the session; the kill and size wording and the `pkill` exit codes are exact.
- Stops run inline in the run worker or in the delete request (up to about 5 s): a stop is rare and
  bounded.
- The event's `outputPath` is absolute (`/workspace/...`), as §2.4 shows it.
- A stop claims its task in PG before signalling (`stopping_at`); the poll skips claimed rows, and the
  stop's finish is the only one for its task. PG rather than Redis, so the claim lives with the row.
- A sub-agent's tasks are stopped in `Waits.childFinished`, which every way a child ends goes through,
  not in the run worker. Only the tasks the ending child run started (`run_id`): a follow-up run of
  the same child keeps its own when an older run's end is handled late.
- A stop that can't confirm the session is empty while the sandbox runs leaves the row `running`
  (claim cleared) and reports the failure, so the poll and the cap still see the task.
- Stopping a reservation (`sid` null) sets the claim; the launch then kills the session as soon as it
  starts and finishes the row `stopped`.
- A stop claim older than 5 minutes counts as abandoned (`STOP_CLAIM_TTL_MS`), so a crashed stopper
  can't hide a task from the poll.
- A task whose exit file existed before the SIGTERM finishes by its exit code, not as `stopped` (it
  "had already finished", §2.3); processes it left running are killed all the same.
- A reservation stopped during its launch ends `stopped` without an event, and the launching call gets
  a tool error: the model never saw a started task.
- The poll fails a reservation still without a session after 2 minutes (`launch_abandoned`): its
  launcher died, and it would otherwise hold a cap slot forever.
- `TaskOutput` and `TaskStop` are offered whenever the agent has `Bash` (the registry adds them); a
  definition need not name them, or an agent could start tasks it can neither read nor stop. Old
  recordings of a `Bash` agent show the expected `tools_changed`.
- Tool error texts keep the spec's wording and add one actionable sentence (the tool design check).
- `TaskOutput` reports a finish only together with its result, so a `reported: true` finish is one
  the model really saw.
- The wake rules live in `RunQueue.ensureRun`, one rule set for a run's end, the delayed job and a
  page open; `BackgroundWake` listens for the domain event `background_task.finished` and calls
  `ensureRun`.
- Boundary order: an unconsumed message first, then a queued message, then a background wake; a
  queued message's run absorbs the finish anyway.
- A person's stop from the panel never wakes an idle conversation: the event records
  `stoppedBy: "person"`, stays unconsumed, and the next run sees it.
- A delayed `bg-wake` job that fires before the window ends on the database's clock re-schedules
  itself for the rest (`-r<n>` job ids) instead of being dropped.
- A `reported: true` event is absorbed like any other and never wakes; it is not marked consumed when
  appended, because that could skip an unabsorbed interjection below it (§2.4).
- A full-run replay seeds a wake run from the recorded `triggerSeq`, else from the fallback in §4.4.
- The background routes answer a non-owner 404 `conversation.not_found`, like the abort route.
- The stop route answers 200 with `stopping: true` for a task another stop already claimed.
- The "background" SSE frame for a start is published after the launch returns.
- The background section shows running items only; finished tasks and sub-agents are counted in
  "N completed". `BackgroundTaskRow` keeps its finished states for lists that show them.
- `TaskOutputPanel` has a state list (running, finished, unavailable), a size table and /dev/ui
  blocks, like every design component.
- `BackgroundTaskRow`'s finished states keep their reference blocks although no page shows finished
  rows yet.
- A sub-agent's tasks nest under their parent sub-agent; the stopping word is announced
  (`aria-live`); the unused `subagent.stop` key is gone; fixture durations are numbers.
- The task output panel's monospace command is stated in the design spec's prose, not its size table
  (the size checker has no font-family token).
- The web reads the background tasks also once a sub-agent was dispatched, because a child's tasks
  live only in the child's log.
- The finished notice is its own documented divider kind (`RunDivider` `kind="notice"`), not the
  fallback divider.
- The background `Bash` row's task link is a documented `ToolRow` / `ToolGroup` slot in the design
  package.
- `TaskOutputPanel` has a stopping state: no stop button, "正在停止…".
- The panel's source `sandbox` / `event` maps from the kernel's `live` / `event`; a 409 shows the
  unavailable note.
- The web tracks stops per task (several can be on their way), and a background label wins over the
  tool row's other extra text.
