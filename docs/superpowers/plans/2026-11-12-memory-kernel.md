# Memory: Kernel Mechanisms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give extensions the three general mechanisms the memory plugin needs (a `context@1`
extension point, the conversation source with per-source tools, durable lifecycle hooks) and ship
pgvector in the images.

**Architecture:** The SDK gains the public types first; the kernel stores `conversations.source` at
creation, filters extension tools by `ToolSpec.sources`, calls `context@1` providers at run start
and records their text as a model-visible `plugin_context` event, and delivers three lifecycle
hooks through a transactional outbox plus a BullMQ queue. Nothing in core is memory-specific.

**Tech Stack:** TypeScript, NestJS, Kysely, PostgreSQL 17 (+ pgvector), BullMQ / Valkey, vitest,
testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-12-memory-plugin-design.md` (§6 is this plan; §4, §5.4,
§6.5 constrain it). The plugin side is `docs/superpowers/plans/2026-11-12-memory-plugin.md`.

## Global Constraints

- English for code, comments, tests and model-visible text; touched comments translated, no bulk
  translation (AGENTS.md "Language").
- Applied migrations are immutable; new files are `NNNN_<snake_desc>.sql` with `IF [NOT] EXISTS`
  (writing-migrations skill). This plan uses `0118` (source), `0119` (lifecycle), `0120` (pgvector); renumber if `main` moved.
- Multi-replica: no in-process state; queue names and job ids contain no `:`; enqueues in
  `afterCommit`; consumers only under `WorkerModule`; periodic work `@LockedInterval`.
- Kernel conventions: `@Injectable`, explicit `@Inject` on every constructor parameter
  (`pnpm check:kernel-conventions`).
- SDK public API change → `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`; image
  change → a changeset on `@capybara-hq/capybara`.
- `ConversationSource = "web" | "channel_dm" | "channel_group" | "subagent"` (spec §6.2).
- `context@1`: multi, brokered, orgScoped; provider timeout **2000 ms**; text cap **32 KB** (UTF-8
  bytes) per provider; fail open (spec §6.1).
- Lifecycle mounts: `org.member_removed {orgId, accountId}`, `agent.deleted {orgId, agentId}`,
  `org.deleted {orgId}`; observe only; delivered whether or not the org enabled the plugin
  (spec §6.3).
- Run the zero-drift tests before and after touching request building:
  `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`.
- Tests run from the repo root: `pnpm exec vitest run <path>`.

## Review Focus

1. **A group scheduled task's conversation must be `channel_group` from its first run**, although
   its thread binds only on the first outbound post → Task 2 pins it with a fire-path test.
2. **A provider that hangs past 2 s or throws must not delay or fail the run**, and its earlier
   text stays in history → Task 5 tests a hanging provider and a throwing one.
3. **Same text on the next run writes no new event; changed text writes one; `null` after text
   writes an empty event that stops re-emission after compaction** → Task 4/5 tests.
4. **A lifecycle delivery for a plugin disabled in that org still arrives, exactly once across two
   replicas, and survives a lost enqueue** (sweeper) → Task 6 dual-replica test.
5. **A sub-agent run and an eval replay never call providers**; a replay rebuilds `plugin_context`
   byte for byte → Task 4/5 tests.

---

### Task 1: SDK public types

**Files:**
- Modify: `packages/plugin-sdk/src/tool.ts` (ToolSpec, ToolCallContext)
- Modify: `packages/plugin-sdk/src/extension-point.ts` (`context` entry, `CONTEXT_EXTENSION_POINT`)
- Create: `packages/plugin-sdk/src/context.ts` (provider types)
- Modify: `packages/plugin-sdk/src/hooks.ts`, `packages/plugin-sdk/src/permissions.ts` (mounts)
- Modify: `packages/plugin-sdk/src/index.ts` (exports)
- Test: `packages/plugin-sdk/test/context.test.ts`, existing tool / hooks / permissions tests
- Create: `.changeset/memory-kernel-sdk.md`

**Interfaces:**
- Produces:
  - `export const CONVERSATION_SOURCES = ["web","channel_dm","channel_group","subagent"] as const; export type ConversationSource` (in `tool.ts`).
  - `ToolSpec.sources?: ConversationSource[]` — absent = every source.
  - `ToolCallContext` new optional fields: `source?: ConversationSource; ownerAccountId?: string; role?: "owner" | "admin" | "member" | "guest"` (doc: kernel always passes them; `accountId` stays the run's trigger account).
  - `export const CONTEXT_EXTENSION_POINT = "context@1"`; `EXTENSION_POINTS.context = info([1], "Adds text to the model's context at run start in conversations of orgs that enable it.", "multi", true, true)`.
  - In `context.ts`: `ContextRequest` (fields exactly as spec §6.1, including `ownerAccountId`, `agentName`, `ownerName`, `tools`), `ContextResult = { text: string } | null`, `interface ContextProvider { provide(req: ContextRequest): Promise<ContextResult> }`, `CONTEXT_LIMITS = { timeoutMs: 2000, maxBytes: 32768 } as const`.
  - `LIFECYCLE_HOOKS = ["org.member_removed","agent.deleted","org.deleted"] as const`; appended to `HOOKS_AVAILABLE` and `HOOK_MOUNT_POINTS`; `HookPayloads` gains `OrgMemberRemovedPayload {orgId; accountId}`, `AgentDeletedPayload {orgId; agentId}`, `OrgDeletedPayload {orgId}`. Not in `POLICY_HOOKS`.
  - `validateToolSpec` (or the existing spec checker) rejects an empty `sources` array and unknown values.

- [ ] **Step 1: Write failing tests**: `context.test.ts` asserts `EXTENSION_POINTS.context` is `{majors:[1], cardinality:"multi", brokered:true, orgScoped:true}` and `CONTEXT_LIMITS` values; in the tool spec test, `sources: []` and `sources: ["dm"]` are rejected, `["web","channel_dm"]` accepted; in the hooks test, `checkHookRegistration`-level SDK validation accepts `"agent.deleted"` observe and rejects it with `mode: "policy"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test` — Expected: the new cases FAIL.
- [ ] **Step 3: Implement the types and validation above.**
- [ ] **Step 4: Run** the same command — Expected: PASS. Then `pnpm gen:sdk-api` and `pnpm check:sdk-api`.
- [ ] **Step 5: Add the changeset** (`@capybara-hq/plugin-sdk: minor`, "context@1, conversation source, lifecycle hooks") and commit `feat(sdk): add context@1, conversation sources and lifecycle hooks`.

### Task 2: `conversations.source`

**Files:**
- Create: `packages/kernel/src/migrations/0118_conversation_source.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (column type)
- Modify: `packages/kernel/src/conversations/conversations.service.ts` (`create`, `createWithMessage` take `source`)
- Modify: `packages/kernel/src/channels/inbound.ts:266`, `packages/kernel/src/schedules/fire.ts` (`:290`, `:366`, `:410`), `packages/kernel/src/runtime/subagents/dispatch.ts:247`
- Test: `packages/kernel/test/migrations/0118.test.ts`, `packages/kernel/test/conversations/source.test.ts`

