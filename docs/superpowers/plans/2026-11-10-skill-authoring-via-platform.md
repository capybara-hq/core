# Skill authoring through files and the Platform tool: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With more than five tasks, plan waves with the `wave-planned-subagent-development` skill.

**Goal:** Replace the builtin tool `SkillWrite` with sandbox files + zip + a Platform operation that
registers the package as the agent's own skill, add org sharing confirmed by org admins, and ship a
builtin `skill-guide` skill.

**Architecture:** One new kernel service (`AgentSkillsService`) owns an agent's own skills:
register (zip), delete, ask to share. `SkillChangesService` keeps only the org-admin decided
requests (`share` and `version` kinds) with their trial overlay. A Platform operation reads the zip
from the conversation's sandbox and calls the same service as the new web upload route. `skill-guide`
is a skill-only plugin in `capybara-hq/plugins`, pinned `required: true` in `bootstrap.json`.

**Tech Stack:** TypeScript, NestJS + Fastify, Kysely/PG, Zod (`createZodDto`), Vitest, Next (apps/web),
TanStack Query, `@capybara-hq/design`.

**Spec:** `docs/superpowers/specs/2026-11-10-skill-authoring-via-platform-design.md`

## Global Constraints

- Only the agent's current owner (`agents.owner_account_id`, read live) registers, deletes or shares
  the agent's skills; anyone else: 403 `forbidden` (404 `agent.not_found` when not visible).
- Registration from a sub-agent conversation is refused (`rootConversationOf(db, conversationId) !==
  conversationId`).
- Confirmation classes: register on a private agent the actor owns with `skills.writePolicy !== "ask"`
  = `personal` (rememberable); otherwise `org`. Share by an org admin = `org`; share by a non-admin
  owner (creates a request) = `personal`. Standard `availability()` gates; no exception.
- Package reader and limits are the web upload's: `readSkillPackage` (`skills/package.ts:154`),
  `SKILL_PACKAGE_MAX_BYTES` (50 MB), `SKILL_LIMITS`. No second reader.
- Skills enter only as zip packages: no text form anywhere (web 新建 dialog, `POST /skills` text
  branch, Platform `skills.create`, agent registration).
- `AGENT_SKILLS_MAX = 50` own skills per agent (pending proposals included).
- Shared skill = org skill (`scope = 'org'`) with `origin_agent_id` and `maintainer_account_id`;
  no fork; a confirmed version is the same as an org admin uploading one.
- `customSkills: deny` refuses sharing (it creates an org skill); it does not refuse registration.
- Org-admin decisions are human only (route in `platform/exclusions.ts`, category `human-only`).
- Writes in `@Transactional()`; object storage writes before the transaction with cleanup on failure;
  `eventLog.notify` / deletes after commit; lock order org (key share) → agent (`FOR NO KEY UPDATE`)
  → conversation (`FOR UPDATE`) → skill rows → request rows, as `changes.service.ts` `writeIn` does.
- English for code, comments, test titles, docs, model-facing text; UI copy through i18n (zh + en),
  zh says 智能体 / 平台 / 超级管理员.
- New migration files `0109_…`, `0110_…`; `IF [NOT] EXISTS`; applied migrations untouched.
- Pre-0.1.0: no compatibility shims; pending R4 requests are cancelled by the migration.
- Every changed published package gets a changeset (`@capybara-hq/kernel`, `@capybara-hq/web` as
  applicable; check `pnpm changeset status`).

## Review Focus

1. A zip with one outer folder (GitHub `repo-main/` style) and a zip with `SKILL.md` at its root both
   register, exactly as the web upload accepts them (Task 4 test `parity with web upload`).
2. A `file_path` outside the sandbox roots, a directory, a missing file or a file over 50 MB gives an
   actionable error naming the problem, never a 500 (Task 3 tests).
3. Registering a name that has a pending version proposal from another conversation is refused with
   text telling the model to wait for the org admin (Task 8 test).
4. Sharing a skill whose name an org skill already uses is refused with `skill.name_exists`; the
   agent's own skill stays (Task 7 test).
5. Deleting the agent or transferring its ownership while a share request is pending cancels the
   request and deletes no shared files (Task 7 test).

---

## Waves

