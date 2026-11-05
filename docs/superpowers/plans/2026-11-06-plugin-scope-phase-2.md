# Plugin scope, phase 2: platform components, component scope and updates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** platform skills, connector templates and agent templates are stored once for the
deployment, each with its own scope and per-org switch; a plugin update previews and applies per
component; components can be updated on their own; plus the phase-1 deferrals (platform inbox,
member-readable 扩展 page, prerelease folding, a `deprecated` marketplace marker).

**Architecture:** new `platform_*` tables hold platform components (files under `deployment/platform/`);
an org's usable set is its own components ∪ the platform components its scope and switches allow.
Existing org copies are not rewritten: they get a link to their platform component and resolve to it
(keeping the ids agents and conversations reference), unless pinned to their own version. Org
installs keep carrying extensions and connectors (credentials are per org). Plugin updates move from
per org to the platform, with a per-component preview.

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` §5 (rules 2, 5,
8, 10, 11), §6, §7, §13.5. Research notes:
`.superpowers/sdd/2026-11-06-followups-and-rename/phase2-research-notes.md` (file:line map).
Written and executed without maintainer review (authorized 2026-11-06); decisions not in the spec are
marked **(ruling)** here and recorded in the ledger.

## Global Constraints

- Everything local: no push, PR, publish. Next migration number `0080`.
- Replay invariant (AGENTS.md, `replay-evals`): no rewrite of agent definitions or logged events; ids
  referenced by `agent_versions.definition`, `skills_catalog`, `user_message.skill`,
  `subagent_started` (template id, definition) and `conversation_queue.skill` keep resolving. Run the
  zero-drift fixture tests (`packages/kernel/test/evals/reconstruct.test.ts`, `rename-compat.test.ts`
  if present) before and after touching request building or the skills catalog.
- Model-visible names do not change: bare skill names and `<plugin>:<name>`; template types
  `<plugin>:<name>`; a template without a plugin is the bare `<name>` (spec §8).
- Shared content never lives under `kernel/<orgId>/` (orgs are purged by prefix): platform files go
  under `deployment/platform/{skills,agent-templates}/<id>/<version>/`.
- Owner value names: `platform` / org id; UI 平台 / Platform; roles per §13.4b; 智能体 in zh.
- Multi-replica discipline, kernel conventions, web rules, migrations rules of AGENTS.md apply.
- Changesets: kernel minor, web (fixed with capybara) minor, plugin-sdk minor for the marketplace
  `deprecated` field, plugin-tools as touched.

## Rulings made while planning

- **(ruling A2)** New `platform_*` tables rather than nullable `org_id` on existing tables: avoids the
  per-org unique indexes, `ON DELETE CASCADE`, org-relative object prefixes and every org-filtered
  reader at once. Cost: the resolver reads two sources.
- **(ruling B2)** Org copies link to the platform component (`platform_skill_id`, `pinned_version`):
  a linked copy without a pin resolves to the platform component's current version under its own id
  (one logged "Updated skills" notice, no Removed/New, no definition rewrite); with a pin it keeps
  serving its own stored version until a plugin or component update preview clears the pin
  (spec §6 migration rule "keeps that version as an individually updated component").
- **(ruling C2)** Component scope columns live on the platform rows (`scope_mode` = `follow` | `own`,
  plus the phase-1 scope fields); org lists and switches use generic tables keyed by
  `(kind, component_id)`.
- **(ruling D2)** Snapshot `source` for platform skills is `platform:<object prefix>`; `findSkillVersion`
  reads platform files from `deployment/` for that prefix form.
- **(ruling E2)** Connectors stay per org; a connector made from a platform template stores
  `platform_template_id`; template updates fan out to connectors by that column (the install ledger
  link is kept for older rows and migrated where known).
- **(ruling F2)** The per-org plugin upgrade routes are retired for platform plugins (one version per
  deployment); the org `PluginUpgradeDialog` goes away.

## Review Focus

1. An existing conversation's next run after the migration: same skill ids, at most one "Updated
   skills" notice, no Removed/New, pinned skills still render; a sub-agent resumed after the migration
   finds its template by id (Task 3, Task 4, Task 5).
2. An org that had changed a plugin skill by uploading a same-name zip keeps its version; on a name
   clash with the platform skill its copy is renamed with a suffix and the org admins get an inbox
   notice; agents referencing it keep working (Task 5).
3. Turning a component off in one org removes it from that org's catalog, pickers and roster at the
   next run and nowhere else; `all`-scoped components cannot be switched off (Task 6, Task 9).
4. A plugin update preview marks components updated on their own and components with their own
   scope; confirming moves them and clears pins; connectors made from changed templates get the
   change in every org that has one (Task 7).
5. Deleting (soft) an org never removes platform files (Task 1, Task 5).

---

### Task 1: Schema for platform components

**Files:** create `packages/kernel/src/migrations/0080_platform_components.sql`; modify
`packages/kernel/src/db/kernel-schema.ts`; test `packages/kernel/test/catalog/platform-schema-migration.test.ts`.

**Interfaces — produces:**
- `platform_skills (id text pk, catalog_item_id uuid null → catalog_items set null, plugin_name text
  null, name, description, description_zh null, current_version int, scope_mode text check
  (follow|own) default 'follow', scope text check (all|optional|named) default 'optional', disabled
  bool default false, shown_to_others bool default true, scope_version int default 0, created_at,
  updated_at, deleted_at)`; unique live `(coalesce(plugin_name,''), name)`.
- `platform_skill_versions (skill_id → platform_skills cascade, version int, manifest jsonb,
  object_prefix text, catalog_version text null, source_format, suggest_pinned bool, updated_on_own
  bool default false, created_by text null, created_at; pk (skill_id, version))`.
- `platform_agent_templates` / `platform_agent_template_versions` (same pattern; `definition jsonb`;
  unique live `(coalesce(plugin_name,''), name)`).
- `platform_connector_templates (id text pk, catalog_item_id uuid → catalog_items cascade, template_id
  text, current_version text, file jsonb, scope_mode/scope/disabled/shown_to_others/scope_version as
  above, created_at, updated_at, deleted_at)`; unique live `(catalog_item_id, template_id)`.
- `component_scope_orgs (kind text check (skill|agent_template|connector_template), component_id
  text, org_id text → orgs cascade, pk)`, `component_org_switches (kind, component_id, org_id, enabled,
  updated_by, updated_at, pk)`.
- Links: `skills.platform_skill_id text null → platform_skills set null`, `skills.pinned_version int
  null`; `agent_templates.platform_template_id text null → platform_agent_templates set null`,
  `agent_templates.pinned_version int null`, `agent_templates.plugin_name` drops NOT NULL (spec §8);
  `connectors.platform_template_id text null → platform_connector_templates set null`.
- Kysely types for all of the above.

- [ ] Test (RED first): migrate to 0079, seed a skill and template, migrate to 0080: tables exist,
  links null, `agent_templates.plugin_name` nullable, re-run is a no-op.
- [ ] Migration + types; `pnpm check:migrations`; commit `feat(kernel): platform component tables`.

### Task 2: Platform components written at import and update

**Files:** `packages/kernel/src/catalog/platform-components.ts` (new `PlatformComponents` provider),
`plugin-import.ts` (confirm), `extensions/bootstrap.ts` (through confirm), tests
`packages/kernel/test/catalog/platform-components.test.ts`.

**Interfaces — produces:**
`PlatformComponents.syncFromVersion(itemId: string, version: string, opts: { initial: boolean }):
Promise<{ skills: ChangedRef[]; agentTemplates: ChangedRef[]; connectorTemplates: ChangedRef[] }>`
— creates or updates platform rows for every component of that catalog version (files copied from
the catalog prefix to `deployment/platform/...`), new version only when content changed (skills by
`dirDigest`, templates by canonical JSON); `initial` = first import creates rows with
`scope_mode: follow`. Called by import confirm when the item is created (and by Task 7 on update).
`ChangedRef = { kind, id, name, from: number | null, to: number }`.

- [ ] Tests: importing a plugin with 2 skills, 1 agent template, 1 connector template creates platform
  rows with files readable from `deployment/platform/…`; importing a new version does not change rows
  (updates happen through Task 7 only); a plugin without components creates nothing.
- [ ] Implement; commit `feat(kernel): platform components from a plugin version`.

### Task 3: Skills resolve from platform components

**Files:** `skills/catalog.ts` (`resolveSkills`, `SkillsCatalogService.record`, pinned bodies),
`tools/builtins/skill-load.ts` (`findEntry`, `findSkillVersion`), `skills/invoke.ts`,
`runtime/subagents/definition.ts` (`pinnedFor`), `skills/skills.service.ts` (`assertOrgSkills`,
`assertPinnedSkills`, list/get for the org library), new `skills/usable.ts`; tests in
`packages/kernel/test/skills/platform-skills.test.ts` plus the evals zero-drift fixtures.

**Interfaces — produces:**
- `usableSkills(db, orgId): Promise<UsableSkill[]>` — the org's own live skills (`scope = 'org'`,
  unlinked or pinned) ∪ platform skills whose scope / list / component switch / plugin switch (when
  `scope_mode = follow`, the plugin's org state from phase 1) make them on in the org, minus disabled;
  `UsableSkill = { id, name, description, version, source, plugin: string | null, origin: 'org' |
  'platform', platformSkillId?: string }`.
- Linked copies (ruling B2) resolve to their platform skill's current version under the copy's id;
  pinned copies serve their own version.
- Agent definitions may reference platform skill ids directly (new selections) and copy ids (old).
- `source` for platform files: `platform:<object_prefix>` (ruling D2); file reads branch on it.
- Rule 10: two usable skills with the same name in one org are refused at the action that would
  create the clash (Task 6/9 switches, Task 5 migration renames); the resolver itself prefers the org's
  own skill if a clash slips through, and logs a warning.

- [ ] Tests (RED first): a platform skill on in the org appears in the catalog snapshot with
  `source: platform:…`, `Skill` loads its body; off → absent; a linked copy referenced by an old agent
  resolves to the platform version under the copy id (snapshot id unchanged, version changed → one
  "Updated skills" line); pinned copy keeps its version; `<plugin>:<name>` still resolves; save checks
  accept platform ids; zero-drift fixture tests unchanged.
- [ ] Implement; run the evals tests before and after; commit `feat(kernel): skills from platform
  components`.

### Task 4: Agent templates resolve from platform components

**Files:** `agents/templates.ts`, `runtime/subagents/roster.ts`, `runtime/subagents/definition.ts`,
`runtime/subagents/dispatch.ts` (resume by id), `agents/agents.service.ts` (`assertSubagents`),
`agents/templates.controller.ts` (list), tests `packages/kernel/test/subagents/platform-templates.test.ts`.

**Interfaces — produces:** `usableTemplates(db, orgId)` analogous to Task 3 (type `<plugin>:<name>` or
bare `<name>`); linked org template rows resolve to the platform template's current version under
their own id unless pinned; dispatch/resume by the id recorded in `subagent_started.template.id` works
for both kinds; `GET orgs/:orgId/agent-templates` lists the usable set with `origin`.

- [ ] Tests: platform template on → in the roster; off → not; a resumed child whose
  `subagent_started.template.id` is an org copy id finds it after linking; the frozen definition is
  used, never re-resolved for a running child.
- [ ] Implement; commit `feat(kernel): agent templates from platform components`.

### Task 5: Migrate org copies to platform components

**Files:** `packages/kernel/src/catalog/platform-migration.ts` (a one-shot `@LockedInterval runOnStart`
worker job `platform-components-migrate`, idempotent, recorded in a `platform_migration_runs` row or
`bootstrap_runs`-like table created in 0080 if needed — builder's call, ledgered), tests
`packages/kernel/test/catalog/platform-migration.test.ts`.

Rules (spec §6 migration + §13.5):
1. For each live catalog item with components: `syncFromVersion(item, item.latest_version, initial)`
   creates the platform rows.
2. For each org skill with provenance (`catalog_item_id` set on the skill and its current version):
   link to the platform skill of (item, name); if its current version's content differs from the
   platform version → `pinned_version` = its version (individually updated, previewed at the next
   update).
3. Org skills whose provenance was reset (`catalog_item_id` null) but whose name equals a platform
   skill offered to that org stay the org's own; rename to `<name>-<suffix>` (`-org`, then `-org-2`…)
   only if the org would otherwise see two skills with that name; inbox notice to the org admins
   (new inbox item kind `skill_renamed`); the platform skill's component switch for that org = off.
4. Same for agent templates (link by plugin + name; changed content → pin).
5. Connectors: set `platform_template_id` from the install ledger `template_id` where known.
6. Plugin switches already exist (phase 1); component scope = `follow` everywhere.

- [ ] Tests: each rule with seeded org copies (same version, other version, reset provenance with and
  without clash, templates, connectors); re-run is a no-op; two replicas → one run.
- [ ] Implement; commit `feat(kernel): migrate org copies to platform components`.

### Task 6: Installs stop copying; component scope and switches

**Files:** `catalog/plugin-install.ts` (skills / agent template steps removed for platform items;
connectors from platform templates set `platform_template_id`), `catalog/scope-sync.ts`,
new `catalog/component-scope.service.ts` + controller routes, `catalog/catalog-scope.service.ts`
(plugin scope change lists components with their own scope), org routes; tests.

**Interfaces — produces:**
```
POST /api/v1/admin/components/:kind/:id/scope/preview  { scope, orgs? } | { disabled } | { follow: true }
PUT  /api/v1/admin/components/:kind/:id/scope           { scope, orgs?, scopeHash } | { follow: true, scopeHash }
PUT  /api/v1/admin/components/:kind/:id/disabled        { disabled, scopeHash? }
PUT  /api/v1/admin/components/:kind/:id/shown           { shownToOthers }
PUT  /api/v1/orgs/:orgId/components/:kind/:id/switch    { enabled, confirm? }   (org admin; 409 plugin.scope_locked for all)
GET  /api/v1/admin/components?kind=skill|agent_template|connector_template      (global list: from, owner, scope, version, orgs)
```
Preview rules as phase 1 (rule 8 impact incl. agents using the component; `scopeHash`); a plugin
scope change applies to components with `scope_mode = follow` and lists those with `own` as replaced
(spec §5 rule 2) and sets them back to `follow`.

- [ ] Tests: per-component switch off in one org removes the skill from that org's usable set only;
  `all` component cannot be switched off; plugin scope change overrides `own` components and the
  preview lists them; installs no longer write org skill / template rows for platform items.
- [ ] Implement; commit `feat(kernel): component scope and org switches`.

### Task 7: Platform plugin update with a per-component preview

**Files:** `catalog/plugin-upgrade.ts` (reworked to a platform-level diff), new admin routes,
`tools/connectors.service.ts` (`applyTemplateIn` fan-out by `platform_template_id`), retire the org
upgrade routes for platform plugins (ruling F2); tests.

**Interfaces — produces:**
```
POST /api/v1/admin/catalog/items/:id/update/preview { version } → { components: [{ kind, id, name,
     change: added|removed|upgrade|downgrade|same, from, to, updatedOnOwn, ownScope, pinnedOrgs[] }],
     extension: {from,to}|null, connectorOrgs: [{ orgId, connectors }], diffHash }