**Interfaces:**
- Consumes: `ConversationSource` (Task 1).
- Produces: `conversations.source text NOT NULL DEFAULT 'web' CHECK (source IN (…4 values))`; `ConversationsService.create(orgId, accountId, agentId, pick, opts?: { source?: ConversationSource })` and `createWithMessage(…, internal: InternalMessageOptions & { source?: ConversationSource })`; `export async function conversationSourceOf(db, conversationId): Promise<ConversationSource>` in `conversations/source.ts`.

- [ ] **Step 1: Write failing tests.** `0118.test.ts`: seed a conversation with a `channel_threads` row `thread_key = 'dm:u1'` **archived**, one with a group thread key, one `kind='subagent'`, one plain; after the migration they are `channel_dm`, `channel_group`, `subagent`, `web`. `source.test.ts`: inbound DM → `channel_dm`; inbound group → `channel_group` (from `e.target.chatType`, `inbound.ts:210`); scheduled task with `chat.chatType = "group"` fired once → its new conversation is `channel_group` **before any outbound post**; DM task → `channel_dm`; `new` mode → `web`; sub-agent dispatch → `subagent`; web create → `web`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/migrations/0118.test.ts packages/kernel/test/conversations/source.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write the migration** (add column, backfill in the order subagent → channel thread rows of any archive state by `thread_key LIKE 'dm:%'` → rest web, add the CHECK) **and pass `source` at each creation site.** The scheduled-task sites read `task.chat.chatType`.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): record each conversation's source`.

