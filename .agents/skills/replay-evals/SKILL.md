---
name: replay-evals
description: Use when changing request building (runtime/context/build.ts, model-call.ts, anything model-visible in the event log), the trajectory viewer, or evals (step / full-run replay, case snapshots, the judge). Covers the replay invariant and zero drift for logs written by the current format (reconstruct.test.ts; no frozen copies before 0.1.0), new model-visible input logged with a DriftReason, the Claude Code tool map, skill invocations (skill_fork_result), the command review record (review, no DriftReason), background sub-agents, full-run replay from recorded tool results (RecordedToolPipeline), the eval queue cap-kernel-evals, per-org concurrency, token caps, privacy (trajectory 404, trajectory.viewed audit, no export), and hooks in replays (hook_denied is not model-visible; replays fire no hooks; compaction usage events).
---

# Evals and replay

Code is in `packages/kernel/src/evals/`; HTTP is under `/api/v1/orgs/:orgId/trajectories*` (`trajectories.read`), `/eval-sets*`,
`/eval-runs*` and `/eval-results/:id/label` (`evals.manage`). Web: the trajectory viewer `/trajectories` and evals `/evals` (`TracePage`,
see `.agents/skills/writing-web-ui`). Design basis: overall design §6 principle 8, M6 plan C1-C9 (D2-D6).

## Replay invariants (read this first)

**The event log is the single source of truth**: any model request can be reconstructed from "the log + the agent version". Replay reads only the case snapshot and never changes the original conversation's log.

- `reconstructRequest` (`evals/reconstruct.ts`) shares `assembleModelRequest` (`runtime/model-call.ts`) with the runtime,
  and all its inputs come from the log: the `model_call` event records `toSeq`, `absorbedUpToSeq`, `params`, `toolChoice`, `maxOutputTokens`,
  `mediaBudgetBytes`, the sequence of tool specHashes and the system fingerprint; tool definitions are fetched from the snapshot by specHash.
- **Zero drift holds for logs written by the current format; no frozen copies before 0.1.0** (maintainer ruling 2026-11-16: no
  compatibility of any kind before the first release, including replay of release-candidate logs). There are no recorded
  fixtures and no frozen copies of old model-visible texts: a text change simply renders the new text for every log. The
  event schema requires what the runtime always records on a `model_call` (`tools`, `params`, `absorbedUpToSeq`,
  `maxOutputTokens`, and `media` with `mediaBudgetBytes` when the request has media), so readers never guess a missing one;
  migration 0143 filled rows logged before a field existed with the values the old readers assumed.
