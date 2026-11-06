# Plugin scope, phase 1: import installs, scope for plugins and extensions, the new pages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bringing a plugin in installs it; every plugin has a scope (全部组织启用 / 组织自选 / 指定组织)
that decides which orgs have it on; the admin console and the workspace get the 插件 and 扩展 pages
of the accepted mock; required bootstrap plugins become built-in and stop looking installable.

**Architecture:** Scope lives on the catalog item (the enterprise plugin); an org's explicit switch
lives in a new table. Phase 1 keeps today's per-org copies of skills, connectors and agent
templates: "a plugin is on in an org" is realised by today's org install (`PluginInstaller`), run
by the admin's action or by a worker job that converges every org to the scope. Catalog policy,
org grants are replaced by scope and a deployment-level disable; requests get a new meaning (Task 5b). Phases 2-4 of
the spec (deployment-level components, org uploads, agent templates as starters) are separate plans.

**Tech Stack:** NestJS kernel (Kysely on PG, BullMQ, `@Transactional`, `@Processor` + `runJob`),
Next web app (`@capybara-hq/design` templates, TanStack Query via `defineQuery` /
`useAppMutation`), vitest, next-intl.

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` (§3 terms, §4.1
import, §5 scope, §9 pages, §6 "Migration of what exists" for the policy and never-deployed rules).
Phase 1 covers §4.1, §5 rules 1-4, 6, 8 (for plugin scope changes and switches), 9 and the plugin and
extension rows of §9.

## Global Constraints

- Scope values are exactly `all` / `optional` / `named`; UI copy 全部组织启用 / 组织自选 / 指定组织
  (en: "All organizations" / "Organizations choose" / "Selected organizations").
- Default scope at import: `optional`.
- Built-in = a plugin installed by the bootstrap step with `required: true`; scope `all`, cannot be
  changed, cannot be switched off in an org, extension cannot be disabled (`extension.required`).
- Confirming an import installs and enables the plugin's extension on the deployment; there is no
  `deployExtension` choice any more.
- Migration mapping: `allow` → `optional`; `needs_approval` → `named` with the granted orgs plus the
  orgs that have a live install; `disabled` → `disabled = true` with scope `optional`; orgs with a
  live install get switch on; pending catalog requests are closed.
- Imported-but-never-deployed extension plugins (no `extension_installs` row for the item's
  extension, or no permission snapshot covering it) are listed in 待确认, not installed.
- Kernel conventions (`check:kernel-conventions`): `@Injectable` providers with explicit `@Inject`,
  `@Transactional()` writes, enqueues after commit (`afterCommit`), consumers only under
  `WorkerModule`, BullMQ queue names and job ids without `:`.
- Migrations: `NNNN_<snake>.sql`, `IF NOT EXISTS`, expand-only (old columns stay, code stops reading
  them); the next number is `0075`.
- Web: pages from design templates only, reads through `defineQuery` with keys from
  `lib/query/keys.ts`, writes through `useAppMutation`, every page in `lib/query/routes.ts`, zh and
  en messages for every string (`check:web-ui`, `check:i18n`).
- No model-visible change; no SDK public API change (so no `plugin-sdk` changeset).
- New error codes are registered in `packages/kernel/src/errors.ts` with these statuses:
  `plugin.builtin` 409, `plugin.scope_locked` 409, `plugin.scope_stale` 409, `plugin.disabled` 409.
- Changeset: `@capybara-hq/kernel` minor, `@capybara-hq/web` minor.

## Review Focus

1. An org created after a plugin was set to `all` gets it on, without anyone visiting the org (Task 4).
2. A `named` org that switched a plugin off keeps it off when the enterprise admin edits the org list
   for other orgs (Task 3, Task 5).
3. A plugin whose org install needs inputs (connector templates, required org config) set to `all`
   leaves each org in `needs_config`, never in a failed install loop (Task 4).
4. Two worker replicas processing the same item's sync converge to one install per org (Task 4,
   dual-replica test).
5. A built-in plugin offers no switch-off, no scope change and no uninstall anywhere: org API, admin
   API and both web pages (Tasks 5, 6, 7, 11).

---

### Task 1: Migration and schema types

**Files:**
- Create: `packages/kernel/src/migrations/0075_plugin_scope.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`CatalogItemsTable`, two new tables in `KernelDatabase`)
- Test: `packages/kernel/test/catalog/scope-migration.test.ts`

