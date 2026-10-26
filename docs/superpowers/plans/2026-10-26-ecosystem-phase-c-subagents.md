# Package Ecosystem Phase C: Sub-agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent with the builtin `agent` tool dispatches sub-agents (a copy of itself, inline templates, plugin agent templates including translated Claude `agents/*.md`, and allowlisted org agents) that run as their own queued runs in read-only child conversations, in parallel, with concurrent commands in the parent conversation's sandbox, their final replies returning as tool results; superpowers' `subagent-driven-development` runs a small plan end to end.

**Architecture:** The tool pipeline gets a dispatch path for `agent` calls: one PG transaction creates the child conversation (`kind = 'subagent'`, first event `subagent_started` freezing the effective definition), its run and a `subagent_dispatches` row, then enqueues the child on `cap-kernel-subagent-runs`; the parent suspends with a `subagents` wait and the last finishing child resumes it through the existing conditional `Waits.resume`. `SandboxService` replaces its single lock with shared leases (commands) and exclusive leases (lifecycle) in Redis, tagging each command with its holder so a takeover kills only a crashed holder's commands. Templates come from the agent definition (`subagents`), from a new `agent_templates` store filled by plugin install, and from other org agents behind three gates.

**Tech Stack:** TypeScript, Kysely + PG migrations, NestJS kernel, BullMQ, ioredis + Lua, LangGraph loop, zod, vitest, `@capybara-hq/testing` (`startFakeE2B`, `openSse`, truncate helpers), the `sandbox-fake` and new `model-script` test fixtures, Docker (gated), Next.js + `@capybara-hq/design`, next-intl (zh, en).

**Spec:** `docs/superpowers/specs/2026-10-26-subagents-design.md` (all of it; section numbers below are its §). Read with it: AGENTS.md, `.agents/skills/writing-tools`, `writing-sandbox-providers`, `replay-evals`, `writing-migrations`, `writing-plugins`, `writing-extensions` (hooks), `writing-kernel-api`, `writing-web-ui`.

## Header notes

- Planned against `origin/main` at `77de4ba` (phase B merged). UI refresh A's branch adds `0052_conversations_account_agent_idx.sql` and merges first, so this plan's migration is **`0053_subagents.sql`**; if anything else takes 0053 by then, use the next free number (the migrator refuses a file older than one already applied).
- UI refresh B is not built; Tasks 18–19 build the interim UI of spec §17 on today's PlaygroundPage. If UI B lands first, Task 18 wires B's components instead and says so in its report.
- `model-fake` answers one tool call per response from the last user text, which cannot drive a multi-step controller or parallel calls. Task 8 adds a test fixture provider `model-script` (not an official plugin; `check:test-plugins` is unaffected) that answers from a rule list in its deployment config.
- Every core test uses `model-fake`, `model-script`, `sandbox-fake` and the fakes in `@capybara-hq/testing` (rule `test-plugins-official`). Docker and E2B tests live in `plugins/sandbox-docker/test` and `plugins/sandbox-e2b/test`, gated the way those suites already are.

## Global Constraints

- Tool name `agent`; inputs exactly `description` (1–80), `prompt` (1–100000), `subagent_type` (1–130, default `general-purpose`), `model` (`inherit|fast|standard|capable`), `resume` (≤ 64); `additionalProperties: false`; `defaultPolicy: "allow"`; always loaded under `tool_search`; never offered to a child (§4).
- Depth 1. Per parent run: `subagents.maxConcurrentPerRun` 4 (1–20), `subagents.maxDispatchesPerRun` 50 (1–500), `subagents.maxTokensPerRun` 5 000 000 (≥ 10 000), all `hot`, org overrides in org settings. Time waiting for sub-agents goes into `waited_ms`, not the parent's `runtime.maxRunSeconds` (§8.2, §7.2).
- `sandbox.maxConcurrentCommands`: default 6, 1–32, `hot`; `1` (or a provider without `concurrentExec` + `killTagged`) is exactly today's serialized behavior. No kernel lock for shell commands writing one file; the `sandbox_bash` and `agent` descriptions warn (§10).
- Children never get `agent`, `ask_user`, `sandbox_deliver`, `skill_write` (§5.3, §5.5).
- **The event log is the single source of truth.** A child's request is built from its own log, with definition and preamble from `subagent_started`, never from `agent_versions`. Run the zero-drift tests before and after every task that touches `runtime/context/build.ts`, `model-call.ts` or `evals/reconstruct.ts`: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`. New event types are not model-visible and request building skips them; a log without them builds byte-identically.
- **Multi-replica discipline**: no waiting in process for a child; no timers except lease renewal of a lease this process holds; all state in PG / Redis; BullMQ queue names and job ids without `:` (`cap-kernel-subagent-runs`, `wait-timeout-sa-<runId>-<step>`, `run-<conv>-resume-<childRunId>`); every `ctx.kv` write has a TTL; Redis lease keys always carry a TTL.
- Migration `0053_subagents.sql`: additive and idempotent (`IF NOT EXISTS` / `IF EXISTS`, `DO` blocks for constraints), nullable or defaulted columns only (post-release zero-downtime rules); `pnpm check:applied-migrations` must pass (no edits to earlier files).
- SDK public API changes (Task 2) → `pnpm gen:sdk-api`, `pnpm gen:package-schemas`, and the changeset `.changeset/ecosystem-phase-c.md` bumping `@capybara-hq/plugin-sdk` (patch: additive). The same changeset lists `@capybara-hq/kernel`, `@capybara-hq/capybara`, `@capybara-hq/web`, `@capybara-hq/plugin-sandbox-docker`, `@capybara-hq/plugin-sandbox-e2b` (patch); later tasks append a sentence.
- Model-visible text is English and fixed by the spec (§4.3–4.5, §6.3 preamble, §16.5); UI text via i18n (zh and en); `apps/web` uses only `@capybara-hq/design` (`pnpm check:web-ui`); new error codes in `packages/kernel/src/errors.ts` with zh / en copy in `apps/web/messages/*.json`.
- Sandbox provider rules (`writing-sandbox-providers`): every method honors `signal`; an aborted `exec` kills its process tree and resolves `{ exitCode: null, timedOut: false }`; `SandboxGoneError` only when certain; auto-start idempotent under concurrent calls; in-sandbox `timeout -s KILL` stays; never publish the socket proxy on a host address; Docker tests skip without Docker or with `CAPYBARA_TEST_NO_DOCKER=1`; E2B live tests run only with `CAPYBARA_TEST_E2B_API_KEY` and `CAPYBARA_TEST_E2B_TEMPLATE`.
- Tests never use the network. Run vitest from the repo root (`pnpm exec vitest run <path>`). English comments in new code; translate comments you edit.
- Commits: Conventional Commits, body lines ≤ 100 characters, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Formats (decided here)

