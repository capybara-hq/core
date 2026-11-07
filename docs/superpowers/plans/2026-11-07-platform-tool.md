# The `Platform` tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. With more than five tasks, plan the waves first with `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One builtin tool, `Platform`, through which an agent discovers and calls the platform's operations as the person who started the run, with layered discovery, per-operation confirmation, live docs and a fence that keeps it complete.

**Architecture:** A kernel domain `src/platform/` holds an operation registry. Each domain provides `PlatformOperation`s, which call the same service methods the controllers call. The `Platform` builtin serves `browse` / `search` / `describe` / `call` / `read` over that registry. The tool pipeline gains a per-call policy key (`Platform:<op>`) so that approvals, grants and `toolPolicies` act per operation. Agent docs ship with the SDK. Two checks keep things in step:
- `check:platform-ops`: every route is mirrored or excluded;
- `check:agent-docs`: the docs are complete and current.

**Tech Stack:** TypeScript, NestJS (kernel), Kysely/PG, zod 4 (`z.toJSONSchema` for `describe`), vitest, Next (web), tsx checks.

**Spec:** `docs/superpowers/specs/2026-11-07-platform-tool-design.md`

## Global Constraints

- The tool key is `Platform`. Operation ids are `<domain>.<verb>` (kebab-case parts, e.g. `agent-templates.list`, `plugins.set-enabled`). The policy key is `Platform:<operation id>`.
- `action` is one of `browse` / `search` / `describe` / `call` / `read`. The tool definition is fixed: the root's content is a result, never part of the description.
- Confirmation classes: `read` runs; `personal` confirms each time and may be remembered; `org` / `platform` confirm each time and are **never** remembered. Human-only operations are not offered.
- The actor is the run's trigger account. Role, membership and super admin are re-read on every call.
- Writes are unavailable when no person is present, or when the org setting `platformTool` is `read-only`. The whole tool is unavailable when it is `off`. Default: `on`.
- `@SuperAdmin` operations run only through the super admin's own private agent, and their results give other orgs as counts, never names or details.
- Confirmation cards are rendered by the kernel from the operation and its params (zh and en), and bind the exact params. Previews with hashes are reused; no new review logic is added. Operations needing credentials or secret config refuse with a pointer to the web page.
- Model-visible text is English. UI text goes through i18n (zh, en; 平台 / 超级管理员 / 智能体; `pnpm check:i18n`).
- Multi-replica: no process state. Writes stay in the services' `@Transactional()` methods. Audit `detail` of writes made through the tool carries `{ via: "agent", conversationId, runId, operation }`.
- Results never contain secrets or config values marked secret.
- Kernel conventions: `@Injectable`, explicit `@Inject` on every constructor parameter (`pnpm check:kernel-conventions`).
- SDK public API changes need `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`. Kernel changes need a changeset on `@capybara-hq/kernel`.
- Run tests from the repo root: `pnpm exec vitest run <path>`.

## Review Focus

1. **A model passes params that do not match the operation's schema, or names an unknown operation.** The person expects an actionable tool error naming `describe`, never a 500 or a generic "Tool failed". Pinned in Task 3.
2. **Params change between the approval and the execution.** For example, the model re-calls with a different URL while the approval is pending, or an approval is reused. Expected: the call is not executed with params the person never saw. Pinned in Task 2.
3. **The actor lost the role between `browse` and `call`** (demoted, removed from the org). Expected: `call` is refused with the reason, nothing is written. Pinned in Task 1.
4. **A super admin uses a shared agent, or a platform result lists orgs.** Expected: the operation is unavailable through the shared agent, and results show counts only. Pinned in Task 6.
5. **"Always allow" on an org-class operation, via the web, an IM card or a crafted API call to decide with `scope: "always"`.** Expected: refused; only `once` is possible. Pinned in Task 2.

---

## Waves