**Interfaces:**
- Produces: columns `catalog_items.scope text NOT NULL DEFAULT 'optional' CHECK (scope IN
  ('all','optional','named'))`, `catalog_items.builtin boolean NOT NULL DEFAULT false`,
  `catalog_items.disabled boolean NOT NULL DEFAULT false`, `catalog_items.scope_version integer NOT
  NULL DEFAULT 0`; table `capybara.catalog_item_scope_orgs (item_id uuid REFERENCES catalog_items ON
  DELETE CASCADE, org_id uuid REFERENCES orgs ON DELETE CASCADE, PRIMARY KEY (item_id, org_id))`;
  table `capybara.catalog_item_org_switches (item_id, org_id, enabled boolean NOT NULL, updated_by
  uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (item_id, org_id))`; Kysely types
  `CatalogItemScopeOrgsTable`, `CatalogItemOrgSwitchesTable`.

- [ ] **Step 1: Write the failing test** `scope-migration.test.ts`: seed (with the SQL as of 0073)
  four items: policy `allow` with an install in org A; `needs_approval` granted to org B and installed
  in org C; `disabled`; one whose `extension_installs` row has `required = true`. Run the migrator to
  0075 and assert:
  ```ts
  expect(allow).toMatchObject({ scope: "optional", disabled: false, builtin: false });
  expect(switches(allow)).toEqual([{ org: A, enabled: true }]);
  expect(approval.scope).toBe("named");
  expect(scopeOrgs(approval).sort()).toEqual([B, C].sort());
  expect(switches(approval)).toEqual([{ org: C, enabled: true }]);
  expect(disabled).toMatchObject({ scope: "optional", disabled: true });
  expect(required).toMatchObject({ scope: "all", builtin: true });
  expect(await pendingRequests()).toBe(0);
  ```
- [ ] **Step 2: Run it to verify it fails**: `pnpm exec vitest run packages/kernel/test/catalog/scope-migration.test.ts` → FAIL (column `scope` does not exist).
- [ ] **Step 3: Write `0075_plugin_scope.sql`**: the columns and tables above, then the backfill of
  the Global Constraints mapping. Pending requests: `UPDATE catalog_requests SET status = 'cancelled'`
  for pending rows, using the existing terminal status the `catalog_requests` check constraint
  allows for withdrawn requests (read it in its migration; add a note `superseded by scope`).
  `builtin` / `all`: items whose `id` is the `catalog_item_id` of an `extension_installs` row with
  `required = true`. Do not drop `policy`, `catalog_org_grants` or `catalog_requests` (expand-only).
- [ ] **Step 4: Update `kernel-schema.ts`** with the new columns and tables.
- [ ] **Step 5: Run the test** → PASS; `pnpm typecheck` → no errors.
- [ ] **Step 6: Commit** `feat(kernel): plugin scope columns and org switches (migration 0075)`.

### Task 2: Scope model: effective state of a plugin in an org

**Files:**
- Create: `packages/kernel/src/catalog/scope.ts`
- Test: `packages/kernel/test/catalog/scope.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PluginScope = "all" | "optional" | "named";
  export type OrgPluginState = "on" | "off" | "needs_config" | "unavailable";
  /** Whether the item should be on in the org: scope, list, switch, disable. Pure. */
  export function wantedOn(item: { scope: PluginScope; disabled: boolean; builtin: boolean },
    inList: boolean, sw: boolean | null): boolean;
  /** Whether the org may see the item at all (named items only for listed orgs). Pure. */
  export function visibleTo(item: { scope: PluginScope }, inList: boolean): boolean;
  /** Whether the org admin may switch it (false for all and builtin). Pure. */
  export function switchable(item: { scope: PluginScope; builtin: boolean }): boolean;
  ```
  Rules (spec §5): `all` → on unless disabled; `named` → on for listed orgs unless switch false;
  `optional` → on only when switch true; `disabled` → never on; builtin implies `all`.

