# Scheduled tasks

Status: built on `feat/scheduled-tasks` (2026-11-11), written back to match the code after the
final review. The decisions the maintainer made in the brainstorm are marked *decided*; the calls
marked *my call* are open to review; what the build settled is marked *decided during
implementation*.

## 0. Why

- Every mainstream agent product now runs prompts without a person typing them: Claude Code (cloud
  scheduled tasks, Desktop scheduled tasks, `/loop` and `CronCreate`), Codex (scheduled tasks in the
  ChatGPT app, standalone or inside a chat), WorkBuddy (自动化: form or natural language, push to
  WeChat). Capybara has none.
- The first uses the maintainer named: a **daily morning brief** delivered to a chat (possibly
  Telegram), and **data sync at a fixed time every day** (connector reads and writes, maybe commands
  in an environment).
- Capybara is a server platform, so it is the "cloud" variant: runs do not depend on anyone's
  laptop, and results can go straight to an IM channel, which the other products do not do natively.
- **The goal is that automation is not blocked.** A task that stops every night on an approval
  nobody is awake to click is a failed feature, even if it technically works.

## 1. What the others do (summary)

| | Claude Code cloud | Claude Code Desktop | Codex | WorkBuddy (third-party sources) |
|---|---|---|---|---|
| Triggers | cron / one-off, API, GitHub events | presets, cron, manual | RRULE, Gmail / Slack / GitHub events | one-off, daily / weekly / monthly, date range |
| Run | new session each run | new session | new chat, or return to the same chat | not documented |
| Unattended approvals | always auto mode (classifier); the prompt is not consent | per-task permission mode; "Run now" once and pick "always allow" | default sandbox; `approval_policy = "never"` if the org allows it | not documented |
| Missed runs | not documented | one catch-up for the latest missed time (7-day look-back) | not documented | not documented |
| Limits | min 1 h; 100 runs / h / account | — | admins restrict sandbox / approval | — |
| Results | run history | history, sidebar group | "Scheduled" inbox with unread | folder, WeChat mini program |

What this design takes: trigger separate from prompt (all); both run modes (Codex); the prompt is
not consent, approval happens when the task is set up (Claude Code); pre-approval by a supervised
trial run (Desktop); one catch-up for the latest missed time (Desktop); deterministic jitter (Claude
Code); org admins bound what unattended runs may do (Codex).

## 2. Goals, non-goals, anti-goals

Goals:
- A member creates a task: an agent, a prompt, a cron schedule in their time zone, a run mode, a
  delivery target and a list of pre-approved tools. It runs on time on a multi-replica deployment,
  exactly once per tick.
- Both run modes (*decided*): a new conversation per run, or continuing one conversation.
- Runs act as the creator (*decided*).
- Agents can create, list, update and delete tasks through tools (*decided*).
- Orgs configure the limits (*decided*): minimum interval, task counts, run rate, expiry, catch-up,
  what happens on an ask outside the list.
- Org admins see and manage every task in the org (*decided*).
- Delivery to a chat of a channel connection (Telegram, Lark, Slack) (*decided*).

Non-goals (this version):
- Triggers other than time: API / webhook, connector or channel events (*decided*: cron first). The
  data model keeps the trigger separate so they can be added.
