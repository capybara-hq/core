# Platform tool phase 2 (parity with the UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a person can do in the UI, their agent can do through `Platform` (sensitive writes excepted, their reads included), kept in sync with the routes by checks, with accurate state and actionable errors.

**Architecture:** This plan extends phase 1 (`packages/kernel/src/platform/*`, `tools/builtins/platform.ts`, `tools/checks/src/platform-ops.ts`) in three parts.
- **Foundations (wave 1):**
  - route schemas move to exported modules that operations reuse, plus a runtime input-parity test;
  - a `precheck` hook that runs before the card;
  - role-aware errors;
  - accurate extension state in the org view;
  - agent docs titles.
- **Domains (waves 2–3):** every `later` route becomes an operation or a permanent exclusion.
- **Closing (wave 4):** profile operations once run-context is on `main`; the fence then rejects `later`.

**Tech Stack:** TypeScript, NestJS kernel, zod 4 (`z.toJSONSchema`), Kysely/PG, vitest, Next web (design components only).

**Spec:** `docs/superpowers/specs/2026-11-07-platform-tool-design.md` §14 (phase 2) and §14.5 (answers); §1–§13 describe phase 1 and still bind.

## Global Constraints

- **Identity and rights:** the run's trigger person, re-read per call. Reads run. Writes are `personal` (rememberable) / `org` / `platform` (never remembered). Destructive personal writes (deleting a conversation) are `personal` with `remember: false`, set through `confirmFor`.
- **Never offered as writes:** deciding approvals and requests, confirming extension permissions, tokens, secret and credential values, roles, and the super-admin flag. Their reads are offered (state and summaries, never values).
- **Super admin:**
  - Admin-console operations run only through the super admin's own private agent and return the admin console's data in full.
  - Other orgs' private plugins remain counts only, and get / update on them is refused.
- **Creating a user:**
  - No password in the input.
  - The kernel generates a one-time password and forces a change at first login.
  - The password is shown only to the person on the web after approval.
  - The tool result never contains it.
- **Sync:**
  - An operation's input is built from the mirrored route's exported schema (`pick` / `omit` / `extend`).
  - It declares `omits` (route fields left out) and `extras` (fields the route lacks).
  - Types are equal and bounds never looser.
  - A removed route takes its operations and exclusion entries with it.
- **Before the card:** every write runs its read-only `precheck`. A known failure is a `deny` with the reason, and no card appears.
- **Errors:** every `errors[]` entry has `next`, keyed by role (`superAdmin` / `orgAdmin` / `member`) where the step differs. Errors say what is missing.
- **Lists:** list operations return compact rows (`id`, `name`, `state`, `reason?`, `next?`, plus at most 3 domain fields); details come from `get`. Paged at 50.
- **Writes:**
  - stay in the services' `@Transactional()` methods;
  - carry audit `detail` `{ via: "agent", conversationId, runId, operation }`;
  - are confirmed by kernel-rendered summaries that name objects (zh, en).
- **Model-visible and UI text:**
  - Model-visible text is English.
  - UI text goes through i18n, zh and en (平台 / 超级管理员 / 智能体; `pnpm check:i18n`).
- **Migrations:** next free number (`ls packages/kernel/src/migrations`), expand-only (`writing-migrations`).
- **Tests:** run from the repo root with `pnpm exec vitest run --maxWorkers=2 <paths>`. Run the full suite once before the wave's PR (phase 1 lesson: focused runs missed cross-package tests). Under heavy machine load, PG "Connection terminated" or 5 s timeouts in unrelated files are environmental: rerun those files alone.
- **Commits and changesets:** Conventional Commits, body ≤ 100 chars/line, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `git add` own paths only. One changeset per PR (kernel / web / sdk as touched).

## Review Focus

1. An operation built from a route schema that the route later narrows (e.g. a new required field): the parity test must go red; the op must not silently accept less. Pinned in Task 1.
2. A write whose precheck passes but the service fails anyway (race): the error after approval is still actionable and nothing is half-written. Pinned in Task 2.
3. A member asking "why can't I use Anthropic": they get the reason (needs deployment config) and their next step (ask an admin / request), never the admin-console path or any config value. Pinned in Task 3.
4. The generated initial password: absent from tool results, events, audit details, logs and the IM card; shown once to the approving person on the web. Pinned in Task 7.
5. Reads of sensitive state (pending approvals, pending permission confirmations): never return secret values, tokens, credential fields or another person's approval inputs beyond the summary the inbox shows. Pinned in Task 9.

---

## Waves