- [ ] **Step 1: Write the failing test** as a table over (scope, disabled, builtin, inList, sw):
  ```ts
  it.each([
    ["all", false, false, false, null, true],
    ["all", false, false, false, false, true],      // org cannot turn off `all`
    ["all", true, false, false, null, false],       // disabled wins
    ["optional", false, false, false, null, false],
    ["optional", false, false, false, true, true],
    ["named", false, false, true, null, true],      // default on for listed orgs
    ["named", false, false, true, false, false],
    ["named", false, false, false, true, false],    // not listed: never on
  ])("%s disabled=%s builtin=%s listed=%s switch=%s -> %s", (scope, disabled, builtin, inList, sw, on) =>
    expect(wantedOn({ scope, disabled, builtin }, inList, sw)).toBe(on));
  ```
  plus `visibleTo({scope:"named"}, false) === false`, `switchable({scope:"all",builtin:false}) === false`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/scope.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three functions in `scope.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): plugin scope rules`.

### Task 3: Org view of plugins and the org switch

**Files:**
- Modify: `packages/kernel/src/catalog/org-catalog.service.ts` (`list`, `detail`; replace `installable`)
- Modify: `packages/kernel/src/catalog/catalog-content.ts` (`OrgCatalogItem`)
- Modify: `packages/kernel/src/catalog/org-catalog.controller.ts` (new switch route; the request
  routes stay as they are, install no longer creates requests; Task 5b reworks requests)
- Test: `packages/kernel/test/catalog/org.test.ts`

**Interfaces:**
- Consumes: Task 2 functions; `PluginInstaller.install` / uninstall as today.
- Produces:
  ```ts
  export interface OrgCatalogItem extends /* today's view minus installable/request */ {
    scope: PluginScope; builtin: boolean;
    state: OrgPluginState;          // from wantedOn + whether a live install exists
    switchable: boolean;
    installed: { pluginInstallId: string; version: string } | null;
  }
  // PUT /api/v1/orgs/:orgId/catalog/:itemId/switch   (org.extensions.manage; plus the component actions as today)
  // body { enabled: true, inputs?: OrgInstallBody } -> 200 { item: OrgCatalogItem }
  // body { enabled: false, confirm?: string }       -> 200 { preview: UninstallPreview, confirm: string } when confirm absent,
  //                                                    200 { item } when confirm equals the preview's hash
  OrgCatalogService.setSwitch(orgId, actor, itemId, body): Promise<SwitchResult>
  ```
  `state` is `needs_config` when `wantedOn` is true, no live install exists, and the plugin's org
  install needs inputs (connector templates, or an extension org config schema with required
  fields and no stored config). Members see the same list, read-only (route guard `catalog.read`).
  Items with `visibleTo === false` are absent; `disabled` items are absent for members and shown to
  admins with state `unavailable`.

- [ ] **Step 1: Write the failing tests** in `org.test.ts` (reuse `startOrgEnv`, `importPlugin`,
  `seedPlugin`):
  - `optional` item: listed `state: "off"`, `switchable: true`; `PUT switch {enabled:true}` installs
    (a `plugin_installs` row, switch row `true`) and returns `state: "on"`.
  - switch off: first call returns `{ preview, confirm }` naming the agents that use its skill;
    second call with `confirm` uninstalls and stores switch `false`.
  - `named` item not listing the org: absent from the list; `PUT switch` → 404 `catalog.item_not_found`.
  - `all` item: `switchable: false`; `PUT switch {enabled:false}` → 409 `plugin.scope_locked`.
  - builtin item (seed `builtin = true`): `state: "on"` without any install row, `switchable: false`.
  - template plugin, `all`: `state: "needs_config"`; `PUT switch {enabled:true, inputs}` installs.
  - installing a former `needs_approval` item no longer creates a request (no 202).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/org.test.ts` → the new cases FAIL.
- [ ] **Step 3: Implement** `list` / `detail` with the new fields and `setSwitch`. The uninstall
  preview reuses the existing uninstall report (kept components and reasons) plus the agents that
  reference the plugin's skills, connectors and agent templates; `confirm` is a sha256 over the
  sorted preview (same scheme as `diffHash`). Writes in `@Transactional()` under the org lock as the
  installer does today. Remove `requestIfNeeded` and the request service calls from install; the
  old `POST catalog/:itemId/install` route stays as an alias of `switch {enabled:true}` for the CLI
  (designer's call: removing it would break `capybara` commands for no gain).
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(kernel): org plugin switch`.

