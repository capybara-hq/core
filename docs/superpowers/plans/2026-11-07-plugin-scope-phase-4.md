# Plugin scope phase 4 — agent templates — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with
> wave-planned-subagent-development (main's `.agents/skills/wave-planned-subagent-development`).

**Goal:** members create agents from templates (pending connectors, provenance only), org admins save
agents as org templates and share them, and the workspace shows agents and templates on one page of
cards (the admin template list too).

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` §15 (15.1 decided,
P4-1…P4-18), with §8, §5 rule 10, §13.5/§13.6 and §14 (P3-*) still binding.

## Global constraints

- Branch `docs/plugin-component-management`, worktree `.claude/worktrees/docs-plugin-component-management`.
  Local commits only (`git -c user.name=Grant -c user.email=284885069@qq.com commit`), Conventional
  Commits, body ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only your paths;
  never `git stash`; a shared file with others' hunks is committed from a temporary index.
- A dev web + kernel run from this worktree: don't start/stop them; no `next build` / Playwright here.
- Kernel: AGENTS.md "Kernel" conventions (`pnpm check:kernel-conventions`), multi-replica rules
  (writes in `@Transactional`, Redis/enqueue after commit), error codes registered with copy in both
  locales, DTOs via `createZodDto`.
- Migrations: next number `0085`; expand-only, `IF NOT EXISTS`; plain SQL (writing-migrations skill).
- SDK: public API change → `pnpm gen:sdk-api`, `pnpm gen:package-schemas`, a changeset bumping
  `@capybara-hq/plugin-sdk` (pre mode `rc`).
- UI: pages = templates + design components; styles only in packages/design (spec.md, reference
  block, accepted.ts, the hand-written reference source); copy zh + en (i18n checks: no 企业, no Latin
  `agent` in zh); the one-box rule (acceptance AB) and the head rhythm (S) apply.
- Roles everywhere: no action shown that the role can't do; designed read-only states.
- Checks per task: lint, typecheck, `pnpm check`, vitest of the touched packages (from the repo root);
  kernel tests use the running PG/Redis.

## Interfaces fixed by this plan

- SDK `AgentTemplate` (P4-1): `selectedSkills?: string[]`; `connectors?: ({ template: string; tools?:
  string[] } | { needs: { protocol: "mcp" | "openapi"; endpoint: string; tools: string[]; label: string
  } })[]`; `subagents?: { general?: boolean; types?: string[]; inline?: InlineTemplate[] }`;
  `modelRef?: string` (`provider/model`); `quickActions?: QuickAction[]`; `instructionFiles?:
  { name: string; content: string }[]`.
- Migration `0085_agent_templates_phase4.sql`: `agents.created_from_template_id text`,
  `created_from_template_version int`, `created_from_template_name text`; `catalog_requests`: kind
  `connector_setup` allowed, `agent_id text NULL` (FK agents ON DELETE CASCADE), `pending_keys
  jsonb NULL`.
- Agent definition: `pendingConnectors?: { key: string; label: string; source: { template: string } |
  { needs: {…} }; tools?: string[] }[]` (model-invisible).
- Kernel module `agents/from-template.ts`: `planFromTemplate(db, orgId, template, opts) →
  { definition, items: { kind, name, state: "carried" | "pending" | "unavailable", reason? }[],
  dropped: string[], hash }` (pure resolution over read snapshots; used by preview and create).
- Routes (all `/api/v1/orgs/:orgId/…`):
  - `POST agents/from-template/preview { templateId }` → `{ items, model, previewHash }` (`agents.create`)
  - `POST agents/from-template { templateId, name, visibility?, members?, model?, previewHash }` →
    201 `{ agent }`; 403 `agent.visibility_forbidden`; 409 `agent.template_preview_stale`
  - `POST agents/:agentId/pending-connectors/:key/bind { connectorId }` (agent editors)
  - `POST connector-templates/:templateId/connectors { name?, config }` (`connectors.manage`)
  - `POST agents/:agentId/save-as-template { name, description }` → 201 `{ template }`
    (`agents.manage`); 409 `agent_template.name_taken`
  - `GET agent-templates/:id` (detail incl. definition; `agents.create` member+ for usable ones),
    `PUT agent-templates/:id { definition, expectedVersion }` (owner-org admins; new version),
    `DELETE agent-templates/:id` (owner-org admins; P3 owner-gone rules)
  - `PUT agent-templates/:id/shareable` accepts org templates (P4-13)
  - `connector_setup` requests appear in `GET …/inbox` / `GET …/catalog/requests` for org admins and
    are decided with the existing decide route (`reject { reason }`; approval = binding).
- Web: `/agents?tab=templates`; `/agents/templates/<id>`; `/agent-templates*` redirect; design
  `CardGrid`, `ObjectCard` (props: `avatar`, `title`, `description`, `meta`, `primary`, `menu`,
  `href`, `loading`), plus `CardGrid` loading/empty shapes.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 SDK template fields | — | packages/plugin-sdk (agent-template.ts, schemas, api report), changeset, kernel parse callers compile | normal | 1 | batched |
| 2 Migration 0085 + types | — | kernel migrations, kernel-schema.ts, migration test | normal | 1 | batched |
| 3 Create from template (kernel) | 1, 2 | new agents/from-template.ts, agents.controller/service (from-template routes), definition.ts (pendingConnectors), provenance | high | 2 | own, most capable |
| 4 Org templates (kernel) | 1, 2 | agents/templates.ts, templates.controller.ts, owned-items (P3-46 lift), save-as-template, get/put/delete | high | 2 | own, most capable |
| 5 Design CardGrid | AB wave 1 done | packages/design (component, CSS, spec, reference, accepted.ts) | normal | 2 | batched |
| 6 Pending connectors (kernel) | 3 | bind route, connector-from-template route, connector_setup requests + inbox | high | 3 | own, most capable |
| 7 Web agents page + admin cards | 4, 5 | apps/web agents list/tabs, templates tab, redirects, nav, admin agent-templates | normal | 3 | batched |
| 8 Web create dialog + agent page | 3, 6, 7 | 用它创建 dialog + preview, provenance, 待配置 notice + bind/configure/request, inbox item | normal | 4 | batched |
| 9 Web template page + save-as | 4, 7 | /agents/templates/[id] (read + editor sections), 另存为模板 dialog, 可共享/删除 | normal | 4 | batched |
| 10 e2e + docs | 1–9 | e2e spec (create from template, pending connector, save-as), skills notes (writing-plugins, writing-tools, writing-kernel-api roles table), AGENTS.md one line, changesets | normal | 5 | final review |

## Tasks

### Task 1 — SDK template fields (P4-1, P4-2)
- Extend `AgentTemplate` and `parseAgentTemplate` with the fields above and their limits (P4-1);
  unknown keys still ignored; existing fixtures parse unchanged. Regenerate schemas and the API report;
  changeset (SDK minor in rc). Kernel compiles; `definition.ts` (sub-agent dispatch) also resolves
  `selectedSkills` names.
- Tests: parser accepts each new field, rejects over-limit and malformed entries with field paths,
  old files unchanged; dispatch name resolution includes `selectedSkills`.

### Task 2 — migration 0085 (P4-7, P4-8)
- The columns above; `catalog_requests` kind check extended to `connector_setup` (named constraint
  replaced idempotently), `agent_id`, `pending_keys`. Kysely types.
- Tests: migrate to 0084, seed, migrate to 0085: columns exist, old rows untouched, re-run is a no-op.

### Task 3 — create from template, kernel (P4-3…P4-6, P4-8)
- `planFromTemplate` per P4-5 (model per P4-4); preview and create routes; create writes the agent
  (version 1 with `pendingConnectors`), provenance columns, and, when the creator lacks
  `connectors.manage` and pending connectors exist, hands over to Task 6's request writer (Task 3 calls
  an interface `PendingConnectorRequests.openFor(agent)` that Task 6 implements; Task 3 ships a no-op
  provider wired in the module and a test seam).
- `pendingConnectors` in the definition schema; model-invisible (tools built only from `tools`).
- Tests: each P4-5 bucket (carried / pending / unavailable) for tools, skills, connectors (0 / 1 / many
  connectors from the template), sub-agents (types found / missing, inline skills added); model
  resolution order; member visibility 403; admin org-visible; preview hash stale 409; a template from
  another org (shared, on) works; a template off in the org 404; provenance set and shown in GET.

### Task 4 — org templates, kernel (P4-9…P4-13)
- `save-as-template` per P4-10/P4-11 (endpoint sanitising, no credentials); org row with
  `plugin_name` null; rule-10 name check; `putTemplateVersionIn` optional `catalogItemId`; GET/PUT/DELETE
  routes with owner-org admin checks; shareable lifted for org templates (P3-46), promotion unchanged.
- Tests: save-as maps every field (template-made connector → `{template}`, custom → `{needs}` without
  userinfo/query), org agents in the roster left out; name clash 409 naming the owner; PUT writes a new
  version with `expectedVersion`; DELETE of a shared used template → platform-owned (P3 rule); members
  403; shareable on an org template works and promotes on show.

### Task 5 — design CardGrid (P4-15)
- `CardGrid` + `ObjectCard` per the interface, tokens for min width and gaps, loading and empty
  shapes, roving keyboard focus, one box per card, no box around the grid; spec.md (component +
  templates using it: ListPage `variant="cards"` or a ListPage slot), reference block, accepted.ts,
  fidelity size rows, the hand-written reference source.
- Tests: rendering, keyboard, loading/empty, the head-rhythm and one-box guards pass.

### Task 6 — pending connectors, kernel (P4-6, P4-7)
- Bind route (agent editors) → new agent version adding the connector's tools and removing the entry;
  `POST connector-templates/:templateId/connectors` (one more connector from a platform connector
  template on in the org; refused when the template is off); `connector_setup` request writer
  (implements Task 3's interface), listing for org admins, reject with reason, close on last bind,
  inbox notices to the owner; 重新申请 route after a rejection.
- Tests: bind adds tools and removes the key; wrong connector (other template / other org) refused;
  request created only when the creator lacks `connectors.manage`; one request per agent; closes when
  all keys resolved; reject notifies the owner; customConnectors deny blocks a `needs` connector
  creation path (existing) and the request still works.

### Task 7 — web agents page + admin cards (P4-14, P4-16, P4-17)
- `/agents` with tabs 智能体 / 模板 on `CardGrid`; toolbar filter 全部 / 我的 / 共享; template cards
  with 用它创建 (opens Task 8's dialog; until then a link to the template page) and ⋯ per P4-16;
  remove 智能体模板 from 更多; redirects from `/agent-templates*`; admin `/admin/agent-templates` on
  cards with its tabs and actions.
- Tests: tabs and filter, cards per role (actions hidden when not allowed), redirects, nav, admin
  cards; loading/empty states.

### Task 8 — web create dialog + agent page (P4-5, P4-7, P4-8, P4-18)
- 用它创建 dialog with preview groups and counts, model preselect, visibility for admins only;
  create lands on the agent; provenance line in the agent basics; 待配置 notice in Tools with, per
  role: create from template / pick an existing connector / custom form prefilled, or the request
  state (已申请 · 等待组织管理员, 重新申请 after a rejection); org inbox shows `connector_setup` items
  with a configure action.
- Tests: preview rendering of each state; member vs admin visibility field; stale-preview retry;
  provenance link; notice actions per role; inbox item and decisions.

### Task 9 — web template page + 另存为模板 (P4-9…P4-14)
- `/agents/templates/<id>`: read view (members) with 用它创建; editor (owner-org admins) reusing the
  agent page sections (basics, prompt, model with tier + optional model, tools, skills, connectors,
  sub-agents), each save a new version; ⋯ 可共享 / 删除; 另存为模板 dialog on the agent page ⋯ (org
  admins) listing what is left out (org agents).
- Tests: read vs edit per role, save writes a version, delete confirm, shareable toggle, save-as dialog.

### Task 10 — e2e and docs
- e2e: create from a template (pending connector shown, admin binds it, tools appear), save an agent
  as a template and create from it; skill notes; AGENTS.md one line under "Plugins and the catalog";
  changesets (kernel, web).

## Review focus
1. A template from a plugin turned off in the org between preview and create: 409 stale, never a broken
   agent.
2. Credentials never leave a connector in 另存为模板 (endpoint userinfo, query tokens, headers, OAuth).
3. A member can't create an org-visible agent through any route; the dialog never shows the option.
4. Deleting a connector bound from a pending entry: the agent behaves like any agent whose connector is
   deleted (no resurrected pending entry); deleting the agent closes its open request.
5. Bare-name templates vs plugin types in `findType` and rule 10 across orgs after sharing.