### Task 3: Per-source tools and the richer tool call context

**Files:**
- Modify: `packages/kernel/src/tools/registry.ts` (`forAgent` def gains `source`; filter in the plugin-tool loop near `:689`)
- Modify: `packages/kernel/src/runtime/model-call.ts:403` (pass the source)
- Modify: `packages/kernel/src/tools/pipeline.ts` (`ToolStepContext` gains `source`, `ownerAccountId`, `role`; `execute` passes them in the base context near `:1510`; a resumed call of a filtered tool is refused like an off tool)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (load `conversations.source`, `account_id` and the trigger account's membership role once per run)
- Test: `packages/kernel/test/tools/tool-sources.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 column.
- Produces: `forAgent(orgId, { …, source?: ConversationSource })` — absent = `"web"`; an extension tool whose `spec.sources` excludes the source goes to `hidden` with reason `Not available in <source> conversations`. Plugin handlers receive `source`, `ownerAccountId`, `role`.

- [ ] **Step 1: Write failing tests** with `fake-tools-ui` (add a tool `web-only` with `sources: ["web","channel_dm"]` to the fixture): `forAgent(…, {source:"channel_group"})` hides it with that reason; `"web"` lists it; a sub-agent run (`source:"subagent"`) hides it; the handler of a called tool sees `source`, `ownerAccountId` (the conversation's `account_id`), `accountId` (the trigger account) and `role`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/tool-sources.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `packages/kernel/test/tools/extension-tools.http.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): filter extension tools by conversation source`.

### Task 4: The `plugin_context` event in request building and replay

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts` (schema after `run_context`, `:581`)
- Create: `packages/kernel/src/runtime/context/plugin-context.ts` (render + fold helpers)
- Modify: `packages/kernel/src/runtime/context/build.ts` (case near `:832`; re-emit after a summary near `:764`; header comment list)
- Modify: `packages/kernel/src/evals/run-replay.ts` (seed like `run_context`, `:159`, `:262`, `:479`)
- Test: `packages/kernel/test/runtime/context/plugin-context.test.ts`, a case in `packages/kernel/test/evals/reconstruct.test.ts` ("baseline zero drift" with a `plugin_context` event, before and after a summary)

**Interfaces:**
- Produces:
  - Event `plugin_context` payload `{ plugin: string (1–64), text: string (≤ 32768 bytes), hash: string (sha256 hex of text) }`, model-visible.
  - `pluginContextText(p): string` → `""` for empty text, else `<plugin-context plugin="${plugin}">\n${text}\n</plugin-context>`.
  - `latestPluginContexts(events, uptoSeq): Map<string, PluginContextPayload>` (last per plugin).
  - Rendering: at its position as `{role:"system"}` (skip empty text); after a summary, the latest non-empty one per plugin, in plugin-name order, after `device_paths` and before the skills re-emit.

- [ ] **Step 1: Run the zero-drift tests** (Global Constraints) — Expected: PASS (baseline).
- [ ] **Step 2: Write failing tests**: rendering at position; empty text renders nothing; two plugins after a summary in name order; a covered empty event suppresses the earlier text after the summary; reconstruct zero drift with the event; full-run replay copies the original run's `plugin_context` events into the eval conversation.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/runtime/context/plugin-context.test.ts packages/kernel/test/evals/reconstruct.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement.** No `DriftReason` (spec §6.1); update the replay-evals skill's list of in-log events with one line for `plugin_context`.
- [ ] **Step 5: Run** the new tests and both zero-drift tests — Expected: PASS.
- [ ] **Step 6: Commit** `feat(kernel): render plugin_context events`.

### Task 5: Calling `context@1` providers at run start

**Files:**
- Modify: `packages/kernel/src/extensions/point-defaults.ts` (public `providersFor<T>(orgId, point)` over the existing private `candidates`)
- Create: `packages/kernel/src/runtime/plugin-context.service.ts` (`PluginContextService`)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (call after `runContext.record`, `:708`) and the runtime module providers
- Create: `packages/testing/fixtures/extensions/fake-context/` (provides `context@1`; behaviour driven by its deployment config: `text`, `mode: "ok"|"null"|"throw"|"hang"`; registers one tool `note` with `sources: ["web","channel_dm"]`)
- Test: `packages/kernel/test/runtime/plugin-context.test.ts`

