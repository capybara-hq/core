# Admin 智能体 and 连接器: the super admin manages every org's agents and connectors

- Date: 2026-11-10, written against `main` at `eaa0d51c1` (latest kernel migration 0108).
- Status: implemented on `feat/admin-agents-connectors`
  - As built, deviations:
    - zh copy says 转移所有者 / 所有者 (maintainer decision V forbids 负责人 in zh).
    - Platform operations act only on the conversation's own org (Platform tool spec §6.1); the
      transfer route is excluded human-only; tool writes audit `via: "platform"` plus operation /
      agentConversationId / agentRunId.
    - Agent detail connectors: the org's live connectors minus those whose every tool the agent
      switches off; skills: selected org skills plus the agent's own.
    - Ids are length-bounded text (400 / 414 / 404), not uuids.
- Related: plugin component management (`2026-11-05-plugin-component-management-design.md`: §9
  pages, §14 share gate and promotion, §15 agent templates), connector cards and member policies
  (`2026-11-09-connector-cards-and-member-policies-design.md`), the `Platform` tool
  (`check:platform-ops`), roles everywhere.
- Markers: **(decided, 2026-11-10)** is the maintainer's answer in the 2026-11-10 discussion;
  **(designer's call)** is decided here and may be overturned in review. Items without a marker
  restate current code or AGENTS.md rules.

## 1. Why

The admin console has 连接器模板 and 智能体模板: platform blueprints only (scope, disable,
versions). The super admin cannot see what the orgs actually run: which agents exist, who owns
them, which connectors are installed where. When an owner leaves or a connector must be stopped,
only that org's admins can act.

The maintainer wants both pages to become management views over the whole deployment
**(decided, 2026-11-10)**:

- 连接器模板 is renamed **连接器**; 智能体模板 is renamed **智能体**.
- Each page has two tabs: the live items of every org (连接器 / 智能体) and the templates (模板).
- The super admin sees every org's agents, private ones included; sensitive details may be hidden,
  and the necessary management is possible: transfer, delete. Promoting to a template stays the org's
  decision (§4.3).
- Instructions (the system prompt) and skills are visible to the super admin: they describe how
  work is done, not the data of a specific job **(decided, 2026-11-10)**.

## 2. Goals, non-goals, anti-goals

Goals

1. One admin page 智能体 with tabs 智能体 / 模板, one admin page 连接器 with tabs 连接器 / 模板.
2. Cross-org lists of live agents and live connectors, with org filter and name search.
3. A read-only agent detail and connector detail for the super admin.
4. Agent actions: transfer owner (within its org), delete.
5. Connector actions: disable / enable, delete.
6. Every new route has a `Platform` operation (or a reasoned exclusion) and every write is audited.

Non-goals

- Moving an agent or connector to another org (transfer is within the agent's org, **decided,
  2026-11-10**).
- Editing an agent's definition or a connector's endpoint from the admin console: org admins and
  owners keep doing that in the workspace.
- Disabling an agent: agents have no disabled state today (only soft delete); adding one would touch
  the runtime, channels, sub-agents and schedules. Delete covers the urgent case **(designer's
  call)**; a disabled state is a later spec if needed.
- Reading conversations, run trajectories, or any credential.
- Promoting an org's agent or connector to a template from the admin console (§4.3).

Anti-goals (a failure even if it works)

- Any credential, token or secret value reaching the super admin's browser or the `Platform` tool
  output (org or personal connector credentials, OAuth tokens, secret config).
- A super-admin action that bypasses the multi-replica and transaction rules because it skipped the
  service the org route uses (`softDeleteIn`, `removeIn`, the reassign path): the admin path reuses
  the same inner functions, only the authorization differs.
- An org-owned item leaking to other orgs by a path other than the share gate / an explicit scope
  set by the super admin.

## 3. Pages

### 3.1 Navigation and routes

Admin sidebar: `连接器模板` → **连接器** (`admin.nav`), `智能体模板` → **智能体**. Order unchanged.

| Route | Content |
|---|---|
| `/admin/connectors` | Tab 连接器 (default): every live connector of every org |
| `/admin/connectors/templates` | Tab 模板: today's connector template page, with its owner filter 全部 / 平台 / 组织创建 |
| `/admin/connectors/<id>` | Connector detail (read-only + actions) |
| `/admin/connectors/templates/<id>` | Today's connector template detail |
| `/admin/agents` | Tab 智能体 (default): every live agent of every org |
| `/admin/agents/templates` | Tab 模板: today's agent template page with its owner filter |
| `/admin/agents/<id>` | Agent detail (read-only + actions) |
| `/admin/agents/templates/<id>` | Today's agent template detail |

The tabs are routes, not local state, so a link can open a tab **(designer's call)**. The old routes
`/admin/connector-templates` and `/admin/agent-templates` are removed without redirects (pre-0.1.0,
no compatibility layers); every in-app link that points at them (admin inbox, `lib/components.ts`,
`SaveAsTemplateDialog`, …) moves to the new routes. The existing owner filter (全部 / 平台 /
组织创建) stays inside the 模板 tab as a secondary filter; how it is rendered (segmented control,
filter chip) is the builder's, within the design system.

zh copy: 智能体, 模板, 连接器; en: Agents, Templates, Connectors. Page descriptions are rewritten
to say the page manages every org's items and their templates.

### 3.2 Agents list (tab 智能体)

Columns: name (avatar + name), org, owner (name; a 待重新指派 chip when `needs_reassignment`),
visibility (私有 / 组织 / 指定成员), created from template (name, when set), updated. Filters: org
(select over all orgs), search on name. Cursor pagination like `GET /api/v1/admin/accounts`
(`after`, `limit` 1–200, default 50). Soft-deleted agents are not listed. Row → detail.

### 3.3 Agent detail

Read-only sections built from the same data the workspace agent page shows: profile (avatar,
description), org, owner, visibility and members, model and effort, instructions (full text,
**decided**), skills, connectors (names only), sub-agents, created-from template, versions count
and updated time. Not shown: conversations, runs, credentials, quick-action contents beyond their
labels **(designer's call)**.

Actions (header):

- **转移所有者** (zh): pick a member of the agent's org (not an anonymous guest); same result as the org
  route (`agent.owner_changed`, clears `needs_reassignment`, retargets setup requests).
- **删除**: confirm dialog naming the org and owner; same effect as the org delete.

### 3.4 Connectors list (tab 连接器)

Columns: name, org, kind (the connector extension, e.g. MCP / OpenAPI), from template (when
`platform_template_id` or `catalog_item_id` is set), status (启用 / 停用), tools count, last tool
sync, created by. Filters: org, status, search on name. Same pagination. Soft-deleted are not
listed.

### 3.5 Connector detail

Read-only: org, kind, endpoint through `endpointView` / `publicEndpoint` (large `*Text` fields show
size and sha256 only, as today), auth type and ownership (org / per-member) **without any credential
value or whether a member has one** **(designer's call)**, tools with their status and default
policy, from-template, created by, timestamps.

Actions: **停用 / 启用** (the same `status` patch the org uses), **删除**.

## 4. Kernel

### 4.1 Routes

New super-admin controllers (`@SuperAdmin()` at class level), schemas exported for the parity test:

| Route | Does |
|---|---|
| `GET /api/v1/admin/agents?orgId&q&after&limit` | cross-org agent list (§3.2) |
| `GET /api/v1/admin/agents/:agentId` | agent detail (§3.3) |
| `POST /api/v1/admin/agents/:agentId/owner` | `{ accountId }` transfer |
| `DELETE /api/v1/admin/agents/:agentId` | delete |
| `GET /api/v1/admin/connectors?orgId&status&q&after&limit` | cross-org connector list |
| `GET /api/v1/admin/connectors/:connectorId` | connector detail |
| `PATCH /api/v1/admin/connectors/:connectorId` | `{ status }` only |
| `DELETE /api/v1/admin/connectors/:connectorId` | delete |

Ids are global, so routes carry no org id; the service loads the row and its org. The transfer
member picker reuses the existing super-admin read of an org's members if there is one, otherwise
the builder adds `GET /api/v1/admin/orgs/:orgId/members` under the same rules.

### 4.2 Authorization and reuse

- The super admin need not be a member of the org. The org services authorize inside the same
  call that locks: `softDeleteIn` calls `lockForWrite` (`agents.service.ts:681`, which runs
  `lockAndAuthorize(..., "agents.create")` plus the owner-or-admin check), `reassignOwner` runs
  `orgLock.lockAndAuthorize(..., "agents.manage")`, the connector update requires
  `connectors.manage`. The builder splits each of agent delete, agent reassign and connector status
  patch into (a) lock + authorize and (b) the work on a locked org, and the admin path does lock +
  super-admin check, then (b). Connector `removeIn` (`connectors.service.ts:1476`) is already (b):
  it expects the caller to hold the org row lock, so the admin path takes that lock first.
- Every write keeps its audit event (`agent.owner_changed`, `agent.deleted`, `connector.updated`,
  `connector.deleted`, …) with the super admin as actor and `detail.via = "platform"`
  **(designer's call)**, so an org's audit log shows that the platform acted.
- Org admins are not notified beyond the audit log in this spec **(designer's call)**.

### 4.3 No promotion from the admin console

The super admin does not turn an org's agent or connector into a template **(decided,
2026-11-10)**: promoting copies an org's instructions, quick actions and internal endpoint URLs to
other orgs, so it stays the org's decision, through the existing path (the org's 另存为模板, then
可共享 and the share gate of the component management spec §14). The super admin's part stays what
it is today: scope, disable and versions of templates in the 模板 tab.

Recorded for later promotion work (not built here): when an agent becomes a template that reaches
other orgs, org-owned skills it uses are listed as not carried over (`omitted[]`), not promoted with
it **(decided, 2026-11-10)**. An org-initiated path to turn a connector into a template does not
exist yet and is a later spec.

### 4.4 Data

No migration: every column the lists and actions need exists.

### 4.5 Platform tool

Each route gets an operation in `platform/ops` (`admin-agents.ops.ts`, `admin-connectors.ops.ts`, or
added to the existing files) built from the routes' exported schemas. Operations return the same
redacted views as the HTTP routes, so no credential can reach the model.

## 5. Web

- `admin-nav.ts`: ids `connectors` and `agents`; labels from `admin.nav.connectors` /
  `admin.nav.agents`.
- Pages follow `writing-web-ui`: thin `page.tsx` + client `view.tsx`; lists are `ListPage` +
  `DataTable`; reads `defineQuery` with entries in `lib/query/routes.ts`; writes `useAppMutation`
  invalidating the lists and the detail; tabs in the `ListPage` header as links.
- The 模板 tabs reuse today's views (`ComponentsTable`, `ComponentCard`, `useOwnerTabs` turned into
  the secondary filter) moved under the new routes.
- Empty states: 还没有组织创建智能体 / 还没有组织安装连接器 (final copy is the builder's, through
  i18n zh and en, `check:i18n` vocabulary).
- Screenshot baselines change; they are re-rendered by `visual-update`.

## 6. Testing

- Kernel: each admin route with a super admin who is not a member of the org; a non-super-admin gets
  403; the list returns private agents of several orgs; no response (HTTP or Platform op) of the
  connector routes contains a credential written in the test (a sentinel value search); transfer to
  a non-member → `member.not_found`; audit rows carry `via: "platform"`.
- Web: route render tests for the four list/detail pages with the cache helpers; jsdom
  `findNestedBoxes`.
- `pnpm check` (platform-ops parity, i18n, web-ui, kernel-conventions).

## 7. Left to the builder

Exact column widths and table vs card for the agents list; the secondary filter's component; how
the transfer picker searches members; event names where an existing one fits; splitting into
PRs (suggested: kernel routes, then web).