| Wave | Tasks | PR |
|---|---|---|
| 1 | 1 sync check, 2 precheck + errors, 3 extension state, 4 agent docs | PR A: foundations |
| 2 | 5 conversations, 6 skills + components, 7 admin accounts + orgs, 8 admin catalog / extensions / models | PR B: workspace and admin |
| 3 | 9 inbox and pending reads, 10 channels / members / settings, 11 evals / connectors / the rest | PR C: everything else |
| 4 | 12 agent profile (after run-context merges), 13 close: no `later`, rules, e2e, as built | PR D |

Tasks in one wave own disjoint files: each task owns its `ops/<domain>.ops.ts` and the exclusion entries of its domain. `platform/exclusions.ts` is edited by every domain task, so one task per wave owns it (the first listed) and the others hand it their removals in their report. The controller applies them.

---

### Task 1: Shared route schemas and the input-parity check

**Files:**
- Create: `packages/kernel/src/platform/parity.ts` (pure function `inputParity(op, route): Finding[]`), `tools/checks/test/platform-parity.test.ts` (boots no app: imports the route schema modules and the op registry), and fixtures under `tools/checks/fixtures/platform-parity/`.
- Modify:
  - `packages/kernel/src/platform/operation.ts`: add `omits?: readonly string[]` and `extras?: readonly string[]`.
  - The controllers whose routes phase-1 ops mirror: move their body / query zod schemas into exported `<domain>.schemas.ts` modules next to the controller, and declare path params as a schema there too.
  - Phase-1 ops: build `input` from those schemas.
  - `tools/checks/README.md`.

**Interfaces:**
- Produces:
  - `export interface RouteSchemas { route: string; body?: z.ZodType; query?: z.ZodType; params?: z.ZodType }`;
  - a registry `ROUTE_SCHEMAS: readonly RouteSchemas[]` (in `packages/kernel/src/platform/route-schemas.ts`), filled by importing each `<domain>.schemas.ts`;
  - every later domain task adds its routes' schemas the same way.

- [ ] **Step 1: Write failing fixture tests.** Three cases:
  - (a) type mismatch: the route has `name: string`, the op has `name: number`;
  - (b) undeclared omission: the route has required `visibility`, the op lacks it and has no `omits`;
  - (c) undeclared extra: the op has `cursor`, the route lacks it, and `extras` is empty.

  Each gives one finding with the op id and the field. A clean fixture gives none. Add (d): an op whose `mirrors` names a route absent from `ROUTE_SCHEMAS` and from the controllers gives the existing `platform-op-orphan`. Assert both orphan messages ("operation mirrors a route that does not exist", "exclusion names a route that does not exist") with fixtures.
- [ ] **Step 2: Run `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`.** Expect FAIL.
- [ ] **Step 3: Implement `inputParity`.** Compare `z.toJSONSchema` properties: equal `type`; op `maxLength` / `maximum` ≤ the route's; and the omits and extras rules.
- [ ] **Step 4: Real-tree test.** Every registered op with `mirrors` gets zero parity findings. Move the phase-1 routes' schemas, rebuild the ops' inputs from them, and declare `omits` / `extras` (e.g. `skills.create` omits `uploadId`; `agents.update` omits `visibility`; list ops extra `cursor`). Run until green.
- [ ] **Step 5: Run `pnpm typecheck`, `pnpm lint`, `pnpm check`, and the Platform tests.** Then commit `feat(kernel): Platform operations share their routes' schemas, checked for parity`.

### Task 2: `precheck` before the card, role-aware errors

**Files:**
- Modify:
  - `packages/kernel/src/platform/operation.ts`: `precheck?(input, ctx): Promise<{ ok: true } | { ok: false; code: string; message: string }>`, and `errors[]` entries become `{ code, next: string | { superAdmin?: string; orgAdmin?: string; member?: string } }`.
  - `packages/kernel/src/tools/builtins/platform.ts`: `callPolicy` runs `precheck` after availability; on failure it returns `deny` with the message plus the role's next step. `toToolError` maps an `ApiError` through the op's entry for the actor's role.
  - `tools/checks/src/platform-ops.ts`: rule `platform-op-errors`.
  - Phase-1 ops: add `errors[]` with `next` for their notable codes.
- Test: `packages/kernel/test/tools/platform-tool.test.ts`, `tools/checks/test/platform-ops.test.ts` (red fixture for an entry without `next`).

