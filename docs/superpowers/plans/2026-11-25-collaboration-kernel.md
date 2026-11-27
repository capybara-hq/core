# Collaboration: Kernel Implementation Plan (automations, events, acceptance, inbox)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. With more than five tasks, layer `wave-planned-subagent-development` on top. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kernel everything the `collab` plugin needs: scheduled tasks renamed to
automations, event triggers emitted by extensions, one conversation per subject, a person's
acceptance of work addressed to them, personal inbox items, and a run lifecycle hook.

**Architecture:** Three PRs in order. PR A renames scheduled tasks to automations (no behavior
change). PR B adds the `event` trigger: `ctx.triggers.emit` writes `trigger_events` and owes a
dispatch job; the dispatcher matches event automations through the plugin's `trigger-source@1`
provider and ends in today's claim/start fire path with a new `subject` mode. PR C adds directed
events with acceptance rules and offers, personal `inbox_items` (`ctx.inbox`), `ctx.agents`,
`ctx.conversations`, and the `run.lifecycle` hook.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely + Postgres, BullMQ through the
transactional outbox, zod (`createZodDto`), Next web app on `@capybara-hq/design`, vitest
(`kernel-unit`, `kernel-integration`, `kernel-container`).

**Spec:** `docs/superpowers/specs/2026-11-25-collaboration-design.md` (§4 is this plan; §5–§6
are the plugin plan, written after PR C's interfaces are merged).

## Global Constraints

- Before 0.1.0: rename directly, no compatibility shims; applied migrations 0001–0184 stay
  untouched. New migrations take the next free numbers at execution time, in plan order (when
  written: `0188` rename, `0189` events, `0190` inbox items, `0191` acceptance); rename the file and
  its test if main took a number meanwhile.
- The event log's stored names are not renamed: `user_message.schedule`, `ScheduleMarkerSchema`,
  `run_started.trigger: "schedule"`, `execution: "scheduled"` (spec §4.6).
- Every new kernel table with `org_id` ships `CREATE POLICY org_scope … USING (rls_admits(org_id))`
  in the same migration (`check:org-filter`).
- BullMQ job ids and queue names contain no `:`; owed work goes through `OutboxService.add` with a
  registry entry; new jobs run on `cap-kernel-maintenance` via `MaintenanceProcessor.dispatch`.
- English for code, comments, model-visible text; UI text in `apps/web/messages/{en,zh}.json`;
  zh says 自动化 and 智能体.
- SDK public API changes: `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`;
  kernel/web changes take a `@capybara-hq/capybara` changeset.
- Values pinned by the spec: `automations.maxEventDepth` = 8, `automations.coalesceSeconds` = 30,
  `automations.maxEventRunsPerSubjectPerHour` = 12, `summary` ≤ 4096 bytes, inbox item actions ≤ 3,
  acceptance default `auto`, acceptance automations `unattendedAsk: "wait"` with no grants.
- New unit or container tests join `packages/kernel/test/unit-tests.json` /
  `container-tests.json` in the same change.
- Local gate per task: `pnpm verify --fast` plus `pnpm exec vitest run <changed test files>`.

## Review Focus

1. **An event emitted twice** (plugin retry after a crash): one `trigger_events` row, one run.
   Pinned in Task B3 (`emit is idempotent on dedupeKey`).
2. **Two events for one item arrive while its conversation is running:** both reach the same
   conversation, in order, after the run; never a second conversation. Task B6
   (`second event queues into the subject conversation`).
3. **A member removed from the project** still has an automation on it: no fire, run skipped as
   `not_visible`. Task B5 (`skips owners the source does not admit`).
4. **Agent A's own write triggers A again / A and B ping-pong:** self-trigger skipped; the chain
   stops at depth 8 with an inbox notice. Tasks B4 and B5.
5. **The plugin is disabled in the org between emit and dispatch:** dispatch stores the event as
   `undelivered` and fires nothing; no crash loop. Task B5 (`provider gone: no fire, no retry`).

---

## PR A: rename scheduled tasks to automations

Mechanical rename, no behavior change. One PR, four tasks, each green on its own.

Name map (use everywhere outside the frozen event-log names):

| Old | New |
|---|---|
| tables `scheduled_tasks`, `scheduled_task_runs`, `scheduled_task_grants` | `automations`, `automation_runs`, `automation_grants` |
| `scheduled_task_runs.task_id`, `scheduled_task_grants.task_id` | `automation_id` |
| `runs.scheduled_task_run_id`, `conversations.scheduled_task_id` | `runs.automation_run_id`, `conversations.automation_id` |
| `conversation_queue.schedule` (queue marker column) | unchanged (carries the frozen marker) |
| dir `packages/kernel/src/schedules/` | `packages/kernel/src/automations/` |
| `ScheduledTasksService`, `ScheduledTaskFirer`, `ScheduledTaskScanJob`, `ScheduledTaskStore`, run tracker | `AutomationsService`, `AutomationFirer`, `AutomationScanJob`, `AutomationStore`, `AutomationRunTracker` |
| jobs `scheduled-task-scan`, `sched-fire`, `sched-settle`, ids `sched-fire-<id>` | `automation-scan`, `automation-fire`, `automation-settle`, `automation-fire-<id>` |
| route `api/v1/orgs/:orgId/schedules` | `api/v1/orgs/:orgId/automations` |
| tools `ScheduleCreate/Update/List/Targets/Delete` | `AutomationCreate/Update/List/Targets/Delete` |
| errors `schedule.*`, roles `schedules.use/manage`, audit `schedule.*` | `automation.*`, `automations.use/manage`, `automation.*` |
| config `schedules.*` (`CAPYBARA_SCHEDULES__`) | `automations.*` (`CAPYBARA_AUTOMATIONS__`) |
| org settings key `scheduledTasks` | `automations` |
| inbox kind `schedule_attention`, push category `schedules`, push source kind `schedule` | `automation_attention`, `automations`, `automation` |
| Platform ops `schedules.*`, group `schedules` | `automations.*`, group `automations` (label 自动化 / Automations) |
| web `/schedules`, `/settings/schedules`, i18n `schedules.*`, `scheduleSettings.*`, `inboxSchedule.*` | `/automations`, `/settings/automations`, `automations.*`, `automationSettings.*`, `inboxAutomation.*` |

### Task A1: Migration 0188 renames tables and rewrites stored values

**Files:**
- Create: `packages/kernel/src/migrations/0188_automations_rename.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (tables at ~1696/1777/1799, columns 506/640, map 1985-1987, push category 235)
- Test: `packages/kernel/test/migrations/0188.test.ts`

**Interfaces:**
- Produces: tables and columns per the name map; Kysely `AutomationsTable`, `AutomationRunsTable`,
  `AutomationGrantsTable`.

- [ ] **Step 1: Write the failing test** `0188.test.ts`: seed a pre-0188 database (migrate to 0184,
  insert a task, run, grant, a `push_preferences` row with category `schedules`, an org settings
  row with key `scheduledTasks`, an audit row `schedule.created`, an org `forbiddenTools` list and an
  agent definition holding `ScheduleCreate`, a pending outbox row `sched-fire`), migrate to 0188,
  assert:

```ts
expect(await tableExists("automations")).toBe(true);
expect(await tableExists("scheduled_tasks")).toBe(false);
expect(await col("automation_runs", "automation_id")).toBe(true);
expect(await col("runs", "automation_run_id")).toBe(true);
expect(await pushCategory(acct)).toBe("automations");
expect(await orgSettings(org)).toHaveProperty("automations");
expect(await auditAction(id)).toBe("automation.created");
expect(await forbiddenTools(org)).toContain("AutomationCreate");
expect(await outboxName(rowId)).toBe("automation-fire");
expect(await policyExists("automations", "org_scope")).toBe(true);
expect(await policyExists("automation_grants", "org_scope")).toBe(true);
```

- [ ] **Step 2: Run, verify it fails:** `pnpm exec vitest run packages/kernel/test/migrations/0188.test.ts` → FAIL (no migration).
- [ ] **Step 3: Write `0188_automations_rename.sql`**: `ALTER TABLE IF EXISTS … RENAME TO`, column
  renames, explicit renames of every index and CHECK constraint the subagent map lists
  (`scheduled_tasks_*_check`, `scheduled_task_runs_skip_reason_check`, `*_idx`, `*_tick_uq`,
  `conversations_scheduled_task_idx`), rewrite the push CHECK and rows, the settings key, audit
  actions (`replace(action,'schedule.','automation.')`), tool keys in grants / forbiddenTools /
  agent definitions (pattern of `0063_tool_keys_claude_code.sql`, whose header rule "logs are never
  rewritten" this file repeats), pending outbox names and job ids; add `org_scope` on
  `automation_grants` if 0182 missed it. Update `kernel-schema.ts`.
- [ ] **Step 4: Run test → PASS.** Add `migrations/0188.test.ts` to no list (integration default).
- [ ] **Step 5: Commit** `refactor(kernel): rename scheduled task tables to automations (0188)`.

### Task A2: Kernel code, tools, routes, Platform ops, config, settings

**Files:**
- Move: `packages/kernel/src/schedules/` → `packages/kernel/src/automations/` (all 18 files; rename `scheduled-tasks.service.ts` → `automations.service.ts`, `schedules.controller.ts` → `automations.controller.ts`, `schedules.schemas.ts` → `automations.schemas.ts`, `schedules.module.ts` → `automations.module.ts`)
- Move: `packages/kernel/src/tools/builtins/schedules.ts` → `automations.ts`; `platform/ops/schedules.ops.ts` → `automations.ops.ts`
- Modify: every kernel file in the rename map report (channels, conversations, inbox, orgs, platform, push, roles, runtime, sandbox, tools, git, errors.ts, config/schema.ts, infra/outbox/registry.ts, http/api.module.ts, infra/config/kernel-config.service.ts)
- Modify: `tools/checks/src/kernel-conventions.ts:385` (exemption path), `tools/checks/test-portfolio-baseline.json`, `tools/dev/export-review-corpus.ts`
- Move tests: `packages/kernel/test/schedules/` → `test/automations/`, `platform/ops-schedules.test.ts` → `ops-automations.test.ts`, `tools/schedule-tools.test.ts` → `automation-tools.test.ts`, `inbox/schedule-attention.test.ts` → `automation-attention.test.ts`; update `unit-tests.json`, `container-tests.json`

**Interfaces:**
- Produces: the new names in the map; `run-context.ts` keeps `scheduleHeader` text unchanged (it is
  model-visible; renaming the header would be drift for no gain).

- [ ] **Step 1:** `git mv` the directories and files; rename identifiers per the map with a
  scripted replace limited to the map's patterns; keep `ScheduleMarkerSchema`, `user_message.schedule`,
  `trigger: "schedule"`, `execution: "scheduled"`, `scheduleHeader`, and the unrelated
  `infra/schedule/*`, `DriftTrigger "schedule"`, `DirectorySyncTrigger "schedule"`.
- [ ] **Step 2:** `pnpm gen:config-docs`; `pnpm typecheck` → PASS.
- [ ] **Step 3:** `pnpm check` → PASS (kernel-conventions, outbox-registry, platform-ops, org-filter).
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test/automations packages/kernel/test/platform/ops-automations.test.ts packages/kernel/test/tools/automation-tools.test.ts packages/kernel/test/evals/reconstruct.test.ts` → PASS (zero drift unchanged).
- [ ] **Step 5: Commit** `refactor(kernel): rename scheduled tasks to automations`.

### Task A3: Web, design and i18n

**Files:**
- Move: `apps/web/src/app/(app)/schedules/**` → `automations/**`, `settings/schedules/**` → `settings/automations/**`; components `ScheduleForm.tsx`, `ScheduleParts.tsx`, `ScheduleRunSheet.tsx`, `ScheduleCalendarView.tsx`, `schedule-calendar-words.ts` → `Automation*`; lib `schedules.ts`, `schedules-url.ts`, `schedule-calendar.ts`, `query/schedules.ts` → `automations*`
- Modify: `apps/web/src/lib/{query/keys.ts,query/routes.ts,audit-actions.ts,inbox.ts,org-settings.ts,push.ts,agents.ts,conversations.ts,shell.ts}`, `components/shell/{nav.tsx,path.ts}`, `components/settings-nav.ts`, conversation components, dev catalog files
- Modify: `apps/web/messages/en.json`, `zh.json` (prefix moves; zh copy 定时任务 → 自动化 where it names the feature; the calendar keeps 定时 wording for time triggers)
- Modify: `packages/design/src/{native.ts,fixtures/index.ts,shell/*}` route/id references (the `schedule-calendar` display component keeps its name: it shows time triggers)
- Move web tests `schedules*.test.tsx` → `automations*.test.tsx`

- [ ] **Step 1:** move and rename; `/schedules` gets no redirect (pre-0.1.0).
- [ ] **Step 2:** `pnpm check:web-api-parity && pnpm check:i18n && pnpm check:web-ui` → PASS.
- [ ] **Step 3:** `pnpm exec vitest run apps/web/test/automations.test.tsx apps/web/test/inbox.test.tsx apps/web/test/nav.test.tsx apps/web/test/messages-parity.test.ts` → PASS.
- [ ] **Step 4: Commit** `refactor(web): rename scheduled tasks to automations`.

### Task A4: Terms guard, docs, skills, changeset

**Files:**
- Modify: `tools/checks/src/terms.ts` (`OLD_REFERENCES` entry `scheduled-tasks` matching `scheduled_task(s|_runs|_grants|_run_id|_id)`, `Schedule(Create|Update|List|Targets|Delete)`, `CAPYBARA_SCHEDULES__`, `schedule_attention`; `OLD_ROUTES` `/schedules`; `OLD_CONFIG_KEYS` `schedules`; `allowedIn`: migrations 0113/0122/0128/0172/0182/0188, `test/migrations/0113.test.ts`, `0188.test.ts`, `docs/superpowers/**`, `CHANGELOG.md`, `.changeset/**`)
- Create: red fixture lines under `tools/checks/fixtures/terms/` for the new entry
- Modify: `.agents/skills/{writing-kernel-api,replay-evals,writing-tools,writing-channels}/SKILL.md`, `docs/guide/sandbox.md`, `docs/design/spec.md`
- Create: `.changeset/automations-rename.md` (`@capybara-hq/capybara`: patch)

- [ ] **Step 1:** add the fixture; `pnpm exec vitest run tools/checks/test/terms.test.ts` → FAIL.
- [ ] **Step 2:** add the entries → PASS; `pnpm check:terms` on the tree → PASS.
- [ ] **Step 3:** update skills and docs; `pnpm verify --fast` → PASS.
- [ ] **Step 4: Commit** `chore: guard the old scheduled task names`.

---

## PR B: event automations

### Task B1: SDK contract (`ctx.triggers`, `trigger-source@1`, permission `triggers`)

**Files:**
- Create: `packages/plugin-sdk/src/triggers.ts`, `packages/plugin-sdk/src/trigger-source.ts`
- Modify: `packages/plugin-sdk/src/{ctx.ts,permissions.ts,extension-point.ts,index.ts}`
- Create: `packages/plugin-sdk/agent-docs/extension-points/trigger-source.md` (via `pnpm gen:agent-docs`, then prose); row in `agent-docs/extensions.md`
- Modify: `packages/plugin-sdk/api/plugin-sdk.api.md` (generated), `tools/checks/src/terms.ts` allow-list if a new type name trips it
- Test: `packages/plugin-sdk/test/triggers.test.ts`, `test/permissions-triggers.test.ts`
- Create: `.changeset/sdk-triggers.md` (`@capybara-hq/plugin-sdk`: minor)

**Interfaces:**
- Produces (in `triggers.ts`):

```ts
export type TriggerFactValue = string | number | boolean | string[];
export interface TriggerSubject { kind: string; id: string; title: string; url?: string }
export type TriggerCause = { call: ToolCallContext } | { accountId: string };
export interface TriggerEvent {
  orgId: string; type: string; subject: TriggerSubject;
  facts: Record<string, TriggerFactValue>; summary: string; dedupeKey: string;
  cause?: TriggerCause; audience?: { accountId: string; agentId: string };
}
export interface EventFilterClause { fact: string; op: "eq" | "in" | "contains"; value: TriggerFactValue }
export type EventFilter = EventFilterClause[];        // conjunction
export interface TriggersCtx { emit(event: TriggerEvent): Promise<{ eventId: string; duplicate: boolean }> }
export class TriggerError extends Error { code: "type_not_declared" | "invalid_event" | "org_disabled" }
export const TRIGGER_SUMMARY_MAX_BYTES = 4096;
export function validateTriggerEvent(e: TriggerEvent, declared: readonly string[]): string[]; // errors
export function matchesFilter(filter: EventFilter, facts: Record<string, TriggerFactValue>): boolean;
```

- Produces (in `trigger-source.ts`):

```ts
export interface TriggerEventDeclaration {
  type: string; name: LocalizedName; directed: boolean;
  facts: Record<string, { type: "string" | "number" | "boolean" | "string[]"; name: LocalizedName; filterable: boolean }>;
}
export interface TriggerSource {
  events(): TriggerEventDeclaration[];
  visible(args: { orgId: string; accountIds: string[]; subject: TriggerSubject; config?: unknown }): Promise<string[]>;
  subjectLink?(args: { orgId: string; subject: TriggerSubject }): Promise<string | null>;
}
export const TRIGGER_SOURCE_EXTENSION_POINT: ExtensionPointRef; // "trigger-source@1"
```

- `EXTENSION_POINTS["trigger-source"] = info([1], "Declares the events an extension emits and which people may see their subjects.", "multi", true, true)`.
- `ExtensionPermissions.triggers?: { emit: string[] }` (types match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, ≤ 64 entries); `ExtensionContext.triggers: TriggersCtx`.

- [ ] **Step 1: Write failing tests**:

```ts
test("matchesFilter is a conjunction over eq/in/contains", () => {
  const facts = { status: "ready", labels: ["ui", "p1"], priority: 2 };
  expect(matchesFilter([{ fact: "status", op: "eq", value: "ready" }], facts)).toBe(true);
  expect(matchesFilter([{ fact: "status", op: "in", value: ["done", "ready"] }], facts)).toBe(true);
  expect(matchesFilter([{ fact: "labels", op: "contains", value: "p1" }, { fact: "priority", op: "eq", value: 3 }], facts)).toBe(false);
  expect(matchesFilter([{ fact: "missing", op: "eq", value: "x" }], facts)).toBe(false);
});
test("validateTriggerEvent refuses undeclared types and oversized summaries", () => {
  expect(validateTriggerEvent(ev({ type: "item.deleted" }), ["item.created"])).toContain("type_not_declared");
  expect(validateTriggerEvent(ev({ summary: "x".repeat(4097) }), ["item.created"])).toContain("summary_too_long");
});
test("permissions.triggers validates type names", () => {
  expect(validatePermissions({ triggers: { emit: ["item.created"] } }).ok).toBe(true);
  expect(validatePermissions({ triggers: { emit: ["Item:Created"] } }).ok).toBe(false);
});
```

- [ ] **Step 2:** run `pnpm exec vitest run packages/plugin-sdk/test/triggers.test.ts packages/plugin-sdk/test/permissions-triggers.test.ts` → FAIL.
- [ ] **Step 3:** implement; add `triggers` to `KEYS`; `pnpm gen:agent-docs`, write the topic prose; `pnpm gen:sdk-api`.
- [ ] **Step 4:** tests PASS; `pnpm check:agent-docs && pnpm check:sdk-api` → PASS.
- [ ] **Step 5: Commit** `feat(plugin-sdk): event triggers and the trigger-source extension point`.

### Task B2: Migration 0189 and the event schema

**Files:**
- Create: `packages/kernel/src/migrations/0189_event_automations.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/conversations/events.ts`, `packages/kernel/src/automations/types.ts`
- Test: `packages/kernel/test/migrations/0189.test.ts`

**Interfaces:**
- Produces (SQL):
  - `trigger_events (id uuid pk, org_id, plugin text, type text, subject jsonb, facts jsonb, summary text, dedupe_key text, audience jsonb null, cause_account_id uuid null, cause_run_id uuid null, depth int not null default 0, state text check in ('pending','dispatched','undelivered','depth_stopped'), created_at)`, unique `(org_id, plugin, dedupe_key)`.
  - `automation_event_deliveries (org_id, automation_id, event_id, subject_key text, automation_run_id uuid null, created_at)`, pk `(automation_id, event_id)`, index `(automation_id, subject_key) WHERE automation_run_id IS NULL`.
  - `automations`: `origin text not null default 'person' check in ('person','acceptance')`, `principal jsonb null`, `unattended_ask text null check in ('fail','wait')`; mode CHECK adds `'subject'`.
  - `automation_runs`: `trigger_key text`, backfilled from `scheduled_for`, then NOT NULL; `scheduled_for` nullable; drop `automation_runs_tick_uq`, create `automation_runs_trigger_uq (automation_id, trigger_key) WHERE NOT trial`; skip_reason CHECK adds `'not_visible'`, `'subject_rate'`.
  - `automation_conversations (org_id, automation_id, subject_kind, subject_id, conversation_id, created_at)`, pk `(automation_id, subject_kind, subject_id)`.
  - `conversations.subject jsonb null`; `runs.trigger_event_id uuid null`;
    `conversation_queue.automation_event jsonb null` (the queued item's event marker).
  - `org_scope` policies on the three new tables.
- Produces (TS, `automations/types.ts`): `Trigger` union gains `{ kind: "event"; source: string; types: string[]; filter: EventFilter }`; `AutomationMode` gains `"subject"`; `TaskRunSkipReason` gains `"not_visible" | "subject_rate"`.
- Produces (`events.ts`): `AutomationEventMarkerSchema = z.object({ automationId, automationRunId, automationName: z.string(), events: z.array(z.object({ id, type, subject: z.object({ kind, id, title, url: z.string().optional() }), summary: z.string() })).min(1) })`; `user_message.automationEvent: AutomationEventMarkerSchema.optional()`; `run_started.trigger` enum adds `"automation_event"`.

- [ ] **Step 1:** failing `0189.test.ts`: after migrate, an old time run has `trigger_key = scheduled_for` text; inserting two event runs with the same `(automation_id, trigger_key)` raises unique violation; policies exist on `trigger_events`, `automation_event_deliveries`, `automation_conversations`.
- [ ] **Step 2:** FAIL → **Step 3:** write SQL + types; `AutomationStore.insertRun` conflict target becomes `(automation_id, trigger_key) WHERE trial = false` and time runs pass `triggerKey: scheduledFor.toISOString()`.
- [ ] **Step 4:** `0189.test.ts` and `test/automations/fire.test.ts` PASS.
- [ ] **Step 5: Commit** `feat(kernel): event automation tables (0189)`.

### Task B3: `ctx.triggers.emit`

**Files:**
- Create: `packages/kernel/src/automations/events/trigger-events.service.ts`, `packages/kernel/src/automations/events/events.module.ts`, `events/token.ts`
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (`KernelDeps.triggers?: () => TriggersBackend | undefined`, `GatedKey` adds `"triggers"`, `gated("triggers", …)`), `packages/kernel/src/extensions/host.ts:743-749`, `packages/kernel/src/kernel.module.ts`, `packages/kernel/src/extensions/permission-set.ts` (snapshot + key prefix `permissions.triggers:`), `permission-view.ts` (category `triggers`, not sensitive), `infra/outbox/registry.ts` (`trigger-dispatch`), `runtime/maintenance.ts` (dispatch case)
- Modify: `packages/plugin-tools/src/check/plugin-permissions.ts` (ctx usage `ctx.triggers` needs `permissions.triggers`) + fixture `packages/plugin-tools/fixtures/plugin-perm-triggers/`
- Modify web: `apps/web/src/lib/extensions.ts`, `messages/{en,zh}.json` (category label)
- Create: the `fake-trigger-source` fixture (Step 1)
- Test: `packages/kernel/test/automations/emit.test.ts`

**Interfaces:**
- Consumes: B1 types; `callScopeOf(call)` (`tools/call-scope.ts`).
- Produces: `TriggerEventsService.emit(plugin: string, declared: readonly string[], e: TriggerEvent): Promise<{ eventId: string; duplicate: boolean }>` (`@Transactional`); outbox job `{ queue: "cap-kernel-maintenance", name: "trigger-dispatch", jobId: "trigger-dispatch-<eventId>", data: { orgId, eventId } }`.
- Depth: `cause.call` → `callScopeOf` → run → `runs.trigger_event_id` → that event's `depth + 1`; no cause or a person cause → 0.

- [ ] **Step 1: create the fixture** `packages/testing/fixtures/extensions/fake-trigger-source/{.capybara-plugin/plugin.json,package.json,src/index.ts}`: declares `item.created`, `item.updated`, `item.assigned` (directed) in `permissions.triggers.emit` and its `trigger-source@1` provider; a tool `emit_item_event` that calls `ctx.triggers.emit` with `cause: { call }`; `visible()` returns the accounts in `globalThis.__fakeTriggerSource.visible` (all when unset). Register it in `packages/testing/src/fixtures.ts` and `packages/testing/test/fixtures.test.ts`.
- [ ] **Step 1b: failing tests**:

```ts
test("emit stores one event and owes one dispatch", async () => {
  const r = await emit({ type: "item.created", dedupeKey: "k1" });
  expect(r.duplicate).toBe(false);
  expect(await outboxJobs("trigger-dispatch")).toHaveLength(1);
});
test("emit is idempotent on dedupeKey", async () => {
  await emit({ dedupeKey: "k2" }); const again = await emit({ dedupeKey: "k2" });
  expect(again.duplicate).toBe(true);
  expect(await countEvents("k2")).toBe(1);
});
test("emit refuses an undeclared type and an extension without permissions.triggers", async () => {
  await expect(emit({ type: "item.secret" })).rejects.toMatchObject({ code: "type_not_declared" });
  await expect(noPermCtx.triggers.emit(ev())).rejects.toThrow(ExtensionPermissionError);
});
test("a cause from a run inherits depth + 1", async () => { /* run started from event depth 2 → new event depth 3 */ });
test("a forged call context is refused", async () => {
  await expect(emit({ cause: { call: { orgId, accountId } as ToolCallContext } })).rejects.toMatchObject({ code: "invalid_event" });
});
```

- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS, plus `permission-set.test.ts`, `permission-view.test.ts`, `plugin-permissions.test.ts`.
- [ ] **Step 5: Commit** `feat(kernel): ctx.triggers.emit`.

### Task B4: Guards as pure functions

**Files:**
- Create: `packages/kernel/src/automations/events/guards.ts`
- Test: `packages/kernel/test/automations/event-guards.test.ts` (unit; add to `unit-tests.json`)

**Interfaces:**
- Produces:

```ts
export function subjectKey(s: TriggerSubject): string;                 // `${kind}-${sha1(id).slice(0,16)}`, no ':'
export function coalesceJobId(automationId: string, s: TriggerSubject): string; // `automation-coalesce-${automationId}-${subjectKey(s)}`
export function isSelfTriggered(a: { accountId: string; agentId: string }, cause: { runAccountId: string; runAgentId: string } | null): boolean;
export function depthExceeded(depth: number, max: number): boolean;     // depth > max
```

- [ ] **Step 1: failing tests**: `subjectKey` and `coalesceJobId` contain no `:` for ids with colons; `isSelfTriggered` true only when both account and agent match; `depthExceeded(8, 8)` false, `(9, 8)` true.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(kernel): event automation guards`.