**Interfaces:**
- Consumes: Task 1 `ContextProvider`, `CONTEXT_LIMITS`; Task 2 source; Task 3 role and owner; Task 4 event.
- Produces: `PluginContextService.record(input: { orgId; conversationId; runId; agentId; agentName; ownerAccountId; ownerName; triggerAccountId; source; role; kind: "chat"|"eval"|"subagent"; toolKeysByPlugin: Map<string,string[]>; signal }): Promise<void>`.
  - Skips entirely unless `kind === "chat"`.
  - Calls every `providersFor(orgId, "context")` in parallel **outside any transaction**, each with `AbortSignal.any([signal, AbortSignal.timeout(2000)])` and its effective org config; `tools` = that plugin's keys in the run's resolved tool set (computed with `forAgent` once).
  - Drops (and logs at `warn`, `context=PluginContextService`, plugin, reason) a throw, a timeout or text over 32 KB.
  - Then one `@Transactional` append under the conversation row `FOR UPDATE`: for each plugin, compare `sha256(text)` (null → `""`) with `latestPluginContexts`; append differing ones with idem key `plugin_context-<runId>-<plugin>`; a plugin with no earlier event and `null` writes nothing. `notify` after commit.
  - A provider that is no longer enabled but has a non-empty latest event gets an empty event (the plugin was switched off).

- [ ] **Step 1: Write failing tests** with `fake-context` enabled in an org: first run appends `plugin_context` with the text; second run with the same text appends nothing; changed text appends one; `mode:"null"` after text appends an empty event; `throw` and `hang` → the run finishes normally within its usual time, no event, a warn log; text over 32 KB → dropped; a sub-agent run and an eval run → provider never called (spy); disabling the plugin in the org → next run appends an empty event; `tools` lists `plugin__fake-context__note` in a web conversation and is empty in a group one.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/plugin-context.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the service, `providersFor`, the fixture and the run-worker call. The import review's permission view (`packages/kernel/src/extensions/permission-view.ts`) shows `provides context@1` as "Adds text to the model's context in conversations of orgs that enable it" (zh: "在启用它的组织的对话中，向模型上下文加入文本").
- [ ] **Step 4: Run** the test, `packages/kernel/test/runtime/run-worker.test.ts` and the zero-drift tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): call context@1 providers at run start`.

### Task 6: Durable lifecycle hooks

**Files:**
- Create: `packages/kernel/src/migrations/0119_lifecycle_deliveries.sql`
- Create: `packages/kernel/src/extensions/lifecycle-hooks.ts` (`LifecycleHooks` service: `recordIn`, `enqueue`, consumer, sweeper)
- Modify: `packages/kernel/src/extensions/hooks.ts` (`handlers(mount)` accepts lifecycle mounts as it does `usage.report`; `run` excludes them)
- Modify: `packages/kernel/src/orgs/offboarding.ts` (`offboard` records, `afterOffboard` enqueues), `packages/kernel/src/agents/agents.service.ts` (`softDeleteLocked`), `packages/kernel/src/orgs/orgs.service.ts` (`softDelete`)
- Modify: the worker module (consumer + `@LockedInterval` sweeper), `KernelConfigSchema` only if a knob is needed (prefer constants)
- Modify: `packages/testing/fixtures/extensions/fake-context/` (observe all three mounts; append each payload to a table in its schema)
- Test: `packages/kernel/test/extensions/lifecycle-hooks.test.ts`, `packages/kernel/test/extensions/lifecycle-hooks.dual.test.ts`

**Interfaces:**
- Consumes: Task 1 mounts and payloads.
- Produces:
  - Table `capybara.lifecycle_deliveries (id uuid pk, mount text, payload jsonb, plugin text, created_at timestamptz default now(), delivered_at timestamptz null, attempts int default 0)`, index on `(delivered_at) WHERE delivered_at IS NULL`.
  - `LifecycleHooks.recordIn(mount, payload): Promise<string[]>` — `@Transactional({propagation:"mandatory"})`; one row per plugin whose **approved manifest** declares the mount in `permissions.hooks` (deployment state, not org enablement); returns ids.
  - `LifecycleHooks.enqueue(ids)` — in `afterCommit`; queue `cap-kernel-lifecycle`, job id `lifecycle-<deliveryId>`, attempts 10, exponential backoff from 5 s.
  - Consumer: loads the row, finds the loaded plugin's handler via `HookRegistry.handlers(mount)`, calls it with a 5 s timeout, sets `delivered_at`; not loaded on this replica → throw to retry; row older than 7 days and undelivered → mark delivered with a warn log (the plugin is gone).
  - Sweeper `@LockedInterval` every 60 s: re-enqueue undelivered rows older than 30 s with the same job id; delete delivered rows older than 7 days.

- [ ] **Step 1: Write failing tests**: removing a member records one row per subscribing plugin and the fixture receives `{orgId, accountId}` once; agent soft delete → `{orgId, agentId}`; org soft delete → `{orgId}`; the fixture **disabled in that org** still receives; a rolled-back offboarding records nothing; a handler that throws twice then succeeds is delivered once (attempts 3); dual replica: an enqueue dropped on purpose (test seam) is delivered by the sweeper exactly once.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/extensions/lifecycle-hooks.test.ts packages/kernel/test/extensions/lifecycle-hooks.dual.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** migration, service, wiring at the three call sites (record inside their transactions, enqueue in their after-commit paths).
- [ ] **Step 4: Run** the tests plus `packages/kernel/test/orgs` and `packages/kernel/test/agents` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): deliver lifecycle hooks durably`.