```ts
// conversations/events.ts — child log
subagent_started: {
  parent: { conversationId: string; runId: string; callId: string; step: number };
  agentType: string;
  template: { source: "general" | "inline" | "plugin" | "agent"; id?: string; version?: number; plugin?: string };
  definition: AgentDefinition;   // effective, frozen
  preamble: string;              // SUBAGENT_PREAMBLE at dispatch
  maxSteps: number;
  warnings?: string[];
}
user_message.dispatch?: { parentConversationId: string; parentRunId: string; callId: string }
run_finished.reason: "completed" | "max_steps" | "max_duration" | "budget"
// parent log
subagent_dispatched: { step; callId; subagentId; childRunId; agentType; description; resumed: boolean;
  model: { provider: string; model: string }; tierFallback?: boolean }
subagent_waiting: { subagentId; childRunId; kind: "approval" | "input" | "connect";
  approvalId?: string; questionId?: string; toolKey: string; expiresAt?: string }
subagent_finished: { subagentId; childRunId; callId;
  status: "completed" | "max_steps" | "max_duration" | "budget" | "aborted" | "failed";
  errorCode?: string; toolCalls: number; durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }
```

Idem keys: `subagent_started`, `subagent_dispatched:<runId>:<callId>`, `subagent_waiting:<childRunId>:<waitId>`, `subagent_finished:<childRunId>`.

`0053_subagents.sql`:
- `conversations`: kind check → `('chat','eval','subagent')`; `parent_conversation_id text REFERENCES capybara.conversations(id) ON DELETE CASCADE`; `subagent_type text`; `CREATE INDEX IF NOT EXISTS conversations_parent_idx ON capybara.conversations (parent_conversation_id) WHERE kind = 'subagent'`.
- `runs.subagent_tokens_used bigint NOT NULL DEFAULT 0`.
- `subagent_dispatches (parent_run_id text, parent_call_id text, parent_conversation_id text NOT NULL REFERENCES conversations ON DELETE CASCADE, step int NOT NULL, child_conversation_id text NOT NULL REFERENCES conversations ON DELETE CASCADE, child_run_id text NOT NULL, resumed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (parent_run_id, parent_call_id))`, indexes on `child_run_id`, `child_conversation_id`.
- `agent_templates (id text PK, org_id text NOT NULL, name text NOT NULL, catalog_item_id text NULL, plugin_name text NULL, current_version int NOT NULL, deleted_at timestamptz NULL, created_at, updated_at)`, unique `(org_id, plugin_name, name) WHERE deleted_at IS NULL`; `agent_template_versions (template_id text REFERENCES agent_templates ON DELETE CASCADE, version int, definition jsonb NOT NULL, source_format text NOT NULL DEFAULT 'capybara' CHECK (source_format IN ('capybara','claude-code')), catalog_version text NULL, created_at, PRIMARY KEY (template_id, version))`.
- `plugin_install_components.kind` check gains `'agent_template'`.

Redis keys (§10.3), conversation = sandbox conversation: `capk:sandbox:<conv>` (kept; token or `shared`), `capk:sandbox-users:<conv>` (zset), `capk:sandbox-intent:<conv>`, `capk:sandbox-holders:<conv>` (hash), `capk:sandbox-path:<conv>:<sha256hex(path)>`.

## Review Focus

1. **A person sends a message to the parent conversation while sub-agents run**: the parent run is `waiting`; the message is stored, no second run starts, and after the resume the parent absorbs it as an interjection before its next model request. Task 9 tests it.
2. **A sub-agent of a Slack / Lark conversation needs an approval**: the card appears in the IM thread (from `subagent_waiting`), and approving there resumes the child, then the parent. Task 11 tests it.
3. **Agents and conversations from before phase C**: a definition without `subagents` and without the `agent` tool saves without a new version, is offered no `agent` tool, and its old requests reconstruct with zero drift; an existing conversation's sandbox works unchanged with one holder. Tasks 1, 4, 6 test it.
4. **A forged or foreign `resume` id** (another conversation's child, another user's, a running one, a non-existent one, the same id twice in one response): refused with the §4.5 text, nothing started, no detail about other conversations leaked. Task 8 tests it.
5. **The shared sandbox is suspended when three children start at once**: one takes the exclusive lease, resumes and downgrades; the other two wait and then run concurrently; none fails with `sandbox.busy` or sees a "recreated" notice. Task 4 tests it.

---

### Task 1: Migration 0053, schema types and event schemas

**Files:**
- Create: `packages/kernel/src/migrations/0053_subagents.sql` (Formats above)
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`ConversationKind` adds `"subagent"`; new columns; `SubagentDispatchesTable`, `AgentTemplatesTable`, `AgentTemplateVersionsTable`; `PluginInstallComponentsTable.kind`), `packages/kernel/src/conversations/events.ts` (Formats above), `packages/kernel/src/runtime/context/build.ts` (skip the four new types), `packages/kernel/src/runtime/run-worker.ts` / `run-finish.ts` (accept `budget` in types only)
- Test: `packages/kernel/test/db/migration-0053.test.ts`, append to `packages/kernel/test/runtime/context/` (existing build tests: `new subagent events are skipped by request building`)

**Interfaces:**
- Produces: the tables and event types every later task uses; `EventPayload<"subagent_started">` etc.