- An "unread" state for conversations; e-mail or push notifications.
- A classifier that approves actions on the fly (Claude Code's auto mode).
- Sharing a task between members, or a task owned by the org instead of a person.

Anti-goals (a failure even if it works):
- A scheduled run silently waiting on an approval nobody will see.
- A task that keeps running for someone who has left the org, or with more rights than its creator.
- The prompt, or anything the model writes, widening what the task may do without a person approving.
- Two replicas firing the same tick, or a restart replaying a week of missed ticks.

## 3. Concepts

- **Scheduled task** (定时任务): owned by its **creator**, in one org, for one agent. It holds a
  **trigger** (this version: `cron`, or `once` at a time), a **prompt**, a **run mode**, a
  **delivery target**, the **task grants** (pre-approved tools) and its state.
- **Task run**: one firing of a task for one scheduled time. It points at the conversation and the
  kernel run it produced.
- **Where a run goes** (*decided*: both a new conversation per run and continuing one, plus channel
  chats):
  - `new`: each firing creates a new web conversation with the prompt as its first message.
  - `conversation`: each firing posts the prompt into one fixed web conversation (the **target
    conversation**), which keeps its context. This is Codex's "task inside a chat" and the way an
    agent "comes back later".
  - `chat`: each firing goes to a chat of a channel connection, **always into the chat's current
    conversation** (*decided*). The kernel looks the chat's live thread up at fire time: if there
    is one, the run continues it; if there is none, it creates a conversation and binds it to the
    chat exactly as an inbound message would. When the person sends `/new` in the chat, the binding
    is archived, so the next run starts the chat's new conversation and later runs follow it.
    Replies in the chat therefore always continue the conversation the task posted in.
- **Unattended run**: a kernel run whose trigger is a task's message, and every sub-agent run under
  it. Approval rules differ for these (§7). A run triggered by a person's message in the same
  conversation is an ordinary run.

## 4. Data

Kernel schema `capybara`, one migration (names are *my call*):

`scheduled_tasks`
- `id`, `org_id`, `account_id` (creator), `agent_id`, `name`, `prompt`.
- `trigger` jsonb: `{ kind: "cron", expr, timeZone }` or `{ kind: "once", at, timeZone }`.
  `timeZone` is an IANA name (§5).
- `mode` `'new' | 'conversation' | 'chat'`; `conversation_id` (`conversation` only);
  `chat` jsonb (`chat` only): `{ connectionId, chatId, chatType }`.
- `model` jsonb, a `ModelRef` `{ provider, model }` like an agent definition's (provider 1–100,
  model 1–200 characters), and `effort` (null = the agent's defaults); `device_id` (null = the
  default pick for new conversations, `ConversationDevices.forNew`). All three are a `new`-mode
  task's only (*decided during implementation*): a `conversation` or `chat` task runs with that
  conversation's selection and device, so a task never switches the model of a person's DM or
  conversation for their later turns. Create and update refuse them for another mode
  (`validation_failed`), switching a task away from `new` clears them, and the model must resolve
  for the org (`agent.model_unavailable`) and declare the effort (`validation_failed`), as a
  message's switch. The device is one of the creator's live personal devices in the org (a
  `capybara-device` laptop or server included); when it is offline at fire time the run is
  `skipped` (`device_offline`) without pausing the task.
- `status` `'active' | 'paused' | 'ended'`; `pause_reason` (`creator` / `admin` / `failures` /
  `creator_inactive` / `agent_gone` / `target_gone` / `conversation_gone` / `org_disabled` /
  `expired` / `invalid_schedule`: the scanner cannot evaluate the stored trigger, §6); `paused_by`.
- `next_run_at` timestamptz (null when not active), `jitter_seconds`, `expires_at` (nullable),
  `consecutive_failures`, `created_at`, `updated_at`, `deleted_at`.
- Partial index on `(next_run_at) WHERE status = 'active' AND deleted_at IS NULL`.

`scheduled_task_runs`
- `id`, `task_id`, `org_id`, `scheduled_for` (the tick, before jitter), `fired_at`,
  `trial` boolean, `manual` boolean (a person's "Run now", trial or not), `conversation_id`,
  `run_id`, `status` (`pending` / `running` / `completed` / `failed` / `skipped`), `skip_reason`,
  `error`, `missing_grants` jsonb (§7), `rechecked_at` (when the scan's repair last found this
  started run still in flight; it rotates the rechecks so a new stuck run is reached).
- `skip_reason`: `missed`, `overlap`, `rate_limited`, `queue_paused`, `removed`, `device_offline`,
  `creator_inactive`, `agent_gone`, `target_gone`, `conversation_gone`, `org_disabled`, and
  (*decided during implementation*) `unsupported_target` (a group chat on a channel without
  threads), `task_deleted` (the task was deleted after the tick was recorded) and `task_paused`
  (the task was paused after the scan recorded the tick; a "Run now" still runs).
- `fired_at` (*decided during implementation*): written by the fire job's claim once every check
  passed, before it creates the conversation or queues the message; a run that is skipped or
  released (its start found the target gone, its queued item removed) clears it again. The org's
  `maxRunsPerHour` counts non-skipped runs by `fired_at`, so a claimed run whose start failed
  counts until it is released.
- `UNIQUE (task_id, scheduled_for)` for non-trial runs: the exactly-once guard.

`scheduled_task_grants`
- `task_id`, `tool_key`, `spec_hash`, `connector_id`: the same shape and meaning as
  `conversation_tool_grants` / `tool_grants` (a grant stops applying when `spec_hash` changes).

`runs.scheduled_task_run_id` (nullable): marks the run as unattended and links it to the task run.
It is set on the run the task's message triggers, and inherited (*my call*) by every run that
descends from it without a person: sub-agent runs, and wake runs (`background_task_finished`,
`subagent_delivery`) whose waking event was produced by an unattended run, the same lineage as
`budget_run_id`. A run triggered by a person's message is never unattended, even in a conversation a task
posts into.

`conversations.scheduled_task_id` (nullable): set on the conversations a task's fire creates, so
the web can group and label them ("Started by the scheduled task <name>"): every `new`-mode
conversation, a `chat` DM conversation the fire created because the chat had no live thread, and
each group run's conversation. Never on an existing conversation (*decided during implementation*:
the label stays true).