### Task 4: Scope sync job

**Files:**
- Create: `packages/kernel/src/catalog/scope-sync.ts` (`PluginScopeSync` service, `PluginScopeSyncProcessor`)
- Modify: the catalog module (provide the service) and `WorkerModule` wiring (the processor only
  under `WorkerModule`, `kc-worker-only`)
- Modify: `packages/kernel/src/orgs/orgs.service.ts` (`createIn`: `afterCommit` enqueue for the new org)
- Test: `packages/kernel/test/catalog/scope-sync.test.ts`, `packages/kernel/test/catalog/scope-sync.dual.test.ts`

**Interfaces:**
- Consumes: Task 2 `wantedOn`; `PluginInstaller.install` / uninstall.
- Produces:
  ```ts
  export const PLUGIN_SCOPE_QUEUE = "cap-kernel-plugin-scope";
  PluginScopeSync.enqueueItem(itemId: string): Promise<void>   // job id `scope-item-<itemId>-<scope_version>`
  PluginScopeSync.enqueueOrg(orgId: string): Promise<void>     // job id `scope-org-<orgId>`
  PluginScopeSync.syncPair(itemId: string, orgId: string): Promise<"installed" | "removed" | "needs_config" | "unchanged">
  ```
  For each (item, org): wanted on and no live install and no inputs needed → install as the system
  actor (audit actor null, detail `{ via: "scope" }`); wanted on and inputs needed → nothing
  (`needs_config` is derived); wanted off and a live install exists → uninstall (the admin or org
  admin confirmed the preview in Task 3 / Task 5). Dependencies (spec §5 rule 9): an item is also
  wanted on in an org while a live install in that org depends on it (`plugin_install_components`
  kind `plugin`), whatever its own scope, so the sync never removes a dependency its dependent
  installed. An install failure is logged and audited `plugin.scope_sync_failed`, and does not retry
  until the next enqueue (no loop).

- [ ] **Step 1: Write the failing tests** (`scope-sync.test.ts`):
  - item set to `all` → after the job, every org has a live install; an org created afterwards gets
    one too (`waitFor` on `plugin_installs`).
  - `named` [A, B] with B switched off → A installed, B not, C not.
  - template plugin set to `all` → no install, `syncPair` returns `needs_config`, no audit failure.
  - scope `all` → `optional` (switch rows absent) → installs removed.
  - plugin A (`optional`, switched on in org X) depends on B (`named` [Y]): after the sync B stays
    installed in X as A's dependency.
  `scope-sync.dual.test.ts` (`createDualReplicaHarness`): enqueue the same item on both replicas;
  assert exactly one live install per org and no failed installs.
- [ ] **Step 2: Run** both → FAIL.
- [ ] **Step 3: Implement** the service and the processor (`@Processor(PLUGIN_SCOPE_QUEUE)`, each job
  in `runJob`, per org under the org lock the installer already takes). Enqueue in `afterCommit` only.
- [ ] **Step 4: Run** → PASS; `pnpm check:kernel-conventions`.
- [ ] **Step 5: Commit** `feat(kernel): converge orgs to plugin scope in a worker job`.

### Task 5: Admin scope, disable and the import that installs

**Files:**
- Modify: `packages/kernel/src/catalog/admin-catalog.controller.ts` (replace `PUT items/:id/policy`;
  remove `POST items/:id/install-deployment`)