| Wave | Tasks | Notes |
|---|---|---|
| 1 | 1, 2, 3 | disjoint files (Task 2 touches skills.service / web skills page, Task 4 later rebases on it); Task 1 (migration) reviewed alone on the most capable model |
| 2 | 4, then 5 and 6 | 4 is the service; 5 (routes) and 6 (op) both consume it |
| 3 | 7, then 8, then 9 | 7 removes SkillWrite/R4, 8 sharing + proposals (trust boundary: review alone), 9 web |
| 4 | 10, 11, 12 | docs; plugins repo; bootstrap pin after the plugin is published |

---

### Task 1: Migration and schema types

**Files:**
- Create: `packages/kernel/src/migrations/0109_agent_skill_sharing.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`SkillsTable` ~:750, `SkillChangeRequestsTable` ~:810)
- Test: `packages/kernel/test/skills/migration-0109.test.ts`

**Interfaces:**
- Produces: `skills.origin_agent_id text NULL REFERENCES agents(id) ON DELETE SET NULL`,
  `skills.maintainer_account_id text NULL REFERENCES accounts(id)`,
  `skill_change_requests.kind text NOT NULL DEFAULT 'version' CHECK (kind IN ('share','version'))`;
  TS: `SkillsTable.origin_agent_id`, `.maintainer_account_id` (`ColumnType<string|null, string|null|undefined, string|null>`),
  `SkillChangeRequestsTable.kind: Dflt<"share" | "version">`.

- [ ] **Step 1: Write the failing test** `migration-0109.test.ts` on the test PG container:
  after `migrate`, (a) `information_schema.columns` has the three columns; (b) inserting a request with
  `kind = 'other'` fails with a check violation; (c) a `skill_change_requests` row inserted as
  `pending` before running 0109 (seed by running migrations up to 0108 first, as other migration tests
  do) is `cancelled` with `decided_at` set afterwards; (d) deleting an agent sets `origin_agent_id` of
  its shared skill to null and keeps the skill.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/skills/migration-0109.test.ts` → FAIL (columns missing).
- [ ] **Step 3: Write the migration.** Add columns with `ADD COLUMN IF NOT EXISTS`; index
  `skills_origin_agent_idx ON skills (origin_agent_id) WHERE origin_agent_id IS NOT NULL AND deleted_at IS NULL`;
  `UPDATE skill_change_requests SET status = 'cancelled', decided_at = now() WHERE status = 'pending'`
  (the R4 flow ends; carry the destructive-statement exemption comment the writing-migrations skill
  requires, reason: "R4 owner-approved changes are removed; pending ones cannot be decided any more").
  Draft objects of cancelled rows are left to the org data cleanup (state that in the comment).
  Update `kernel-schema.ts`.
- [ ] **Step 4:** rerun → PASS; `pnpm typecheck` passes.
- [ ] **Step 5: Commit** `feat(kernel): add agent skill sharing columns`.

### Task 2: Remove text-form skill creation