- [ ] **Step 1: Write failing tests.**
  - A write op whose precheck fails returns `policy: "deny"` with the reason, and no approval is created.
  - A precheck that passes, followed by a service failure after approval, yields the op's mapped error with the role's next step (Review Focus 2).
  - An `ApiError` whose code has role-keyed `next` gives the super admin's text to a super admin and the member's text to a member.
  - A fixture op with an `errors` entry lacking `next` gives `platform-op-errors`.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** Precheck reads only and is time-bounded (2 s; on timeout, skip the precheck and let the write's own errors speak).
- [ ] **Step 4: Run the tests and `pnpm check`.** Expect PASS. Commit `feat(kernel): Platform writes check before the card and errors name the next step by role`.

### Task 3: Accurate extension and plugin state

**Files:**
- Modify:
  - `packages/kernel/src/extensions/org-config.ts` (`OrgExtensionView`: `status` and `reason`, derived like `deriveExtensionStatus` in `admin-view.ts`);
  - the org extensions API (`catalog/org-extension.controller.ts`) and the org web page (`apps/web` extensions view: show the reason with design components, i18n zh / en);
  - `catalog/org-catalog.service.ts` list rows (`state` / `reason`);
  - `platform/ops/plugins.ops.ts` and `ops/extensions.ops.ts`:
    - compact list rows;
    - `plugins.set-enabled` precheck: not deployed / needs deployment config / pending approval → deny with the role's next step;
    - error texts per spec §14.2 item 3.
- Test: `packages/kernel/test/platform/ops-catalog.test.ts`, the org extensions HTTP test, and a web test for the reason.

- [ ] **Step 1: Write failing tests**, reproducing the acceptance case (session c9a4e7bf): an extension installed but missing its deployment API key.
  - `extensions.list` shows `available: false`, `reason: "needs_deployment_config"`.
  - `plugins.list` shows that plugin `state: "unavailable"`, same reason.
  - `plugins.set-enabled` as super admin is denied before any card. Its message names "admin console → Extensions → <name> → fill in the deployment config".
  - As org admin: "send a request to the super admin" (with the request op id).
  - As member: no admin-console path, no config field names.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** Then check the web page shows the reason (`pnpm check:web-ui`, `check:i18n`).
- [ ] **Step 4: Assert one call decides it.** An e2e-style test shows that after `plugins.get` the next step is known: the result carries `state` / `reason` / `next`.
- [ ] **Step 5: Run the tests and checks.** Commit `fix(kernel): unloaded extensions show why, and Platform says what to do next`.

### Task 4: Agent docs titles and both-way sync

**Files:**
- Modify:
  - `packages/plugin-sdk/agent-docs/*.md`: titles start with "Authoring:" (writing an extension, building a plugin, skills, templates, connector templates, tool naming, extension points) and `concepts.md` says operations cover using the platform;
  - `tools/checks/src/agent-docs.ts`;
  - `tools/checks/test/agent-docs.test.ts` and fixtures;
  - `packages/kernel/src/tools/builtins/platform.ts` `read` topic list (show titles).

- [ ] **Step 1: Write failing fixtures for both directions** of every plugin-format surface:
  - a field in `plugin.v1` / `connector-template.v1` / `AGENT_TEMPLATE_FIELDS` / `EXTENSION_POINTS` missing from the docs (missing);
  - a docs row or topic for something gone from the code (orphan, including a field row in a hand-written table).
- [ ] **Step 2: Run them.** Expect FAIL where a direction is not caught today.
- [ ] **Step 3: Implement the missing direction(s)** and retitle the topics.
- [ ] **Step 4: Run `pnpm check:agent-docs` and the tests.** Commit `fix(plugin-sdk): agent docs titles say authoring, and both sync directions are checked`.

### Tasks 5–11: domains

Every domain task follows the same template:

- **Files:**
  - Create `packages/kernel/src/platform/ops/<domain>.ops.ts`.
  - Create schema modules for the domain's routes (Task 1 pattern) and register them in `route-schemas.ts`.
  - Register providers in `platform-ops.module.ts`.
  - Remove the domain's `later` exclusions: hand them to the exclusions owner, or apply them yourself if you own the file this wave.
  - Turn routes that must not become operations into permanent exclusions with a reason.
- **Each op:**
  - `defineOperation` literal with `mirrors`, input built from the route schema with `omits` / `extras`, the class (and `confirmFor` where the target decides), `summary` naming objects, `precheck` for writes, `errors[]` with `next`, compact list rows;
  - tests against PG with real services (`app.get`): one read and one write per op group, a lower role refused, and the audit detail checked.
- **End:** `pnpm check:platform-ops` reports no `later` left for the domain. Run `pnpm typecheck`, `pnpm lint` and `pnpm check`. Commit `feat(kernel): Platform operations for <domain>`.

Domain lists (routes as core#91 groups them):

- **Task 5 — conversations** (21): list mine, get, rename, archive / unarchive (personal, rememberable); delete (`confirmFor` → personal, remember false); events and messages reads; sending a message to another conversation stays excluded (`internal`: runs are started by the person). Streams stay `transport`.
- **Task 6 — skills (9) and components (9)**: `skills.set-enabled` (org; the component switch), skill versions, files read, update / delete (org); component lists and switches for agent templates and connector templates.
- **Task 7 — admin accounts and orgs** (platform-admin 9 + orgs 7, plus account routes now classified human-only):
  - `accounts.list` / `get` / `create` / `disable` / `enable` (platform, super admin).
  - `accounts.create` has no password input. The kernel generates a one-time password and sets "must change at first login" (add the flag and migration if absent; login enforces it). The approval's web result shows the password once to the approver. Tool result, events, audit and IM never contain it (Review Focus 4: grep the event log, audit rows and logger output in the test).
  - Super-admin flag and role changes stay `human-only`.
  - `orgs.list` / `get` / limits read and write, member list (read).
  - Model purposes and models.
- **Task 8 — admin catalog, extensions, marketplaces, models** (catalog-admin 8, extensions-admin 7, marketplaces 5, models 2, org-catalog 3, org-uploads 5, extensions 2, extension-points 3):
  - Deployment state reads, plus enable / disable / upgrade (platform).
  - Extension installs from npm and package uploads stay `transport` / `human-only` (permission confirmation).
  - The org extension tool switches.
  - Org uploads: the pending list (read); the upload itself is `transport`.
- **Task 9 — inbox and pending reads** (inbox 3, plus the human-only reads):
  - `inbox.list` (my items: approvals waiting for me, requests pending for org admins, notices), `approvals.waiting` (read), `requests.pending` (read), `extensions.pending-permissions` (super admin, read).
  - Summaries as the inbox shows them, no inputs beyond that, no secrets (Review Focus 5).
  - Decisions stay `human-only`.
- **Task 10 — channels, members, org settings, personal settings** (channels 3, plus org settings and preferences routes):
  - Channel connections list / get (no bot credentials) and binding changes (org).
  - Members list (read).
  - Org settings read / write (org; including `platformTool`).
  - Personal preferences read / write (personal).
- **Task 11 — evals, connectors and the rest** (evals 17, connectors 7, background 2, attachments 1, previewers 2, ui 1, agents 12 except profile routes):
  - Eval sets, cases and runs (org).
  - Connectors list / get / enable tools / delete (org, no credentials; create with credentials stays `secret`).
  - Background tasks list and stop (personal).
  - The agents domain routes except profile (owner transfer stays `human-only`).
  - Attachments, previewers and UI routes: operations or `transport`.

Owner of `platform/exclusions.ts`: Task 5 in wave 2 and Task 9 in wave 3. The other tasks list their exclusion changes in their report, and the controller applies them after the wave.

### Task 12: Agent profile (starts when run-context is on `main`)

**Files:** `ops/agents.ops.ts` (profile: `agents.set-quick-actions`, `agents.set-avatar` with preset ids; `confirmFor` like `agents.update`), `ops/platform.ops.ts` (`me` returns description, quick actions, avatar), `agents.get` result. Custom avatar upload stays `transport`.

- [x] Done before the run-context merge (the profile route was already on `main`): one operation `agents.update-profile` without `description`, which run-context §3.5 moves into the agent definition, edited by `agents.update`, once it merges. Then follow the domain template, with tests for a private agent (rememberable) and a shared agent (`remember: false`).

### Task 13: Close

**Files:**
- `tools/checks/src/platform-ops.ts`: the category `later` becomes a finding (`platform-op-later`), with a red fixture.
- `AGENTS.md`: the Platform line states add / change / remove.
- `.agents/skills/writing-kernel-api/SKILL.md` and `writing-tools`: shared schemas, `omits` / `extras`, `precheck`, role-keyed `next`, removal.
- `packages/kernel/test/platform/platform-e2e.test.ts`: phase-2 cases.
- The spec's §13 / §14 "As built".
- Close core#91.

- [ ] **E2E cases (real pipeline, model-fake):**
  - the acceptance repro of Task 3: a single call, no card, the right next step per role;
  - the super admin creates a user, the result has no password, the web approval result shows it once;
  - a member reads "waiting for my approval";
  - delete a conversation: every time, once only;
  - the three sync failures, each red in the checks suite (from Tasks 1 and 13).