- Modify: `packages/kernel/src/catalog/catalog.service.ts`, `packages/kernel/src/catalog/plugin-import.ts`
  (`confirm`)
- Test: `packages/kernel/test/catalog/plugin-import.test.ts`, `packages/kernel/test/catalog/catalog.test.ts`

**Interfaces:**
- Consumes: Task 4 `enqueueItem`.
- Produces:
  ```ts
  // POST /api/v1/admin/catalog/items/:id/scope/preview  body { scope, orgs?: string[] }
  //   -> { affected: { orgId: string; orgName: string; agents: { id: string; name: string }[] }[],
  //        needsConfig: string[] /* org ids */, scopeHash: string }
  // PUT  /api/v1/admin/catalog/items/:id/scope  body { scope, orgs?, scopeHash } -> CatalogItemView
  // PUT  /api/v1/admin/catalog/items/:id/disabled body { disabled: boolean, scopeHash? } -> CatalogItemView
  // POST /api/v1/admin/catalog/imports/:stagingId/confirm  body { reviewHash, scope?, orgs?, pinnedSuggestions? }
  CatalogItemView gains { scope, scopeOrgs: string[], builtin, disabled, enabledOrgs: number, pending: boolean }
  ```
  `affected` lists orgs that lose the plugin and their agents using its skills, connectors or agent
  templates (spec §5 rule 8); a stale `scopeHash` → 409 `plugin.scope_stale`; builtin → 409
  `plugin.builtin`; `orgs` only with `named` (else `validation_failed`). Each change increments
  `scope_version`, writes the audit `catalog.scope_changed` and enqueues the sync. Confirm always
  deploys and enables the extension (the old `deployExtension: true` path), then writes scope
  (default `optional`). `pending` is true for an item whose extension is not installed or whose
  permission snapshot does not cover it.

- [ ] **Step 1: Write the failing tests**:
  - `plugin-import.test.ts`: confirm without `deployExtension` installs and enables the extension and
    stores `scope: "optional"`; confirm with `scope: "named", orgs: [A]` stores the list; the old
    `deployExtension: false` field is rejected as unknown (`validation_failed`).
  - `catalog.test.ts`: preview of `all` → `optional` lists orgs with installs and the agent using the
    plugin's skill; `PUT scope` with a wrong hash → 409 `plugin.scope_stale`; builtin → 409
    `plugin.builtin`; `disabled: true` → `enabledOrgs` 0 after the sync; `install-deployment` → 404.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): import installs; admin scope and disable with impact preview`.

### Task 5b: Requests under scope (spec §5.1)

**Files:**
- Create: `packages/kernel/src/migrations/0076_scope_requests.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/catalog/requests.service.ts`,
  `packages/kernel/src/catalog/org-catalog.controller.ts`, `packages/kernel/src/catalog/org-catalog.service.ts`
  (`list`), `packages/kernel/src/identity/settings.ts` (deployment setting), the marketplaces
  controller (org read route), the inbox item for requests
- Test: `packages/kernel/test/catalog/requests.test.ts` (rewritten)

**Interfaces:**
- Consumes: Task 3 `setSwitch`, Task 4 `enqueueItem`, Task 5 import confirm with `scope` / `orgs`.
- Produces:
  - `catalog_items.shown_to_others boolean NOT NULL DEFAULT true` (0076; org-owned items arrive in
    phase 3 with default false); `catalog_requests.kind text NOT NULL DEFAULT 'access' CHECK (kind IN
    ('access','import','enable'))`, nullable `item_id` plus `marketplace_id`, `entry_name`,
    `entry_version` for `import`; `reason text` for rejections. One pending request per (org, kind,
    item or entry).
  - Deployment setting `orgMarketplaceBrowse: boolean` (default `true`).
  - Org list: a `named` item not listing the org and `shown_to_others` appears with
    `state: "not_offered"` (add to `OrgPluginState`) and `request` (its pending request or null);
    hidden ones stay absent.
  - Routes:
    ```
    POST /api/v1/orgs/:orgId/catalog/:itemId/requests  body { kind: "access" | "enable", note? }
      access: org admin, item not_offered; enable: member, item optional and off
    POST /api/v1/orgs/:orgId/marketplace-requests      body { marketplaceId, name, version, note? } (org admin)
    GET  /api/v1/orgs/:orgId/marketplaces/entries      (org admin; 404 when orgMarketplaceBrowse is false)
    POST /api/v1/orgs/:orgId/catalog-requests/:id/decide   body { approve, reason? }  (enable kind; org admin)
    GET  /api/v1/admin/catalog/requests; POST …/:id/decide body { approve, reason? }  (access, import)
    ```
  - Approve effects: `enable` → `setSwitch(enabled:true)` for the org; `access` → insert into
    `catalog_item_scope_orgs`, bump `scope_version`, enqueue the sync; `import` → returns the staging
    id of a prepared import (the admin finishes it with the Task 5 confirm, whose `scope` defaults to
    `named` = the requesting org) and the request resolves when that confirm commits. Rejection stores
    `reason`. Each decision writes an inbox item for the requester.

- [ ] **Step 1: Write the failing tests** (`requests.test.ts`, rewritten): member `enable` request on
  an `optional` item → org admin approves → the item is `on` in the org; org admin `access` request
  on a `named` item shown to others → enterprise approves → the org is in the list and, after the
  sync, installed; hidden (`shown_to_others = false`) item is absent and its request → 404; marketplace
  request → approve returns a staging id → confirm with no scope → item `named` [requesting org] and
  the request `approved`; `orgMarketplaceBrowse = false` → entries route 404 and marketplace request
  409; a second pending request of the same kind → 409; rejection reason visible to the requester.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/requests.test.ts` → FAIL.
