# Admin agents and connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The super admin sees and manages every org's agents (transfer owner, delete) and connectors (disable / enable, delete) from the admin console pages 智能体 and 连接器, each with a 模板 tab holding today's template page.

**Architecture:** The kernel gets two super-admin controllers (`/api/v1/admin/agents`, `/api/v1/admin/connectors`) plus an org members read, backed by "platform" paths in `AgentsService` and `ConnectorsService` that lock the org row without an org-role check and reuse the same write code, auditing with `detail.via = "platform"`. Each route gets a `Platform` operation. The web renames the two nav items, moves the template pages under `/admin/{agents,connectors}/templates`, and adds list and detail pages for the live items.

**Tech Stack:** NestJS + Fastify + Kysely (kernel), zod / `createZodDto`, vitest with test containers, Next + TanStack Query + `@capybara-hq/design` (web), next-intl.

**Spec:** `docs/superpowers/specs/2026-11-10-admin-agents-connectors-design.md`

## Global Constraints

- Super admin only: controllers carry `@SuperAdmin()` at class level; the actor need not be a member of the org.
- No credential, token or secret value in any response of the new routes or their `Platform` operations; connector detail shows auth type and ownership only, never whether a member has a credential.
- Agent detail shows instructions in full; never conversations, runs, credentials; quick actions by label only.
- Transfer is within the agent's org only; target must be a member and not an anonymous guest.
- No promotion to templates from the admin console. No agent disabled state. No migration.
- Every write keeps its existing audit action, with the super admin as actor and `detail.via = "platform"` merged into the detail.
- Writes in `@Transactional()`; locks through `OrgLock`; no in-process state (AGENTS.md multi-replica rules).
- Paging: `after` (cursor = last id), `limit` 1–200 default 50, response `{ <items>, next: string | null }`, like `GET /api/v1/admin/accounts`.
- Routes: `/admin/agents`, `/admin/agents/templates`, `/admin/agents/[id]`, `/admin/agents/templates/[id]`, same four under `/admin/connectors`; old `/admin/agent-templates` and `/admin/connector-templates` removed without redirects.
- Copy: zh nav 智能体 / 连接器, tabs 智能体 / 模板 and 连接器 / 模板; en Agents / Connectors / Templates. zh never says 企业 or the Latin word `agent` (`check:i18n`).
- Web: pages from `@capybara-hq/design` only, no styles, thin `page.tsx` + client `view.tsx`, `defineQuery` reads, `useAppMutation` writes, never a box inside a box (`check:web-ui`).
- Comments, identifiers, test titles in English.

## Review Focus

1. A connector with an org credential and a member's personal credential: no admin response or Platform op output contains either value, nor a per-member credential status (Task 2, Task 3 sentinel test).
2. The super admin is not a member of the agent's org: transfer and delete still work, and the same calls by a non-super-admin org owner on the admin routes get 403 (Task 3).
3. Transfer target in another org, or an anonymous guest: `member.not_found` / `member.anonymous_guest`, nothing changes (Task 1).
4. Deleted agents / connectors and agents of a deleted org are not listed, and a detail read of one is 404 (Task 1, Task 2).
5. Paging across orgs with the org filter and the name search together returns each row once and a correct `next` (Task 1, Task 2).

---

## Wave plan

- Wave 1 (parallel, disjoint files): Task 1 (agents service), Task 2 (connectors service).
- Wave 2: Task 3 (controllers, schemas, Platform ops, HTTP tests). Review alone on the most capable model: trust boundary.
- Wave 3 (parallel): Task 4 (nav + template pages move), then Tasks 5 and 6 (agents pages, connectors pages) after Task 4 lands, since they share `routes.ts`, `path.ts`, messages.
- Task 7: changeset, `pnpm verify`.

### Task 1: Agents service platform paths and cross-org read

**Files:**
- Modify: `packages/kernel/src/agents/agents.service.ts` (`lockForWrite` ~681, `softDelete`/`softDeleteIn` ~876–950, `reassignOwner` ~954)
- Create: `packages/kernel/src/agents/admin-agents.ts` (cross-org list and detail reads)
- Modify: `packages/kernel/src/agents/agents.module.ts` (provide/export `AdminAgents`)
- Test: `packages/kernel/test/agents/admin-agents.test.ts`