- [ ] **Step 0:** Run the zero-drift tests; record PASS.
- [ ] **Step 1: Write failing tests:** `0053 applies twice without error and widens conversations.kind` (insert a `subagent` conversation with `parent_conversation_id`; deleting the parent cascades the child and its `subagent_dispatches` rows); `agent_template_versions.source_format rejects 'x'`; build test: a log with `subagent_dispatched`, `subagent_waiting`, `subagent_finished` and `user_message.dispatch` builds the same request as the log without them.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/db/migration-0053.test.ts packages/kernel/test/runtime/context` → FAIL.
- [ ] **Step 3: Implement** the migration and types (constraint replacement in a `DO $$ … $$` block that drops `conversations_kind_check` IF EXISTS and adds the widened one).
- [ ] **Step 4:** Tests PASS; zero-drift tests PASS; `pnpm typecheck`; `pnpm check:applied-migrations --base origin/main`.
- [ ] **Step 5: Commit** `feat(kernel): sub-agent tables and events (migration 0053)`.

### Task 2: SDK additions (hooks, sandbox@1, plugin agents)

**Files:**
- Modify: `packages/plugin-sdk/src/hooks.ts`, `packages/plugin-sdk/src/sandbox.ts`, `packages/plugin-sdk/src/plugin-manifest.ts`, `packages/plugin-sdk/src/index.ts`
- Create: `packages/plugin-sdk/src/agent-template.ts`
- Modify (generated): `packages/plugin-sdk/api/plugin-sdk.api.md`, `packages/plugin-sdk/schemas/*` (`pnpm gen:package-schemas`)
- Create: `.changeset/ecosystem-phase-c.md`
- Test: `packages/plugin-sdk/test/agent-template.test.ts`, append to `packages/plugin-sdk/test/plugin-manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HookParentScope { conversationId: string; runId: string; callId: string }
  // HookScope.parent?: HookParentScope; UsageReportPayload.parent?: HookParentScope (conversationKind unchanged)
  // SandboxProvider: readonly concurrentExec?: boolean; exec args tag?: string; killTagged?(h, tags: string[], signal): Promise<void>
  export const SANDBOX_TAG_RE = /^[a-z0-9-]{1,64}$/;
  export interface PluginAgentRef { path: string }          // PluginManifest.agents?: PluginAgentRef[]; omitted = scan agents/*.md
  export type AgentTemplateTier = "inherit" | "fast" | "standard" | "capable";
  export interface AgentTemplate {
    name: string; description: string; instructions: string;
    tools?: string[]; disallowedTools?: string[]; toolPolicies?: Record<string, "ask" | "deny">;
    model?: AgentTemplateTier; effort?: "low" | "medium" | "high" | "xhigh" | "max";
    maxSteps?: number; skills?: string[];
  }
  export const AGENT_TEMPLATE_LIMITS = { bodyChars: 100_000, descriptionChars: 4096, perPlugin: 64, skills: 3, tools: 200 } as const;
  export const AGENT_TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  export function parseAgentTemplate(text: string): { template: AgentTemplate } | { errors: string[] };
  ```
- [ ] **Step 1: Failing tests:** `parseAgentTemplate reads frontmatter and body` (all fields), `rejects a missing name or description, a bad name, unknown model tier, maxSteps < 1, more than 3 skills, a body over 100000 chars` (one error string each, exact text in the test); `plugin manifest accepts agents refs and rejects a path outside the plugin`; `more than 64 agents is rejected`.
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test` → FAIL.
- [ ] **Step 3: Implement**, reusing the SKILL.md frontmatter reader (`parseSkillMd`'s YAML step) for `parseAgentTemplate`; doc comments on the sandbox additions carry the §10.7 contract text (concurrent safety, idempotent auto-start, `concurrentExec` requires `killTagged`).
- [ ] **Step 4:** PASS; `pnpm gen:sdk-api`, `pnpm gen:package-schemas`, `pnpm check:sdk-api`, `pnpm check:package-schemas`, `pnpm typecheck`.
- [ ] **Step 5:** Write the changeset (frontmatter per Global Constraints; text: "Agents can dispatch sub-agents with the builtin `agent` tool; plugins can ship agent templates; sandboxes run commands of parallel sub-agents concurrently.").
- [ ] **Step 6: Commit** `feat(plugin-sdk): sub-agent hook scope, agent templates and concurrent sandbox exec`.

### Task 3: Sandbox leases (Redis protocol)

**Files:**
- Create: `packages/kernel/src/sandbox/leases.ts`
- Test: `packages/kernel/test/sandbox/leases.test.ts` (real Redis from the test containers)

**Interfaces:**
- Produces:
  ```ts
  export type LeaseKind = "shared" | "exclusive";
  export interface SandboxLease {
    readonly kind: LeaseKind; readonly token: string; readonly conversationId: string;
    readonly signal: AbortSignal;          // aborts with SandboxLockLostError when lost
    renew(): Promise<boolean>;
    release(): Promise<void>;
    /** exclusive → shared in one Lua step; throws if not exclusive. */
    downgrade(): Promise<SandboxLease>;
  }
  export class SandboxLeases {
    constructor(d: { redis: Redis; log: Pick<Logger, "warn">; ttlMs?: number; pollMs?: number });
    acquireShared(conv: string, cap: number, signal: AbortSignal, capMs: number): Promise<SandboxLease>;   // sandbox.busy after capMs
    acquireExclusive(conv: string, signal: AbortSignal, capMs?: number, o?: { intent?: boolean }): Promise<SandboxLease>;
    tryExclusive(conv: string): Promise<SandboxLease | null>;      // sweeps: one try, no intent
    /** Holder records: write before provider calls, delete after. */
    registerHolder(conv: string, token: string, ttlMs: number): Promise<void>;
    unregisterHolder(conv: string, token: string): Promise<void>;
    /** Tags of holders without a live lease, plus whether the legacy single busy marker was present. Atomically claims them (removes the fields) so only one caller kills. */
    claimDeadHolders(conv: string): Promise<{ tags: string[]; legacyMarker: boolean }>;
    pathLease(conv: string, path: string, signal: AbortSignal, capMs: number): Promise<{ release(): Promise<void> }>;
    sharedCount(conv: string): Promise<number>;
  }
  ```
- Lua per spec §10.3 (purge expired by Redis `TIME`; `sandbox:<conv>` holds a token or `shared`; intent honored by `acquireShared` unless the caller owns it). TTL `SANDBOX_LOCK_TTL_MS` (60 000), renewal every TTL/3 with the existing "stale after 2/3 TTL" rule moved from `SandboxService.hold`.
- [ ] **Step 1: Failing tests:** `up to cap shared leases coexist; cap+1 waits and gets in when one releases`; `exclusive waits while shared exist; shared waits while exclusive exists`; `intent: a waiting exclusive blocks new shared leases and gets in when running ones release`; `downgrade lets the downgrader keep running while others join`; `a holder that stops renewing expires; its signal aborts on the next failed renewal`; `an old-style SET NX token on capybara:sandbox key blocks shared; a shared value blocks SET NX` (rollout, §10.8); `claimDeadHolders returns only tags without live leases, once`; `pathLease serializes the same path, not different paths`; `all keys carry a TTL` (`PTTL > 0` after every operation).
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/sandbox/leases.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(kernel): shared and exclusive sandbox leases`.

### Task 4: SandboxService on leases, tags and the fake provider

**Files:**
- Modify: `packages/kernel/src/sandbox/sandbox.service.ts` (use `SandboxLeases`; shared fast path; exclusive slow path with intent and downgrade; `gone` handling by generation; takeover via `claimDeadHolders` → `killTagged`, legacy marker → `killAll` under exclusive; `last_used_at = GREATEST(last_used_at, now())` on release; sweeps via `tryExclusive`; `maxRunningMinutes` sets intent for one poll window), `packages/kernel/src/config/schema.ts` (`sandbox.maxConcurrentCommands`), `docs/config.md` (regenerated), `packages/kernel/src/tools/builtins/sandbox/common.ts` (`BuiltinCallContext.sandboxConversationId`; path lease around `write` / `edit` / attachment sync; busy text for path lease "Another sub-agent is writing this file; try again."), `packages/kernel/src/tools/builtins/sandbox/bash.ts` (description sentence §10.4), `packages/kernel/src/tools/builtins/skill-load.ts` (path lease, sandbox conversation), `packages/kernel/test/fixtures/plugins/sandbox-fake/index.ts` (tag in `procs/<pid>`, `killTagged`, `concurrentExec: true`, delay hook holding a command open), `.agents/skills/writing-sandbox-providers/SKILL.md` (lifecycle section rewritten for leases, tags, `concurrentExec`, `killTagged`)
- Test: `packages/kernel/test/sandbox/concurrent.test.ts`, `packages/kernel/test/sandbox/concurrent.dual.test.ts`; existing `sandbox.service.test.ts`, `sandbox.dual.test.ts`, `sandbox-artifacts.dual.test.ts`, `packages/kernel/test/tools/sandbox/*` must stay green