- [ ] **Step 3: Implement** (migration 0076 with types; expand-only: the old `stage` column stays and
  is no longer read).
- [ ] **Step 4: Run** → PASS; `pnpm check:kernel-conventions`.
- [ ] **Step 5: Commit** `feat(kernel): requests under plugin scope`.

### Task 6: Extensions follow their plugin's scope

**Files:**
- Modify: `packages/kernel/src/extensions/org-config.ts` (`list`, `write`)
- Modify: `packages/kernel/src/extensions/admin-view.ts` (admin list fields)
- Test: `packages/kernel/test/extensions/org-config.test.ts`, `packages/kernel/test/extensions/org-config.http.test.ts`

**Interfaces:**
- Produces: org extension view gains `{ plugin: { itemId: string; scope: PluginScope } | null;
  switchable: boolean }`; admin extension view gains `{ scope: PluginScope | null; enabledOrgs:
  number; builtin: boolean }`. In an org, an extension whose catalog item is not visible to it
  (`named` without the org) is absent from `list`. Writing `enabled` for an extension that has a
  catalog item delegates to `OrgCatalogService.setSwitch` (one switch per plugin in phase 1);
  `enabled: false` for an `all` or builtin plugin → 409 `plugin.scope_locked` (builtin keeps
  `extension.required`). Config writes are unchanged. `enabled.ts` is unchanged: installs keep
  writing `extension_org_configs.enabled` as today.

- [ ] **Step 1: Write the failing tests**: `named` plugin's extension absent for an unlisted org;
  `PUT extensions/:name {enabled:false}` on an `all` plugin → 409 `plugin.scope_locked`; on an
  `optional` plugin → the plugin's install is removed (via the confirm flow: first call returns the
  preview); admin list reports `enabledOrgs`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): org extension switches follow plugin scope`.

### Task 7: Built-in plugins and 待确认

**Files:**
- Modify: `packages/kernel/src/extensions/bootstrap.ts` (write `builtin = true`, `scope = 'all'` on
  the catalog item of a required entry; `builtin = false` when an entry stops being required)
- Modify: `packages/kernel/src/catalog/admin-catalog.controller.ts` (`GET items?pending=true`,
  `POST items/:id/confirm`)
- Test: `packages/kernel/test/extensions/bootstrap.test.ts`, `packages/kernel/test/catalog/catalog.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/admin/catalog/items/:id/confirm` body `{ permissionsHash }` → approves the
  current permission set (snapshot source `web`) and, for a never-deployed item, installs and
  enables its extension; `pending` (Task 5) also covers builtin items whose snapshot source is
  `bootstrap` (never confirmed by a person).

- [ ] **Step 1: Write the failing tests**: after bootstrap the required fake (`fake-bootstrap-a`)
  item has `builtin: true, scope: "all", pending: true`; `confirm` sets `pending: false` and the
  snapshot source `web`; an imported-never-deployed item is `pending: true` and `confirm` installs it.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): built-in plugins and permission confirmation`.