| Wave | Tasks | Why together |
|---|---|---|
| 1 | 1 | the registry and its types everything else imports |
| 2 | 2, 7, 8 | disjoint files: pipeline and approvals / SDK docs / check scanner |
| 3 | 3, 4, 5, 6 | the builtin (needs Task 2's `callPolicy` type), the approval card, operations by domain (each its own files) |
| 4 | 9, 10 | route classification needs every operation; docs and the end-to-end test last |

Task 2 touches the approval and policy path (a trust boundary): review it alone, on the most capable model.

---

### Task 1: Operation registry and availability

**Files:**
- Create: `packages/kernel/src/platform/operation.ts`, `packages/kernel/src/platform/registry.ts`, `packages/kernel/src/platform/availability.ts`, `packages/kernel/src/platform/actor.ts`, `packages/kernel/src/platform/platform.module.ts`
- Modify: `packages/kernel/src/orgs/settings.service.ts` (setting `platformTool`), `packages/kernel/src/kernel.module.ts` (import `PlatformModule`; place it like `ToolsModule`), `apps/web/src/lib/org-settings.ts`, `apps/web/src/app/(app)/settings/organization/view.tsx` and the zh/en messages
- Test: `packages/kernel/test/platform/availability.test.ts`, `packages/kernel/test/platform/registry.test.ts`, `packages/kernel/test/platform/actor.test.ts`

**Interfaces:**
- Produces (`operation.ts`):

```ts
export type ConfirmClass = "read" | "personal" | "org" | "platform";
export type OperationAuthz = { orgAction: OrgAction } | { superAdmin: true };
export interface OperationContext {
  orgId: string; actorAccountId: string; agentId: string; conversationId: string;
  runId: string | null; signal: AbortSignal;
}
export interface PlatformOperation<I = unknown> {
  id: string;                      // "<domain>.<verb>", /^[a-z][a-z-]*\.[a-z][a-z-]*$/
  description: string;             // English, one paragraph; first sentence is the browse line
  input: z.ZodType<I>;
  example: I;
  authz: OperationAuthz;           // the route's, or the role the service enforces (spec §9)
  mirrors: readonly string[];      // "POST /api/v1/orgs/:orgId/skills"; [] for synthetic ops
  confirm: ConfirmClass;
  summary?: (input: I) => { zh: string; en: string };   // required unless confirm === "read"
  run(input: I, ctx: OperationContext): Promise<unknown>;
}
export function defineOperation<I>(op: PlatformOperation<I>): PlatformOperation<I>;
export const PLATFORM_DOMAINS: readonly { id: string; description: string }[];
// platform, skills, agents, agent-templates, plugins, marketplaces, requests, connectors, extensions
export interface OperationProvider { operations(): readonly PlatformOperation[] }
export const OPERATION_PROVIDERS = Symbol("OPERATION_PROVIDERS");
```

- Produces (`actor.ts`):

```ts
export interface ActorFacts {
  role: OrgRole | null;            // null: not a member any more
  isSuperAdmin: boolean;
  personPresent: boolean;
  agentPrivateToActor: boolean;    // agent visibility "private" and owner === actor
  setting: "on" | "read-only" | "off";
}
@Injectable() export class PlatformActor {
  facts(ctx: { orgId: string; accountId: string; agentId: string; conversationId: string; runId?: string | null }): Promise<ActorFacts>;
}
```

- Produces (`availability.ts`): `export function availability(op: PlatformOperation, f: ActorFacts): { ok: true } | { ok: false; reason: string }`. The reason is English and actionable, and names who can do it (`an org admin`, `the super admin`) or why (`no person is present in this run`, `the org set the Platform tool to read-only`, `only through your own private agent`).
- Produces (`registry.ts`): `@Injectable() class PlatformOperations` with `domains()`, `inDomain(domain)`, `search(query, limit)`, `get(id): PlatformOperation | null` and `all()`. It throws at construction on a duplicate id, an id outside its domain list, or a non-read op without `summary`.

- [ ] **Step 1: Write the failing tests.** Two files:
  - `availability.test.ts`: one case per rule.
    - member + `{orgAction:"skills.manage"}`: refused, reason contains `org admin`;
    - admin: ok;
    - `role: null`: refused, `not a member`;
    - `{superAdmin:true}` with `isSuperAdmin` and `agentPrivateToActor:false`: refused, `private agent`;
    - `confirm:"org"` with `personPresent:false`: refused;
    - `setting:"read-only"` with a write: refused, a read ok.
  - `registry.test.ts`: a duplicate id throws; `search("skill")` returns `skills.*` before others; a write op without `summary` throws.
- [ ] **Step 2: Run them, expect FAIL** (`pnpm exec vitest run packages/kernel/test/platform`).
- [ ] **Step 3: Implement** `operation.ts`, `availability.ts` and `registry.ts`. Search scores id words above description words, like ToolSearch's `KEY_WEIGHT`.
- [ ] **Step 4: Implement `PlatformActor.facts`.**
  - `role` comes from the membership read and `isSuperAdmin` from `accounts.is_super_admin`.
  - `setting` comes from `readOrgSettings(db, orgId).platformTool`.
  - `agentPrivateToActor` comes from the agent row.
  - `personPresent` is true only when all of these hold:
    - the root conversation's `kind` is `chat` (follow `parent` for `subagent`);
    - the trigger account is a member;
    - the run was not started by a service token, and not by a channel message from an unlinked user.

  First find how those two runs set `trigger_account_id`: `channel_threads.account_id` null, and the token path. If either is indistinguishable from a person, add `runs.trigger_kind text NOT NULL DEFAULT 'person'` (`person` / `token` / `channel_unlinked` / `wake`) in migration `0086_run_trigger_kind.sql`, written where runs are inserted (`runtime/run-queue.ts`). Wake runs (`budget_run_id` set) count as present: the person's own run continues. Test the four kinds in `actor.test.ts` against PG (`startTestPostgres`, helpers `truncateTables`, `testMembers`).
- [ ] **Step 5: Add the org setting** `platformTool: z.enum(["on","read-only","off"]).default("on").catch("on")` to `OrgSettingsSchema` and the patch schema (like `sandboxToolPolicy`). Add a select to the organization settings page with zh/en labels 开启 / 只读 / 关闭, and a help line: 智能体通过 Platform 工具了解并操作平台；写操作总要当事人确认。
- [ ] **Step 6: Run the tests and `pnpm check:kernel-conventions`, expect PASS.**
- [ ] **Step 7: Commit** `feat(kernel): Platform operation registry and availability`.

---

### Task 2: Per-call policy keys, bound approvals, allowed scopes

**Files:**
- Modify: `packages/kernel/src/tools/registry.ts` (`BuiltinTool`), `tools/pipeline.ts` (`PolicyContext` :178, `DecidePolicy` :204, call :669, approval binding :690, request :694), `tools/policy.ts` (`createDecidePolicy` lookups :144, :159, :212, `findGrant` :239), `tools/approvals.service.ts` (`requestIn` :194, `decideIn` :334, `ApprovalView` :53), `agents/agents.service.ts` (`checkTools` :361), `agents/definition.ts` (`policyKeys` :376 keeps `Platform:` keys)
- Create: `packages/kernel/src/migrations/0087_approval_summary.sql` (renumber if Task 1 took no migration)
- Test: `packages/kernel/test/tools/call-policy.test.ts`, additions to `test/tools/policy.test.ts` and `test/tools/approvals.http.test.ts`

**Interfaces:**
- Produces: on `BuiltinTool`:

```ts
callPolicy?: (input: unknown) => {
  key: string;                                   // e.g. "Platform:skills.create"
  policy: "allow" | "ask" | "deny";              // the class default (read allow, writes ask)
  remember: boolean;                             // false: only "once"
  summary?: { zh: string; en: string };
  denyReason?: string;                           // set with policy "deny" (unavailable)
} | null;
```

- `PolicyContext` gains `callPolicy` (the value above, or null).
- `ApprovalView` gains `summary: {zh,en} | null` and `scopes: ("once"|"session"|"always")[]`.
- Migration: `ALTER TABLE capybara.approvals ADD COLUMN IF NOT EXISTS summary jsonb, ADD COLUMN IF NOT EXISTS scopes text[]` (null = today's derivation).

- [ ] **Step 1: Write the failing tests** in `call-policy.test.ts`, with a fake builtin whose `callPolicy` maps `{op}` to a key:
  - `toolPolicies {"Platform:x.write":"deny"}` denies that op only;
  - an `always` grant on `Platform:x.personal` lets the next call with that key run without asking and does not cover `Platform:x.other`;
  - `remember:false` makes `decide` ask even with a grant present, and `decideIn` with `scope:"always"` or `"session"` answers 409 `approval.scope_not_allowed` (new error code);
  - an approved approval whose stored `input` differs (canonical JSON, `tools/canonical-json.ts`) from the call's input is not used: the call asks again;
  - `ApprovalView.scopes` is `["once"]` for `remember:false`.
  - In `agents.service`, saving `toolPolicies {"Platform:skills.create":"deny"}` with `Platform` selected passes; with `Platform` not selected it fails `validation_failed`; `"Platform:BAD"` fails.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - The pipeline computes `callPolicy` after `validateInput`. With a key present, it uses the key everywhere the tool key is used for policy: agent and parent overrides, grants, `approvals.tool_key` and grant rows. `deny` with `denyReason` returns that reason as the tool error.
  - `remember:false` sets `fixedAsk`.
  - Binding: the `approved` check at :690 also requires canonical input equality.
  - `requestIn` stores `summary` and `scopes`. `decideIn` refuses a scope not in `scopes`.
  - `checkTools` accepts `^Platform:[a-z][a-z-]*\.[a-z][a-z-]*$` when `Platform` is among the agent's tools (unknown op ids are kept: a removed op's policy is harmless).
- [ ] **Step 4: Run the tests plus `test/tools/policy.test.ts`, `test/tools/pipeline.test.ts`, `test/tools/approvals.http.test.ts`, expect PASS.** Run the zero-drift tests (`runtime/.../reconcile`, `rename-compat`; see `replay-evals`): unchanged.
- [ ] **Step 5: Commit** `feat(kernel): per-call policy keys and approvals bound to their input`.

---

### Task 3: The `Platform` builtin

**Files:**
- Create: `packages/kernel/src/tools/builtins/platform.ts`, `packages/kernel/src/platform/method.ts` (the root text), `packages/kernel/src/platform/errors.ts`
- Modify: `tools/builtin-names.ts` (`BUILTIN` :11, `BUILTIN_TOOL_NAMES` :80, `DEFAULT_AGENT_TOOLS` :145, `BUILTIN_TOOL_KINDS` :151), `tools/builtins/builtin-tools.ts` (inject `PlatformOperations`, `PlatformActor`, `AgentDocs` from Task 7; register), `apps/web/src/lib/agents.ts`, `apps/web/src/lib/timeline.ts` (web copies), zh/en tool names in web messages
- Test: `packages/kernel/test/tools/platform-tool.test.ts`, `packages/kernel/test/tools/builtin-names.test.ts` (existing equality check)

**Interfaces:**
- Consumes: Task 1 registry, availability and actor; Task 2 `callPolicy`; Task 7 `AgentDocs` (`topics(): {id, title}[]`, `read(id): string | null`). Until Task 7 lands, inject a stub provider returning `[]`.
- Produces:
  - `platformTool(deps): BuiltinTool`, with `spec.name = "Platform"`, `defaultPolicy: "allow"`, `keyArgs: ["action", "operation", "domain"]`, `unavailable` = `"The org turned the Platform tool off; ask an org admin to turn it on."` when `setting === "off"`;
  - `toToolError(e: unknown): ToolError` in `platform/errors.ts`.

- [ ] **Step 1: Write the failing tests** with a test registry of three ops (read / personal / org) and fake facts:
  - `browse` without a domain returns every domain line and the method text (assert it contains `describe` and `Read before you write`);
  - `browse {domain}` lists ops with `read`/`write` and `available: false, reason` for a member on an admin op;
  - `search` finds by id word;
  - `describe` returns `inputSchema` equal to `z.toJSONSchema(op.input)`, plus the example and `confirm`;
  - `call` with invalid params gives a ToolError mentioning `describe` (Review Focus 1);
  - an unknown op gives a ToolError naming `browse`;
  - `read` without a topic lists topics;
  - `callPolicy({action:"call", operation:"x.org"})` is `{key:"Platform:x.org", policy:"ask", remember:false, summary}`;
  - for `browse` it is null (the tool's default `allow`);
  - for an unavailable op it is `{policy:"deny", denyReason}`;
  - `call` re-checks availability with fresh facts (Review Focus 3: facts flip to `role:null` between `callPolicy` and `run`, and the call is refused);
  - an `ApiError("skill.name_taken", …)` thrown by an op becomes a ToolError carrying the code and the message plus `Check the input with describe and call again, or ask the person.`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the tool.**
  - Input schema: `action` enum, with optional `domain`, `query` (≤ 200), `operation` (≤ 100), `params` (object), `topic` (≤ 100). Validate per action inside `run`.
  - Results are JSON objects; lists are capped at 50 entries, with `next` paging via `params.cursor` for ops that page.
  - The tool description, verbatim: `Discover and use the platform's own operations (skills, agents, templates, plugins, marketplaces, requests, connectors, extensions) and its documentation, as the person you are working for. Start with action "browse", then "describe" an operation before you "call" it; never guess parameters. Writes ask the person to confirm. Use "read" for how-to documentation (plugin format, skills, extension points).`
  - The method text (`method.ts`) holds the six rules of spec §5.2, in English.
- [ ] **Step 4: Run the tests and `pnpm check` (`tool-error-actionable` covers `tools/builtins`), expect PASS.**
- [ ] **Step 5: Commit** `feat(kernel): the Platform builtin tool`.

---

### Task 4: Confirmation card on the web and in IM

**Files:**
- Modify: `apps/web/src/components/ApprovalCard.tsx` (:226-266), `apps/web/src/lib/approvals.ts` (`scopesFor` :53), `apps/web/src/lib/tool-label.ts`, `packages/kernel/src/channels/cards.ts` (`approvalCard` :141), web messages zh/en
- Test: `apps/web/src/components/ApprovalCard.test.tsx` (or its existing test file), `packages/kernel/test/channels/cards.test.ts`

**Interfaces:**
- Consumes: `ApprovalView.summary` and `ApprovalView.scopes` (Task 2).
- Produces: the card shows the summary in the UI language above the raw params, with the label `Platform [<operation>]` (the `operation` from the input). Scope buttons come from `view.scopes` when non-null.

- [ ] **Step 1: Write the failing tests.**
  - An approval with `toolKey:"Platform:marketplaces.add"`, `summary {zh:"添加市场源 https://x", en:"Add marketplace source https://x"}` and `scopes ["once"]` renders the label `Platform [marketplaces.add]` and the zh summary, with no 本会话 / 始终 buttons.
  - The IM card text contains the summary and only the once action.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `toolLabelOfKey` maps `Platform:<op>` to `Platform [<op>]`. `scopesFor` prefers `view.scopes`. The IM card puts the summary first and builds its actions from `scopes`.
- [ ] **Step 4: Run, plus `pnpm check:web-ui` and `pnpm check:i18n`, expect PASS.** If a rendered page changes visually, note it: the visual baselines are refreshed by the `visual-update` workflow, never locally.
- [ ] **Step 5: Commit** `feat(web): Platform confirmations show the operation and its summary`.

---

### Task 5: Operations — platform, skills, agents, agent templates

**Files:**
- Create: `packages/kernel/src/platform/ops/platform.ops.ts`, `ops/skills.ops.ts`, `ops/agents.ops.ts`, `ops/agent-templates.ops.ts` (one `@Injectable` `OperationProvider` each, registered under `OPERATION_PROVIDERS` in `PlatformModule`, which imports `SkillsModule`, `AgentsModule`)
- Test: `packages/kernel/test/platform/ops-workspace.test.ts`

**Interfaces:**
- Consumes: the Task 1 types and the services below (signatures as on `main`).
- Produces: these operations (`authz` / `confirm` / service):

| id | authz | confirm | calls |
|---|---|---|---|
| `platform.overview` | `org.read` | read | composed: what the platform is, tool families, the actor's role and what it may build, `PLATFORM_DOMAINS` |
| `platform.me` | `agents.use` | read | the agent definition (model, tools by key, skills, pinned, sub-agents), sandbox yes/no and egress mode |
| `skills.list` / `skills.get` | `skills.read` | read | `SkillsService.list(orgId)` / `get(orgId, id)` |
| `skills.create` | `skills.manage` | org | `SkillsService.createFromText(orgId, actor, {name, description, body, shareable?})` |
| `agents.list` / `agents.get` | `agents.use` | read | `AgentsService.listVisible(orgId, actor)` / `get(orgId, id, actor)` |
| `agents.create` | `agents.create` | personal | `AgentsService.create(orgId, actor, {definition, visibility:"private"})`; other visibilities refused with a pointer to the web |
| `agents.update` | `agents.create` (service enforces owner or admin) | personal | `AgentsService.update(…)` with `version` required |
| `agents.preview-from-template` | `agents.create` | read | `FromTemplateService.preview(orgId, templateId)` |
| `agents.create-from-template` | `agents.create` | personal | `FromTemplateService.create(orgId, actor, {templateId, name, previewHash, model?})`; private only |
| `agent-templates.list` / `.get` | `agents.use` | read | `listForOrg(orgId)` / `OrgTemplates.detail(orgId, id)` |
| `agent-templates.save` | `agents.manage` | org | `OrgTemplates.saveAs(orgId, actor, agentId, {name, description})` |

Each write's `summary` names the object, e.g. 新建组织技能「{name}」/ Create org skill "{name}". Each write passes audit detail `{via:"agent", conversationId, runId, operation}`. If a service has no way to take extra audit detail, add an optional `auditDetail?: Record<string, unknown>` to its options, merged into its audit call. `mirrors` lists the exact routes from the controllers.

- [ ] **Step 1: Write the failing tests** against PG with real services, `app.get(...)` per `writing-kernel-api`:
  - a member `skills.list` returns the org skills;
  - a member `skills.create` is unavailable with the reason naming an org admin;
  - an admin `skills.create` creates the skill, and the audit row's detail has `via:"agent"` and the operation;
  - `agents.update` by a member on another member's agent answers the service's forbidden error as a ToolError;
  - `agents.create-from-template` with a stale `previewHash` answers `agent.template_preview_stale`;
  - `platform.me` lists the agent's tool keys and never a secret;
  - `agents.create` with visibility `org` is refused, pointing to the web page.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the four providers.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(kernel): Platform operations for skills, agents and templates`.

---

### Task 6: Operations — plugins, marketplaces, requests, connectors, extensions

**Files:**
- Create: `packages/kernel/src/platform/ops/plugins.ops.ts`, `ops/marketplaces.ops.ts`, `ops/requests.ops.ts`, `ops/connectors.ops.ts`, `ops/extensions.ops.ts`, `packages/kernel/src/platform/redact-orgs.ts`
- Test: `packages/kernel/test/platform/ops-catalog.test.ts`

**Interfaces:**
- Produces:

| id | authz | confirm | calls |
|---|---|---|---|
| `plugins.list` / `plugins.get` | `catalog.read` | read | `OrgCatalogService.list(orgId, actor)` / `detail(orgId, actor, id)` |
| `plugins.set-enabled` | the role `setSwitch` enforces for the item (test it: `skills.manage` / `org.extensions.manage` / `connectors.manage`) | org | `OrgCatalogService.setSwitch(orgId, actor, id, {enabled})`; when enabling needs `inputs` (connectors or config), refuse: `This plugin needs configuration a person must enter; ask them to enable it on the 插件 page.` Disabling with an uninstall preview takes its `confirm` hash, from `plugins.get` |
| `plugins.platform-list` / `plugins.platform-get` | superAdmin | read | `CatalogService.page(q)` / `get(id)`, through `redactOrgs` |
| `plugins.update-preview` | superAdmin | read | `PluginUpgrade.preview(id, version)`, through `redactOrgs` |
| `plugins.update` | superAdmin | platform | `PluginUpgrade.update(actor, id, {version, diffHash})` |
| `marketplaces.list` / `marketplaces.entries` | the routes' authz (super admin; the org's read-only marketplace view for org admins where the route exists) | read | `MarketplacesService.list()` / `entries({marketplaceId?, q?})` |
| `marketplaces.add` | superAdmin | platform | `MarketplacesService.add(actor, {name, url, ref?})`; no `form` / `mirrors` / credentials through the tool |
| `requests.list-mine` | `catalog.request` | read | requester's pending and decided requests (add `listForRequester(orgId, accountId)` to `RequestsService` if none exists) |
| `requests.create` | `catalog.request` | personal | `requestItem(orgId, actor, itemId, {kind, note?})` |
| `requests.create-import` | `catalog.decide` (org admin, as the route) | org | `requestImport(orgId, actor, {marketplaceId, name, version, note?})` |
| `connectors.list` / `connectors.get` | `connectors.use` | read | `ConnectorsService.list(orgId)` / `get(orgId, id, actor)`, credentials never included |
| `connectors.templates` | `catalog.read` | read | the connector templates usable in the org (the source the 从模板新建 page uses) |
| `extensions.list` | `org.extensions.read` | read | `OrgExtensionConfigs.list(orgId)`, projected as for members (no config, secrets, schema) |
| `extensions.points` | `org.read` | read | `EXTENSION_POINTS` with `description` (Task 7) and the registered providers' plugin names |

`redactOrgs(value)` replaces every org list (`orgs`, `connectorOrgs`, `usedBy`, … as the views name them) with `{ count }`, and drops org ids and names elsewhere. Test it on the real view types.

- [ ] **Step 1: Write the failing tests:**
  - a super admin through a shared agent: `plugins.platform-list` is unavailable with `private agent` (Review Focus 4);
  - through the private agent, `plugins.update-preview` returns counts and no other org's id or name (assert on the JSON string);
  - `marketplaces.add` called by an org admin is unavailable naming the super admin;
  - `plugins.set-enabled` on a plugin whose enabling needs connector inputs is refused with the 插件 page pointer;
  - an org admin enables a no-input optional plugin and it is on;
  - a member gets `plugins.set-enabled` unavailable;
  - `requests.create` by a member creates the request and `requests.list-mine` shows it;
  - `connectors.get` contains no credential fields.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(kernel): Platform operations for plugins, marketplaces, requests, connectors and extensions`.

---

### Task 7: Agent docs, `EXTENSION_POINTS` descriptions, `check:agent-docs`

**Files:**
- Create: `packages/plugin-sdk/agent-docs/` with these topics:
  - `concepts.md` (platform and org, scope, owner and shareable, requests, sandbox);
  - `plugin-format.md`;
  - `skills.md`;
  - `agent-templates.md`;
  - `connector-templates.md`;
  - `tool-naming.md`;
  - `extensions.md`;
  - `extension-points/<name>.md`, one per `EXTENSION_POINTS` key.
- Create: `tools/checks/src/agent-docs.ts`, `tools/checks/src/cli/agent-docs.ts`, `tools/checks/src/cli/gen-agent-docs.ts`, `tools/checks/fixtures/agent-docs/{clean,violations}`, `tools/checks/test/agent-docs.test.ts`, `packages/kernel/src/platform/agent-docs.ts`
- Modify: `packages/plugin-sdk/src/extension-point.ts` (`ExtensionPointInfo` gains `description: string`; `info(...)` takes it), `packages/plugin-sdk/package.json` (`files` adds `agent-docs`), root `package.json` (`check:agent-docs`, `gen:agent-docs`), `tools/checks/src/cli/all.ts`, `tools/checks/README.md`, SDK API report (`pnpm gen:sdk-api`), `.changeset/platform-agent-docs.md` (plugin-sdk minor in pre mode)

**Interfaces:**
- Produces: `@Injectable() class AgentDocs { topics(): {id: string; title: string}[]; read(id: string): string | null }`. It reads the SDK's `agent-docs` directory once per process (the files are immutable within a version: a cache of package files, not shared state). Topic id = path without `.md` (`extension-points/channel`).
- Generated sections sit between `<!-- generated:<name> -->` and `<!-- /generated -->`. They are field tables rendered from `packages/plugin-sdk/schemas/*.json` (plugin manifest, connector template, agent template frontmatter) and the `EXTENSION_POINTS` table.

- [ ] **Step 1: Write the failing check tests on fixtures:**
  - `agent-docs-stale`: a generated section edited by hand;
  - `agent-docs-missing`: an extension point without its topic, and a schema field absent from the field table;
  - `agent-docs-orphan`: a topic for a removed extension point;
  - the clean fixture yields no finding.
- [ ] **Step 2: Run, expect FAIL** (`pnpm exec vitest run tools/checks/test/agent-docs.test.ts`).
- [ ] **Step 3: Implement the check and the generator** (pattern: `cli/terms.ts`, `report(...)`).
- [ ] **Step 4: Write the docs.** Prose is hand-written in English and short; run `pnpm gen:agent-docs`. Add a `description` to every `EXTENSION_POINTS` entry. Run `pnpm gen:sdk-api` and add the changeset.
- [ ] **Step 5: `AgentDocs` test** (`packages/kernel/test/platform/agent-docs.test.ts`): `topics()` includes `skills` and one `extension-points/*`; `read("nope")` is null.
- [ ] **Step 6: Run `pnpm check:agent-docs`, `pnpm check:sdk-api`, the tests, expect PASS.**
- [ ] **Step 7: Commit** `feat(plugin-sdk): agent docs and extension point descriptions, checked by check:agent-docs`.

---

### Task 8: `check:platform-ops` (the fence)

**Files:**
- Create: `tools/checks/src/platform-ops.ts`, `tools/checks/src/cli/platform-ops.ts`, `tools/checks/fixtures/platform-ops/{clean,violations}/…` (a mini `src/` with controllers, `platform/ops/*.ops.ts`, `platform/exclusions.ts`), `tools/checks/test/platform-ops.test.ts`, `packages/kernel/src/platform/exclusions.ts` (empty array for now)
- Modify: `tools/checks/src/cli/all.ts`, root `package.json` (`check:platform-ops`), `tools/checks/README.md` (full on PRs: a cheap source scan)

**Interfaces:**
- `exclusions.ts`:

```ts
export type ExclusionCategory = "human-only" | "secret" | "transport" | "internal" | "later";
export const PLATFORM_EXCLUSIONS: readonly { route: string; category: ExclusionCategory; reason: string; issue?: string }[];
```

- The scanner reads source with the TypeScript AST (as `kernel-conventions.ts` does: `decoratorName`):
  - routes are `@Controller(prefix)` plus `@Get|Post|Put|Patch|Delete(path?)`, **including the argument-less form**, normalised to `"<METHOD> /<prefix>/<path>"`;
  - a route's authz is its method's or class's `@OrgAction("x")` / `@SuperAdmin()` / `@Public()`;
  - operations are the object literals passed to `defineOperation` in `**/platform/ops/*.ops.ts`; their `mirrors` and `authz` must be literals (the rule `platform-op-literal` reports otherwise).
- Rules:
  - `platform-op-missing`: a route neither mirrored nor excluded;
  - `platform-op-exclusion-reason`: an empty reason, or `later` without an `issue` URL;
  - `platform-op-authz`: the op's `authz` differs from the route's. An op may declare `authzNote: "service-enforced"` when the service enforces a higher role than the decorator; the rule then requires the op's role to be at least the route's;
  - `platform-op-orphan`: a mirror or exclusion naming no route;
  - `platform-op-describe`: an op without `description`, `example`, or (`confirm !== "read"`) `summary`.

- [ ] **Step 1: Write the failing tests:** one violation fixture per rule, plus a clean fixture; `@Get()` without an argument is found.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Register the check in `all.ts`, but leave it **out of the default run** until Task 9 classifies the kernel (a `pending: true` flag the `all` runner skips, removed in Task 9), so that wave 3 is not red.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(checks): check:platform-ops keeps the Platform tool complete`.

---

### Task 9: Classify every kernel route; turn the fence on

**Files:**
- Modify: `packages/kernel/src/platform/exclusions.ts`, `tools/checks/src/cli/all.ts` (drop `pending`)
- Test: `pnpm check:platform-ops` on the real tree

- [ ] **Step 1: Run `pnpm check:platform-ops`, expect FAIL.** It lists every unclassified route (about 260, minus those mirrored in Tasks 5–6).
- [ ] **Step 2: Classify each route.** Each one is either mirrored by an existing op or excluded with a specific reason.
  - Categories per spec §9:
    - `human-only`: approvals, request decisions, permission confirmations, roles, invitations, transfer, org delete, login and account security, tokens;
    - `secret`: credentials, OAuth, secret config;
    - `transport`: SSE, presigned uploads, embeds, webhooks, health, `/plugin-ui`;
    - `internal`: CLI or kernel-only;
    - `later`: anything else agents should eventually have.
  - Open one issue per domain for the `later` routes (`gh issue create`, title `Platform operations: <domain>`), and put its URL in `issue`.
  - Write reasons in English, one line, specific ("decides another person's approval").
- [ ] **Step 3: Run `pnpm check:platform-ops` and `pnpm check`, expect PASS.**
- [ ] **Step 4: Commit** `chore(kernel): classify every route for the Platform tool`.

---

### Task 10: Rules, docs and the end-to-end run

**Files:**
- Modify: `AGENTS.md` ("Rules by area": add `- **Platform tool:** a new HTTP route gets a Platform operation or an exclusion with a reason; operations call the controllers' services, never new logic (`pnpm check:platform-ops`).`), `.agents/skills/writing-kernel-api/SKILL.md` and `.agents/skills/writing-tools/SKILL.md` (a "Platform operations" section: defining an op, classes, summary, `mirrors`, exclusions, docs topics), `docs/superpowers/specs/2026-11-07-platform-tool-design.md` (an "As built" section with rulings made during implementation), `docs/superpowers/specs/2026-10-29-co-build-design.md` (a note at §8: replaced by the Platform tool spec), `.changeset/platform-tool.md` (kernel)
- Test: `packages/kernel/test/platform/platform-e2e.test.ts` (model-fake scripted run; helpers `runs.ts`, `MODEL_FAKE`)

- [ ] **Step 1: Write the end-to-end test.** model-fake scripts `Platform` calls in a real run:
  - (a) a member's run calls `browse` → `search "skill"` → `call skills.list`: allowed without approval, and the results are in the log;
  - (b) an admin's run calls `skills.create`: an approval with `toolKey "Platform:skills.create"`, a zh summary and `scopes ["once"]`; approving creates the skill, the run continues with the result;
  - (c) denying it: the model gets the denial and the skill does not exist;
  - (d) a run whose trigger kind is not a person: `skills.create` is unavailable with the reason, no approval;
  - (e) the org setting `read-only`: same; `off`: the tool is unavailable;
  - (f) replay: reconstructing the run's requests has zero drift.
- [ ] **Step 2: Run, expect PASS.** Fix forward in the owning task's files.
- [ ] **Step 3: Write the rules and docs listed above.** `pnpm verify` passes.
- [ ] **Step 4: Commit** `docs: the Platform tool rules, skills and as-built notes`.