Also added by the migration (*decided during implementation*): `conversation_queue.schedule`
jsonb, the marker of a queued task message (null for a person's), copied to the `user_message`
when the item is dispatched; `channel_deliveries.pending_thread_account_id`, a group run's
delivery whose thread is not bound yet (§8); and an index on `channel_threads (account_id,
connection_id)` for the chat targets.

## 5. Schedules and time zones

- Syntax (*decided*: cron first): 5-field cron, evaluated in the task's `timeZone` with the `cron`
  package already in the kernel (`CronTime`). No seconds field. `once` takes a local date-time.
  The UI offers presets (hourly, daily at, weekdays at, weekly on…) that write cron.
- **Time zone follows the creator** (*decided*). At creation the kernel fixes the creator's
  effective zone in the task, resolved like a message's (`readMessageContext`): the account's
  `time_zone`, else the browser zone sent with the create request, else the org's `timeZone`, else
  UTC. A tool call uses the zone of the current run's `run_context`. *My call*: later changes to the
  account setting do not move existing tasks; the task page shows the zone and lets the creator
  change it. DST follows `CronTime` (a skipped local time does not fire that day; a repeated one
  fires once). A `once` time inside a DST gap fires at the first valid instant after the gap
  (02:30 → 03:00), since a one-off the person asked for should run (*decided during
  implementation*). A malformed `once` time (out-of-range fields such as `2030-02-30T09:00`) is
  `schedule.invalid_once_time`; a past one `schedule.once_in_past`.
- **Minimum interval**: the smallest gap between the next 50 fire times must be at least the org's
  `minIntervalMinutes` (§9). Checked on create and on an update of the schedule; resume does not
  re-check it (a task that met the minimum when saved keeps running after the org raises it).
- **Jitter** (*my call*): a fixed per-task offset `jitter_seconds = hash(task id) mod min(10 % of the
  interval, 300 s)`, added to every tick, so a thousand "09:00" tasks do not fire in the same second.
  The UI shows "runs at about 09:00". `once` tasks have no jitter.
- **Expiry**: `expires_at` set by the creator (it must lie in the future), else, for a cron task,
  now + the org's `defaultExpiryDays` when the org sets one, else never. An explicit null counts as
  "not given" on create and on update alike, so a creator cannot clear the org's expiry policy by
  sending null (*decided during implementation*). Past it the task ends (`status = 'ended'`,
  reason `expired`). A `once` task ends after its run and has no default expiry.

## 6. Firing (multi-replica)

- A `@LockedCron("* * * * *")` job under `WorkerModule` (*my call*: once a minute, the tick of the
  existing sweeps) selects active tasks with `next_run_at <= now()` in batches,
  `FOR UPDATE SKIP LOCKED`, in a `@Transactional()` method. For each task:
  1. Compute the tick it is due for. If the oldest due tick is older than the org's
     `catchUpWindowMinutes`, record the missed ticks as one `skipped` run (`skip_reason:
     "missed"`) and fire only the latest one inside the window, if any (Desktop's rule: one
     catch-up, never a backlog).
  2. Insert the `scheduled_task_runs` row (`pending`); the unique key makes a second insert a no-op.
  3. Advance `next_run_at` to the next tick plus jitter.
  4. In `afterCommit`, enqueue the fire job `sched-fire-<taskRunId>` on the maintenance queue (no
     `:` in ids).
  A task whose stored trigger the schedule math cannot evaluate is paused (`invalid_schedule`)
  instead of failing the scan; a database error fails the pass (the next minute retries) and
  pauses nothing (*decided during implementation*).
- **Repair** (*decided during implementation*): after the due tasks, the same scan re-enqueues the
  fire job of a run still `pending` and unfired 10 minutes after its tick, and gives it up
  (`skipped`, `missed`) after an hour; a run fired an hour ago and still `pending` goes through the
  run tracker's check, which links it to its run, settles it, or releases it, so a `once` task's
  last run never stays pending. A started run that shows no queued item, no message and no run
  5 minutes after `fired_at` is released (`skipped`, `removed`).
- The fire job (idempotent on the task run's status) re-checks, then starts the run:
  - **Checks**, in order: the task still exists (else `task_deleted`) and, for a tick of the
    schedule, is not paused since the scan (`task_paused`; a person's "Run now" is `manual` and
    still runs on a paused task, and only the creator can ask for one); the org has scheduled tasks
    enabled; the creator is active and still a member of the org; the agent exists and is visible
    to them (`authorCanSend`); for `conversation`, the target conversation exists, is not deleted
    and the creator can send to it; for `chat`, the connection is active and bound to the task's
    agent (a group also needs a channel with threads, else `unsupported_target`, and the
    creator's thread row there); then overlap, the org's `maxRunsPerHour`, the device and a paused
    queue. A failed check marks the run `skipped` with the reason, and a lasting one pauses the
    task with that reason: creator gone, agent gone, conversation or target gone, and the org
    turning scheduled tasks off (`org_disabled`, *decided during implementation*: a task paused
    so needs its creator's resume once the org turns them back on). The rate limit, overlap, a
    paused queue and an offline device skip without pausing.
  - **Overlap** (*my call*): if the task's previous run is not terminal (still running, waiting on
    an approval in `wait` mode, or still queued), the new tick is `skipped` (`overlap`). A task
    never has two runs in flight.
  - `new`: create the conversation and its first message as the creator, idempotent on
    `create_request_id` = the task run id, with the task's model, effort and device and
    `conversations.scheduled_task_id`.
  - `chat` (*decided*: always the chat's current conversation): in one transaction, under the
    same key inbound uses (`connection_id, chat_id, thread_key, account_id`; for a DM the thread
    key is `dm:<the creator's external id on that connection>`), look up the live thread
    (`findThread`). Found: post into that conversation as `conversation` mode does. Not found:
    create a conversation for the connection's agent as the creator, bind it (`insertThread`) and
    write its `channel_deliveries` row with the chat as target, then post. This is what an inbound
    message would do, so a later reply in the chat lands in the same conversation, and after a
    `/new` (which archives the binding) the next run starts the chat's new conversation.
    `createWithMessage` writes in its own `requires_new` transaction and calls `ensureRun` right
    after, so the create path needs a variant (or an option) that takes these extra writes; the
    builder picks the shape. Groups: see §8.
  - `conversation` and `chat` posts (*my call*): the message goes through the **conversation queue**
    (`conversation_queue`, the path that waits for the conversation to be idle), not
    `postUserMessage`, which would be absorbed into a run in progress, possibly one a person is
    attending. The queue item carries the schedule marker and `dispatchQueuedIn` copies it to the
    `user_message`. A paused queue skips the run (`queue_paused`). A person may remove, edit or
    "send now" the queued item like any other (*decided during implementation*): an edit or a
    send-now drops the marker (the item becomes the person's message), and in all three cases the
    task run becomes `skipped` (`removed`), so the next tick is not held by the overlap check. A
    task message that a person's run took in with their own message (dispatched while the
    person's message arrived, consumed by that run) has no run of its own: the overlap check
    finds it at or below the conversation's `consumed_seq` and settles the task run as
    `completed`, since its content was handled.
  - Either way the message is a `user_message` authored by the creator with a new
    non-model-visible marker `schedule: { taskId, taskRunId, scheduledFor, trial }`, and its
    `timeZone` is the task's zone through a new top-priority override in `readMessageContext`
    (today the account setting would beat a zone passed as the browser's). Because the message
    is posted alone into an idle conversation, it is the run's trigger, and `ensureRun` sets
    `runs.scheduled_task_run_id` from its marker.
- The task run follows its kernel run to a terminal state (`completed` / `failed`; *my call*: a
  run aborted by a person counts as completed). A failed run increments `consecutive_failures`; a
  completed one resets it; at the org's `pauseAfterFailures` the task pauses (`failures`). A start
  the kernel refuses for a reason that is not a lasting skip (a full queue, a model removed since
  the task was saved, …) fails the task run the same way and counts toward the pause (*decided
  during implementation*); a trial run's failures never count.
- **"Run now"**: inserts a run for `now()` outside the schedule (no unique-key conflict: it uses the
  request time) and fires it at once; it does not move `next_run_at`. Counted in the rate limit.
- **Trial run** (§7): a "Run now" with `trial = true`.

## 7. Unattended runs and approvals

The goal is that automation is not blocked (*decided*), and the prompt is never consent.

- **Task grants**: the creator pre-approves tools for the task. In an unattended run the policy
  check (`createDecidePolicy`) also looks up `scheduled_task_grants` of the run's task: a matching
  grant turns `ask` into `allow`, exactly like a `tool_grants` entry. It never turns `deny` into
  anything, never covers the R3 fixed-ask tools (`requiresUserInteraction`), and never covers a tool
  the org admin turned off. The creator's own grants of this conversation and their "always"
  grants for the agent apply too, as in any run of theirs (*decided during implementation*: they
  are checked first; a task grant is the fallback).
- **Who is present** (*decided during implementation*): a run is attended again only when the
  task's creator joins it, that is a message of theirs (no schedule marker) that the run already
  absorbed after its trigger; the rest of that run asks the creator as an attended run would.
  Another person's message (someone replying in a group thread the task posted into) keeps the run
  unattended, since the grants and approvals are the creator's. A later wake of the conversation
  (a background task or sub-agent finishing) is unattended again.
- **Skill changes in unattended runs** (*my call*; `SkillWrite` was removed on main, so the rule
  now covers the Platform operations `agents.register-skill`, `agents.delete-skill` and
  `agents.share-skill`): always treated as an ask outside the grants, even on a private agent where
  registering normally runs without asking, so an unattended run cannot rewrite the agent's skills
  (anti-goal: the model widening what the task does).
- **Who can add a grant**: the creator, only for a tool they could approve with scope `always`
  themselves. A tool with a `requiredRole` the creator lacks cannot be pre-approved; in `wait` mode
  its approval goes to the role holders as today, and an escalated approval in a trial run is not
  added to the task's grants (it stays `once`). Org admins can list tools in `forbiddenTools`: those
  never enter a task's grants and are refused in unattended runs.
- **One rule** (*decided during implementation*): `grantRefusalOf` (`schedules/grant-rules.ts`)
  decides what can be a task grant, and every path asks it: the task form and `addGrants`
  (`grantable-tools` gives its code per tool: `forbidden`, `not_grantable`, `not_available`,
  `needs_role`, `fixed_ask`), a trial run's kept approvals, and the unattended refusals below. It
  refuses a tool the org forbids (by its key or the call's key), a skill change, a per-call key
  (`Platform:<operation>`, decided per call), a tool the agent does not have now, a
  `requiredRole` above the creator's, and a fixed ask.
- **How grants are collected** (*decided* in principle; the UI is *my call*):
  - picked from the agent's tool list when creating or editing the task;
  - by a **trial run**: an attended "Run now" whose approvals reach the creator as usual (in the
    conversation, the inbox, or the IM card). An approval the creator grants in a trial run is
    added to the task's grants when the rule above allows it against the task agent's tools at
    that moment (never one another account decided, nor one whose scopes were "once" only);
    afterwards the task page lists them for review.
- **An ask outside the grants** in an unattended run, by the org's `unattendedAsk` setting:
  - `fail` (default, *my call*, so runs are not blocked): no approval is created; the tool call
    returns an error the model can act on ("This scheduled run cannot ask for approval; the task's
    owner can add <tool> to the task's approved tools."), and the tool key is recorded in
    `missing_grants`. The run ends normally; the task page and the creator's inbox say which
    grants are missing. Only a key the creator could grant is recorded, or one that needs a role
    they lack (the inbox lists it under "needs a role you don't have", with no action); a fixed
    ask, a per-call key (a skill change among them) or a forbidden tool gets the fixed-ask text ("<tool> always
    needs a person's approval, which a scheduled run cannot ask for; state what you wanted to do
    in your final answer.") and is not recorded, so the inbox never offers a grant that cannot be
    added (*decided during implementation*). `missing_grants` thus holds tool keys and
    `connection:<connector slug>` entries (below).
  - `wait`: an ordinary approval to the creator (inbox, IM card), expiring after
    `approvalTimeoutHours`.
- **Other waits for a person** (*my call*), in `fail` mode:
  - `AskUserQuestion` returns an error ("No one is present in this scheduled run; decide with the
    information you have, or state the open question in your final answer.");
  - a personal connector that is not connected (`connection_required`) fails the call and records
    `connection:<connector>` in `missing_grants`, so the task page asks the creator to connect it;
  - a connector elicitation is declined.
  In `wait` mode they behave as today, addressed to the creator.
- A grant whose `spec_hash` no longer matches (the tool definition changed) does not apply; the
  call is handled as an ask outside the grants, and the task page shows "approval out of date".
  The inbox treats such a grant as missing (a refused tool granted since drops out of the item
  only while its grant matches the tool now). When the agent's tools cannot be read, the task
  page shows the grants with their staleness unknown instead of failing.
- Sub-agents of an unattended run are unattended and use the root task's grants.

## 8. Delivery

- `new`: the run's conversation appears in the creator's sidebar, labeled with the task.
- `conversation`: results stay in the target web conversation.
- `chat` (*decided*): results go to the chat's current conversation (§3, §6), and the existing
  outbound posts them to the chat, approval cards included. Replies in the chat continue that
  conversation; `/new` in the chat moves later runs to the new one.
  - **Which chats** (*my call*): the creator's own DM with a connection's bot, picked from the
    `channel_threads` rows with their `account_id` (archived ones included: a DM the creator has
    used is enough), because a bot can only start a DM it has seen (Lark has no open_id-to-DM
    path; Telegram needs the person to have started the bot). The task's agent is the
    connection's agent, since the chat's conversations are.
  - **Groups** (*my call*): a group has no single current conversation today: each top-level
    message starts its own thread. A group target therefore starts a new thread per run: the
    run's first post is the thread root, and the binding is written with that message's id as the
    thread key once outbound has it, so replies in that thread continue the run. On a channel
    without threads (`features.threads` false), group targets are not offered in this version.
    The creator must be a member of the group (a group thread row with them exists).
    Built (*decided during implementation*): each run's conversation gets a `channel_deliveries`
    row with no thread yet and `pending_thread_account_id` = the creator; outbound's first
    successful post binds it (`bindThreadIn`, conditional on still pending, written before the
    lease check so a retry never posts a second root). Thread rows are per account, so replies in
    that thread continue the conversation only for the creator; another member's reply starts
    their own conversation, as for any group message.
  - Creating a task from an IM conversation (through the tools, `mode: "here"`) makes it a `chat`
    task for that chat when the conversation is the creator's live DM thread, not a
    `conversation` task pinned to today's conversation. From an IM group thread it is a
    `conversation` task for that thread's conversation (*decided during implementation*: a group
    target starts a new thread per run, which is not "here").
  - A `ChannelSendError` with reason `target_gone` or `auth` pauses the task (`target_gone`). The
    error surfaces in the async outbound worker (`channels/outbound.ts`), which today only stops
    that delivery; the plan adds the link from there to the task (the task run that triggered the
    run being delivered, through `runs.scheduled_task_run_id`). Built so; `auth` pauses as
    `target_gone` too, and nothing resumes the task after the credentials are rotated: the creator
    resumes it (*decided during implementation*).
- **Attention**: there is no notification system. The creator's inbox (`InboxService`) gets a new
  item kind for a task that needs attention: paused (any reason but `creator`), missing grants, or
  `pauseAfterFailures` reached. Org admins see nothing extra; the admin page (§10) shows status.
  Built (*decided during implementation*): the item is `schedule_attention`, derived live (no
  table), with ids `<taskId>:paused` (any pause but the creator's; `pausedBy` names an admin),
  `<taskId>:failed` (an active task whose latest settled run failed, with its error; a paused one
  shows its pause instead) and `<taskId>:grants` (the latest settled run's `missing_grants` the
  task still lacks: `missing`, with `needsRole` the keys whose `requiredRole` the creator lacks,
  and `connection:<slug>` entries offered as "connect"). Skipped runs (`queue_paused`, `overlap`,
  `rate_limited`, …) are not surfaced. Resuming, a clean run or a granted tool clears the item; a
  task paused by `org_disabled` needs its creator's resume.

## 9. Org and platform settings

New org setting group `scheduledTasks` in `OrgSettingsSchema` (lenient parse; org admins edit it;
defaults are *my call*):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Off: no task fires and none can be created (existing ones show "turned off by the org") |
| `minIntervalMinutes` | `60` | Smallest gap between two fire times |
| `maxTasksPerMember` | `20` | Active and paused tasks per creator |
| `maxTasksPerOrg` | `200` | Across the org |
| `maxRunsPerHour` | `60` | Fired runs per org per hour, "Run now" included |
| `defaultExpiryDays` | `null` | Expiry set on new recurring tasks; null = never |
| `catchUpWindowMinutes` | `60` | A tick older than this when fired late is skipped (§6) |
| `unattendedAsk` | `"fail"` | `fail` or `wait` (§7) |
| `pauseAfterFailures` | `5` | Consecutive failed runs before the task pauses |
| `forbiddenTools` | `[]` | Tool keys never allowed in unattended runs |

Platform bounds in kernel config (`schedules.*`, `adding-config`): a floor for
`minIntervalMinutes` (default 5) and ceilings for the counts and the run rate; an org value outside
them is clamped. *My call*: platform per-org overrides wait until someone needs them.

## 10. Management

Roles (`orgs/roles.ts`, all `HUMAN_ONLY` except reads):
- `schedules.use` (member and up): create, edit, pause, resume, run now, delete one's own tasks.
  Guests cannot create tasks (*my call*: a guest's rights are too narrow to run unattended).
- `schedules.manage` (admin and up): list every task in the org, pause, resume, delete any task
  (*decided*: admins manage). They cannot edit another person's prompt, schedule, target or grants:
  the task runs as its creator, and editing it would act with the creator's rights (*my call*).
  Each admin action is audited and the creator's inbox says who paused the task; an admin's
  deletion is only audited (no inbox item: a deleted task has nothing to act on; *decided during
  implementation*).
- A creator demoted to guest may still list, pause and delete their own tasks (narrowing only;
  these routes take `org.read`, the service decides by ownership), not edit, resume or run them
  (*decided during implementation*).

HTTP (`/api/v1/orgs/:orgId/schedules…`): list (own; `?all=true` for admins; `?conversationId=`
keeps the tasks that post into that conversation, for its side panel; each item carries `lastRun`,
its latest settled non-trial run), get, create, patch, delete, pause, resume, run
(`{ trial?: boolean }`), runs (history), grants (list, add, remove), and (*decided during
implementation*) `chat-targets` (the creator's DMs with each active connection's bot and, on a
channel with threads, the groups they have talked in) and `grantable-tools?agentId=` (the agent's
tools with `grantable` and the refusal code of §7).
Every route gets a Platform operation (`check:platform-ops`): `schedules.list`,
`schedules.chat-targets`, `schedules.grantable-tools`, `schedules.get`, `schedules.create`,
`schedules.update`, `schedules.delete`, `schedules.pause`, `schedules.resume`, `schedules.run`,
`schedules.runs`, `schedules.grants-list`, `schedules.grants-add`, `schedules.grants-remove` (an
operation id allows one dot). Writes are confirm class `personal`; `create`, `update`, `delete`,
`run`, `resume`, `grants-add` and `grants-remove` are `rememberable: false`, so no remembered
approval or task grant lets an unattended run create, widen, restart or trigger a task.

Web (`writing-web-ui`, zh copy 定时任务, 智能体):
- `/schedules`: the member's tasks (`ListPage`), each with status, next run, last result.
- `/schedules/new` and `/schedules/<id>`: `FormPage` with name, agent, prompt, schedule (presets
  plus cron, the zone shown), where runs go (`new` / `conversation` / `chat`), model and effort
  (`new` tasks only), approved tools, and a run history table; actions "Run now", "Trial run",
  pause / resume, delete. A new task's end date is read in the zone it will take (the account's,
  else the browser's), and a one-off sends none.
- `/settings/schedules`: org admins: the settings of §9 and every task in the org.
- A conversation started by a task shows "Started by the scheduled task <name>" and links to it; a
  conversation a task posts into shows its tasks in the side panel.

## 11. Agent tools

*Decided*: agents can manage tasks. New builtin tools (names *my call*, close to Claude Code's
`CronCreate` / `CronList` / `CronDelete`; keys contain no dots):

- `ScheduleCreate { name, prompt, cron? | runAt?, mode: "new" | "here", approvedTools? }`:
  `here` targets the current conversation: a `chat` task for its chat when the conversation is an
  IM thread, else a `conversation` task (so "check this again at 3 pm"
  works with `runAt`); the zone is the run's `run_context` zone. **Fixed ask** (R3): the approval
  card shows the whole task, grants included, so a person approves every task an agent creates.
- `ScheduleUpdate { id, … }`: fixed ask, same card with the diff.
- `ScheduleList`: allow; the creator's tasks.
- `ScheduleDelete { id }`: allow for the creator's own tasks (deleting only narrows), even when the
  caller is an org admin: an agent never deletes another member's task.
- Because the first two are fixed-ask, an unattended run can never create or widen a task (§7).

All four act as the run's trigger account through the same service as the HTTP routes and respect
the org's limits; errors are English and actionable (`writing-tools`).

## 12. Replay

- The firing message is a `user_message` written to the log before the run starts; everything the
  model sees about the schedule is in its `content`, so nothing is read on the spot and no new
  `DriftReason` is needed. *My call*: the request builder renders a marked message with a one-line
  English header (`[Scheduled task "<name>", run for <local time>]`) taken from the marker fields
  fixed in the log.
- The run's zone comes from the message's `timeZone` through `run_context`, as today.
- Unattended refusals are ordinary `tool_result` errors in the log.
- Run the zero-drift fixture tests before and after (`replay-evals`).

## 13. Tests (outline)

- Firing on two replicas: one task run and one kernel run per tick (dual-replica helper).
- Catch-up: a worker down for 3 hours fires one run, records one `skipped`.
- Time zones: `0 9 * * *` in `Asia/Shanghai` and `America/New_York` across a DST change.
- Minimum interval, task counts and rate limit enforced on create, update and fire.
- Unattended: a granted ask runs; an ungranted ask fails with `missing_grants` (`fail`) or waits for
  the creator (`wait`); a fixed-ask, forbidden or switched-off tool is refused; `agents.register-skill` is
  refused on a private agent; `AskUserQuestion`, a missing connection and an elicitation do not
  wait; a stale `spec_hash` is treated as ungranted; a sub-agent and a wake run descending from the
  scheduled run use the task's grants; a person's message in a conversation a task posts into
  starts an ordinary run.
- Overlap: a tick while the previous run waits is `skipped` (`overlap`); a `conversation` or `chat` tick goes
  through the queue and never joins a run in progress.
- Trial run: approvals granted in it become task grants.
- Lifecycle: creator deactivated or removed, agent deleted, target conversation deleted,
  `target_gone` from the channel: each pauses the task with its reason and an inbox item.
- Delivery: a `new` task to a fake Telegram DM posts the result (`startFakeTelegram`).
- Admin: lists all, pauses and deletes others' tasks, cannot edit them.
- Tools: `ScheduleCreate` asks, and the created task matches the approved card.
- Replay: a scheduled run reconstructs with zero drift.

## 14. Later

API / webhook triggers, connector and channel event triggers, an unread state for task results,
notifications by IM DM, tasks shared with or owned by a team, platform per-org overrides of the
limits.

## 15. Decided during review

- **Channel delivery goes to the chat's current conversation** (maintainer, 2026-11-11): a task
  delivering to a chat looks the chat's live conversation up at fire time, continues it if there is
  one and creates and binds one if not; `/new` in the chat moves later runs to the new
  conversation. This replaced a draft where each run created its own conversation and the reply
  routing was open.