**Interfaces:**
- Consumes: Task 3, Task 2 (`concurrentExec`, `tag`, `killTagged`).
- Produces: `withSandbox(ctx: { orgId; conversationId /* sandbox conversation */ }, fn, signal)` unchanged signature; `effectiveCap(p: SandboxProviderEntry): number` (= `maxConcurrentCommands` when `concurrentExec && killTagged`, else 1, with a startup warn if only one is declared).
- [ ] **Step 0:** Run `pnpm exec vitest run packages/kernel/test/sandbox packages/kernel/test/tools/sandbox`; record PASS.
- [ ] **Step 1: Failing tests** (`concurrent.test.ts`, fake provider, `maxConcurrentCommands: 3`): `three held-open commands overlap (ops log intervals)`; `a fourth waits and runs when one ends`; `rebuild after removeFakeSandbox waits for shared leases and is not starved (intent)`; `gone with three running holders rebuilds once (generation +1) and all three results carry the recreated notice`; `two sandbox_edit calls on one file both apply`; `a provider without concurrentExec gets cap 1`; **Review Focus 5** `a suspended sandbox and three simultaneous first commands: one resume, then all three run; no sandbox.busy, no recreated notice`; **Review Focus 3** `with one holder the ops sequence equals today's (create, exec, …)`. `concurrent.dual.test.ts`: `holders on replicas A and B run concurrently; killing A mid-command leaves B's command running; the next acquirer kills only A's tag`; `suspendIdle skips while any holder is live and suspends after the last one ends`.
- [ ] **Step 2:** Run them → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** New and existing sandbox tests PASS; `pnpm gen:config-docs` and `pnpm check`.
- [ ] **Step 5: Commit** `feat(kernel): concurrent commands in one sandbox under shared leases`.

### Task 5: Docker and E2B providers

**Files:**
- Modify: `plugins/sandbox-docker/src/provider.ts` (`execArgv(ctl, command, timeoutMs)` where `ctl = /tmp/.capybara-exec-<tag>-<uuid>` when a tag is given; `KILL_TAGGED_SCRIPT` = `KILL_ALL_SCRIPT` matching `capybara-exec /tmp/[.]capybara-exec-<tag>-`; `killTagged` validating `SANDBOX_TAG_RE`; `concurrentExec: true`; auto-start tolerates 304 / "already started"), `plugins/sandbox-docker/README.md`, `plugins/sandbox-e2b/src/provider.ts` (same wrapper change, `killTagged`, `concurrentExec: true`, concurrent `connect` tolerated), `plugins/sandbox-e2b/README.md`, `packages/testing/src/fake-e2b*` only if the fake envd serializes processes (fix it to run them concurrently)
- Test: `plugins/sandbox-docker/test/concurrent.test.ts` (gated like `sandbox-docker.test.ts`), append to `plugins/sandbox-e2b/test/sandbox-e2b.test.ts` (`startFakeE2B`), append to `plugins/sandbox-e2b/test/live/sandbox-e2b.live.test.ts`

**Interfaces:**
- Consumes: Task 2 SDK additions.
- [ ] **Step 1: Failing tests (Docker):** `two sleep 2; date +%s%N commands overlap`; `killTagged kills one tag's process tree and leaves the other running`; `a timed-out command kills only itself`; `concurrent auto-start of a stopped container succeeds for both calls`; `killTagged rejects a tag outside SANDBOX_TAG_RE`. **(E2B fake):** the same five. **(E2B live):** `concurrent processes and uploads` (header lists it under assumptions to confirm).
- [ ] **Step 2:** `pnpm exec vitest run plugins/sandbox-docker/test/concurrent.test.ts plugins/sandbox-e2b/test` → FAIL (or skipped without Docker; then run with Docker before claiming PASS).
- [ ] **Step 3: Implement.** No socket-proxy rule change (`pnpm check:compose-haproxy` unchanged).
- [ ] **Step 4:** PASS with Docker available; `pnpm --filter @capybara-hq/plugin-sandbox-docker exec tsc --noEmit` via `pnpm typecheck`; `pnpm check:plugin-pack` packs both.
- [ ] **Step 5: Commit** `feat(sandbox-docker,sandbox-e2b): tagged concurrent exec and killTagged`.

### Task 6: Agent definition `subagents`, roster and effective definition

**Files:**
- Modify: `packages/kernel/src/agents/definition.ts` (`subagents` schema, §5.2, with `InlineAgentTemplate` = `AgentTemplate` with `skills` as ids), `packages/kernel/src/agents/agents.service.ts` (save checks → `agent.subagents_invalid` with reasons `not_found`, `invalid_name`, `duplicate`, `tool_not_selected`, `skill_not_selected`, `agent_not_available`, `self`, `too_many`; export `isAgentVisibleTo(db, agentId, accountId): Promise<boolean>` reusing the visibility predicate), `packages/kernel/src/errors.ts`, `packages/kernel/src/models/purposes.ts` (`subagent_fast`, `subagent_standard`, `subagent_capable`, kind chat, labels zh / en)
- Create: `packages/kernel/src/runtime/subagents/roster.ts`, `packages/kernel/src/runtime/subagents/definition.ts`
- Test: `packages/kernel/test/agents/subagents-definition.test.ts`, `packages/kernel/test/runtime/subagents/definition.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RosterEntry {
    type: string;                                   // "general-purpose" | inline name | "<plugin>:<name>" | org agent `as`
    source: "general" | "inline" | "plugin" | "agent";
    description: string;                            // cut to 1024
    templateId?: string; agentId?: string; plugin?: string;
  }
  export async function resolveRoster(db: KernelDb, orgId: string, parent: AgentDefinition): Promise<RosterEntry[]>;  // ≤ 20, owner's order, general-purpose first when enabled
  export function findType(roster: RosterEntry[], requested: string): RosterEntry | null;  // bare plugin name accepted when unique
  export interface EffectiveDefinition { definition: AgentDefinition; template: EventPayload<"subagent_started">["template"]; maxSteps: number; warnings: string[] }
  export async function effectiveDefinition(d: { db: KernelDb; purposes: ModelPurposesService; config: () => KernelConfig },
    a: { orgId: string; parent: AgentDefinition; parentAgentId: string; entry: RosterEntry; tier?: AgentTemplateTier })
    : Promise<EffectiveDefinition & { model: ModelRef; tierFallback: boolean }>;
  export const CHILD_REMOVED_TOOLS = ["agent", "ask_user", "sandbox_deliver", "skill_write"] as const;
  ```