### Task 8: Web data layer

**Files:**
- Modify: `apps/web/src/lib/catalog.ts` (types of Tasks 3, 5, 7), `apps/web/src/lib/extensions.ts`,
  `apps/web/src/lib/admin-extensions.ts` (Task 6 fields)
- Modify: `apps/web/src/lib/query/catalog.ts`, `apps/web/src/lib/query/keys.ts` (no new key
  prefixes needed beyond `catalogPending` under the deployment prefix)
- Modify: the request types, loaders and queries for Task 5b (kinds `access` / `import` / `enable`, `reason`; `orgMarketplaceEntriesQuery`, `requestMarketplaceEntry`)
- Test: `apps/web/test/catalog.test.tsx`

**Interfaces:**
- Produces: `setOrgPluginSwitch(orgId, itemId, body)`, `previewScope(itemId, body)`,
  `setScope(itemId, body)`, `setDisabled(itemId, body)`, `confirmPending(itemId, body)` loaders;
  `pendingPluginsQuery()`; mutations invalidate `org.catalog`, `org.catalogItemsAll`,
  `org.extensions`, `deployment.catalog`, `deployment.catalogItemsAll`, `deployment.extensions`.

- [ ] **Step 1: Write the failing test**: the loaders call the routes of Tasks 3, 5, 7 with the given
  bodies (the existing fetch-mock pattern of `catalog.test.tsx`).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/catalog.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(web): plugin scope data layer`.

### Task 9: Admin 插件 pages

**Files:**
- Move: `apps/web/src/app/(app)/admin/catalog/**` → `apps/web/src/app/(app)/admin/plugins/**`
  (`page.tsx` list, `[itemId]`, `import` becomes the 上传插件包 flow); `admin/marketplaces/entries`
  → `admin/plugins/market`; `admin/marketplaces` → `admin/plugins/sources`; new
  `admin/plugins/pending` (lists permission confirmations and the `access` / `import` requests with approve / reject + reason); delete `admin/catalog/requests`
- Create: `apps/web/src/components/PluginScopeDialog.tsx`
- Modify: `apps/web/src/components/admin-nav.ts` (`ADMIN_PAGES`: overview, accounts, orgs, plugins
  `/admin/plugins` with the pending count, extensions, models, settings), `apps/web/src/lib/query/routes.ts`,
  `apps/web/src/lib/admin-tabs.ts`, `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/catalog-pages.test.tsx`, `apps/web/test/nav.test.tsx`

**Interfaces:**
- Consumes: Task 8.
- Produces: the pages of spec §9 for plugins, matching the accepted mock (`/dev/mock/admin/plugins`,
  `/dev/mock/admin/plugins/jina`): header tabs 已安装 / 市场 / 待确认 (count), actions 添加市场源
  (`/admin/plugins/sources`) and 上传插件包 (primary); rows with chips 内置 / Claude Code, meta
  `version · source · components · scope · N 个组织在用`, state 运行中 / 可更新 x / 权限待确认 /
  已停用. Detail: tabs 组件 / 组织 / 版本, inspector, actions 设置范围 (dialog: scope radio, org
  multi-select for `named`, then the impact preview from `previewScope` with affected orgs and
  agents, confirm), 停用 / 启用 (with the same preview), 更新到 x. The import review's confirm step
  asks for the scope (default 组织自选) and has no deploy checkbox.

- [ ] **Step 1: Write the failing tests** (`renderRouteWithCache`): the list shows the three tabs and
  the 内置 chip; the detail's 设置范围 dialog shows the affected org and agent from a mocked preview
  and sends `scopeHash`; a builtin item has no 设置范围; the nav has 插件 and no 企业目录 / 市场.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm check:web-ui`,
  `pnpm check:i18n`.
- [ ] **Step 5: Commit** `feat(web): admin plugins pages with scope`.

### Task 10: Admin 扩展 list fields

**Files:**
- Modify: `apps/web/src/app/(app)/admin/extensions/view.tsx`, `[name]/view.tsx`; delete
  `admin/extensions/install` (uploads go through 上传插件包)
- Test: `apps/web/test/admin-extensions.test.tsx`

- [ ] **Step 1: Write the failing test**: a row's meta reads `… · 组织自选 · 3 个组织启用`, the
  page has no 安装扩展 action, and the description is 插件里在部署上运行的代码。部署级配置、权限和运行状态在这里。
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): admin extensions show plugin scope`.

### Task 11: Workspace 插件 and 扩展 pages and navigation

**Files:**
- Move: `apps/web/src/app/(app)/catalog/**` → `apps/web/src/app/(app)/plugins/**`;
  `settings/extensions` → `apps/web/src/app/(app)/extensions`; fold `settings/plugins` (installed
  plugins, upgrade dialog) into `plugins/[itemId]`; delete `catalog/[itemId]/install` in favour of
  the switch flow (the connector inputs wizard `CatalogInstallWizard` opens from 启用 /
  需要配置)
- Modify: `apps/web/src/components/shell/nav.tsx` (更多: 插件, 扩展, 技能, 连接器, 渠道, 评测与运行,
  组织设置), `apps/web/src/components/settings-nav.ts` (drop 扩展 and 已安装的插件),
  `apps/web/src/components/CatalogInstallAction.tsx`, `routes.ts`, messages
- Test: `apps/web/test/catalog-pages.test.tsx`, `apps/web/test/nav.test.tsx`

**Interfaces:**
- Produces (spec §5.1): a 市场 tab on the org 插件 page for org admins (hidden when
  `orgMarketplaceBrowse` is false) with 申请引入 per entry; `not_offered` rows show 未开放，可申请 and
  申请 (org admins); members get 申请启用 on `optional` rows that are off; a pending request shows
  已申请，等待处理.
- Produces (spec §9, mock `/dev/mock/work/plugins`, `/dev/mock/work/extensions`): rows with state
  已启用 / 未启用 / 需要配置 / 已启用 · 企业统一, actions 启用 / 组织配置 / 停用 (停用 shows the
  preview from Task 3 before confirming); members see the same rows without actions. The 扩展 page
  is today's `/settings/extensions` content with the switch following Task 6.

- [ ] **Step 1: Write the failing tests**: an `optional` plugin shows 启用 and the mutation sends
  `{enabled:true}`; a builtin plugin shows 已启用 · 企业统一 and no action (the bug that started
  this); a member sees no actions; 停用 shows the agents from the preview; the nav's 更多 has 插件
  and 扩展 and the settings nav has neither.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(web): workspace plugins and extensions pages`.

### Task 12: Docs, skills, changeset, verify

**Files:**
- Modify: `AGENTS.md` (Catalog and marketplaces line: scope replaces policy and requests; import
  installs), `.agents/skills/writing-plugins/SKILL.md`, `.agents/skills/writing-extensions/SKILL.md`
  (org enablement follows scope), `docs/design/spec.md` page list if it names the moved pages
- Create: `.changeset/plugin-scope-phase-1.md` (kernel minor, web minor)
- Modify: the spec's status line (`implemented: phase 1`)

- [ ] **Step 1:** Update the docs and skills; run `pnpm check` (terms, skills frontmatter, synced
  skills untouched).
- [ ] **Step 2:** `pnpm -s verify --json` → `ok: true`. Visual baselines that change (nav, moved
  pages) are regenerated by the `visual-update` workflow when the branch is pushed; say so in the
  PR.
- [ ] **Step 3: Commit** `docs: plugin scope phase 1`.