**Interfaces:**
- Produces:
  - `type WriteActor = { accountId: string; tokenId?: string; platform?: true }` exported from `agents.service.ts`.
  - `AgentsService.softDeleteAsPlatform(agentId: string, actor: WriteActor): Promise<void>`: loads the live agent's org (404 `agent.not_found`), `orgLock.lock(orgId)`, same work as `softDeleteIn`, audit detail `{ via: "platform" }`, then `skillChanges.finishCancel`.
  - `AgentsService.reassignOwnerAsPlatform(agentId: string, newOwnerId: string, actor: WriteActor): Promise<AgentView>`: same checks and effects as `reassignOwner`, audit detail adds `via: "platform"`.
  - `AdminAgents.list(q: { orgId?: string; q?: string; after?: string; limit: number }): Promise<{ agents: AdminAgentRow[]; next: string | null }>`
  - `AdminAgents.get(agentId: string): Promise<AdminAgentDetail>`
  - `interface AdminAgentRow { id; orgId; orgName; name; avatar: string | null; ownerAccountId; ownerName; needsReassignment: boolean; visibility: AgentVisibility; createdFrom: { templateId; name } | null; updatedAt: Date }`
  - `interface AdminAgentDetail extends AdminAgentRow { profile: { description: string | null; quickActions: { label: string }[] }; memberIds: string[] | null; definition: AgentDefinition /* instructions included */; versions: number; createdAt: Date }`. Quick actions carry the label only.

- [ ] **Step 1: Write the failing tests** in `admin-agents.test.ts` (containers like `test/agents/agents.test.ts`): two orgs, a private agent owned by a member in each, one deleted agent, one agent in a deleted org.
  - `lists live agents of every org, private ones included` → ids of the two live agents; deleted ones absent.
  - `filters by org and searches the name case-insensitively` → `{ orgId: A, q: "SUPP" }` returns only A's "Support bot".
  - `pages by id with next` → `limit: 1` returns one row and `next` = its id; second page returns the other and `next: null`.
  - `detail has instructions and quick action labels only` → `definition.instructions` equals what was saved; `profile.quickActions` items have only `label`.
  - `get of a deleted agent is agent.not_found`.
  - `reassignOwnerAsPlatform works for an account outside the org` → owner changed, `needs_reassignment` false, audit row `agent.owner_changed` with `detail.via === "platform"`.
  - `reassignOwnerAsPlatform rejects a member of another org` → `member.not_found`, owner unchanged; and an anonymous guest → `member.anonymous_guest`.
  - `softDeleteAsPlatform deletes and audits via platform` → `deleted_at` set, audit `agent.deleted` with `detail.via === "platform"`.

- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/agents/admin-agents.test.ts` — Expected: FAIL (module / methods missing).

- [ ] **Step 3: Implement.** Split `lockForWrite` and `reassignOwner` so the org-member path keeps `lockAndAuthorize` and the platform path calls `orgLock.lock(orgId)`; the body after the lock is shared (a private method each), so effects (attachments expiry, setup request settle/retarget, eval cancel, pending skill changes) stay identical. `AdminAgents` reads with Kysely: join `orgs` (not deleted) and `accounts` (owner name), current version's definition for name/instructions, `agents.deleted_at is null`, order by `agents.id`, `after` as `id > after`, `q` as `ILIKE` on the definition name with `%`/`_` escaped.

- [ ] **Step 4: Run** the test file — Expected: PASS. Also `pnpm exec vitest run packages/kernel/test/agents/agents.test.ts` stays green.

- [ ] **Step 5: Commit** `feat(kernel): platform paths for agent delete and owner transfer`

### Task 2: Connectors service platform paths and cross-org read

**Files:**
- Modify: `packages/kernel/src/tools/connectors.service.ts` (`update` ~1332, `remove` ~1460)
- Create: `packages/kernel/src/tools/admin-connectors.ts`
- Modify: the module that provides `ConnectorsService` (provide/export `AdminConnectors`)
- Test: `packages/kernel/test/tools/admin-connectors.test.ts`

**Interfaces:**
- Consumes: `WriteActor` from Task 1 (import the type from `agents.service.ts` or move it to a shared `identity` file if that reads better; one definition).
- Produces:
  - `ConnectorsService.setStatusAsPlatform(connectorId: string, status: "active" | "disabled", actor: WriteActor): Promise<void>`: org row lock, status update, audit `connector.updated` `{ status: { from, to }, via: "platform" }`.
  - `ConnectorsService.removeAsPlatform(connectorId: string, actor: WriteActor): Promise<void>`: org row lock, then `removeIn(orgId, id, actor.accountId, actor.tokenId, undefined, { via: "platform" })`.
  - `AdminConnectors.list(q: { orgId?: string; status?: "active" | "disabled"; q?: string; after?: string; limit: number }): Promise<{ connectors: AdminConnectorRow[]; next: string | null }>`
  - `AdminConnectors.get(connectorId: string): Promise<AdminConnectorDetail>`
  - `interface AdminConnectorRow { id; orgId; orgName; name; slug; connector: string; status; platformTemplateId: string | null; catalogItemId: string | null; toolCount: number; toolsSyncedAt: Date | null; createdBy: string; createdByName: string; createdAt: Date; updatedAt: Date }`
  - `interface AdminConnectorDetail extends AdminConnectorRow { endpoint: unknown /* endpointView */; auth: { type: string; ownership: "org" | "personal" | null }; tools: { name; title: string | null; status; defaultPolicy }[] }`

- [ ] **Step 1: Write the failing tests** in `admin-connectors.test.ts` (fixtures as in `test/tools/connectors.http.test.ts`): connectors in two orgs, one with an org credential `SENTINEL-ORG-SECRET` and one personal credential `SENTINEL-MEMBER-SECRET`, one deleted.
  - `lists live connectors of every org with tool counts`.
  - `filters by org, status and name; pages with next`.
  - `detail never contains a credential` → `JSON.stringify(detail)` contains neither sentinel, and has no `credential` key.
  - `detail shows auth type and ownership only` → `auth` deep-equals `{ type, ownership }`.
  - `setStatusAsPlatform disables for an account outside the org` → status `disabled`, audit `connector.updated` with `detail.via === "platform"`.
  - `removeAsPlatform soft-deletes and clears credentials` → `deleted_at` set, credentials gone, audit `connector.deleted` with `via`.
  - `get of a deleted connector is connector.not_found`.

- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/admin-connectors.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Endpoint through the existing `endpointView` (`tools/endpoint.ts:108`); `auth` built from the stored `auth` keeping `type` and `ownership` only. Lists ordered by `connectors.id`, join `orgs` (live) and `accounts` (creator name), tool count by subquery on `connector_tools`.

- [ ] **Step 4: Run** the test file and `test/tools/connectors.http.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(kernel): platform paths for connector status and delete`

### Task 3: Admin routes, schemas and Platform operations

**Files:**
- Create: `packages/kernel/src/admin/admin-agents.controller.ts`, `packages/kernel/src/admin/admin-connectors.controller.ts`, `packages/kernel/src/admin/admin-items.schemas.ts`
- Modify: `packages/kernel/src/admin/admin.controller.ts` (add `GET orgs/:orgId/members`), `admin/admin.schemas.ts` (its route entry), `admin/admin.module.ts`, `platform/route-schemas.ts` (add `ADMIN_ITEM_ROUTES`)
- Create: `packages/kernel/src/platform/ops/admin-items.ops.ts`; Modify: `platform/platform-ops.module.ts`
- Test: `packages/kernel/test/admin/admin-items.http.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 interfaces; `MembersService.list(orgId)`.
- Produces (HTTP, consumed by Tasks 5–6):
  - `GET /api/v1/admin/agents?orgId&q&after&limit` → `{ agents: AdminAgentRow[]; next }`
  - `GET /api/v1/admin/agents/:agentId` → `{ agent: AdminAgentDetail }`
  - `POST /api/v1/admin/agents/:agentId/owner` body `{ accountId }` → 200 `{ agent: AdminAgentDetail }`
  - `DELETE /api/v1/admin/agents/:agentId` → 204
  - `GET /api/v1/admin/connectors?orgId&status&q&after&limit` → `{ connectors: AdminConnectorRow[]; next }`
  - `GET /api/v1/admin/connectors/:connectorId` → `{ connector: AdminConnectorDetail }`
  - `PATCH /api/v1/admin/connectors/:connectorId` body `{ status }` (strict) → 200 `{ connector: AdminConnectorDetail }`
  - `DELETE /api/v1/admin/connectors/:connectorId` → 204
  - `GET /api/v1/admin/orgs/:orgId/members` → `{ members: Member[] }`
  - Platform operations (names): `admin.agents-list`, `admin.agent-get`, `admin.agent-transfer`, `admin.agent-delete`, `admin.connectors-list`, `admin.connector-get`, `admin.connector-set-status`, `admin.connector-delete`, `admin.org-members`; follow the naming the existing `admin.ops.ts` uses if it differs (check `check:platform-ops`).