### Task 7: pgvector in the images and the database

**Files:**
- Modify: `docker/compose.yaml:85`, `docker/compose.dev.yaml:5`, `packages/testing/src/containers.ts:118` → `pgvector/pgvector:pg17`
- Create: `packages/kernel/src/migrations/0120_pgvector.sql`
- Modify: `docs/deploy/` (the PG requirements page: pgvector recommended, not required; what falls back)
- Create: `.changeset/memory-pgvector-image.md` (`@capybara-hq/capybara: patch`)
- Test: `packages/kernel/test/migrations/0120.test.ts`

**Interfaces:**
- Produces: after 0120, `vector` is installed in `public` when available and creatable; otherwise the migration is a no-op with a notice.

- [ ] **Step 1: Write failing tests**: on the pgvector container, after 0120 `SELECT extnamespace::regnamespace FROM pg_extension WHERE extname='vector'` is `public`, and `SET search_path = plugin_x, public; SELECT '[1,2]'::vector <=> '[1,3]'::vector` works; with the extension pre-installed in schema `other`, 0120 leaves it there and succeeds; as a role without `CREATE` on the database, 0120 succeeds (notice only); on a plain `postgres:17` container (`describe` that starts one), 0120 succeeds and installs nothing.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/migrations/0120.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write the migration** as one `DO $$ … $$` block: return when `NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='vector')` or `EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')`; else `EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector SCHEMA public'` inside `BEGIN … EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE …`. Switch the images.
- [ ] **Step 4: Run** the test and `docker compose -f docker/compose.dev.yaml up -d` then `pnpm dev:kernel` once (migrations apply; `grep -i vector /tmp/capybara-dev-kernel.log`) — Expected: PASS, kernel starts.
- [ ] **Step 5: Commit** `feat(docker): ship pgvector and enable it when available`.

### Task 8: Docs and skills

**Files:**
- Modify: `.agents/skills/writing-extensions/SKILL.md` (`context@1`; lifecycle hooks: durable, delivered regardless of org enablement, idempotent handlers)
- Modify: `.agents/skills/writing-tools/SKILL.md` (`ToolSpec.sources`, the new `ToolCallContext` fields)
- Modify: `.agents/skills/replay-evals/SKILL.md` (if not done in Task 4)
- Modify: `docs/architecture.md` (the new extension point in the list)

- [ ] **Step 1: Write the lines**, one paragraph each, citing the files above.
- [ ] **Step 2: Run** `pnpm check` and `pnpm verify` — Expected: PASS.
- [ ] **Step 3: Commit** `docs: describe context@1, tool sources and lifecycle hooks`.
