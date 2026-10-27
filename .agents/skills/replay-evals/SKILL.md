---
name: replay-evals
description: Use when changing request building (runtime/context/build.ts, model-call.ts, anything model-visible in the event log), the trajectory viewer, or evals (packages/kernel/src/evals - eval sets, case snapshots, step / full-run replay, the judge, eval runs). Covers the replay invariant and the zero-drift fixture tests (reconstruct.test.ts, rename-compat.test.ts), new model-visible input going into the log with a DriftReason, pinned skills and the Claude Code tool map in the skills_catalog snapshot (pinned_changed), full-run replay using only recorded tool results (RecordedToolPipeline, never executes tools), the eval queue cap-kernel-evals and per-org concurrency, token caps and accounting, the judge's purpose eval, the privacy rules (trajectory 404, trajectory.viewed audit, no export), and how extension hooks interact with replays (hook_denied is not model-visible and needs no DriftReason, replays fire no hooks, compaction usage events).
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
- **Run both zero-drift test groups before and after changing request building**:
  - `packages/kernel/test/evals/reconstruct.test.ts` ("baseline zero drift": multi-step tools, `tool_search` loading, approval resume, skill catalog snapshot,
    reminders, mid-run messages, compaction, images / placeholders, and so on; it reconstructs from logs produced by real runs and requires `drift` to be empty and the reconstructed request to equal the one sent to the model at the time);
  - `packages/kernel/test/tools/rename-compat.test.ts` (fixtures recorded before the T22 rename, in `test/evals/fixtures/pre-rename/`; the old form
    `{kind:"app", appId}` and `appId` event fields must show zero drift).
  Run from the repo root: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`.
- **Any new model-visible input must go into the log** (written into an event or the `model_call` record); request building must not read PG / config / the clock on the spot.
  Also add a matching reason to `DriftReason` (`reconstruct.ts`, and add it to `DRIFT_ORDER` in order). It marks "an old log has no record of this"
  or "it can't be fetched at reconstruction", and add a case to the "drift reasons" group in `reconstruct.test.ts`. Existing reasons: `system_hash`,
  `tools_changed` (baseline check only), `tool_spec_missing`, `definition_missing`, `pinned_changed` (step replay, see "Pinned skills and the tool map"),
  `subagent_changed` (child cases, see "Sub-agents"), `legacy_event`, `params_changed`, `media_missing`, `media_changed` (baseline check only), `tool_unmatched` (full-run replay).
- The history sent to the model is append-only; model-visible text that appears in replay (such as `REPLAY_NO_RECORDING`) is always English.

## Pinned skills and the tool map (phase B)

- The `skills_catalog` event carries, besides `skills` (each with `plugin`, the catalog item name, when the skill came from a plugin):
  `pinned: [{ id, version, name, source, body }]` (≤ 3, the agent's order, bodies read from storage at run start) and `toolMap` (the fixed
  English Claude Code tool-name map, present iff a skill has source format `claude-code`). Request building renders only these fields:
  the pinned header and `<pinned_skill name=… version=…>` blocks after the catalog in the system segment; when a later snapshot changes the
  pinned set or the map, an append-only system notice (full body of each new / changed entry, names of removed ones; pinned ids are left out
  of the "Updated skills" list); after compaction the current pinned set and map are restored with the catalog. Code:
  `runtime/context/skills.ts`, `runtime/context/claude-tools.ts`, `skills/catalog.ts` (`recordSkillsCatalog`, `loadPinnedBodies`, `fitPinned`).
- **Old logs render byte for byte as before**: a snapshot without `plugin` / `pinned` / `toolMap` means none, and a run on such a conversation
  writes no new snapshot or notice when nothing changed. The bodies and the map are in the log, so a baseline can never miss them and they
  need no drift reason of their own.
- `pinned_changed`: for a non-baseline reconstruction without `definition_missing`, the candidate's `skills.pinned` (deduplicated, capped at 3)
  differs from the **original agent version's** `skills.pinned` (same normalisation); only when that definition is missing are the recorded
  snapshot's pinned ids compared. The request still uses the recorded bodies (a step replay never reads storage).
- **Changing the map text** (phase C changed the `Task` / `Agent` line and added `TaskOutput, TaskStop`, sub-agents spec §16.5): old
  snapshots keep their text and reconstruct byte for byte; a conversation's next run writes a new snapshot (the map differs) and the request
  gets the "The following tool-name map now applies:" notice, all from the log. `reconstruct.test.ts` "an old snapshot keeps its old map
  text; a new snapshot gets the new one" pins this; run the zero-drift tests before and after any change to `claude-tools.ts`.
- Full-run replay copies the run's `skills_catalog` (with `pinned` and `toolMap`) unchanged into the eval conversation.
- Zero-drift coverage: `reconstruct.test.ts` "pinned skills, a pinned version change mid-conversation, a claude-code skill with the tool map,
  and a compaction" and the drift-group `pinned_changed` cases; the phase B acceptance `packages/kernel/test/catalog/claude-superpowers.e2e.test.ts`
  (a superpowers import, an agent pinning `using-superpowers`, `skill_load` by qualified and plain name, then every `model_call`
  reconstructed with `drift: []` and equal to what the provider received, and a full-run replay sending the same requests).
  Both capture provider requests with `packages/kernel/test/helpers/provider-capture.ts`.

## Sub-agents (phase C, sub-agents spec §15)

- **Parent requests** change only through the `agent` tool definition (by spec hash) and its `tool_result` text; `subagent_*` events
  are not model-visible and request building skips them, so a log without them builds byte-identically.
- **Parent full-run replay** needs nothing special: `RecordedToolPipeline` matches each `agent` call by `(toolKey, canonical input)` and
  returns the recorded result (the child's reply and status line); it always returns `done`, so the parent never suspends, **no child is
  started**, no `subagent_*` event or `subagent_dispatches` row is written and child tokens are not spent. Parallel calls replay in the same
  step; a `resume` matches because the recorded status line gave the model the same `agentId`. Pinned by
  `test/evals/subagents-replay.test.ts` (three parallel calls and a resume: same requests, zero `tool_unmatched`).
- **A child is an ordinary case** (`addCase` accepts `kind = 'subagent'`; sampling stays `chat` only), listed under its conversation's
  agent: the parent's for `general` / inline / plugin templates, the dispatched org agent's (its `runs.agent_version`) for an org agent.
  `takeSnapshot` copies `subagent: { definition, preamble }` from `subagent_started` and `parent` (the dispatching call, from
  `subagent_dispatches`; navigation only, shown on the case detail). `caseBase` uses the logged definition (model included), never
  `definitions`; a child step therefore never gets `definition_missing` or `pinned_changed`. For a follow-up's run the
  snapshot's definition carries that run's narrowing (`user_message.dispatch.narrowed` on its task message: the frozen tools and
  `orgSkills` intersected with the current version at the `resume`), as the run itself used.
- **Child requests** render the logged preamble and instructions (`build.ts` reads `subagent_started`), also under a candidate.
  `subagent_changed` (`reconstruct.ts` `subagentChanged`, pure): a candidate whose effective definition differs from the logged one in
  instructions, pinned skills or tools: the same version with an instruction override; another version of the case's agent (an org agent's
  next version; for templates the parent's version: `general` takes its instructions and tools, `inline` its template of that name, gone =
  changed); a plugin template's current version (`ReconstructOptions.subagentTemplate`, read by the worker; removed = version 0). Model
  and params are separate candidate axes. Template narrowing that needs the database is not recomputed; instead, from the
  snapshot alone, an `inline` child compares its whole template between the case's version and the candidate's, and a `general` /
  `plugin` child also compares the parent's `tools`, `orgSkills` and roster entry (`subagents.general`, the selected template);
  any difference counts.
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
- **Child full-run replay** runs the logged definition with the candidate's model and params only, and the logged `maxSteps`; the
  run result's drift gets `subagent_changed` by the same rule (`subagentCaseChanged`).
- **Trajectory**: an `agent` call carries `subagent: { subagentId, childRunId, agentType, resumed, status }` (`running` until its
  `subagent_finished`); a child's detail carries `conversation.parent` (the first dispatching call). A child's access is its parent's
  (the parent conversation's agent owner or an org admin; the dispatched org agent's owner gets 404, and a non-admin viewer of an
  org agent child must also still see that agent, as on the conversation read path), so a link never exposes a child the
  viewer cannot open.

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
  - Seed events keep their original seq; mid-run messages absorbed during the original run are fed in at the original absorption step; after a crash, that case's old eval conversation is deleted and the case reruns from the start.
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
- Every view of trajectory details or eval case details writes the audit entry `trajectory.viewed`. Eval data has no export endpoint. Enterprise admins cannot read conversations by default.
- Latency is derived from event `created_at`, with no new event fields (C2): model latency = that step's `usage` - `model_call`, tool duration = `tool_result` -
  `tool_call_started`, approval wait = `approval_decided` - `approval_requested`. Cost is computed at read time from PG `model_prices` (per million tokens, currency =
  the deployment setting `priceCurrency`), is not written to the log, is labeled "estimated" in the UI, and shows "—" when there is no price.
- A compaction call logs its own `usage` event with `purpose: "compaction"` (written with
  `compaction_summary` / `compaction_failed`, before the step's `model_call`). It is not a step call:
  anything that pairs `usage` with a step's `model_call` (estimate calibration, trajectory steps,
  step-replay baselines, `plan_step`) must skip it; run totals (trajectory `totals`, `plan_run`,
  full-run replay summaries) include it, since it is real spend. It is not model-visible and needs no
  `DriftReason`.

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

## Tests

- Unit / HTTP: `packages/kernel/test/evals/` (`reconstruct`, `step-replay`, `run-replay`, `runs`, `judge`, `diff`, `sets.*`,
  `trajectory.*`), `packages/kernel/test/runtime/pinned-render.test.ts` (pinned / map texts) and `packages/kernel/test/catalog/claude-superpowers.e2e.test.ts`.
  To compare reconstructed requests with real ones, install `captureProviderRequests()` (`test/helpers/provider-capture.ts`) before the kernel starts. For a deterministic judge verdict, map the `eval` purpose to a fake model extension in the test (such as `judge-gate` in
  `m6-segment1.dual.test.ts`).
- Dual-replica: `runs.dual.test.ts` (org concurrency 1 / 2, `capped` after the limit and the bound on overshoot), `m6-segment1.dual.test.ts` (conversation -> trajectory ->
  eval set -> killing a replica mid step replay -> full-run over the limit -> labeling).
- Always run vitest from the repo root (`pnpm exec vitest run <path>`): the root config carries the `@capybara-hq/source` condition that dual-replica tests need to load extensions from source.