- [ ] **Step 1: Write the failing HTTP tests** (harness as `test/admin/admin.http.test.ts`): super admin S (no membership), org owner O of org A.
  - `super admin lists and reads agents of an org they are not in`.
  - `org owner gets 403 on every admin agents and connectors route` (table over the 9 routes).
  - `transfer and delete through HTTP` → 200 / 204, audit rows with `via`.
  - `connector routes never return a credential` → every response body of the list, detail and patch contains neither sentinel.
  - `PATCH rejects keys other than status` → 400 `validation_failed`.
  - `the Platform operations return the same views` → call `admin.connector-get` through the Platform tool test seam and assert no sentinel.

- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/admin/admin-items.http.test.ts` — Expected: FAIL (404 routes).

- [ ] **Step 3: Implement** controllers with `@SuperAdmin()`, `createZodDto` DTOs from `admin-items.schemas.ts` (`AdminAgentListQuery`, `AdminConnectorListQuery`, `AgentIdParams`, `ConnectorIdParams`, `OwnerBody`, `ConnectorStatusBody`), explicit `@Inject` on every constructor param, `WriteActor` from `requireUser(principal)` + `patTokenId`. Operations call the same services (no new logic), mirroring the routes.

- [ ] **Step 4: Run** the test, `pnpm exec vitest run packages/kernel/test/platform`, `pnpm check:platform-ops`, `pnpm check:kernel-conventions` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(kernel): super admin routes for every org's agents and connectors`

### Task 4: Rename nav, move the template pages under 模板 tabs

**Files:**
- Move: `apps/web/src/app/(app)/admin/agent-templates/**` → `admin/agents/templates/**`; `admin/connector-templates/**` → `admin/connectors/templates/**`
- Modify: `apps/web/src/components/admin-nav.ts`, `components/shell/path.ts` (64–67), `lib/components.ts` (23–24), `lib/query/routes.ts` (345–380), `components/AdminComponents.tsx` (`useOwnerTabs` → secondary filter), `apps/web/messages/zh.json` / `en.json` (`admin.nav`, `adminComponents` titles/descriptions, new `adminItems.tabs`)
- Create: `apps/web/src/components/admin-item-tabs.ts` — `adminItemTabs(kind: "agents" | "connectors", active: "items" | "templates")` returning the `ListPage` header `tabs` / `activeTab` as links
- Test: `apps/web/test/admin-components.test.tsx`, `apps/web/test/admin.test.tsx` (update routes and labels)

**Interfaces:**
- Produces: `ADMIN_PAGES` ids `agents` (`/admin/agents`) and `connectors` (`/admin/connectors`); `adminItemTabs` used by Tasks 5–6; message keys `admin.nav.agents`, `admin.nav.connectors`, `adminItems.tabs.agents`, `adminItems.tabs.connectors`, `adminItems.tabs.templates`.