**Files:**
- Delete: `apps/web/src/components/SkillCreateDialog.tsx`
- Modify: `apps/web/src/app/(app)/skills/view.tsx` (:24, :191 and the 新建 header action; keep 上传技能),
  `apps/web/src/lib/skills.ts` (`createSkillFromText`), `apps/web/messages/{en,zh}.json` (the dialog's keys),
  `packages/kernel/src/skills/skills.service.ts` (`checkCreateFromText` :700, `createFromText` :723, `textSkillFiles` :269),
  `packages/kernel/src/skills/skills.controller.ts` (`create` :78: `uploadId` only),
  `packages/kernel/src/skills/skills.schemas.ts` (`SkillCreateBody`: `{ uploadId: string; shareable?: boolean }`),
  `packages/kernel/src/platform/ops/skills.ops.ts` (delete `skills.create` :64-121),
  `packages/kernel/src/platform/exclusions.ts` (add `POST /api/v1/orgs/:orgId/skills`, category `transport`,
  reason "Creates an org skill from an uploaded archive; uploads are multipart bytes")
- Test: the existing tests of these (web skills page test, `skills.http` tests, `platform/ops-*skills*` tests)

**Interfaces:**
- Produces: `POST /orgs/:orgId/skills` accepts `{ uploadId, shareable? }` only; a body with `name`/`body` → 400 `validation_failed`.
  No `skills.create` operation. `skill-write.ts` keeps its own `buildSkillWrite` until Task 7 deletes it.

- [ ] **Step 1:** change tests first: web skills page shows 上传技能 and no 新建 action (admin view);
  HTTP test: text body → 400; platform test: `skills.create` is not registered; run → FAIL.
- [ ] **Step 2:** remove the code per the file list.
- [ ] **Step 3:** tests PASS; `pnpm check:platform-ops`, parity test, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
- [ ] **Step 4: Commit** `refactor!: skills enter only as uploaded packages`.

### Task 3: Read one file from a conversation's sandbox

**Files:**
- Create: `packages/kernel/src/sandbox/sandbox-file-reader.ts` (Nest `@Injectable`, provided and exported by the sandbox module)
- Modify: the sandbox module file that provides `SandboxService`
- Test: `packages/kernel/test/sandbox/sandbox-file-reader.test.ts` (sandbox-fake fixture)

**Interfaces:**
- Consumes: `ConversationDevices.forTool(orgId, rootConversationId)` (`devices/conversation-devices.ts:81`),
  `SandboxService.withSandbox(ctx, fn, signal)` (`sandbox/sandbox.service.ts:604`), `checkPath`,
  `mapSandboxError` (`tools/builtins/sandbox/common.ts`).
- Produces:
  ```ts
  class SandboxFileReader {
    read(input: { orgId: string; conversationId: string; actorAccountId: string; path: string;
      maxBytes: number; signal: AbortSignal }): Promise<Uint8Array>;
  }
  ```
  Throws `ApiError` 422 with codes `sandbox.file_invalid_path`, `sandbox.file_not_found`,
  `sandbox.file_is_directory`, `sandbox.file_too_large` (message names the path and the limit), and
  maps provider failures through `mapSandboxError`. Register the codes in `errors.ts`.

- [ ] **Step 1: Write failing tests**: reads a file written into the fake sandbox and returns its bytes;
  `../etc/passwd` and a path outside the roots → `sandbox.file_invalid_path`; missing →
  `sandbox.file_not_found`; a directory → `sandbox.file_is_directory`; `maxBytes: 4` on a 5-byte file →
  `sandbox.file_too_large`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement the stat → readFile sequence of `deliver.ts:144-160` (holder = the root
  conversation, actor = the account); no attachment sync, no `device_paths` record.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(kernel): read a file from a conversation sandbox`.

### Task 4: `AgentSkillsService`: register and delete

**Files:**
- Create: `packages/kernel/src/skills/agent-skills.service.ts`, `packages/kernel/src/skills/conversation-catalog.ts`
- Modify: `packages/kernel/src/skills/changes.service.ts` (move out `appendCatalog`, `createVersion`,
  `assertBelowCap`, `deleteAgentSkill`/`deleteAgentSkillIn`, `AGENT_SKILLS_MAX`), `packages/kernel/src/skills/skills.module.ts`
- Test: `packages/kernel/test/skills/agent-skills.test.ts`

**Interfaces:**
- Consumes: `readSkillPackage`, `skillManifest` (`skills/package.ts`), `skillFilesPrefix`, `StorageService`, `EventLog`.
- Produces:
  ```ts
  // conversation-catalog.ts: extracted from changes.service.ts appendCatalog, unchanged behavior
  appendConversationCatalog(deps: { db: KernelDb; log: KernelLogger }, conversationId: string,
    derive: (base: SkillsSnapshot) => SkillsSnapshot | null, idemKey: string, runId?: string | null): Promise<number | null>;

  interface AgentSkillActor { orgId: string; agentId: string; accountId: string;
    conversationId?: string; runId?: string | null; actorTokenId?: string; auditDetail?: Record<string, unknown> }
  type RegisterOutcome =
    | { kind: "version"; skillId: string; name: string; version: number; created: boolean; manualOnly: boolean }
    | { kind: "proposed"; requestId: string; skillId: string; name: string; version: number; manualOnly: boolean }; // Task 8

  class AgentSkillsService {
    register(actor: AgentSkillActor, zip: Uint8Array): Promise<RegisterOutcome>;
    deleteAgentSkill(orgId: string, agentId: string, skillId: string, accountId: string,
      actorTokenId?: string, auditDetail?: Record<string, unknown>): Promise<void>;
    assertOwner(orgId: string, agentId: string, accountId: string): Promise<void>; // used by op prechecks
  }
  export const AGENT_SKILLS_MAX = 50;
  ```
  Errors (`ApiError`, registered in `errors.ts`): `forbidden` (not owner), `agent.not_found`,
  `skill.invalid_package` (reader's messages), `skill.agent_cap` (409, at 50), `storage.unavailable`.

- [ ] **Step 1: Write failing tests** (model-fake org + agent, test S3):
  - `registers a zip as the agent's own skill`: zip with `SKILL.md` + `scripts/run.sh` → outcome
    `version`, `created: true`, version 1; `skills` row `scope='agent'`, `agent_id` set; files readable.
  - `same name registers a new complete version`: second zip without `scripts/run.sh` → version 2,
    manifest lacks that file.
  - `parity with web upload`: the same zip (outer folder variant and root variant) gives the same
    manifest as `SkillsService.upload`.
  - `non-owner is refused`: a member of a shared (`org`) agent → `forbidden`; nothing written to storage.
  - `appends a catalog snapshot in the conversation`: with `conversationId`, the log's last
    `skills_catalog` lists the skill with `source` = the version prefix; without, no event.
  - `manual-only is not in the snapshot`: `disable-model-invocation: true` → skill absent from snapshot, `manualOnly: true`.
  - `cap`: 50 existing → `skill.agent_cap`.
  - `delete`: owner deletes → soft-deleted; non-owner → `forbidden`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement. `register`: read the zip via `readSkillPackage` (errors → `skill.invalid_package`) → put files under `skillFilesPrefix(randomUUID())`
  → `@Transactional registerIn` with the global lock order (owner check inside, reading the agent row)
  → create version (moved `createVersion`) → audit `skill.created` / `skill.version_created` with
  `detail.via` = `auditDetail` → `appendConversationCatalog` when `conversationId` is set (same derive as
  today's `writeIn`, pinned body update included) → after commit `eventLog.notify`; on failure delete the
  prefix. Visibility does not branch (no R4).
- [ ] **Step 4:** run → PASS; `pnpm exec vitest run packages/kernel/test/skills` still green (changes.service callers updated to the moved functions).
- [ ] **Step 5: Commit** `feat(kernel): register an agent's own skill from a package`.

### Task 5: Routes for agent skill packages

**Files:**
- Create: `packages/kernel/src/skills/agent-skills.controller.ts` (move `AgentSkillsController` out of `changes.controller.ts` and add the routes)
- Modify: `packages/kernel/src/skills/skills.schemas.ts` (`SKILL_ROUTES` :49), `packages/kernel/src/skills/skills.service.ts` (`createUpload` :593), `packages/kernel/src/http/api.module.ts`, `packages/kernel/src/platform/exclusions.ts`
- Test: `packages/kernel/test/skills/agent-skills.http.test.ts`

**Interfaces:**
- Consumes: `AgentSkillsService.register` / `deleteAgentSkill` (Task 4).
- Produces routes (all `@OrgAction("agents.create")`, owner checked in the service):
  - `POST /api/v1/orgs/:orgId/agents/:agentId/skills/uploads` body `{ name: string; size: number }` → `CreatedAttachment`
    (purpose `skill-package`, **no** `customSkills` check: add `SkillsService.createAgentUpload(orgId, accountId, agentId, input)`
    that checks ownership then calls `attachments.create`). Exclusion: category `transport`, reason "Uploads a skill archive as multipart bytes".
  - `POST /api/v1/orgs/:orgId/agents/:agentId/skills` body `AgentSkillRegisterBody = { uploadId: string }`
    → `{ skill: RegisterOutcome }`. Schemas exported as `AgentSkillRegisterBody` and added to `SKILL_ROUTES`.
  - existing `GET` / `DELETE :skillId` unchanged in behavior.

- [ ] **Step 1: Failing HTTP tests**: owner uploads (presigned PUT) then registers → 200 version 1;
  member on a shared agent → 403; `customSkills: deny` still allows the agent upload;
  unknown `uploadId` → 404 `attachment.not_found`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; read the zip with `attachments.readSkillPackage` and consume it in the
  register transaction (as `SkillsService.upload` does).
- [ ] **Step 4:** run → PASS; `pnpm check:kernel-conventions`, `pnpm check:platform-ops` (expect it to flag the new POST until Task 6: add the op there before committing, or commit 5 and 6 together).
- [ ] **Step 5: Commit** `feat(kernel): agent skill package routes`.

### Task 6: Platform operation `agents.register-skill`

**Files:**
- Modify: `packages/kernel/src/platform/ops/agent-skills.ops.ts`
- Test: `packages/kernel/test/platform/ops-agent-register-skill.test.ts`

**Interfaces:**
- Consumes: `SandboxFileReader.read` (Task 3), `AgentSkillsService.register` / `assertOwner` (Task 4),
  `rootConversationOf` (`runtime/subagents/child.ts:142`), `AgentSkillRegisterBody` (Task 5).
- Produces operation:
  - `id: "agents.register-skill"`, `mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/skills"]`,
    `authz: { orgAction: "agents.create" }`, `omits: ["uploadId"]`, `extras: ["filePath"]`.
  - input: `{ filePath: string }`;
    the agent is always `ctx.agentId` (no `agentId` input: only the agent itself registers; declare it
    as the op's way of filling the path param, as other `agents.*` ops do for the current agent, or
    take `agentId` and refuse any value other than `ctx.agentId`; pick whichever the parity test accepts).
  - `confirm: "personal"`, `confirmFor`: `"personal"` when the agent is private, owned by the actor and
    `definition.skills.writePolicy !== "ask"`, else `"org"`.
  - `precheck`: refuse sub-agent (`skill.subagent_register`, next: "Hand the skill files back to your
    parent agent; only the agent the person talks with registers skills."), refuse non-owner (`forbidden`).
  - `summary`: zh `从 <filePath> 为智能体登记技能` / en `Register a skill on this agent from <filePath>`.
  - `run`: read `filePath` with `maxBytes: SKILL_PACKAGE_MAX_BYTES`, then `register` with
    `conversationId: ctx.conversationId`, `runId: ctx.runId`, `auditDetail: viaAgent("agents.register-skill", ctx)`.
  - Result text (English) states created/updated, version, files count, that it applies to every
    conversation with this agent from now and in this run after `Skill`, or for manual-only that a
    person invokes it with `/<name>`; for `proposed` (Task 8) that it waits for an org admin.
  - `errors` with `next` for every code from Tasks 3, 4 and 8.

- [ ] **Step 1: Failing tests** (model-fake script that calls `Platform`):
  end to end: fake sandbox holds `out/weekly.zip` → op → `Skill` loads it in the same run;
  `confirmFor` returns `personal` for own private agent, `org` with `writePolicy: "ask"`, `org` on an
  `org`-visible agent; remembered grant applies on private, not on shared; sub-agent call refused;
  `platformTool: "read-only"` and a scheduled run (no person) → unavailable.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run → PASS; `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`; `pnpm check:platform-ops`.
- [ ] **Step 5: Commit** `feat(kernel): Platform operation to register an agent skill`.

### Task 7: Remove `SkillWrite`, R3 skill ask and the owner-decided flow

**Files (from the footprint survey; each listed line range is SkillWrite-only or R4-only):**
- Delete: `packages/kernel/src/tools/builtins/skill-write.ts`, `packages/kernel/test/skills/skill-write.test.ts`
- Modify: `tools/builtin-names.ts` (:19, :87, :120-131 drop `R3_FIXED_ASK_TOOL_KEYS` and `R3_SHARED_AGENT_ONLY_TOOL_KEYS`, :133-142 entry),
  `tools/policy.ts` (:8, :16, :49-62, :266-272: `isFixedAsk` loses `skillWritePolicy`),
  `tools/builtins/builtin-tools.ts` (:24-115), `tools/legacy-keys.ts` (:38 keep the `skill_write` →
  `SkillWrite` name mapping only if the zero-drift tests need it for old logs; otherwise remove),
  `agents/definition.ts` (:271-277 comment: `writePolicy` now governs `agents.register-skill`),
  `platform/ops/platform.ops.ts` (:27), `platform/ops/agents.ops.ts` (:48), `identity/settings.ts` (:102, :152), `conversations/events.ts` (:729-730),
  `skills/invocation-keys.ts` (:7), `skills/catalog.ts` (:412 comment)
- Tests to update (SkillWrite references): `tools/policy.test.ts`, `tools/ask-user.test.ts:343`, `tools/info.test.ts:164`,
  `tools/sandbox/sandbox-helpers.test.ts`, `runtime/subagents/definition.test.ts`, `runtime/subagents/dispatch.test.ts:326`,
  `skills/manual-skills.test.ts:284-298` (rewrite on `AgentSkillsService.register`), `catalog/m6-segment3.dual.test.ts`,
  `skills/m5-segment3.dual.test.ts` scenario 1 (rewrite as a register test or delete), `platform/ops-workspace.test.ts:153`,
  `subagents/forked-skill.e2e.test.ts:845`, `agents/pinned-skills.test.ts:197-204`, `skills/invoke.http.test.ts:398-405`
- Modify: `tools/checks/src/terms.ts:153` (message text only)

**Interfaces:**
- Produces: no builtin `SkillWrite`; `isFixedAsk(tool, visibility)` without the write policy argument.
  The R4 parts of `SkillChangesService` (`write`, owner `decide`) are deleted here; the request table,
  trial overlay (`catalog.ts:157-181`, `skill-load.ts:312-322`), `get`, `listPending`, review page and
  inbox rows stay for Task 8 (which changes who decides).

- [ ] **Step 1:** run the zero-drift fixtures before: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/evals/rename-compat.test.ts` → PASS (baseline).
- [ ] **Step 2:** add a test in `tools/builtin-names.test.ts`: `BUILTIN_TOOL_NAMES` does not contain `SkillWrite`; run → FAIL.
- [ ] **Step 3:** remove and update per the file list.
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test` (touched dirs) → PASS; zero-drift fixtures → PASS; `pnpm typecheck`; `pnpm check`.
- [ ] **Step 5: Commit** `refactor(kernel)!: remove the SkillWrite tool`.

### Task 8: Sharing and version proposals decided by org admins

**Files:**
- Modify: `packages/kernel/src/skills/agent-skills.service.ts`, `packages/kernel/src/skills/changes.service.ts`,
  `packages/kernel/src/skills/changes.controller.ts` (`decide` → `@OrgAction("skills.manage")`),
  `packages/kernel/src/skills/agent-skills.controller.ts`, `packages/kernel/src/skills/skills.schemas.ts`,
  `packages/kernel/src/skills/usable.ts` (`selectedSkills` :394), `packages/kernel/src/inbox/inbox.service.ts`,
  `packages/kernel/src/platform/ops/agent-skills.ops.ts`, `packages/kernel/src/platform/ops/inbox.ops.ts`,
  `packages/kernel/src/agents/agents.service.ts` (:364-367, :931, :964, :1027 cancellation on delete / transfer), `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/skills/agent-skill-sharing.test.ts`, `packages/kernel/test/skills/agent-skill-sharing.dual.test.ts`

**Interfaces:**
- Consumes: Task 1 columns, Task 4 service, `SkillsService.createVersionFromFiles` (`skills.service.ts:758`),
  `assertCustomAllowed(db, "customSkills")`, `roleAtLeast`.
- Produces:
  ```ts
  type ShareOutcome = { kind: "shared"; skillId: string } | { kind: "requested"; requestId: string };
  AgentSkillsService.share(actor: AgentSkillActor, skillId: string): Promise<ShareOutcome>;
  SkillChangesService.decide(orgId: string, id: string, accountId: string,
    body: { decision: "approve" | "reject"; note?: string }, actorTokenId?: string): Promise<SkillChangeView>; // now org admins
  SkillChangeView.kind: "share" | "version";
  ```
  Route `POST /api/v1/orgs/:orgId/agents/:agentId/skills/:skillId/share` (`agents.create`) → `{ share: ShareOutcome }`;
  op `agents.share-skill` mirroring it, `confirm: "personal"`, `confirmFor`: `"org"` when the actor is an org admin, else `"personal"`.
  Errors: `skill.name_exists` (409), `catalog.custom_disabled`, `skill.share_pending` (409), `skill_change.not_found`,
  `skill_change.already_decided`, `skill.proposal_pending_elsewhere` (409).

  Behavior:
  - **share** (owner only): `customSkills` must allow; an org skill with the name → `skill.name_exists`.
    Admin actor → in one transaction set `scope='org'`, `agent_id=NULL`, `origin_agent_id=<agent>`,
    `maintainer_account_id=<actor>`; audit `skill.shared`. Otherwise insert a request `kind='share'`,
    `skill_id=<agent skill>`, `proposed_version` = the current version (no new files; `object_prefix` =
    that version's prefix, **never deleted** on reject/cancel for `share`). Approve applies the same
    update with the requester as maintainer.
  - **version proposal**: `register` whose name matches an org skill with `maintainer_account_id = actor`
    (and no own agent skill of that name) → admin actor: `createVersionFromFiles` on that org skill;
    otherwise request `kind='version'`, trial in the proposing conversation (existing overlay),
    `RegisterOutcome.kind = "proposed"`. A pending proposal from another conversation →
    `skill.proposal_pending_elsewhere`. Approve = `createVersionFromFiles` with the request's prefix;
    reject reverts the trial and deletes the draft prefix (existing code).
  - **resolution**: `selectedSkills` also returns org skills with `origin_agent_id = agentId`, so the
    original agent keeps a shared skill without a definition change.
  - **decide**: org admins (role ≥ admin, read live) only; `listPending` lists for org admins.
  - **cleanup**: agent delete cancels its pending requests (share and version); ownership transfer
    cancels pending `share` requests (rename `cancelPendingForAgent` usage accordingly).

- [ ] **Step 1: Failing tests**: member owner shares → request; admin approves → skill is org-scoped,
  original agent still resolves it, another agent can select it; admin owner shares → immediate;
  name clash → `skill.name_exists`, own skill unchanged; `customSkills: deny` → refused; maintainer
  registers same name → proposal, only the proposing conversation sees the new version, approve →
  every agent's next run sees it, reject → trial reverted; second conversation proposing →
  `skill.proposal_pending_elsewhere`; non-admin decide → 403; agent deleted while share pending →
  request cancelled, files kept; dual-replica: two replicas approving the same request → one wins,
  the other `skill_change.already_decided`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run → PASS; zero-drift fixtures; `pnpm check:platform-ops`; parity test.
- [ ] **Step 5: Commit** `feat(kernel): share agent skills with the org`.

### Task 9: Web

**Files:**
- Modify: `apps/web/src/components/agent/SkillsSection.tsx`, `apps/web/src/components/AgentSkills.tsx` (:143-160),
  `apps/web/src/lib/agents.ts` (:45, :96-101), `apps/web/src/lib/skills.ts`, `apps/web/src/components/SkillChangeReview.tsx`,
  `apps/web/src/app/(app)/inbox/view.tsx`, `apps/web/src/lib/inbox.ts`, `apps/web/src/lib/query/*` as needed,
  `apps/web/messages/en.json`, `apps/web/messages/zh.json`
- Test: `apps/web/test/agent-skills.test.tsx`, `apps/web/test/agent-page-sections.test.tsx`, `apps/web/test/inbox.test.tsx`, `apps/web/e2e/skills.spec.ts` (:192-252 rewrite)

**Interfaces:**
- Consumes: routes from Tasks 5 and 8.
- Produces UI (templates + design components only; `useAppMutation` for writes, `defineQuery` for reads):
  - Agent page skills section, owner only: "Upload skill package" (zip, the uploads + register routes),
    per own skill a "Share with org" action (confirm dialog; shows "Waiting for an org admin" when a
    share request is pending), delete unchanged. Non-owners see the list read-only (roles-everywhere rule: no refused actions shown).
  - `SkillWrite` removed from `BUILTIN_TOOLS`; the write-confirmation switch (`writePolicy`) stays,
    relabelled: en "Confirm every skill registration", hint "When on, the agent asks you each time it
    registers a skill, and the answer is never remembered."; zh "每次登记技能都确认" / "开启后，智能体每次登记技能都会请你确认，且不会记住授权。"
  - Inbox: skill change rows for org admins with kind label (en "Share skill" / "New skill version";
    zh "共享技能" / "技能新版本"); review page shows files and, for versions, the diff against current.
  - Remove i18n keys `agents.form.builtin.SkillWrite`, `confirmSkillWrite*`.
- [ ] **Step 1:** update/add failing component tests for each bullet (owner sees upload/share; member doesn't; inbox row kinds; switch label).
- [ ] **Step 2:** run `pnpm exec vitest run apps/web/test/agent-skills.test.tsx apps/web/test/inbox.test.tsx …` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests PASS; `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(web): upload and share agent skills`.

### Task 10: Docs, skills, changesets

**Files:**
- Modify: `docs/guide/skills.md` (:7 bullet rewritten: authoring via files + `agents.register-skill`, sharing, org admin decisions, `skill-guide`),
  `docs/guide/catalog.md` (:3), `.agents/skills/writing-tools/SKILL.md` (SkillWrite / writePolicy lines → the new flow),
  spec status line → "Approved; implemented by plans/2026-11-10-skill-authoring-via-platform.md"
- Create: changesets for `@capybara-hq/kernel` and `@capybara-hq/web` (minor; "Agents author skills with files and the Platform tool; SkillWrite removed")
- [ ] **Step 1:** edit docs; `pnpm check` (terms) passes.
- [ ] **Step 2:** `pnpm changeset` entries; `pnpm verify` green.
- [ ] **Step 3: Commit** `docs: skill authoring through files and the Platform tool`.

### Task 11 (repo `capybara-hq/plugins`): `skills-core` with `skill-guide`

**Files:**
- Create: `plugins/skills-core/.capybara-plugin/plugin.json` (`schemaVersion`, `name: "skills-core"`, `displayName {zh:"核心技能", en:"Core skills"}`,
  `version: "0.1.0"`, `publisher`, `description`, `skills: [{ path: "skills/skill-guide" }]`, no extension),
  `plugins/skills-core/package.json` (`@capybara-hq/plugin-skills-core`, files list), `plugins/skills-core/skills/skill-guide/SKILL.md`,
  `plugins/skills-core/skills/skill-guide/references/format.md`, `.../references/sharing.md`, changeset; marketplace entry per that repo's release flow
- Follow that repo's `writing-plugins` skill for layout, pack and release.
- Content of `SKILL.md` (English, < 500 lines): frontmatter `name: skill-guide`, `description: "Use when creating or
  upgrading a skill for this agent: the Agent Skills layout, writing SKILL.md, packaging a zip in the sandbox and
  registering it with the Platform tool (agents.register-skill), testing it with Skill, and sharing it with the org."`;
  body sections: when to make a skill; layout; frontmatter rules (`name` 1-64 lowercase letters, digits, single
  hyphens, equal to the folder name; `description` 1-1024 chars, what + when); keep `SKILL.md` short, detail in
  `references/` one level deep with when-to-read lines; steps: write → `cd <parent> && zip -r <name>.zip <name>` →
  `Platform` `agents.register-skill` with `filePath` → `Skill` to test → upgrade = register again (complete version);
  only the owner registers; sharing needs an org admin. `references/format.md`: optional fields (`license`,
  `compatibility`, `metadata`, `allowed-tools`, invocation keys `disable-model-invocation`, `user-invocable`,
  `context`, `agent`, `argument-hint`, `arguments`), limits (10 MB per file, 50 MB total, 1000 files).
  `references/sharing.md`: share flow and version proposals.
- [ ] **Step 1:** `capybara-plugin check plugins/skills-core` fails before the files exist; create them; passes.
- [ ] **Step 2:** pack test per the repo's conventions; commit `feat(skills-core): add skill-guide`; release through that repo's flow.

### Task 12 (core, after Task 11 is published): pin `skills-core`

**Files:** `packages/kernel/bootstrap.json` (entry `{ name: "skills-core", source: "npm", npm: "@capybara-hq/plugin-skills-core", version, integrity, required: true }`, `marketplace.commit` bumped to the commit listing it)
- [ ] **Step 1:** add a kernel test asserting a fresh deployment's org sees `skill-guide` as a builtin platform skill that an org admin cannot switch off; run → FAIL.
- [ ] **Step 2:** add the entry; `pnpm check:bootstrap --network` passes.
- [ ] **Step 3:** test PASS; changeset `@capybara-hq/capybara` (image content); commit `feat(kernel): pin skills-core as a builtin plugin`.