- Rules (tests pin them): §5.3 narrowing for general / inline / plugin (tools filtered by resolved key, `tools: "all"` connector refs narrowed, `disallowedTools` removed, `CHILD_REMOVED_TOOLS` always removed; policies stricter-wins; pinned = template skills ∩ selection, ≤ 3 / 32 KB with warnings; general pins nothing; `maxSteps = min(template ?? runtime.maxSteps, runtime.maxSteps)`); §5.4 tiers (call → template → inherit; unmapped purpose → parent model, `tierFallback: true`; `effort` only when declared); §5.5 for `source: "agent"` (the agent's current version, its own tools minus `CHILD_REMOVED_TOOLS`, its policies then the parent's same-key policies stricter-wins, its skills and pinned, its model; `tier` ignored).
- [ ] **Step 1: Failing tests:** save checks one per reason; **Review Focus 3** `a definition without subagents saves without a new version`; `allowlisting an agent the editor cannot see → agent_not_available`; `dispatchable false on the target → agent_not_available`; roster order and the 20 cap; `findType` bare-name rule; narrowing per source; tier resolution incl. fallback; org agent overlay (`ask` from the agent + parent `deny` on another key; the agent's connector kept although the parent lacks it).
- [ ] **Step 2:** Run both test files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; `pnpm typecheck`; `pnpm exec vitest run packages/kernel/test/agents`.
- [ ] **Step 5: Commit** `feat(kernel): sub-agent roster and effective definitions`.

### Task 7: The `agent` builtin tool (spec, description, results)

**Files:**
- Create: `packages/kernel/src/tools/builtins/agent.ts`
- Modify: `packages/kernel/src/tools/registry.ts` (register; per-agent description from the roster; `isAlwaysLoaded`), `packages/kernel/src/tools/builtins/tool-search.ts` (always loaded)
- Test: `packages/kernel/test/tools/agent-tool.test.ts`

**Interfaces:**
- Consumes: `resolveRoster` (Task 6).
- Produces:
  ```ts
  export const AGENT_TOOL = "agent";
  export const AgentToolInput: z.ZodType<{ description: string; prompt: string; subagent_type?: string; model?: AgentTemplateTier; resume?: string }>;
  export function agentToolSpec(roster: RosterEntry[], maxConcurrent: number): ToolSpec;   // description text §4.3 verbatim
  export function agentResultText(r: { reply: string; agentId: string; status: SubagentStatus; errorCode?: string; errorMessage?: string;
    toolCalls: number; durationMs: number; tokens: number; ownModel?: boolean }): { content: string; isError: boolean };  // §4.4 table
  export const AGENT_REFUSALS: { unknownType(x: string, roster: string[]): string; tooManyConcurrent(n: number): string;
    tooManyDispatches(n: number): string; budget(n: number): string; noSuchAgent(id: string): string; stillRunning(id: string): string;
    resumeWithType: string; notAvailableHere: string; agentNotAvailable(name: string): string };   // §4.5 verbatim
  ```
- [ ] **Step 1: Failing tests:** golden description text for a roster with general, one inline, one plugin, one org agent; schema rejects extra keys and a vendor model name; `agentResultText` for each §4.4 row (exact strings); the tool passes `pnpm check` tool-design rules; a child's tool resolution never contains `agent`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** (the handler body is a stub that Task 8 replaces with the pipeline path; the registry marks `agent` as handled by the pipeline, not `execute`).
- [ ] **Step 4:** PASS; `pnpm check` (tool design rules).
- [ ] **Step 5: Commit** `feat(kernel): the agent builtin tool definition`.

### Task 8: Dispatch and child runs (single replica)

**Files:**
- Create: `packages/kernel/src/runtime/subagents/dispatch.ts`, `packages/kernel/src/runtime/subagents/child.ts` (finish hook, result read), `packages/kernel/src/runtime/subagents/preamble.ts` (`SUBAGENT_PREAMBLE` verbatim §6.3), `packages/kernel/test/fixtures/plugins/model-script/` (`index.ts`, manifest; deployment config `{ rules: { when: { systemIncludes?: string; lastUserIncludes?: string; lastToolResultIncludes?: string; assistantTurns?: number }; reply: { text?: string; toolCalls?: { name: string; input: unknown }[] } }[] }`, first match wins, default "done")
- Modify: `packages/kernel/src/tools/pipeline.ts` (`agent` path §7.1: no `tool_call_started`; dispatch after policy / approval / `tool.preExecute`; dispatched-call check by `(runId, callId)`; open calls → `{ kind: "suspended", waitingFor: { kind: "subagents", id: "sa-<runId>-<step>", expiresAt } }`), `packages/kernel/src/runtime/loop.ts` (`WaitingFor.kind` adds `"subagents"`), `packages/kernel/src/runtime/run-queue.ts` (`SUBAGENT_RUN_QUEUE_NAME = "cap-kernel-subagent-runs"`; `enqueue` picks the queue by conversation kind), `packages/kernel/src/runtime/run-worker.ts` (second `Worker` on the subagent queue; `kind = 'subagent'` takes the definition and `maxSteps` from `subagent_started`; calls `onChildFinished` after the terminal commit), `packages/kernel/src/runtime/context/build.ts` + `runtime/model-call.ts` (system = `BEHAVIOR_RULES` + preamble + instructions for a subagent conversation, from the log), `packages/kernel/src/conversations/conversations.service.ts` (`get` / `isAccessible` accept `subagent`; `postUserMessage` on a child → 409 `conversation.read_only`), `packages/kernel/src/errors.ts`, `packages/kernel/src/kernel.ts` (wiring), `packages/kernel/src/tools/builtins/sandbox/common.ts` callers (a child's `sandboxConversationId` = its parent conversation); audit `subagent.dispatched` for every dispatch (actor: trigger account; target: child conversation; detail: parent conversation, run, call, agent type, source)
- Test: `packages/kernel/test/runtime/subagents/dispatch.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 6, 7.
- Produces:
  ```ts
  export async function dispatchSubagent(d: DispatchDeps, a: { ctx: ToolStepContext; callId: string; input: AgentToolInputT }):
    Promise<{ kind: "dispatched"; childRunId: string } | { kind: "refused"; content: string }>;
  export async function onChildFinished(d: ChildDeps, childRunId: string): Promise<void>;   // appends subagent_finished (idem), then Waits.resume(parentRunId, childRunId)
  export async function childResult(db: KernelDb, eventLog: EventLog, childRunId: string): Promise<{ content: string; isError: boolean; finished: EventPayload<"subagent_finished"> }>;
  ```
- [ ] **Step 0:** Zero-drift tests PASS.
- [ ] **Step 1: Failing tests** (one kernel, `model-script`, `sandbox-fake`): `a child's sandbox_write lands in the parent conversation's sandbox`; `a general-purpose dispatch: child conversation with subagent_started then the task message; the child's first request holds only system (rules + preamble + instructions) and the prompt; the parent gets the reply plus status line`; `three agent calls in one response run concurrently and the parent continues once`; `resume appends a message to the same child conversation and the child sees its earlier history`; **Review Focus 4** `resume with another conversation's child id, a running id, a bad id, and the same id twice in one response: each refused with the §4.5 text, nothing started`; `posting to a child conversation is 409 conversation.read_only`; `a child cannot see the agent tool`; `a dispatch refused by tool.preExecute starts nothing`.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/runtime/subagents/dispatch.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; zero-drift tests PASS; `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/tools`.
- [ ] **Step 5: Commit** `feat(kernel): dispatch sub-agents as child runs`.

### Task 9: Suspend, resume and recovery across replicas

**Files:**
- Modify: `packages/kernel/src/runtime/waits.ts` (`isSettled` for `subagents`; third `NOT EXISTS` in `resume` over `subagent_dispatches` joined to active child runs; `sweepStuckRuns` likewise; new sweep `sweepSubagentOrphans`: queued child past grace without a job → re-enqueue, running without job and lock → `run.orphaned` + `onChildFinished`; expiry of a `subagents` wait = now + `tools.approvalTimeoutHours` + `runtime.maxRunSeconds` + 10 min, whose timeout stops remaining children (Task 13 provides `stopChildren`)), `packages/kernel/src/runtime/run-queue.ts` (`isOrphan` reusable for children)
- Test: `packages/kernel/test/runtime/subagents/resume.test.ts`, `packages/kernel/test/runtime/subagents/subagents.dual.test.ts`

**Interfaces:**
- Consumes: Task 8.
- [ ] **Step 1: Failing tests:** `the parent resumes exactly once when the last of three children finishes (finish order permuted)`; `a step with an approval and a sub-agent resumes only after both`; `crash after the dispatch commit and before enqueue: the sweep re-enqueues, no second dispatch`; `child finisher crash: the sweep resumes the parent and the parent writes the missing subagent_finished`; **Review Focus 1** `a user message during the wait starts no run and is absorbed after resume`; `waiting time is in waited_ms, not the parent deadline`. Dual: `parent on A, children on B, the parent resumes on B`; `a child replica killed repeatedly → run.stalled → parent result failed (run.stalled)`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS; `pnpm exec vitest run packages/kernel/test/runtime/waits.test.ts packages/kernel/test/runtime/wait-sweep.test.ts packages/kernel/test/runtime/waits-dual.test.ts` still PASS.
- [ ] **Step 5: Commit** `feat(kernel): resume parents from sub-agent completion across replicas`.

### Task 10: Limits and token accounting

**Files:**
- Modify: `packages/kernel/src/config/schema.ts` (`subagents.*`), org settings (`subagentLimitOverrides` in `packages/kernel/src/identity/settings.ts` or the org settings service the run concurrency override uses), `packages/kernel/src/runtime/subagents/dispatch.ts` (concurrency, dispatch-count and budget checks under the parent run row lock), `packages/kernel/src/runtime/model-call.ts` (after a child's `usage` event: `UPDATE runs SET subagent_tokens_used = subagent_tokens_used + n WHERE id = parentRunId RETURNING`; before each child request: at or over cap → finish the child `run_finished { reason: "budget" }`), `docs/config.md`
- Test: `packages/kernel/test/runtime/subagents/limits.test.ts`

**Interfaces:**
- Produces: `subagentLimits(settings, config, orgId): Promise<{ maxConcurrentPerRun: number; maxDispatchesPerRun: number; maxTokensPerRun: number }>`.
- [ ] **Step 1: Failing tests:** `five calls with maxConcurrentPerRun 3: three dispatched, two refused with the exact text`; `the 51st dispatch of a run is refused`; `child usage (step and compaction) sums into the parent run's counter`; `over the cap a running child ends with budget and the parent's result says stopped: token budget used up`; `a dispatch at the cap is refused`; `an org override lowers the cap`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; `pnpm gen:config-docs`; `pnpm check`.
- [ ] **Step 5: Commit** `feat(kernel): sub-agent concurrency, dispatch and token limits`.

### Task 11: Permissions, approvals surfacing and hooks

**Files:**
- Modify: `packages/kernel/src/tools/policy.ts` (child overlay: parent agent current version, then frozen overlay; for `source: "agent"` the dispatched agent's current version then the parent's same-key policies; session grants looked up and stored on the parent conversation), `packages/kernel/src/tools/approvals.service.ts` (`ApprovalView.parentConversationId`; session grant stored on the parent conversation), `packages/kernel/src/runtime/waits.ts` (`suspend` of a child appends `subagent_waiting`), `packages/kernel/src/tools/pipeline.ts` (`connection_required` in a child also appends `subagent_waiting { kind: "connect" }`), `packages/kernel/src/channels/outbound.ts` (render `subagent_waiting` approval / input as the card of `approval_requested` / `question_asked` by id), `packages/kernel/src/runtime/hook-calls.ts` (`hookScope` fires for `subagent`, sets `parent`; `ConversationKindForHooks` adds `"subagent"`), `packages/kernel/src/runtime/usage-report.ts` (child: `conversationKind: "chat"` + `parent`), `.agents/skills/writing-extensions/SKILL.md` (hooks: `parent`)
- Test: `packages/kernel/test/runtime/subagents/permissions.test.ts`, append to `packages/kernel/test/runtime/hooks-runtime.test.ts`, `packages/kernel/test/runtime/usage-report.test.ts`, `packages/kernel/test/channels/` (new `subagent-cards.test.ts` with the fake channel server)

**Interfaces:**
- Consumes: Tasks 6, 8.
- [ ] **Step 1: Failing tests:** `a template's ask on top of the parent's allow asks; a template cannot loosen a parent deny`; `a child's approval goes to the starter, appears as subagent_waiting in the parent log and in GET /inbox with parentConversationId`; `approve for this conversation on one child covers a sibling's identical call`; **Review Focus 2** `a child of a fake-channel conversation: the approval card is posted in the thread, approving there resumes child and parent`; hooks: `tool.preExecute and model.request fire for a child with parent set; eval replays still fire none`; usage: `a child's usage.report has conversationKind chat and parent`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/channels packages/kernel/test/tools`.
- [ ] **Step 5: Commit** `feat(kernel): sub-agent policies, approvals in the parent and hook scope`.

### Task 12: Org agents as sub-agents

**Files:**
- Create: `packages/kernel/src/runtime/subagents/org-agents.ts`
- Modify: `packages/kernel/src/runtime/subagents/dispatch.ts` (gates at dispatch and `resume`; child conversation `agent_id` = dispatched agent, run `agent_version` = its frozen version; audit), `packages/kernel/src/tools/policy.ts` / `credentials.ts` (agentId of the child for always-grants; personal credentials of the trigger account)
- Test: `packages/kernel/test/subagents/org-agents.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OrgAgentGate = "allowlist" | "dispatchable" | "visibility" | "deleted";
  export async function checkOrgAgent(db: KernelDb, a: { orgId: string; parentDefinition: AgentDefinition; agentId: string; triggerAccountId: string })
    : Promise<{ ok: true; version: number; definition: AgentDefinition } | { ok: false; gate: OrgAgentGate }>;
  // audit actions "subagent.dispatched" (every dispatch, Task 8 writes it for all sources) and "subagent.refused" (detail.gate)
  ```
- [ ] **Step 1: Failing tests** (spec §21 "Org agents" item, each as an `it`): starter's personal credential used for the analyst's connector; stricter policy result; approval to the starter; always-grant stored for the analyst agent; `subagent.dispatched` audited; refusals for a member outside the members list, `dispatchable` turned off after allowlisting, a deleted agent (each `subagent.refused` with the gate); follow-up keeps the frozen version after the analyst's new version.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(kernel): dispatch other org agents as sub-agents`.

### Task 13: Cancellation

**Files:**
- Modify: `packages/kernel/src/runtime/waits.ts` (`abortWaiting`: open `agent` calls get `The run was stopped while this sub-agent was working; it was stopped too.`; after commit `stopChildren(parentRunId, byAccountId)`), `packages/kernel/src/runtime/subagents/child.ts` (`stopChildren`: waiting child → its `abortWaiting`; queued / running → `RunAbort.request`), `packages/kernel/src/runtime/run-worker.ts` / `run-finish.ts` (after any parent terminal commit: `stopChildren`), `waits.ts` sweep (active child of a terminal parent → stop), `packages/kernel/src/conversations/conversations.service.ts` (`abort` on a child conversation)
- Test: `packages/kernel/test/runtime/subagents/cancel.test.ts`

**Interfaces:**
- Produces: `stopChildren(d: ChildDeps, parentRunId: string, byAccountId: string | null): Promise<number>`.
- [ ] **Step 1: Failing tests:** `stopping the parent while three children run (one waiting for approval) leaves all four aborted and the parent's calls with the stop text`; `stopping one child: the parent gets "stopped by the user" and completes after the others`; `the parent's deadline ends it and its children stop`; `a subagents wait timeout stops remaining children and resumes the parent`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(kernel): stop sub-agents with their parent and on their own`.

### Task 14: Sub-agent APIs and progress

**Files:**
- Modify: `packages/kernel/src/conversations/conversations.controller.ts` + `.service.ts` (`GET /conversations/:id/subagents`, view fields `parentConversationId`, `subagentType`; usage of a conversation includes children), `packages/kernel/src/runtime/run-worker.ts` / `model-call.ts` (after each child step publish `{ kind: "subagent_progress", subagentId, step, toolCalls, lastToolKey? }` on the parent's conversation topic), `packages/kernel/src/runtime/stream.ts` (forward it)
- Test: `packages/kernel/test/conversations/subagents.http.test.ts`

**Interfaces:**
- Produces: `SubagentView { id; agentType; description; status; toolCalls; startedAt; finishedAt: string | null; usage; pendingApprovalIds: string[]; pendingQuestionIds: string[] }`; route owner-only, paged `?after=&limit=` (≤ 100).
- [ ] **Step 1: Failing tests:** `the list shows each sub-agent with status and counts; another user gets 404`; `GET a child conversation and its events works for the owner`; `listMine never lists children`; `the parent's SSE receives subagent_progress during a child run`; `conversation usage sums the children`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(kernel): sub-agent list API and progress messages`.

### Task 15: Agent templates from plugins

**Files:**
- Create: `packages/kernel/src/agents/templates.ts` (store: create version, list for org, resolve by id / `<plugin>:<name>`)
- Modify: `packages/kernel/src/catalog/plugin-package.ts` (read `agents` refs or scan `agents/*.md`, `parseAgentTemplate`), `packages/kernel/src/catalog/plugin-import.ts` (review lists templates; part of `reviewHash`), `packages/kernel/src/catalog/plugin-install.ts` (component kind `agent_template`; skills resolved by name within the plugin first), `packages/kernel/src/catalog/plugin-upgrade.ts` (diff + `diffHash`; rollback), uninstall (`used_by_agents` keeps a selected template), `tools/pack-plugin` (packs `agents/`), `.agents/skills/writing-plugins/SKILL.md`
- Test: `packages/kernel/test/catalog/agent-templates.test.ts`

**Interfaces:**
- Produces: `AgentTemplatesService { listForOrg(orgId): Promise<AgentTemplateView[]>; resolve(orgId, ref: string): Promise<{ id; version; plugin; template: AgentTemplate } | null> }` (consumed by `resolveRoster` / `effectiveDefinition`, which until this task read the tables directly).
- [ ] **Step 1: Failing tests:** `a plugin with agents/reviewer.md imports with the template in the review and reviewHash`; `org install creates the template; an agent selects it; it appears in the roster as <plugin>:reviewer`; `upgrade adds a version and lists it in the diff`; `uninstall keeps a selected template (used_by_agents)`; `rollback restores the previous version`; `a running sub-agent keeps its frozen definition after an upgrade`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; `pnpm exec vitest run packages/kernel/test/catalog`; `pnpm check:plugin-pack`.
- [ ] **Step 5: Commit** `feat(kernel): agent templates in plugins`.

### Task 16: Claude `agents/*.md` translation and the tool-name map

**Files:**
- Modify: `packages/kernel/src/catalog/claude/translate.ts` (`agents/` joins the tree; generated `.capybara-generated/agents/<name>.json`; field table §16.4), `packages/kernel/src/catalog/claude/report.ts` (codes `agent_imported`, `agent_invalid`, `agent_tools_unmapped`, `agent_model_mapped`, `agent_skills_truncated`, `agent_field_ignored`; retire `agent_needs_subagents`; `skill_needs_subagents` detail text "runs as a sub-agent when invoked manually; phase D"), `packages/kernel/src/runtime/context/claude-tools.ts` (the two lines of §16.5 verbatim), `apps/web/messages/*.json` (report messages)
- Test: append to `packages/kernel/test/catalog/claude-translate.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts` (a snapshot with the new map text)

- [ ] **Step 0:** Zero-drift tests PASS.
- [ ] **Step 1: Failing tests:** `superpowers code-reviewer imports as superpowers:code-reviewer with model inherit and the parent's tools`; `mixed reviewer: tools mapped, Agent / AskUserQuestion / WebFetch dropped with agent_tools_unmapped, haiku → fast, permissionMode / hooks / mcpServers not_applicable, memory / isolation agent_field_ignored`; `a name with uppercase is agent_invalid, never renamed`; `an old snapshot keeps its old map text; a new snapshot gets the new one; both reconstruct with zero drift`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; zero-drift tests PASS.
- [ ] **Step 5: Commit** `feat(kernel): translate Claude agents into agent templates`.

### Task 17: Replay, evals and the trajectory viewer

**Files:**
- Modify: `packages/kernel/src/evals/reconstruct.ts` (`DriftReason` `"subagent_changed"` after `pinned_changed` in `DRIFT_ORDER`; a `subagent` case reconstructs from `subagent_started`), `packages/kernel/src/evals/snapshot.ts` (`CaseSnapshot.subagent?: { definition: AgentDefinition; preamble: string }`), `packages/kernel/src/evals/run-replay.ts` (child case full-run replay uses the logged definition), `packages/kernel/src/evals/trajectory.ts` + `trajectory.service.ts` (agent call span with `subagentId`; child header with parent link; access same as parent), `.agents/skills/replay-evals/SKILL.md`
- Test: append to `packages/kernel/test/evals/reconstruct.test.ts`, `packages/kernel/test/evals/run-replay.test.ts`, trajectory tests

- [ ] **Step 0:** Zero-drift tests PASS.
- [ ] **Step 1: Failing tests:** `parent full-run replay with three parallel agent calls and a resume: same requests, zero tool_unmatched, no child conversation created, no subagent_* events`; `each child step reconstructs with drift []`; `a candidate template version (and, for an org agent child, a candidate agent version) → subagent_changed, request still from the log`; `a child case's full-run replay uses the logged definition`; `the trajectory of a parent links each agent call to its child and back; another user gets 404`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; zero-drift tests PASS; `pnpm exec vitest run packages/kernel/test/evals`.
- [ ] **Step 5: Commit** `feat(kernel): replay and evals for sub-agents`.

### Task 18: Web: sub-agents in the conversation

**Files:**
- Create: `packages/design/src/conversation/subagent-group.tsx` (`SubagentGroup`, `SubagentRow`; props from spec §17), `/dev/ui` fixtures, design spec entry in `docs/design/spec.md`
- Modify: `apps/web/src/...` conversation page (message list renders `agent` calls from `subagent_dispatched` / `subagent_finished` / progress; Inspector view "Sub-agent": task block, agent / model / tools line, read-only message list, stop button; `subagent_waiting` cards; inbox link to the parent with the child open), `apps/web/src/lib/*` API client (`/subagents`, child conversation), `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/subagents.test.tsx`, screenshot cases via `/dev/ui` (baselines through the `visual-update` workflow)

- [ ] **Step 1: Failing tests:** `three running sub-agents render one group "3 sub-agents running"; finished "3 sub-agents done (1 failed) · N calls · duration"`; `clicking a row opens the read-only child view with stop`; `stop calls POST /conversations/:childId/abort`; `a child's approval card renders in the parent with the sub-agent's name`; `an org agent row shows that agent's name and avatar`.
- [ ] **Step 2:** `pnpm exec vitest run apps/web/test/subagents.test.tsx` → FAIL. **Step 3:** Implement. **Step 4:** PASS; `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm --filter @capybara-hq/web build`.
- [ ] **Step 5: Commit** `feat(web): sub-agents in the conversation page`.

### Task 19: Web: agent page, review and purposes

**Files:**
- Modify: agent page (Sub-agents section: `agent` toggle, general-purpose, templates, inline templates, org-agent allowlist with the "shared more widely" warning, `dispatchable` switch), import review and catalog item (agent templates), model purposes page (three tiers), `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/agent-subagents.test.tsx`, append to `apps/web/e2e/skills.spec.ts` or a new `apps/web/e2e/subagents.spec.ts` (loads only `model-fake`; add it to `tools/ci/test-plugins.json` under `apps/web/e2e` only if a new plugin is loaded)

- [ ] **Step 1: Failing tests:** `saving templates, an inline template and an org agent sends the subagents block`; `the 400 agent.subagents_invalid reasons show next to the field`; `the dispatchable switch saves`; `the review lists agent templates with tier and tools`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm check:test-plugins`.
- [ ] **Step 5: Commit** `feat(web): sub-agent settings on the agent page`.

### Task 20: Acceptance, live checklist and as-built

**Files:**
- Modify fixture: `packages/kernel/test/catalog/fixtures/claude/superpowers/` (add `skills/subagent-driven-development/` with `SKILL.md`, `implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`, `scripts/task-brief`, `scripts/review-package`; `skills/requesting-code-review/`, `skills/dispatching-parallel-agents/` from superpowers 7.0.x, MIT; update `FIXTURE.md`; no `.js` / `.cjs`)
- Create: `packages/kernel/test/subagents/superpowers-sdd.e2e.test.ts`, `model-script` rules file `packages/kernel/test/subagents/sdd-script.json`
- Modify: `docs/superpowers/plans/m7-live-acceptance-checklist.md` (or the current release checklist: the live SDD item), `docs/superpowers/specs/2026-10-26-subagents-design.md` ("As built" section: deviations, rulings), AGENTS.md (rules line for sub-agents and concurrent sandbox leases; `writing-tools` skill section for `agent`), `.changeset/ecosystem-phase-c.md` (final sentence)
- Test: the e2e test

- [ ] **Step 1: Write the e2e test** per spec §21 "End to end on fakes": agent with sandbox tools, `skill_load`, `agent`, template `superpowers:code-reviewer`; two-task plan file in the fake sandbox workspace (git initialized); the script drives: load skill → `scripts/task-brief` → implementer (`model: "fast"`, writes and commits) → `scripts/review-package` → reviewer (one finding) → `resume` implementer → scoped re-review → task 2 → final review with `superpowers:code-reviewer` (`model: "capable"`). Assertions: each child's first request holds only system and prompt; results have the status line; both commits are in the shared workspace; `subagent_fast` mapped, `subagent_capable` unmapped (`tierFallback: true`); parent run's `subagent_tokens_used` equals the sum of child usage; a parent full-run replay has zero `tool_unmatched`.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/subagents` → PASS (if it fails, the failing behavior belongs to the task that owns it; fix there).
- [ ] **Step 3:** Run the full gate: `pnpm lint && pnpm typecheck && pnpm check && pnpm exec vitest run packages/kernel packages/plugin-sdk apps/web plugins/sandbox-docker plugins/sandbox-e2b`, then `pnpm verify`.
- [ ] **Step 4:** Write the spec "As built" section and the checklist item; `pnpm check:terms`.
- [ ] **Step 5: Commit** `test(kernel): superpowers subagent-driven-development end to end` and `docs: sub-agents as built`.