- [ ] **Step 1: Update tests first**: nav renders 智能体 and 连接器 (zh) linking to `/admin/agents` and `/admin/connectors`; `/admin/agents/templates` renders the template list with header tabs 智能体 / 模板 (模板 active) and the owner filter 全部 / 平台 / 组织创建; no link in the app points at `/admin/agent-templates` or `/admin/connector-templates` (grep assertion over `src`).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/admin-components.test.tsx apps/web/test/admin.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** the moves and renames; the owner filter becomes a secondary control inside the page (design component of the builder's choice, no styles); route entries renamed to the new patterns with the same queries.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): admin 智能体 and 连接器 nav with 模板 tabs`

### Task 5: Admin agents pages

**Files:**
- Create: `apps/web/src/app/(app)/admin/agents/{page,view}.tsx`, `admin/agents/[id]/{page,view}.tsx`, `apps/web/src/lib/query/admin-items.ts` (queries and mutations for both kinds)
- Modify: `lib/query/routes.ts`, `components/shell/path.ts`, messages (`adminItems.agents.*`)
- Test: `apps/web/test/admin-agents.test.tsx`

**Interfaces:**
- Consumes: Task 3 HTTP; `adminItemTabs` from Task 4; `adminOrgsQuery()`.
- Produces: `adminAgentsQuery(filter: { orgId?: string; q?: string })` (infinite or cursor-paged), `adminAgentQuery(id)`, `adminOrgMembersQuery(orgId)`, `useTransferAgent()`, `useDeleteAgent()`; `adminConnectorsQuery`, `adminConnectorQuery`, `useSetConnectorStatus`, `useDeleteConnector` defined here too for Task 6.

- [ ] **Step 1: Write failing tests** (`renderRouteWithCache` / `renderRouteEmptyCache`): list shows name, org, owner with 待重新指派 chip, visibility, from-template, updated; org filter and search change the query; row links to `/admin/agents/<id>`; detail shows instructions text and quick action labels; 转移负责人 dialog lists the org's members (anonymous guests excluded) and posts `{ accountId }`; 删除 confirm names org and owner, then navigates back to the list; empty state copy; `findNestedBoxes` finds none.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/admin-agents.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** with `ListPage` + `DataTable`, detail with the read template the agent template detail uses; mutations invalidate `adminAgentsQuery` and `adminAgentQuery(id)`.
- [ ] **Step 4: Run** the test, `pnpm check:web-ui`, `pnpm check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): admin agents list and detail`

### Task 6: Admin connectors pages

**Files:**
- Create: `apps/web/src/app/(app)/admin/connectors/{page,view}.tsx`, `admin/connectors/[id]/{page,view}.tsx`
- Modify: `lib/query/routes.ts`, `components/shell/path.ts`, messages (`adminItems.connectors.*`)
- Test: `apps/web/test/admin-connectors.test.tsx`

**Interfaces:**
- Consumes: Task 5's connector queries and mutations; `adminItemTabs`.

- [ ] **Step 1: Write failing tests**: list columns name, org, kind, from-template, status, tools, last sync, created by; filters org / status / search; detail shows endpoint view, auth type and ownership, tools with status and policy, and no credential section; 停用 / 启用 toggles via PATCH `{ status }`; 删除 confirm then back to list; empty state; `findNestedBoxes` none.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/admin-connectors.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** like Task 5.
- [ ] **Step 4: Run** the test, `pnpm check:web-ui`, `pnpm check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): admin connectors list and detail`

### Task 7: Changeset and verification

- [ ] **Step 1:** `pnpm changeset` for the published packages the diff touches (at least `@capybara-hq/capybara` for the image), summary "Super admin pages for every org's agents and connectors".
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm check && pnpm verify` — Expected: all pass. Visual baselines that change are left to the `visual-update` workflow (note it in the PR).
- [ ] **Step 3:** Update the spec's Status line to "implemented on `<branch>`" and list deviations, if any.
- [ ] **Step 4: Commit** `chore: changeset for admin agents and connectors`