PUT  /api/v1/admin/catalog/items/:id/update { version, diffHash }
```
Confirm: upgrades the extension (deployment), writes platform component versions (`syncFromVersion`),
clears pins of linked copies, fans connector template changes out to every org connector with that
`platform_template_id` (credentials untouched unless the auth method changed → those orgs show
需要配置), removed components follow rule 8 (agents using them lose them; connectors stay as orgs').
Journaled and undoable like today's upgrade.

- [ ] Tests: preview marks a component updated on its own and one with its own scope; confirm moves
  both, clears a pinned copy, updates connectors in two orgs; a failure mid-way undoes.
- [ ] Implement; commit `feat(kernel): platform plugin updates with a per-component preview`.

### Task 8: Component updated on its own

**Files:** component routes (`POST /api/v1/admin/components/skill/:id/versions` zip upload,
`POST /api/v1/admin/components/agent_template/:id/versions` markdown upload), `PlatformComponents`
(new version with `updated_on_own = true`), tests.

- [ ] Tests: uploading a new skill version keeps plugin provenance, sets `updated_on_own`, usable in
  orgs at once; the next plugin update preview marks it.
- [ ] Implement; commit `feat(kernel): update a platform component on its own`.

### Task 9: Web — admin component pages and plugin detail

**Files:** `apps/web/src/app/(app)/admin/{skills,connector-templates,agent-templates}/**` (list +
detail), `components/ComponentScopeDialog.tsx` (reuse PluginScopeDialog parts),
`admin/plugins/[itemId]` (components tab with scope column 跟随插件 / own, update preview dialog for
Task 7), nav (超级管理员 sidebar: 插件, 扩展, 技能, 连接器模板, 智能体模板, …), lib/query, messages;
tests. Mock reference: `.superpowers/sdd/2026-11-05-plugin-scope-phase-1/mock/mock-pages.tsx`
(`AdminSkills`, `AdminTemplates`, `PluginDetail`).

- [ ] Tests: lists show 来自 / 归属 / 范围 / 版本; scope dialog per component; update preview shows
  updated-on-own and own-scope marks.
- [ ] Implement; commit `feat(web): admin component pages and platform plugin updates`.

### Task 10: Web — workspace components

**Files:** `apps/web/src/app/(app)/skills/**` (platform skills with switches 已启用 · 平台统一 / 启用 /
停用, origin chips), new `agent-templates` page (list; 用它创建智能体 waits for phase 4 — not here),
agent editor pickers (`components/agent/SkillsSection.tsx`, `AgentSubagents.tsx`) list the usable set
with origin; plugin detail shows its components with per-component switches; tests.

- [ ] Tests: member sees read-only; org admin switches a component; `all` shows no switch; pickers
  show platform skills; a renamed org skill (Task 5) shows its notice in the inbox.
- [ ] Implement; commit `feat(web): workspace platform components`.

### Task 11: Platform inbox (super admin)

**Files:** kernel `inbox/platform-inbox.service.ts` + `GET /api/v1/admin/inbox` (requests to the
super admin: `access` / `import`; permission confirmations; failed scope syncs), web
`/admin/inbox` page + nav entry with count; tests.

- [ ] Implement with tests; commit `feat: a platform inbox for the super admin`.

### Task 12: Member-readable 扩展 page

**Files:** kernel route `GET /api/v1/orgs/:orgId/extensions` readable by members with a projection
without `config`, `secrets`, `orgConfigSchema` (new action `org.extensions.read` = member), web nav
audience member, editing controls hidden for members; tests.

- [ ] Implement with tests; commit `feat: members can see the org's extensions`.

### Task 13: Marketplace prerelease folding and `deprecated`

**Files:** SDK `MarketplaceEntry.deprecated?: boolean | { reason?: string }` (zod + schema +
API snapshot + changeset), plugin-tools keeps it on `--write`, kernel `MarketplaceEntryView`
passes it, web: grouped rows prefer the newest stable version (prereleases into 其他版本) and hide
deprecated versions from 引入 (shown with a 已废弃 note in 其他版本, not importable); kernel refuses
importing a deprecated entry (`marketplace.entry_deprecated` 409); tests on each layer.

- [ ] Implement; commit `feat: marketplace prerelease folding and deprecated versions`.

### Task 14: Docs, changesets, verify

AGENTS.md (catalog, plugins, runtime skills/agent templates bullets), skills (writing-plugins,
writing-tools Skill section, replay-evals for the source form and linked copies), spec status
(phase 2 implemented), changesets; `pnpm -s verify --json`.
