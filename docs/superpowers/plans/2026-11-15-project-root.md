# Project root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversation can bind one project on its device, and the agent starts every run already knowing that repository's `AGENTS.md` and `.agents/skills/`, working inside it.

**Architecture:** The device declares its projects in its local policy and gains four request operations; the kernel records a `project_root` snapshot event at run start (before the first model call), renders it as a system segment, merges the project's skills into the catalog as `project:<name>`, and makes the project root the working directory and the command review's workspace fact. The device's file calls widen only where auto mode already widens them.

**Tech Stack:** TypeScript, NestJS kernel, Kysely + PostgreSQL, Zod event schemas, Next web app + `packages/design`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-project-root-design.md`

## Global Constraints

- English for code, comments, docs and commit messages; UI text goes through i18n (zh and en); Chinese UI writes agent as 智能体 (`pnpm check:i18n`).
- Pre-0.1.0: no compatibility layers. Applied migrations stay immutable; the new one is `0133_project_root.sql`, `IF NOT EXISTS`.
- Every model-visible text is an event in the log. Run the zero-drift fixtures before and after any change in request building.
- Multi-replica: no state in process memory; writes in `@Transactional()`; post-commit work through the outbox.
- A kernel route added for this is a Platform operation or an exclusion with a reason (`pnpm check:platform-ops`).
- `@capybara-hq/plugin-sdk` changes need `pnpm gen:sdk-api` and a changeset.
- Run vitest from the repository root: `pnpm exec vitest run <path>`.
- Caps: `AGENTS.md` 64 KiB; skill descriptions follow `CATALOG_DESCRIPTION_MAX_CHARS`; candidates at most 50 entries, two levels deep.

## Review Focus

1. **A project root outside the device's workspace (auto mode).** Every write inside the project must be judged inside, not `ask`: the review's `workspace` fact is the project root, and `Bash` runs there.
2. **A project that disappeared.** The run continues in free mode with a notice, and the old `AGENTS.md` stops rendering — it must not keep instructing the model.
3. **A device that predates the project operations.** No projects offered, no failed call, no error the model sees.
4. **Replay.** A recorded conversation with a project renders from the log; a replay never reads the device.
5. **Size.** A huge `AGENTS.md` or a large skills tree truncates visibly and never swallows the context.

## Decisions taken while planning

Each is marked so review can overturn it.

- **P-D1 The binding is stored on the conversation as name + path.** `NewConversationDevice` gains `project?: string` (the name); the path is resolved from the device's declared list at create time and both are written to `conversations.project_name` / `conversations.project_path`, so a device that later re-points a name does not silently move an existing conversation.
- **P-D2 Projects live in the device's `policy.json`**, beside the mode, and are reported on `DeviceLocalPolicySummary`. The device is the only writer.
- **P-D3 The knowledge is recorded at run start by a new `ProjectKnowledgeService`**, called from the run pipeline before the first model call — not from the sandbox tool path (`device_paths` stays where it is).
- **P-D4 The review is unchanged.** The pipeline passes `workspace: projectRoot ?? roots.workspace`; every rule that reads "the workspace" then reads the project root.
- **P-D5 Skill bodies are read on demand.** The event records name, description and digest only; `Skill` loads a body through the provider and its result is a tool result in the log.
- **P-D6 `SandboxProvider` gains `list`.** The device, `sandbox-docker` and `sandbox-e2b` implement it; a provider without it offers no projects (free mode).
- **P-D7 Candidates are a two-level scan** for a directory containing `.git` or `AGENTS.md`, at most 50 entries, never file contents.
- **P-D8 A device without the four operations** (an older program) reports no projects and the conversation stays in free mode; the kernel never calls an op the device did not advertise.
- **P-D9 The project's instructions render after the agent's own**, and a direct conflict resolves to the agent's instructions.
- **P-D10 Binding is create-time and owner-only**, checked in the service inside the conversation's transaction.

## Wave plan

| Task | Depends on | Files / area | Risk | Wave | Review |
|---|---|---|---|---|---|
| T1 Contract: projects on the policy summary, four ops, `list` | — | `packages/plugin-sdk/src/{device-protocol,sandbox,index}.ts`, `api/plugin-sdk.api.md`, changeset | **high** (public SDK) | 1 | alone |
| T2 Device: project store, four ops, policy report | T1 | `packages/device/src/{policy,server-ops,project}*` | **high** (trust boundary: what a device offers) | 2 | alone |
| T3 Device: `list` implementation | T1 | `packages/device/src/...` provider adapter | normal | 2 | batch |
| T4 Kernel: `project_root` event schema | T1 | `conversations/events.ts` | normal | 2 | batch |
| T5 Kernel: conversation columns, migration, binding on create | T4 | `migrations/0133_project_root.sql`, `db/kernel-schema.ts`, `conversations/conversations.service.ts`, DTO/schema | **high** (migration, ownership check) | 3 | alone |
| T6 Kernel: `ProjectKnowledgeService` at run start | T4, T5 | `runtime/project/…`, run pipeline | **high** (fail-closed, multi-replica) | 3 | alone |
| T7 Kernel: rendering, catalog merge, `Skill` loading | T6 | `runtime/context/{build,skills,project}.ts`, `tools/builtins/skill-load.ts` | **high** (replay) | 4 | alone |
| T8 Kernel: working directory and the review's workspace fact | T6 | `tools/builtins/sandbox/{bash,glob,grep,common}.ts`, `tools/pipeline.ts` | **high** (trust boundary) | 4 | alone |
| T9 Kernel: the four admin routes + Platform operations | T5, T6 | `devices/*.controller.ts`, `platform/ops/*` | normal | 4 | batch |
| T10 Kernel: free-mode fallbacks and notices | T6 | `runtime/project/…`, `conversations/events.ts` | normal | 4 | batch |
| T11 Web: project list + form on the device settings view | T9 | `app/(app)/devices/[id]/view.tsx`, `components/DeviceProjectsSection.tsx`, `lib/devices.ts`, messages | normal | 5 | batch |
| T12 Web: composer binding, header, `/` menu source | T9, T11 | `components/conversation/ComposerBar.tsx`, conversation header, `skills/invocable.controller.ts`, `apps/web/src/lib/query/skills.ts` | normal | 5 | batch |
| T13 plugins: `list` in `sandbox-docker` / `sandbox-e2b` | T1 | `capybara-hq/plugins` | **high** | after core | alone |
| T14 Docs, skills, changesets, verify | all | `docs/guide/devices.md`, `.agents/skills/*`, changesets | normal | 6 | batch |

---

## Phase 1 — contract

### Task 1: `projects` on the policy summary, four device ops, `list`

**Files:**
- Modify: `packages/plugin-sdk/src/device-protocol.ts`
- Modify: `packages/plugin-sdk/src/sandbox.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Test: `packages/plugin-sdk/test/device-protocol.test.ts`
- Generated: `api/plugin-sdk.api.md`; changeset under `.changeset/`

**Interfaces:**
- Produces: `DeviceProject = { name: string; path: string }`; `DeviceLocalPolicySummary.projects: DeviceProject[]` (always present, `[]` when none); `DeviceOp` gains `"projectList" | "projectCandidates" | "projectAdd" | "projectRemove"`; `SandboxProvider.list(h: SandboxHandle, path: string, signal: AbortSignal): Promise<{ name: string; isDir: boolean }[]>`.

- [ ] **Step 1: Write the failing test**

In `packages/plugin-sdk/test/device-protocol.test.ts`, a parse test: a summary without `projects` parses to `{ mode, allowedDomains, projects: [] }` (the field is defaulted, never absent), and one with `projects: [{ name: "core", path: "/w/core" }]` round-trips; a `policy` op result carrying an unknown op name still parses.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/plugin-sdk/test/device-protocol.test.ts`
Expected: FAIL — `projects` is not part of the summary.

- [ ] **Step 3: Add the types**

`DeviceProject`, the new `DeviceLocalPolicySummary.projects` (defaulted in the parser, alongside how the existing summary fields default), the four `DeviceOp` members plus their entries in `DEVICE_OPS`, and `SandboxProvider.list` with the signature above.

- [ ] **Step 4: Regenerate the API report and add a changeset**

Run: `pnpm gen:sdk-api`, then add `.changeset/<slug>.md` bumping `@capybara-hq/plugin-sdk` (new public types and a new provider method).

- [ ] **Step 5: Run the tests and the SDK checks**

Run: `pnpm exec vitest run packages/plugin-sdk/test && pnpm check:sdk-api && pnpm check:sdk-api-changeset`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sdk .changeset api
git commit -m "feat(plugin-sdk): a device reports its projects, and providers list a directory"
```

### Task 1b: the kernel parses the device's projects

Added during execution: the plan's T1 made `projects` a required field, so the kernel's own summary
parser and the test fixtures that write one stopped compiling, and no task owned them.

**Files:**
- Modify: `packages/kernel/src/local-devices/policy-summary.ts` (`localPolicyOf`)
- Test: `packages/kernel/test/local-devices/` (beside the existing summary tests)
- Modify: the kernel test files that build a policy summary literal (~12 files the compiler names)

**Interfaces:**
- Consumes: `DeviceLocalPolicySummary.projects` (T1), defaulted to `[]` by the parser.
- Produces: the kernel's parsed local policy carries `projects`, which T9's routes and T11's device
  page read.

- [ ] **Step 1: Write the failing test**

A summary with `projects: [{ name: "core", path: "/w/core" }]` parses to the same list; a summary
without the field parses to `[]`; an unreadable value fails closed to `[]` rather than throwing.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/kernel/test/local-devices`
Expected: FAIL.

- [ ] **Step 3: Implement the parse** in `localPolicyOf`.

- [ ] **Step 4: Make the branch typecheck** — add `projects: []` to every test fixture the compiler
  names, then run `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel
git commit -m "feat(kernel): parse a device's projects in its local policy"
```

## Phase 2 — device program and event schema

### Task 2: Device: the project store, the four operations, the policy report

**Files:**
- Create: `packages/device/src/projects.ts`
- Modify: `packages/device/src/policy.ts` (the local policy file's shape — `mode`, `allowedDomains` live there today)
- Modify: `packages/device/src/server-ops.ts:365` (the `switch` that serves `readFile` / `stat`)
- Test: `packages/device/test/projects.test.ts`, and an ops test beside the existing `server-ops` test

**Interfaces:**
- Consumes: `DeviceProject`, the four ops from T1.
- Produces: `listProjects(policy): DeviceProject[]`, `addProject(policy, { path, name? }, mode): { project } | { refused: string }`, `removeProject(policy, name): boolean`, `candidates(root, limit): DeviceProject[]`.

- [ ] **Step 1: Write the failing tests**

`projects.test.ts`: `addProject` refuses a path outside what the mode allows (the workspace in sandbox mode) with a message naming the reason; a name defaults to the basename and a duplicate name is refused; `candidates` finds a directory with `.git` or `AGENTS.md` two levels down and ignores a plain directory, capped at 50; `removeProject` on an unknown name returns false.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/device/test/projects.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

One pure module over the policy object (no IO in the functions; the caller persists). The containment check is the mode's rule from the spec §4.2.

- [ ] **Step 4: Serve the four ops**

In `server-ops.ts`, add the cases beside `readFile`; each answers `{ ok: true, value }` or the refused shape. Report the resulting list on the policy frame the device already sends.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run packages/device/test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/device
git commit -m "feat(device): projects in the local policy and four project operations"
```

### Task 3: Device: `list`

**Files:**
- Modify: the device's `SandboxProvider` implementation
- Test: beside the existing provider test

**Interfaces:** Consumes `SandboxProvider.list` from T1; produces the implementation.

- [ ] **Step 1: Write the failing test** — listing a directory returns `{ name, isDir }` per entry, sorted, and a missing directory returns `[]` (never throws).

- [ ] **Step 2: Run it to see it fail** — `pnpm exec vitest run packages/device/test` → FAIL.

- [ ] **Step 3: Implement** over the same file helper `readFile` uses.

- [ ] **Step 4: Run the tests and commit** — `feat(device): list a directory`.

### Task 4: Kernel: the `project_root` event

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts`
- Test: the event schema test beside the existing ones

**Interfaces:**
- Produces: event type `"project_root"` with payload `{ project: string; root: string; agentsMd?: string; agentsMdTruncated?: boolean; absent?: string; skills: { name: string; description: string; digest: string }[] }`.

- [ ] **Step 1: Write the failing test** — a payload with `absent` and no `agentsMd` parses; skills default to `[]`.

- [ ] **Step 2: Run it to see it fail.**

- [ ] **Step 3: Add the schema** with the doc comment stating it is model-visible and needs no `DriftReason` (it is new content in new events).

- [ ] **Step 4: Run and commit** — `feat(kernel): a project_root event`.

## Phase 3 — kernel

### Task 5: Conversation columns, migration, binding on create

**Files:**
- Create: `packages/kernel/src/migrations/0133_project_root.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts`
- Modify: `packages/kernel/src/conversations/conversations.service.ts` (`create`, `createWithMessage`)
- Modify: the new-conversation DTO/schema and `NewConversationDevice`
- Test: `packages/kernel/test/conversations/*` beside the existing create tests

**Interfaces:** Consumes nothing new; produces `conversations.project_name` / `project_path` and `NewConversationDevice.project?: string`.

- [ ] **Step 1: Write the failing tests** — creating with `project: "core"` on a device that declares it stores both name and path; the same name on a device that does not declare it is refused with a model-person-readable error; another member cannot bind (owner-only).

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Write the migration** `0133_project_root.sql`: two nullable text columns, `IF NOT EXISTS`.

- [ ] **Step 4: Resolve and store** inside the create transaction: look the name up in the device's declared projects, refuse otherwise.

- [ ] **Step 5: Run the tests and commit** — `feat(kernel): bind a conversation to a project`.

### Task 6: `ProjectKnowledgeService` at run start

**Files:**
- Create: `packages/kernel/src/runtime/project/knowledge.service.ts`, `runtime/project/knowledge.ts` (pure: parse a skills tree, apply the caps, compute digests)
- Modify: the run pipeline where the first model call is prepared
- Test: `packages/kernel/test/runtime/project-knowledge.test.ts`

**Interfaces:**
- Consumes: `SandboxProvider.list`, `readFile`; the conversation's `project_name` / `project_path`.
- Produces: `readProjectKnowledge(...): Promise<ProjectRootPayload>`, where `ProjectRootPayload` is the type inferred from the `project_root` schema T4 adds; and a service that appends the event (or skips it when the latest recorded digest matches).

- [ ] **Step 1: Write the failing tests** — a fake provider with an `AGENTS.md` over 64 KiB yields truncated text and `agentsMdTruncated: true`; a skills tree with three `SKILL.md` files yields three entries with stable digests; an unparsable `SKILL.md` is skipped; a missing root yields `absent` and no throw; a second run with unchanged digests appends nothing.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement the pure part** (caps, digests, parsing) then the service.

- [ ] **Step 4: Run and commit** — `feat(kernel): read the project's knowledge at run start`.

### Task 7: Rendering, catalog merge, `Skill` loading

**Files:**
- Modify: `packages/kernel/src/runtime/context/build.ts` (where `device_paths` renders), `runtime/context/skills.ts`, `tools/builtins/skill-load.ts`
- Test: `packages/kernel/test/runtime/context/*` and the zero-drift fixtures under `packages/kernel/test/evals/`

**Interfaces:** Consumes the event from T4; produces the system segment text and catalog entries named `project:<name>`.

- [ ] **Step 1: Write the failing tests** — a conversation with a `project_root` event renders the `AGENTS.md` text after the agent's instructions; the catalog contains `project:fix-issue`; a recorded conversation without the event renders exactly as before (zero-drift case A).

- [ ] **Step 2: Run them to see them fail**, including the zero-drift fixtures.

- [ ] **Step 3: Implement rendering and the catalog merge**; `Skill` loads a `project:` body through the provider and records the tool result.

- [ ] **Step 4: Run the tests and both zero-drift fixtures; commit** — `feat(kernel): show the project's instructions and skills`.

### Task 8: Working directory and the review's workspace fact

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/bash.ts` (`cwd: roots.workspace` at both call sites), `glob.ts`, `grep.ts`, `common.ts`
- Modify: `packages/kernel/src/tools/pipeline.ts` (the `review.review({...})` call)
- Test: `packages/kernel/test/tools/sandbox/*` and `packages/kernel/test/tools/review-*.test.ts`

**Interfaces:** Consumes the latest `project_root` event; produces one helper that answers "the working root of this conversation" (project root, else the device workspace).

- [ ] **Step 1: Write the failing tests** — with a project bound, `Bash` reports `cwd` at the project root and a relative `Read` resolves there; a write inside the project but outside the device workspace reviews as `allow`, not `ask`.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement the helper and use it** at the four call sites and in the review call.

- [ ] **Step 4: Run the tests and commit** — `feat(kernel): work inside the project root`.

### Task 9: The four admin routes and their Platform operations

**Files:**
- Modify: `packages/kernel/src/devices/*.controller.ts`, `packages/kernel/src/platform/ops/*`
- Test: `packages/kernel/test/devices/*`, `packages/kernel/test/platform/platform-parity.test.ts`

**Interfaces:** Produces `GET /api/v1/orgs/:orgId/devices/:deviceId/projects`, `POST …/projects` (add), `DELETE …/projects/:name`, `GET …/projects/candidates` — each behind `@OrgAction` (owner only) — and the matching Platform operations or a documented exclusion.

- [ ] **Step 1: Write the failing tests**

In `packages/kernel/test/devices/`, the list returns the device's declared projects; a non-owner gets `forbidden`; adding a path the device refuses returns that reason unchanged. The platform parity test gains the four operations.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/kernel/test/devices`
Expected: FAIL — routes do not exist.

- [ ] **Step 3: Implement the controller and the operations**

The controller forwards to the device through the existing request channel and does not validate paths itself (the device is the authority, §4.2); the operations call the same controller services.

- [ ] **Step 4: Run the checks**

Run: `pnpm exec vitest run packages/kernel/test/devices packages/kernel/test/platform && pnpm check:platform-ops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/devices packages/kernel/src/platform packages/kernel/test
git commit -m "feat(kernel): the device project routes"
```

### Task 10: Free-mode fallbacks and notices

**Files:**
- Modify: `packages/kernel/src/runtime/project/knowledge.service.ts`
- Modify: the conversation surface that renders a notice (the `device_paths` notice path is the model)
- Test: `packages/kernel/test/runtime/project-knowledge.test.ts` (extends T6's file)

**Interfaces:** Consumes T6; produces the degraded path. The binding is never cleared.

- [ ] **Step 1: Write the failing tests**

A conversation whose bound root no longer exists records a `project_root` with `absent` and appends nothing else; the next run records the absence again rather than the old text; a device that does not advertise the four ops produces no device call and no model-visible error; the conversation's binding columns are unchanged.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/kernel/test/runtime/project-knowledge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the degraded path** — the absence is a recorded event so the old text stops rendering; a run never fails because of a project.

- [ ] **Step 4: Run the tests and the zero-drift fixtures; commit**

```bash
pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/evals
git add packages/kernel && git commit -m "fix(kernel): degrade to free mode when a project is gone"
```

## Phase 4 — web

### Task 11: The device settings section

**Files:**
- Create: `apps/web/src/components/DeviceProjectsSection.tsx`
- Modify: `apps/web/src/app/(app)/devices/[id]/view.tsx`, `apps/web/src/lib/devices.ts`, `apps/web/src/lib/query/*`, messages (zh + en)
- Test: `apps/web/test/device-projects.test.tsx`

**Interfaces:** Consumes T9's four routes; produces the section. Follows the page rules: a `defineQuery` for reads, `useAppMutation` for writes, design components only (no `className` / `style`), UI text through i18n.

- [ ] **Step 1: Write the failing test**

The section lists the device's declared projects; submitting the form sends the typed path (the `workspace/` prefix is fixed in the UI, not typed); a refusal from the device renders inline under the field and the list is unchanged.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/web/test/device-projects.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the section** into the 设置 view beside the run mode and the allowlist, and list the projects read-only on 概览.

- [ ] **Step 4: Run the web checks and commit**

```bash
pnpm exec vitest run apps/web/test/device-projects.test.tsx && pnpm check:web-ui && pnpm check:i18n
git add apps/web && git commit -m "feat(web): projects on the device settings view"
```

### Task 12: Binding, header and the `/` menu

**Files:**
- Modify: `apps/web/src/components/conversation/ComposerBar.tsx`, the conversation header component, `apps/web/src/lib/query/skills.ts`
- Modify: `packages/kernel/src/skills/invocable.controller.ts` (the list gains the project's skills)
- Test: `apps/web/test/conversation-project.test.tsx`, `packages/kernel/test/skills/invocable.test.ts`

**Interfaces:** Consumes T7's catalog and T9's list; produces `InvocableSkill.source: "platform" | "plugin" | "agent" | "project"` and the composer's project pick.

- [ ] **Step 1: Write the failing tests**

The picker offers only the projects the conversation's device declares, plus 自由模式; the header shows the bound project's name and whether `AGENTS.md` loaded; the `/` palette groups entries by `source` and lists `project:fix-issue` under `project`.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement** the picker on the existing device affordance (one entry point, not a second menu) and the header line; add `source` to the invocable list.

- [ ] **Step 4: Run the checks and commit**

```bash
pnpm exec vitest run apps/web/test/conversation-project.test.tsx packages/kernel/test/skills && pnpm check:web-ui && pnpm check:i18n
git add apps/web packages/kernel && git commit -m "feat(web): bind a conversation to a project"
```

## Phase 5 — plugins and wrap-up

### Task 13: `list` in `sandbox-docker` / `sandbox-e2b`

**Files:** in `capybara-hq/plugins`, `plugins/sandbox-docker` and `plugins/sandbox-e2b`, each with its existing test style (real Docker; `startFakeE2B`). Separate PRs, one per provider.

- [ ] **Step 1: Write the failing test** in each provider: listing a directory returns entries with `isDir`, and a missing path returns `[]`.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement `list`** against the provider's file API.
- [ ] **Step 4: Run the provider's suite; commit** `feat(sandbox-docker): list a directory` (and the e2b equivalent).

### Task 14: Docs, skills, changesets, verify

**Files:** `docs/guide/devices.md`, `.agents/skills/writing-sandbox-providers/SKILL.md`, `.agents/skills/writing-tools/SKILL.md`, changesets.

- [ ] **Step 1: Update the docs** — the device guide gains the projects section (what a project is, the two views, the binding), and both skills note the new provider call and that the review's workspace fact is the project root.
- [ ] **Step 2: Add the changesets** — kernel, device, web, and `@capybara-hq/plugin-sdk` if T1 did not add it.
- [ ] **Step 3: Run the full gate**

Run: `pnpm verify`
Expected: PASS, including `check:sdk-api`, `check:platform-ops`, `check:web-ui`, `check:i18n` and the zero-drift fixtures.

- [ ] **Step 4: Commit** `docs: the project root in the device guide`.