### Task B5: Dispatcher and coalescing

**Files:**
- Create: `packages/kernel/src/automations/events/dispatcher.ts`, `events/coalesce.ts`
- Modify: `packages/kernel/src/automations/effective-settings.ts` + `orgs/settings.service.ts` (org settings `automations.maxEventDepth` 8, `coalesceSeconds` 30, `maxEventRunsPerSubjectPerHour` 12, `eventSourcesOff: string[]`), `config/schema.ts` caps, `infra/outbox/registry.ts` (`automation-coalesce`, `removeOnComplete: true`), `runtime/maintenance.ts`
- Modify: `packages/kernel/src/inbox/*` only after C1 exists — until then a depth stop logs and sets `state='depth_stopped'` (C1 Step adds the notice)
- Test: `packages/kernel/test/automations/dispatch.test.ts`

**Interfaces:**
- Consumes: `ExtensionPointDefaults.providersFor<TriggerSource>(orgId, "trigger-source")`; B4 guards; `AutomationStore`.
- Produces:
  - `TriggerDispatcher.dispatch(data: { orgId: string; eventId: string }): Promise<void>`: load event; depth check; providers for the org — the emitting plugin's provider missing → `state='undelivered'`, return (no throw); fact schema from `events()`; select active automations `trigger->>'kind'='event' AND trigger->>'source'=plugin AND trigger->'types' ? type` (directed events skip this branch until C2); drop filter misses and self-triggered; `visible()` once with all owners; insert `automation_event_deliveries`; for each delivery owe `automation-coalesce` with `jobId = coalesceJobId(...)`, `runAt = now + coalesceSeconds`; `state='dispatched'`.
  - `EventCoalescer.flush(data: { orgId; automationId; subjectKey }): Promise<void>` (`@Transactional`): lock automation row; collect undelivered deliveries for the pair ordered by event `created_at`; subject rate check (`subject_rate` skip when > `maxEventRunsPerSubjectPerHour` runs for this subject in the last hour); insert `automation_runs` with `trigger_key = <first event id>`; set deliveries' `automation_run_id`; owe `automation-fire`.