- **Run the zero-drift tests before and after changing request building**: `packages/kernel/test/evals/reconstruct.test.ts`
  ("baseline zero drift": multi-step tools, `ToolSearch` loading, approval resume, skill catalog snapshot, reminders, mid-run
  messages, compaction, images / placeholders, and so on; it reconstructs from logs produced by real runs on the current code and
  requires `drift` to be empty and the reconstructed request to equal the one sent to the model at the time).
  Run from the repo root: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts`.
- **Any new model-visible input must go into the log** (written into an event or the `model_call` record); request building must not read PG / config / the clock on the spot.
  Also add a matching reason to `DriftReason` (`reconstruct.ts`, and add it to `DRIFT_ORDER` in order) when it can differ between the recording
  and a reconstruction (a candidate changes it, or it can't be fetched at reconstruction), and add a case to the "drift reasons" group in `reconstruct.test.ts`. Existing reasons: `system_hash`,
  `tools_changed` (baseline check only), `tool_spec_missing`, `definition_missing`,
  `subagent_changed` (child cases, see "Sub-agents"), `permission_profile_changed` (see "Recorded permission context" below), `params_changed`, `model_switched` (see below), `media_missing`, `media_changed` (baseline check only), `context_fit` (context compaction spec §4.9), `tool_unmatched` (full-run replay).
- The runtime (request building, the loop, waits) lives in `packages/kernel/src/runtime`. An agent's `instructions` is derived from its
  `instructionFiles` on save.
- The history sent to the model is append-only; model-visible text that appears in replay (such as `REPLAY_NO_RECORDING`) is always English.
- Display-only `tool_result` fields: request building reads only `callId` / `content` / `isError` (plus `loadedTools` for the loaded set),
  so `display` (the bilingual summary), `view` (UI refresh B: `command` exit code and description, `edit` line diff, `read` range, `guard` for a read-before-write refusal)
  and `review` (the command review's decision, below) never reach a request, are not in compaction records and need no
  `DriftReason`. A tool's input schema change (such as `Bash`'s required `description`) needs none either: definitions
  are fetched from the snapshot by the recorded specHash.
- **The command review's record** (auto mode spec §5.4): `tool_result.review` says who decided a `Bash` / `Write` /
  `Edit` call (the rule table, the classifier, or the person through a `command` approval) and the rule and reason.
  Display only: request building reads only `callId` / `content` / `isError`, and a replay renders the recorded result,
  so a denied, allowed or held command needs no `DriftReason`; a resumed `command` approval replays from its recorded
  result and is never reviewed again (`RecordedToolPipeline` never executes or reviews a tool). The review's own
  classifier call fires `model.request` / `model.response` with purpose `review` and writes a `usage` event with
  the same purpose — neither is model-visible, so neither needs a `DriftReason`.
- **`tools_changed`** (tool naming spec §9.1): written before a step's request when its resolved tool set differs from the
  previous request's (last `model_call` `tools` + `catalog`, plus later `tools_changed`; a call with `toolsOmitted`, whose model
  has no tool support, is skipped); never before a conversation's first request. `model_call.request.toolsOmitted` is recorded by
  `assembleModelRequest`, never inferred from the reminder text, and is not model-visible. Rendered as a system message at its
  position, dropped once a summary covers it. In the log, so no `DriftReason` (the `tools_changed` DriftReason is a different
  thing: a baseline whose rebuilt tool sequence differs from the record).
- **`device_paths`** (devices spec §13.1, ruling R22): the first sandbox tool call of every conversation
  (cloud included, default roots included) appends `device_paths { roots }` to the calling conversation, and a later
  call appends it again whenever the held instance's roots differ from the latest recorded ones (back to the defaults,
  A → B → A too); one indexed read per call (migration 0094), idem `device_paths:<hash>:<previous event seq>`.
  Always before the call's result; rendered at its position as a system line (`devicePathsText`, so after that
  step's tool results), the latest one again right after a summary that covers it, left out of the compaction
  transcript. In the log: no `DriftReason`; old logs have none and rebuild byte for byte. Full-run replay:
  `recordedCalls` marks every recorded call from the step where one was logged onward (`devicePaths`), and
  `RecordedToolPipeline` appends it before a matched call's result when the eval conversation's latest differs.
- **Recorded permission context** (permission context replay spec
  `docs/superpowers/specs/2026-11-16-permission-context-replay-design.md`): `permission_context { payload:
  PermissionContextV1 }` and the marked `device_paths` branch (`permissionContextVersion: 1`) render at their
  position, the latest covered ones again after a summary, and `model_call.request.permissionContext` (`{ version,
  contextSeq, hash }`) records the rendered contributions; absent when no context was recorded.
  `permissionContextHistory` refuses a present marker or version its strict schema rejects
  (`RecordedPermissionContextError`) in live build and replay alike; in a case snapshot that is
  `eval.snapshot_invalid` (422), never a provider error. `permission_profile_changed` (after
  `subagent_changed`): a request's recorded metadata cannot be reproduced from its own bounded range
  (`min(toSeq, callSeq - 1)`); a normal profile change is recorded input, zero drift.
  **Request boundary** (`runtime/model-call.ts`, spec B2): every agent-history request construction of the
  attempt ladder (a retry, a fallback, the rebuild after a forced compaction, wrap-up) first awaits
  `ModelStepDeps.permissionContext.beforeRequest` and then rereads the complete log once; without the port there is
  no call and no reread (old requests build byte for byte). A revoked execution keeps its identical
  `ExecutionRevoked` (checked before the abort); every other callback or refresh failure is a named no-send
  `run.permission_context_*` run error, never a provider error or fallback. Compaction, title, review and
  extraction calls get no permission context. **Live producers are on** (the paired activation, device
  protocol 3): `RunSteps` wires the recorder (`PermissionContextRecorder`) and `BuiltinTools` the managed device
  writer (`ManagedDeviceContextRecorder`) while the one gate `PERMISSION_CONTEXT_ACTIVATION` is on (production
  `PERMISSION_CONTEXT_ACTIVE = true`; a test may provide `false` for the dormant state). Every agent run now
  records a context before its first request (a conversation without a usable device records it as
  `unavailable` / `unsupported`, which the model sees), and again whenever it changes (a device's first
  provisioning moves `unprobed` to `supported`, a profile change): all logged, so zero drift without a new
  `DriftReason`. **The log, never the live gate, decides rendering**: request building and replay read only the
  recorded events, so a log written with the gate off (no `permission_context`, no `model_call.request.
  permissionContext`, old-mode `device_paths` lines with `mode`) rebuilds byte for byte on an activated kernel.
  Cases in `reconstruct.test.ts` ("the device's permission context"): a provisioned device and a profile change
  between runs, and a log written before the activation (made with the request boundary removed from
  `RunSteps.deps`). Activated cases that run builtins bind a cloud device whose provider reports permission
  support (`bindScopedCloudDevice`): sandbox-fake alone reports none, so its devices are `unsupported`.
  Full-run replay (`evals/recorded-permission-context.ts`, spec B4): earlier runs' contexts are seeds; the target
  run's are fed by the recorded-only feeder at the generated request boundary (sparse `(step, attempt)` table,
  monotone, idem `replay_permission_context:<generatedRunId>:<originalSeq>`), so generated requests carry the
  recorded content and their metadata locates the generated seq; none for a recording without markers.
  `replayLoopDeps` (`evals/worker.ts`) strips any live recorder, and the live recorder refuses an eval conversation
  or a tree whose root is one. The result reports `permission_profile_changed` from the original-coordinate
  diagnostics. `RecordedToolPipeline` copies a managed `device_paths` whole and a matched result's `review`
  verbatim (absent stays absent); a replay never previews, reviews, admits, provisions, resumes, probes or touches
  a device.
- **Attachments** (attachments-on-demand spec `docs/superpowers/specs/2026-11-17-attachments-on-demand-design.md` §5.2):
  the log holds `image` / `document` / `file` blocks with a `ref` source, its name and its size; the request names the
  model's content and the attachment's `MediaInfo` (size, PDF pages, etag, the unsigned `uri`) supplies the rest.
  A `file` attachment, and a text attachment above `TEXT_INLINE_MAX_CHARS` (8 000), render as one reference line
  (`attachmentReferenceText`, with the object URI and `FetchAttachment`) — never bytes, never a truncated inline,
  recorded as outcome `reference`. No new model-visible input is logged, so no `DriftReason`. Case in
  `reconstruct.test.ts` ("a text attachment over the inline cap …").
- **A question skipped by a message** (reply-while-question spec §12): the skipped result is a logged `tool_result`,
  the message a logged `user_message` taken in at the recorded `absorbedUpToSeq`; `question_answered` (outcome
  `skipped`, `skippedBySeq`) is not model-visible. No `DriftReason`; full-run replay returns the recorded skipped
  result and never creates questions. Cases in `reconstruct.test.ts`: a skip, and a message logged while the asking
  step streamed (model-fake `slowtool:<ms>:<name>:<json>`).
- **`run_context`** (run context spec `docs/superpowers/specs/2026-11-08-run-context-design.md`): written at run start by
  `RunContextService.record` (after `skills_catalog`, under the conversation row lock, idem `run_context:<runId>`): the
  agent version's name and description, the org, the date (clock seam `RUN_CONTEXT_CLOCK`), the zone and language of the
  person whose message started the run (`user_message.timeZone` / `locale`, not model-visible); a sub-agent's roster
  name and `dispatchedBy`. First one full, later ones only changes (a date only forward unless the zone changes).
  Rendered at its position as a system message (`runtime/context/run-context.ts`); covered by a summary, the fold at
  the boundary follows the summary whole; left out of the compaction transcript. `user_message.sender` (display name
  and role at send time) renders as a separate first text block `From <name> (<role>)` only when the sender changes,
  and again on the first message after a summary (`senderLines`, log only). Also `attribution` (spec
  `2026-11-14-agent-attribution`): the effective attribution line of agent-created commits and pull requests
  (platform defaults or the agent's override, with the resolved conversation link), fixed at the run start that
  wrote the event; the instruction is rendered from it, a later change renders the new values, and turning it off
  renders the explicit off line. Both are in the log: no `DriftReason`; old logs (no event, no field) rebuild byte
  for byte. Full-run replay copies the run's `run_context` as recorded.
- **`plugin_context`** (memory spec §6.1, `runtime/context/plugin-context.ts`): a `context@1` provider's text `{ plugin, text, hash }`, rendered at its position as `<plugin-context plugin="…">` (empty text: nothing), the latest non-empty one per plugin again after a summary (name order, after `device_paths`), left out of the compaction transcript; in the log, so no `DriftReason`; full-run replay copies the run's events as recorded.
- **`project_root`** (project root spec §4.4–§5, `runtime/context/project-root.ts`): a bound conversation's project as its run start read it (`AGENTS.md`, skills by name / description / digest, or `unavailable`), rendered at its position as a system message (`projectRootText`: after the agent's own instructions, skills as `project:<name>`, a name over `Skill`'s 64 characters left out with a warning at the run's first step; unavailable: one line), the latest one again after a summary (after `plugin_context`), left out of the compaction transcript; a logged project with skills offers `Skill` (`hasProjectSkills`). In the log, so no `DriftReason`; `Skill`'s project body is an ordinary tool result; full-run replay copies the run's event as recorded and never reads a device.
- **Conversation source in a replay** (memory spec §6.2): a case records the original conversation's `source`; a full-run replay seeds its eval conversation with it and lists that source's tools (a `channel_group` case never offers a `sources: ["web", ...]` tool). A case taken before the field existed replays as `web` (a child case as `subagent`).
- **Scheduled task messages** (scheduled tasks spec §6, §12): a task's `user_message` carries `schedule { taskId,
  taskRunId, scheduledFor, trial, taskName, localTime }`, fixed at write time; request building renders only the
  header `[Scheduled task "<name>", run for <local time>]` (`scheduleHeader`, a text block after the sender line),
  never the task row, so a rename changes no rebuilt request. Its zone is the message's `timeZone` (the
  `timeZoneOverride` of `readMessageContext`), so `run_context` follows. `run_started.trigger: "schedule"` is
  display only. In the log: no `DriftReason`.

## Queued messages (UI refresh B)

- There is no message queue for new input: a message sent during a run is logged at once as an
  ordinary `user_message` and absorbed by the run's next step (or starts the next run).
  `capybara.conversation_queue` only holds leftover rows
  queued by older versions, not in the log (the model has not seen them); each enters the log only
  when sent, as an ordinary `user_message` (author, text, the `@` resource blocks read at queue time,
  file refs), written by `RunQueue.ensureRun` (the dispatcher drains them one per run after each run,
  when the conversation is idle and the queue not paused; a paused leftover queue drains only after
  继续发送, `…/resume`) or by "send now". Their routes (`GET` / `PATCH` / `DELETE` / `…/send` /
  `…/resume`) stay until the contract step drops the table. Replay therefore needs nothing: the log
  holds exactly what the model saw, and an edit to a leftover's text never touches it.

- Run input and live drafts (run input spec 2026-11-07): nothing new is queued (`POST …/queue` is
  gone; send with `…/messages`). A message sent during a run is an ordinary logged `user_message` that a
  `model_call` absorbs (`absorbedUpToSeq`), so replay needs nothing. Live drafts (partial text and
  thinking of the step in progress, Redis keys `capk:run-draft:*` plus the bus) are display only:
  never in the log, never in a replay, no `DriftReason`; a resumed step resets its draft (`step_reset`).

## Model and effort switches (UI refresh B)

- A person switches model or effort with a message (`POST …/messages` or the first message of
  `POST /conversations`, fields `model` / `effort`): the kernel appends `model_switched { model, effort,
  byAccountId, reason: "user" }` just before that `user_message` (same transaction) and caches the
  result in `conversations.selection`. `model: null` = the agent's model, `effort: null` = the agent's
  saved effort or the model's default.
- The run worker reads the selection under the conversation row lock while it appends `run_started`
  (`readSelection`), so the selection in effect for a run is exactly `selectionAt(events,
  run_started.seq)` (`conversations/selection.ts`); the run uses `effectiveDefinition(definition,
  selection)` (model replaced; `modelParams` = the agent's own only while the model is the agent's,
  plus the effort; fallback untouched). A run already in progress keeps its model.
- A switched-to model that no longer resolves: the run appends `model_switched { model: null,
  effort: null, byAccountId: null, reason: "unavailable" }` (its own `runId`, before `run_started`)
  and runs on the agent's model.
- `model_switched` is not model-visible (request building skips it); its effect is in each
  `model_call` (provider, model, `params`), so baselines need nothing new and old logs (no switches)
  reconstruct byte for byte.
- Replays honor the switch: `caseBase` returns the run's definition with the switch applied (and the
  `selection`), so a step-replay candidate without a model override, and a full-run replay
  (`candidate.definition`), use the switched model; a candidate agent version gets the same switch.
  `model_switched` (DriftReason, after `params_changed`) flags a non-baseline reconstruction whose
  run used a switch and whose candidate model (`ReconstructOptions.modelRef`, or
  `ResolvedCandidate.overridesSwitch` for full-run results) replaces it. Covered by
  `reconstruct.test.ts` ("UI refresh B model switches" and the drift group), `step-replay.test.ts`,
  `run-replay.test.ts` and `runtime/model-switch.test.ts`.

## Skills snapshots and the tool map (phase B; pinning removed by skills default-on)

- **Skills are on by default** (`docs/superpowers/specs/2026-11-12-skills-default-on-design.md` §9): the catalog a run start resolves
  is the agent's own and shared skills plus every skill on in the org its `disabledSkills` leaves on. A skill that appears because a
  plugin was enabled gets a new snapshot and the existing "New skills" notice at the next run start: it is in the log, so no
  `DriftReason`. A step replay renders the recorded catalog whatever the candidate's `disabledSkills` say.
- **Catalog budget** (spec §7): the cut is decided when the snapshot is written (`skills[].nameOnly`, from
  `skills.catalogBudgetChars` at that run start), so rendering stays a pure function of the snapshot and needs no `DriftReason`; a
  later budget never changes an old request. A snapshot without `nameOnly` renders byte for byte as before. `sameSkills` compares
  `nameOnly`, so an entry crossing the budget writes a new snapshot and shows in the "Updated skills" notice at the next run
  start. Ranking: the agent's own and the org skills it shared, builtin, the org's own, then plugin skills.
  `skills.catalog_over_budget` (info) is logged at every run start while the catalog is over budget, whether or not a new snapshot
  is written. Zero-drift case: "a catalog budget change between runs" in `reconstruct.test.ts`; unit tests in
  `test/runtime/context/skills-budget.test.ts`.
- **Nothing is pinned**: run start reads no bodies, the `skills_catalog` schema has no `pinned` and request building renders no
  pinned skills (maintainer ruling 2026-11-16: a release-candidate snapshot's `pinned` is ignored; there is no `pinned_changed`).
- The `skills_catalog` event carries `skills` (each with `plugin`, the catalog item name, when the skill came from a plugin) and
  `toolMap` (the fixed English Claude Code tool-name map, present iff a skill has source format `claude-code`). Request building
  renders only these fields: the map after the catalog in the system segment; when a later snapshot changes the map, an append-only
  system notice; after compaction the current map is restored with the catalog. Code: `runtime/context/skills.ts`,
  `runtime/context/claude-tools.ts`, `skills/catalog.ts` (`SkillsCatalogService.record`).
- Platform skills (plugin scope phase 2): a snapshot entry's `source` is `platform:<object prefix>` for a platform skill version (read from
  `deployment/`, `skills/usable.ts` `skillFileStore`); an org copy linked to its platform skill keeps its id in agent definitions and
  snapshots and serves the platform's current version under that id, so linking or a platform update shows as one "Updated skills" notice
  (no removed / new entries, no definition rewrite). Old snapshots keep their org prefixes and still load.
- Promote on share (plugin scope phase 3, ruling P3-43): when an org skill is promoted to a platform skill, the owner's org row keeps its
  id and serves its own stored version while it equals the platform's, so the owner's agents see the same id, version and content: no
  "Updated skills" notice and no DriftReason. Other orgs' agents reference the platform id; an owner's later version reaches both as an
  ordinary update.
- A skill renamed under its id (the platform components migration renames an org skill whose name a platform skill on in the org has)
  is noticed as its old name removed and its new name added; no log before phase 2 holds such a change, so old logs render as before.
- The map is in the log, so a baseline can never miss it and it needs no drift reason of its own.
- **Changing the map text** (phase C changed the `Task` / `Agent` line and added `TaskOutput, TaskStop`, sub-agents spec §16.5; background
  Bash maps `TaskOutput` / `TaskStop` to themselves instead of "not available", spec §4.4; background sub-agents name `SendMessage` as a
  same-name tool instead of "`Agent` with `resume`", agent map spec §4.2): a
  snapshot keeps its text and reconstructs byte for byte; a conversation's next run writes a new snapshot (the map differs) and the request
  gets the "The following tool-name map now applies:" notice, all from the log. `reconstruct.test.ts` "an old snapshot keeps its old map
  text; a new snapshot gets the new one" pins this; run the zero-drift tests before and after any change to `claude-tools.ts`.
- Full-run replay copies the run's `skills_catalog` (with `toolMap`) unchanged into the eval conversation.
- Zero-drift coverage: `reconstruct.test.ts` "a skill version change mid-conversation, a claude-code skill with the tool map, and a
  compaction: zero drift …"; the phase B acceptance
  `packages/kernel/test/catalog/claude-superpowers.e2e.test.ts` (a superpowers import, `using-superpowers` in the catalog and loaded
  with `Skill` by qualified and plain name, then every `model_call` reconstructed with `drift: []` and equal to what the provider
  received, and a full-run replay sending the same requests).
  Both capture provider requests with `packages/kernel/test/helpers/provider-capture.ts`.

## Sub-agents (phase C, sub-agents spec §15; background sub-agents, agent map spec §8)

- **Parent requests** change through the `Agent` / `SendMessage` tool definitions (by spec hash), their `tool_result` texts and the
  model-visible `subagent_delivery` events (a child's report, note or finish, rendered like an interjection by
  `renderSubagentDelivery`); the other `subagent_*` events (`subagent_dispatched`, `subagent_finished`, `subagent_waiting`, …) are not
  model-visible and request building skips them.
- **`subagent_delivery` is the third absorbable event** (with `user_message` and `background_task_finished`, `isAbsorbable`): `build.ts`
  places it by `absorbedUpToSeq`, a full-run replay feeds a recorded one at the step that absorbed it, and a wake run
  (`run_started.trigger: "subagent"`) is seeded from its recorded boundary `run_started.triggerSeq` (the delivery), not the last
  message. New input, so no `DriftReason`. Pinned by `run-replay.test.ts` ("a wake run with trigger "subagent" …", "a delivery
  absorbed mid-run …") and `reconstruct.test.ts` ("a parent request with a subagent_delivery …").
- **A run that handed back and completed writes no finished delivery** (acceptance 2026-11-07, only `subagent_finished`); older
  logs keep their `handedBack` delivery and its "already delivered" line. The switch is the delivery's absence in the log, so no
  `DriftReason`: `reconstruct.test.ts` "a handed-back finish: an old log's delivery keeps its line …".
- **Parent full-run replay** needs nothing special: `RecordedToolPipeline` matches each `Agent`, `SendMessage` and `SubagentHandback`
  call by `(toolKey, canonical input)` and returns the recorded result; it **never dispatches, sends, hands back or wakes**: no child
  conversation or run, no `subagent_*` event, no `subagent_dispatches` row, nothing appended to another conversation, no child tokens.
  Parallel calls replay in the same step; a `SendMessage` matches because the recorded `Agent` result gave the model the same
  `agentId`. Pinned by `test/evals/subagents-replay.test.ts` and `run-replay.test.ts` ("replay never dispatches, sends or hands back").
- **A child is an ordinary case** (`addCase` accepts `kind = 'subagent'`; sampling stays `chat` only), listed under its conversation's
  agent: the parent's for `general` / inline / plugin templates, the dispatched org agent's (its `runs.agent_version`) for an org agent.
  `takeSnapshot` copies `subagent: { definition, preamble }` from `subagent_started` and `parent` (the dispatching call, from
  `subagent_dispatches`; navigation only, shown on the case detail). `caseBase` uses the logged definition (model included), never
  `definitions`; a child step therefore never gets `definition_missing`. For a follow-up's run the
  snapshot's definition carries that run's narrowing (`user_message.dispatch.narrowed` on its task message: the union of the frozen
  and the current version's `disabledTools` / `disabledSkills` at the restart by `SendMessage`), as the run itself used. A child case offers the sub-agent message tools as its recorded requests did (a fork invocation's child has none).
- **Child requests** render the logged preamble and instructions (`build.ts` reads `subagent_started`), also under a candidate.
  `subagent_changed` (`reconstruct.ts` `subagentChanged`, pure): a candidate whose effective definition differs from the logged
  one in instructions, turned-off skills (canonical `disabledSkills`) or tools: the same version with an instruction override;
  another version of the case's agent (an org agent's next version; for templates the parent's version: `general` takes its
  instructions and tools, `inline` its template of that name, gone = changed); a plugin template's current version
  (`ReconstructOptions.subagentTemplate`, read by the worker; removed = version 0). Model and params are separate candidate axes.
  Template narrowing that needs the database is not recomputed; instead, from the snapshot alone, an `inline` child compares its
  whole template between the case's version and the candidate's, and a `general` / `plugin` child also compares the parent's
  turned-off tools, canonical `disabledSkills` and roster entry (`subagents.general`, the selected template), and an `inline`
  child the parent's side as well; any difference counts. Not compared: the candidate's `subagents` block as the child's own
  roster, and whether it offers `Agent` (that follows the child's depth: `keepAgent` comes only from the logged child); a nesting
  child's dispatches are its recorded `Agent` results.
- **Candidates on a child case** (`resolveCandidate` with the sub-agent's source): the request always renders the logged definition
  (preamble and instructions from `subagent_started`); only the candidate's **model and params** change it. A candidate's
  **instructions are not applied** to a child's request: they only flag `subagent_changed` (so an instructions-only eval run over
  child cases sends baseline-identical requests). The model is the candidate's, else the other version's only for an org agent child,
  else the logged one (a template tier never follows the parent's model). Params: the candidate's, else (an org agent child under
  another version with that version's model) that version's `modelParams`, else the logged ones when the model is unchanged. An
  instructions override flags every child (`subagent_changed`), so under another version it reports it for every source too. Another version's own definition is passed separately
  (`ResolvedCandidate.subagentVersion` / `ReconstructOptions.subagentVersion`) and used only for the `subagent_changed` comparison. The
  run plan prices such cases the same way (it reads the sub-agent source from the snapshot only for a version-only candidate).
- A plugin template child's case is compared with the template's **current** version (`currentTemplate`, the one DB read): once the
  plugin was upgraded after the case, any changed candidate (a model-only one too) reports `subagent_changed`, and an upgrade landing
  mid-run can give two cases of one run different answers.
  The comparison also covers the content source (`subagent_started.template.platformTemplateId`, not model-visible; absent = the org's
  own template): an org copy linked to a platform template, or a pin changing back, reports `subagent_changed` once even when the
  version number happens to match.
- **Child full-run replay** runs the logged definition with the candidate's model and params only, and the logged `maxSteps`; the
  run result's drift gets `subagent_changed` by the same rule (`subagentCaseChanged`).
- **Trajectory**: an `Agent` call (or a `SendMessage` that restarted a child) carries `subagent: { subagentId, childRunId, agentType, resumed, status }` (`running` until its
  `subagent_finished`); a child's detail carries `conversation.parent` (the first dispatching call). A child's access is its parent's
  (the parent conversation's agent owner or an org admin; the dispatched org agent's owner gets 404, and a non-admin viewer of an
  org agent child must also still see that agent, as on the conversation read path), so a link never exposes a child the
  viewer cannot open.

## Skill invocations (phase D, manual skills spec §4.3, §6.3, §7)

- **`user_message.skill`** (`{ id, version, source, name, plugin?, arguments, mode, agentType? }`) records which skill version
  a person invoked with `/name args`. It is **not model-visible**: the rendered text (the `<skill_invocation>` block with its lead
  and optional lines, or the fork lead) is the message's `content`, written once at send time. Request building never re-renders
  it from the skill tables, so a later version, a deselected or a deleted skill never changes an old request.
- **`skill_fork_result`** (`{ invokedSeq, subagentId?, childRunId?, text }`) is **model-visible**: the report of the sub-agent a
  fork invocation ran (`Report from the sub-agent that ran the skill "{name}":` + phase C's result text, or the stop / not-started
  text), written once (idem `skill_fork_result:<seq>`) before the parent's first model call. `build.ts` appends it as a second
  text block of its invocation's user message (same user turn, wherever that message is placed); it is rendered at its own
  position instead when the invocation is covered by a summary, or when a `model_call` absorbed the invocation before the
  report was logged (that request already sent the turn: append-only). Compaction records render it as `User: …`. The
  fallback reports (nothing dispatched before the run ended, an unreadable SKILL.md, storage down at dispatch) are fixed
  English texts in `runtime/subagents/skill-fork.ts`, logged like any report.
- **The compaction line** (`Skills invoked earlier in this conversation: {names}. Call Skill …`) follows the restored
  catalog after a summary whose range holds inline invocations: a person's and the template skills the kernel wrote as
  invocations at a child's start (`skill.template`), so the line names no invoker. It is computed from the log only
  (`invokedSkillNames`, the `skill` fields of covered messages), so replay renders it identically; logs without invocations
  render as before.
- **Template skills at child start** (`runtime/subagents/template-skills.ts`): a template child's `skills` are written at
  dispatch as inline invocation messages after the task (the version's `skill` record and rendered text), no longer as a
  preamble line. In the log, so no `DriftReason`: older children's logged preambles with the line still rebuild byte for
  byte, and a candidate that changes a template's skills is flagged by `subagent_changed` as before. A child case is titled by
  its task, never by these messages (`caseTitle`). Pinned by `subagents-replay.test.ts` ("an inline child starts with its
  template's skills …").
- **No new `DriftReason`**: the invocation text and the fork report are inputs fixed in the log, like the `@` resource bodies read
  with the person's credentials at send time. A baseline reconstructs them byte for byte, and a candidate agent version that no
  longer selects the invoked skill still replays the recorded message (a person's input is not the agent's to change).
  `Skill` of an invoked manual-only skill is an ordinary logged tool result.
- **Full-run replay** of a run triggered by a fork invocation never dispatches (spec A5): `runReplay` gives the loop
  `recordedSkillForks` (`runtime/subagents/skill-fork.ts`) in place of the live `skillForks`, which appends the recorded
  `skill_fork_result` and writes no `subagent_*` event, `subagent_dispatches` row or child run. A recording without a report (the
  original run was stopped before it) ends the replayed run at that point with no model call (`completed`, not `aborted`: an aborted
  replay outcome reads as a lost claim to the eval worker). Every terminal path writes a report, so a recording without one
  only arises in a crash window before the sweep; an original stopped mid-fork has a stop-text report, so its replay goes on
  to a model call the original never made (as a recorded stopped `Agent` call replays).
- **The fork child** is an ordinary phase C child case. `takeSnapshot` copies `subagent_started.template.invokedSkill` into
  `CaseSnapshot.subagent.invokedSkill` (`{ id, version, name }`), shown on the case detail (`EvalCaseDetail.invokedSkill`); its
  `parent.callId` is `skill-<seq>`. Never rendered.
- **Trajectory**: a fork invocation's run carries `skillFork: { invokedSeq, skill: { name, plugin?, arguments }, subagent?:
  { subagentId, childRunId, agentType, status }, report }` (the dispatch is at step 0 with no tool call, so it is not in `steps`).
- Coverage: `reconstruct.test.ts` (the "phase D" cases: inline invocations with a compaction, a manual-only skill's `Skill`,
  a fork with its report, and all of them together with a candidate that deselects the skills), `run-replay.test.ts` (recorded
  report, no report), `subagents-replay.test.ts` ("forked skills (phase D)": full-run replay of the parent, the child case with
  `invokedSkill`, the trajectory span) and `trajectory.test.ts`.

## Case snapshots and eval sets

- An eval set belongs to one agent (C4). An org admin adds cases from real conversations (by run) or by sampling; the run must have reached a terminal state (`eval.run_not_finished`).
- A snapshot (`evals/snapshot.ts`, stored in `eval_cases.snapshot`) = the events up to that run's terminal state + the referenced agent version definition + the tool definitions the requests used
  (by specHash); the serialized size must be <= `evals.maxCaseBytes` (`eval.case_too_large`), and each set <= `evals.maxCasesPerSet`.
  Media bytes are not copied: replay fetches the original attachment by reference, and deleted ones get a "no longer available" placeholder (`media_missing`).
- When a case is written, the replay plan is computed from the snapshot (`evals/plan.ts`, stored in `plan_step` / `plan_run`); estimation and start read only the plan columns, not the snapshot.
- Always read snapshots through `readSnapshot`: it normalizes the pre-rename `{kind:"app", appId}` to the connector form (C27).
- Deleting an eval set: cases are hard-deleted (results cascade), the set row stays as a soft-deleted stub (Ruling S1-a), runs in progress are cancelled, and the eval conversations are deleted.

## The two kinds of replay

- **Step replay** (`step-replay.ts`, C5): keeps the recorded tool definitions and swaps only the system prompt (instructions), model and params; one result per replayable model call.
  A candidate = an optional agent version + optional model / params (`modelParams`, validated against the candidate model's declarations, `eval.candidate_invalid`) / instruction override.
- **Full-run replay** (`run-replay.ts`, C6): runs the **same** `LangGraphLoop` in a hidden conversation with `kind = 'eval'`, with the tool pipeline replaced by
  `RecordedToolPipeline` (`recorded-tools.ts`):
  - **Never executes any tool**: no policy, approval, sandbox or connector, and no handler is called; it matches the first unused recording exactly on (toolKey, normalized arguments),
    and if nothing matches it returns the English error result `REPLAY_NO_RECORDING` (`isError: true`) and records `tool_unmatched`.
  - Normalized arguments leave out display-only arguments (`MATCH_IGNORED_FIELDS` in `recorded-tools.ts`: `Bash` `description`),
    so recordings made before the argument existed match calls that pass it, and the reverse; the structural diff (`diff.ts`) compares
    calls the same way (`matchKey`).
  - The candidate sees the **current** tool definitions (builtins are deployment-wide, not per agent version), so a builtin schema change (e.g. `Bash` gaining `description`) is not drift and records no `tools_changed`; step replay instead pins the recorded definitions (C5). `RecordedToolPipeline` does not validate input either, so a replayed call missing a now-required argument still gets the recorded result.
  - Seed events keep their original seq; mid-run messages absorbed during the original run are fed in at the original absorption step; after a crash, that case's old eval conversation is deleted and the case reruns from the start.
  - Finished background tasks (`background_task_finished`, background Bash spec §2.4, §4.4) are absorbable like messages (`isAbsorbable`, the loop's `pendingAbsorbable`): `build.ts` places them by the same `absorbedUpToSeq` rule and renders them as a system message (`renderBackgroundFinished`, one short line when `reported`), a full-run replay feeds recorded ones at the step that absorbed them (no task starts, polls or stops), and a wake run (`run_started.trigger: "background_task"`) is seeded from its recorded boundary (`run_started.triggerSeq`; older recordings: the newest finish after the consumed position that is neither `reported` nor a person's stop), not the last message. New input, so no `DriftReason`. A recorded background `Bash`, `TaskOutput` or `TaskStop` result replays as recorded (`run_in_background` stays in the match key), and `TaskOutput` / `TaskStop` come with `Bash` in every request, so a recording of a `Bash` agent made before them shows the expected `tools_changed`.
  - Eval conversations always return 404 on the ordinary conversation endpoints; there is no real-tool replay (D2).
- Scoring (`diff.ts`, `judge.ts`): structural diff (tool calls / arguments, text LCS similarity, C8) + an optional LLM judge + manual pass / fail in the viewer.
  The judge uses the model purpose `eval` (`model_purpose_mappings`, deployment default, overridable per org; judge enabled but not mapped -> `model.unconfigured`),
  with an output cap of `evals.judgeMaxOutputTokens`; the content being compared is placed in the user message as data only.

## Eval queue, concurrency and token caps

- Queue `cap-kernel-evals`, one job per case, `eval-<runId>-<caseId>` (queue names and job ids contain no `:`), consumed only on the `worker` role,
  `evals.workerConcurrency` jobs per replica. The per-org concurrency quota is the Redis ZSET `capk:org-evals:<orgId>`, capped by `evals.orgConcurrency`
  (default 2, hot-reloadable); a job that can't get quota is delayed by 5 seconds.
- The pre-run estimate (`POST .../runs/estimate`, D5) gives the expected request count, tokens, and the default / max / effective cap; `tokenCap` defaults to
  `evals.defaultTokenCap` and must not exceed `evals.maxTokenCap` (`eval.token_cap_invalid`).
- Accounting (`budget.ts`): usage = input + output + cache read + cache write; `consumeTokens` accumulates atomically in PG `eval_runs.tokens_used`,
  and the run is set to `capped` once the total reaches the cap, after which no new requests are sent; in-flight requests may exceed it (at most one extra per concurrent job). **Attempts that fail after being sent are
  likewise counted by estimate**, and requests already sent by an old execution that lost its claim are counted too (Ruling P2); judge requests count as well.
- Before every model request, check that the run is still active (not cancelled / not capped / org and agent not deleted) and still holds the claim; results are written by claim number. After
  `evals.maxConsecutiveErrors` consecutive error results the run is `failed`. A set whose agent was deleted can no longer be estimated or started (`agent.not_found`).
- When a provider extension is revoked / upgraded / reloaded mid-request (`ExtensionUnloadedError`, for example after changing a non-hot deployment config): handled like the runtime, as a retryable
  `run.provider_unavailable`; step replay and judge requests both retry (failed attempts are still counted by estimate), and the retry picks up the new instance live; no error is recorded and the circuit breaker is untouched. Run states: `queued` / `running` / `completed` / `cancelled` /
  `capped` / `failed`; result states: `pending` / `running` / `done` / `error` / `skipped`.

## Trajectory viewer and privacy

- After `trajectories.read` (member and up), the service additionally checks "org admin or the agent's owner" (the owner is read live); eval replay conversations
  (`kind = 'eval'`) are visible only to org admins (Ruling S1-c). **No permission and does not exist both return 404** (`trajectory.not_found`).
- Every view of trajectory details or eval case details writes the audit entry `trajectory.viewed`. Eval data has no export endpoint. Super admins cannot read conversations by default.
- Latency is derived from event `created_at`, with no new event fields (C2): model latency = that step's `usage` - `model_call`, tool duration = `tool_result` -
  `tool_call_started`, approval wait = `approval_decided` - `approval_requested`. Cost is computed at read time from PG `model_prices` (per million tokens, currency =
  the deployment setting `priceCurrency`), is not written to the log, is labeled "estimated" in the UI, and shows "—" when there is no price.
- A compaction call logs its own `usage` event with `purpose: "compaction"` (written with
  `compaction_summary` / `compaction_failed`, before the step's `model_call`). It is not a step call:
  anything that pairs `usage` with a step's `model_call` (estimate calibration, trajectory steps,
  step-replay baselines, `plan_step`) must skip it; run totals (trajectory `totals`, `plan_run`,
  full-run replay summaries) include it, since it is real spend. It is not model-visible and needs no
  `DriftReason`.
- A conversation title call (UI refresh B, `conversations/titles.ts`, queue `cap-kernel-titles`,
  model purpose `title`) logs its own `usage` event with `purpose: "title"`, `step` 0 and no run
  (`runId` null). It is not model-visible to the agent (request building skips `usage`), needs no
  `DriftReason`, and replays never run it (eval conversations have `kind = 'eval'`; seed events
  copy it as data only). Step consumers skip every `usage` with a `purpose`; it belongs to no run,
  so run totals never see it; `usage.report` delivers it with `purpose: "title"` and `runId: ""`.
  Titles are generated after a completed run; a rename always wins (the generated title is written only while
  `title_source IS NULL`), and titles reject control, bidi and other format characters (ZWJ / ZWNJ allowed; `packages/kernel/src/text.ts`).

## Hooks and replays

- `hook_denied` events are **not model-visible**: `runtime/context/build.ts` skips them. A
  `tool.preExecute` denial reaches the model as the denied call's `tool_result` text, which is already
  in the log, so it needs **no `DriftReason`**. A model-path denial ends the step with a `RunError`
  and puts nothing in a request.
- Replays fire no extension hooks, twice over: `runReplay` strips `hooks` from the loop deps, and the
  loop runs with `conversationKind: "eval"` (hooks only fire for `"chat"`).
- The one exception is metering: usage of a **full-run** replay is still enqueued to `usage.report`
  and delivered with `conversationKind: "eval"`; single-step replays and judge calls are not reported.
- The trajectory shows denials: `toolCalls[].hookDenied` and `steps[].modelHookDenied`.

## Web tools and replays

- `WebFetch`'s extraction logs a `usage` event with `purpose: "web_fetch"` and the call's `callId`. It is **not model-visible** (`build.ts` skips usage events), so it needs **no `DriftReason`**. Trajectory building counts it in the totals and keeps it out of step pairing, like a compaction or title call's usage (`evals/trajectory.ts`).
- `WebSearch`'s date line is part of the recorded `tool_result`, so a replay shows the date of the original call. Full-run replay uses recorded results only: it never calls a web provider or the extraction model, and fires no hooks.

## Tests

- Unit / HTTP: `packages/kernel/test/evals/` (`reconstruct`, `step-replay`, `run-replay`, `runs`, `judge`, `diff`, `sets.*`,
  `trajectory.*`), `packages/kernel/test/runtime/tool-map-render.test.ts` (map texts) and
  `packages/kernel/test/catalog/claude-superpowers.e2e.test.ts`. To compare reconstructed requests with real ones, install
  `captureProviderRequests()` (`test/helpers/provider-capture.ts`) before the kernel starts. For a deterministic judge verdict,
  map the `eval` purpose to a fake model extension in the test (such as `judge-gate` in `m6-segment1.dual.test.ts`).
- Dual-replica: `runs.dual.test.ts` (org concurrency 1 / 2, `capped` after the limit and the bound on overshoot), `m6-segment1.dual.test.ts` (conversation -> trajectory ->
  eval set -> killing a replica mid step replay -> full-run over the limit -> labeling).
- Always run vitest from the repo root (`pnpm exec vitest run <path>`): the root config carries the `@capybara-hq/source` condition that dual-replica tests need to load extensions from source.