- [ ] **Step 1: failing tests**:
  - `fires matching automations once per subject within the window` (three events in 30 s → one run whose marker lists three events in order).
  - `skips owners the source does not admit` (`visible()` returns `[]` → no run).
  - `skips self-triggered events`.
  - `stops at depth 8` (event depth 9 → `state='depth_stopped'`, no run).
  - `provider gone: no fire, no retry` (plugin disabled in org → `undelivered`, job completes).
  - `subject rate limit skips with subject_rate`.
  - `event source switched off by the org admin fires nothing`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Use `drainOutbox(app, …)` and a clock seam for `runAt` instead of sleeping.
- [ ] **Step 5: Commit** `feat(kernel): dispatch and coalesce event automations`.

### Task B6: Fire path: subject mode, marker, header, drift

**Files:**
- Modify: `packages/kernel/src/automations/fire.ts` (`StartPlan` mode `"subject"`; claim plans it: look up `automation_conversations`, else create), `conversations/conversations.service.ts` (`InternalMessageOptions.automationEvent?: AutomationEventMarker`, `NewConversationOptions.subject?: TriggerSubject & { source: string }`, insert `conversations.subject`), `conversations/queue.service.ts` (carry the marker in `conversation_queue.automation_event`, B2), `runtime/context/run-context.ts` (`automationEventBlock(marker): string`), `runtime/context/build.ts:~1026`, `runtime/context/compaction.ts:~318`, `runtime/run-queue.ts:365-383` (set `runs.trigger_event_id` = marker's last event id; `automation_run_id` from the marker), `automations/unattended.ts` (`automationRunAt` reads either marker), `evals/reconstruct.ts` (`DriftReason` + `DRIFT_ORDER` add `"automation_event_block"`)
- Test: `packages/kernel/test/automations/subject-mode.test.ts`, extend `test/evals/reconstruct.test.ts` (`describe("reconstructRequest: event automations")`)

**Interfaces:**
- Produces: `automationEventBlock` renders exactly:

```
[Automation "<name>": <n> event(s) from <source>]
<for each event>
- <type> on "<subject.title>"<" (" + url + ")" if url>
  Reported by an extension; the text below was written by people other than the conversation owner:
  <summary>
</for>
```

  followed by the automation's prompt as the user text.
- `ConversationsService` lists `subject` in conversation views (`subject: { source, kind, id, title } | null`).

- [ ] **Step 1: failing tests**: `first event creates the subject conversation and links it` (row in `automation_conversations`, `conversations.subject` set); `second event queues into the subject conversation` (same conversation id, message queued while the first run is running, delivered after it); `run carries trigger_event_id and automation_run_id`; `event run is unattended with the automation's unattended_ask override`; reconstruct `zero drift for an event automation conversation`.
- [ ] **Step 2:** run reconstruct suite before changes → PASS (baseline); new tests FAIL.
- [ ] **Step 3:** implement. **Step 4:** all PASS, reconstruct zero drift.
- [ ] **Step 5: Commit** `feat(kernel): subject conversations for event automations`.

### Task B7: Automations API, tools, Platform ops, web form

**Files:**
- Modify: `packages/kernel/src/automations/automations.schemas.ts` (trigger union adds event; mode `subject`; `unattendedAsk` field), `automations.service.ts` (validate: source provider enabled in org, types declared, filter facts filterable and typed via `validateFilter`; event automations get `next_run_at = null`; `subject` mode only for event triggers), `automations.controller.ts` (new `GET api/v1/orgs/:orgId/automations/event-sources` → `{ source, name, events: TriggerEventDeclaration[] }[]`), `platform/ops/automations.ops.ts` (`automations.event-sources`; create/update accept event triggers), `platform/route-schemas.ts`, `tools/builtins/automations.ts` (`AutomationCreate` accepts `trigger: { kind: "event", … }`)
- Modify web: `apps/web/src/components/AutomationForm.tsx` (trigger kind segmented: 定时 / 事件; event: source, event types, filter rows built from facts, mode incl. "每个事项一条会话"), `lib/automations.ts`, `lib/query/automations.ts`, list/detail views show the trigger; i18n keys `automations.trigger.event.*`
- Test: `packages/kernel/test/automations/event-api.http.test.ts`, `test/platform/ops-automations.test.ts`, `apps/web/test/automations-event-form.test.tsx`

**Interfaces:**
- Produces: `validateFilter(filter: EventFilter, decl: TriggerEventDeclaration[]): string[]` in `automations/events/guards.ts`.
- Errors: `automation.event_source_unavailable`, `automation.event_type_unknown`, `automation.filter_invalid` (registered in `errors.ts` with Platform `next` steps).

- [ ] **Step 1: failing tests**: create with an unknown type → 400 `automation.event_type_unknown`; filter on a non-filterable fact → `automation.filter_invalid`; `subject` mode with a cron trigger → 400; event-sources lists the fixture's declarations; Platform parity test PASS; web form submits the event trigger body.
- [ ] **Step 2–4:** FAIL → implement → PASS; `pnpm check:platform-ops && pnpm check:web-api-parity && pnpm check:i18n`.
- [ ] **Step 5: Commit** `feat: create and edit event automations`.

### Task B8: End-to-end and dual-replica tests

**Files:**
- Consumes: the `fake-trigger-source` fixture from B3
- Create: `packages/kernel/test/automations/events-e2e.test.ts`, `packages/kernel/test/automations/dispatch.dual.test.ts` (add to `container-tests.json`)

- [ ] **Step 1:** e2e: a person creates an event automation in subject mode → the fixture's tool emits two events for one subject → one conversation, two user messages with `automationEvent` markers, model-fake replies, run linked. Dual: both replicas run the dispatcher for the same event → one `automation_runs` row.
- [ ] **Step 2:** run → FAIL until B5–B7 are in; **Step 3:** fix gaps found → **Step 4:** PASS; `pnpm check:test-plugins`.
- [ ] **Step 5: Commit** `test: event automations end to end`.

---

## PR C: acceptance, inbox, agents, conversations, lifecycle


### Task C0: Serializable trigger cause for queued emits

Added after the PR B final review (2026-11-28): the reliable emit path (emit from a `ctx.queue` job)
cannot carry `cause.call` (an in-memory call scope), so such events lose depth and the self-trigger
check. Add `ctx.triggers.causeOf(call: ToolCallContext): Promise<string>` returning an opaque handle
(kernel-signed or a stored row id bound to org + run, short TTL), and accept `cause: { handle }` in
`emit`; the kernel re-verifies the run is in the event's org and derives depth as for `cause.call`.
SDK additive (minor), kernel, tests (handle from another org refused, expired handle refused, depth
carried through a queued emit). Must land before the collab plugin relies on queued emits.

### Task C1: Personal inbox items and `ctx.inbox`

**Files:**
- Create: `packages/kernel/src/migrations/0190_inbox_items.sql` (`inbox_items (id uuid pk, org_id, account_id, source text check in ('kernel','plugin'), plugin text null, kind text, title text, body text, link text null, actions jsonb not null default '[]', state text check in ('open','resolved','expired') default 'open', expires_at timestamptz, created_at, resolved_at)`, index `(org_id, account_id) WHERE state='open'`, `org_scope` policy; `push_preferences` category CHECK adds `'inbox'`)
- Create: `packages/kernel/src/inbox/inbox-items.service.ts`, `inbox/inbox-items.controller.ts` (`POST api/v1/orgs/:orgId/inbox/items/:id/actions/:actionId`, `POST …/items/:id/dismiss`)
- Modify: `inbox/inbox.service.ts` (`InboxItem` variant `{ type: "item"; … }`), `push/{jobs.ts,triggers.ts,push.schemas.ts}` (source `{ kind: "inbox", itemId }`, category `inbox`), SDK `ctx.ts` + new `packages/plugin-sdk/src/inbox.ts`, `permissions.ts` (`inbox?: true`), kernel `create-ctx.ts`, `permission-set.ts`, `permission-view.ts`, plugin-tools check + fixture, Platform ops (`inbox.item-action`, `inbox.item-dismiss` as operations; `handoff` none, `noHandoff` reason), web inbox view + i18n
- Modify: `automations/events/dispatcher.ts` (depth stop posts a kernel item `kind: "automation_depth_stopped"` to the owners of matched automations)
- Test: `packages/kernel/test/inbox/inbox-items.test.ts`, `apps/web/test/inbox.test.tsx`

**Interfaces:**
- Produces (SDK `inbox.ts`):

```ts
export interface InboxAction { id: string; label: LocalizedName; style?: "primary" | "danger"; uiAction: { contribution: string; actionId: string; payload?: unknown } }
export interface InboxPost { orgId: string; accountId: string; kind: string; title: string; body?: string; link?: string; actions?: InboxAction[]; expiresInSeconds?: number; dedupeKey?: string }
export interface InboxCtx { post(p: InboxPost): Promise<{ itemId: string }>; resolve(args: { orgId: string; itemId: string }): Promise<void> }
export const INBOX_ACTIONS_MAX = 3;
```

- Produces (kernel): `InboxItemsService.post(source: { kind: "kernel" } | { kind: "plugin"; plugin: string }, p: InboxPost): Promise<{ itemId }>` (`@Transactional`, owes push); clicking an action calls the plugin's UI action through `UiService` with the clicking person's `accountId`, then resolves the item.

- [ ] **Step 1: failing tests**: post → appears only in that person's inbox list; 4 actions → refused; clicking an action invokes the fixture's UI action with the clicker's account and resolves; another member cannot click it (404); expired items vanish; push owed with category `inbox`; extension without `permissions.inbox` → `ExtensionPermissionError`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `pnpm gen:sdk-api`, changeset.
- [ ] **Step 5: Commit** `feat: personal inbox items and ctx.inbox`.

### Task C2: Directed events, acceptance rules and offers

**Files:**
- Create: `packages/kernel/src/migrations/0191_automation_acceptance.sql` (`automation_acceptance (org_id, account_id, source text, mode text check in ('auto','confirm','off'), updated_at)`, pk `(org_id, account_id, source)`; `automation_offers (id uuid pk, org_id, account_id, automation_id null, event_id, agent_id, state text check in ('open','accepted','declined','expired'), created_at, decided_at)`; `org_scope` on both)
- Create: `packages/kernel/src/automations/events/acceptance.ts`, `automations/acceptance.controller.ts` (`GET/PUT api/v1/orgs/:orgId/automations/acceptance` for the caller's rules; `POST api/v1/orgs/:orgId/automations/offers/:id/accept|decline`)
- Modify: `events/dispatcher.ts` (directed branch), `orgs/settings.service.ts` (`automations.directedDefault: "auto" | "confirm" | "off"`, default `"auto"`), `inbox/inbox.service.ts` (variant `automation_offer`), push trigger, Platform ops (`automations.acceptance-get/set`, `automations.offer-accept/decline`), web: settings page `/settings/automations` section "接受工作", inbox offer card, automations list badge for `origin = acceptance`; i18n
- Test: `packages/kernel/test/automations/acceptance.test.ts`

**Interfaces:**
- Consumes: C1 `InboxItemsService.post`; B5 `TriggerDispatcher`.
- Produces: `AcceptanceService.route(event: TriggerEventRow): Promise<"fired" | "offered" | "off">`:
  - Find `automations` where `origin='acceptance' AND account_id=audience.accountId AND agent_id=audience.agentId AND trigger->>'source'=plugin`. Missing and mode `auto` → create `{ name: "<source name> · <agent name>", trigger: { kind: "event", source, types: <all directed types>, filter: [] }, mode: "subject", origin: "acceptance", unattended_ask: "wait", grants: [] }` then deliver as B5 does.
  - Mode `confirm` → `automation_offers` row + inbox `automation_offer`; accept → deliver; decline → kernel inbox item to the causer (`cause_account_id`, or the causing run's `trigger_account_id`) `kind: "automation_offer_declined"` and fire `run.lifecycle` `offer_declined` (C4).
  - Mode `off` → nothing; `run.lifecycle` `offer_declined` with `reason: "off"`.
  - Self-trigger and visibility apply as in B5; the agent must pass `AgentLookup.get(org, agent, account)` (else skip `target_invalid`).

- [ ] **Step 1: failing tests**: `auto creates one acceptance automation and fires`; `second directed event reuses it`; `confirm creates an offer, accept fires, decline notifies the causer`; `off fires nothing`; `org directedDefault confirm applies when the person has no rule`; `agent the person cannot use is skipped`; `acceptance runs ask the person (wait), never fail`.
- [ ] **Step 2–4:** FAIL → implement → PASS (C4's hook assertion lands in C4).
- [ ] **Step 5: Commit** `feat: acceptance rules and offers for directed events`.

### Task C3: `ctx.agents.usableBy`, `ctx.conversations.bySubject`, `ctx.people`

**Files:**
- Modify: SDK `ctx.ts` (+ `packages/plugin-sdk/src/agents-ctx.ts`), `permissions.ts` (`agents?: { read: true }`, `conversations?: { subjects: true }`, `people?: { read: true }`), kernel `create-ctx.ts`, `permission-set.ts`, `permission-view.ts`, plugin-tools check
- Modify: `agents/agent-lookup.ts` (reuse `listVisible`), `conversations/conversations.service.ts` (`bySubject`), `orgs/members` service (people lookup)
- Test: `packages/kernel/test/ctx/agents-conversations-ctx.test.ts`

**Interfaces:**
- Produces:

```ts
interface AgentsCtx { usableBy(args: { orgId: string; accountId: string }): Promise<{ id: string; name: string; avatar: unknown | null }[]> }
interface ConversationsCtx { bySubject(args: { orgId: string; subject: { kind: string; id: string } }): Promise<{ id: string; ownerAccountId: string; agentId: string; state: "idle" | "running" | "waiting"; lastActivityAt: string }[]> }
```

  `bySubject` returns only conversations whose `subject.source` is the calling plugin.

```ts
interface PeopleCtx {
  get(args: { orgId: string; accountIds: string[] }): Promise<{ id: string; name: string; avatar: AvatarValue | null; active: boolean }[]>; // ≤ 200 ids
  search(args: { orgId: string; query: string; limit?: number }): Promise<{ id: string; name: string; avatar: AvatarValue | null }[]>;      // limit ≤ 50
}
```

  Members of the org only; never email or other profile fields (spec
  `2026-11-25-plugin-full-pages-design.md` §8).

- [ ] **Step 1: failing tests**: `usableBy` excludes another member's private agent; `bySubject` returns no content fields and never another plugin's subjects; `people.get` drops accounts outside the org and returns no email; `people.search` caps at 50.
- [ ] **Step 2–4:** FAIL → implement → PASS; `gen:sdk-api`.
- [ ] **Step 5: Commit** `feat: ctx.agents and ctx.conversations for subject plugins`.

### Task C4: `run.lifecycle` hook

**Files:**
- Modify: SDK `hooks.ts` (`HOOKS_AVAILABLE` + `RunLifecyclePayload` + `HookPayloads`), `permissions.ts` (`HOOK_MOUNT_POINTS`)
- Modify: kernel `extensions/hooks.ts` (`QueuedHook` adds `"run.lifecycle"`), `extensions/lifecycle-hooks.ts` (handler + outbox job `hook-run-lifecycle`), `infra/outbox/registry.ts`, `runtime/run-queue.ts` (started), `runtime/run-finish.ts:~149` (finished/failed, owed in `finishIn`'s transaction), the waiting transition (`runs.waiting_since` set), `automations/events/acceptance.ts` (offer_declined)
- Create: `packages/testing/fixtures/extensions/fake-run-lifecycle/` (records payloads on `globalThis`)
- Test: `packages/kernel/test/extensions/run-lifecycle-hook.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RunLifecyclePayload extends HookScope {
  phase: "started" | "waiting" | "finished" | "failed" | "offer_declined";
  subject: { kind: string; id: string };
  runId?: string; conversationId?: string;
  waitingOn?: "approval" | "question" | "input";
  reason?: "declined" | "off";
}
```

  Delivered only to the plugin named by `conversations.subject.source` (or the event's plugin for `offer_declined`), at least once.

- [ ] **Step 1: failing tests**: a subject conversation's run produces `started` then `finished` for its plugin only; a run waiting on approval produces `waiting` with `waitingOn: "approval"`; a declined offer produces `offer_declined`; a conversation without a subject produces nothing.
- [ ] **Step 2–4:** FAIL → implement → PASS; `gen:sdk-api`.
- [ ] **Step 5: Commit** `feat: run.lifecycle hook for subject plugins`.

### Task C5: Docs, AGENTS.md, skills

**Files:**
- Modify: `AGENTS.md` (Extensions line: `ctx.triggers` / `ctx.inbox` / `trigger-source@1`; automations wording), `.agents/skills/writing-extensions/SKILL.md` (ctx and permissions tables, hook section), `packages/plugin-sdk/agent-docs/*` (topics for inbox and triggers usage), `docs/architecture.md` if it lists ctx members
- [ ] **Step 1:** edit; `pnpm check:agent-docs && pnpm verify --fast` → PASS.
- [ ] **Step 2: Commit** `docs: automations, event triggers and inbox items`.

---

## Waves (for subagent execution)

| Wave | Tasks (parallel where files are disjoint) | Review |
|---|---|---|
| A | A1 → A2 → A3 → A4 (sequential: same names) | one batched review; A1 alone on the most capable model (migration rewriting stored data) |
| B1 | B1, B4 | batched |
| B2 | B2 → B3 | B2 alone (migration + unique key change), B3 alone (trust boundary: forged call contexts) |
| B3 | B5 → B6 | each alone (multi-replica coalescing; model-visible input + drift) |
| B4 | B7, B8 | batched |
| C1 | C1, C3 | C1 alone (cross-tenant inbox actions) |
| C2 | C2 → C4 → C5 | C2 alone (consent and run identity) |

PR A merges before PR B starts; PR B before PR C. The plugin plan (`capybara-hq/plugins`) is
written after PR C's SDK release.
