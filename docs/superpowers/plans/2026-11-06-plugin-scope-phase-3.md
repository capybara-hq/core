# Plugin scope, phase 3: org uploads, sharing and 新建技能

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** org admins upload plugins (installed at once, or pending the super admin's confirmation
when they carry an extension), mark what their org owns 可共享, and create skills from text; the super
admin shows and associates shareable org items; shared items follow their owner's updates and survive
their owner (transferred to the platform).

**Architecture:** an owner (`owner_org_id`, null = platform) and a `shareable` flag on catalog items
and platform components (migration 0083). An org upload goes through the existing import
(`PluginImport` prepare → review → confirm with `reviewHash`) in an owner mode: org-scoped routes,
staging rows carrying the org, a commit that writes the item owned by the org with scope
`named: [org]`. An extension-bearing upload is committed in a pending state with nothing deployed or
synced; the super admin's existing 待确认 confirmation deploys it. Standalone org skills and agent
templates are promoted to platform rows only when first shown or associated (promote on share),
linked by ruling B2 so every id keeps resolving. Owner and org deletion transfer used items to the
platform in the same transaction; extension cleanup runs on the worker.

**Tech Stack:** NestJS + Fastify kernel, Kysely on PG, BullMQ (`cap-kernel-maintenance`), Next web app
with TanStack Query and `@capybara-hq/design`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` §4.2, §5 rule 1,
§5.1 rules 1-2, §6 (org-owned items), §9, and **§14** (the phase 3 decisions and rulings P3-1 to
P3-24, cited below as "P3-n"). §13.5 and §13.6 (rulings A2-F2, P2-*) are binding. Research map:
`.superpowers/sdd/phase3-research-notes.md` (file:line facts; paths there are relative to
`packages/kernel/src`). Written and executed without a maintainer review gate (authorized
2026-11-06).

## Global Constraints

- Everything local: no push, PR or publish. Next migration number `0083`; one migration file for the
  phase: `packages/kernel/src/migrations/0083_org_owned_items.sql`. Expand-only; `IF NOT EXISTS` /
  `IF EXISTS`; a dropped index or constraint carries `-- capybara:allow-destructive <reason>`.
- Owner values: `platform` (null `owner_org_id`) / an org id. API shape
  `Owner = { kind: "platform" } | { kind: "org"; orgId: string; name: string }`. UI: 平台 / Platform;
  roles per §13.4b (超级管理员, 组织管理员); 智能体 in zh; no 企业 or the Latin word "agent" in zh
  messages; labels end without a period; `…` not `...` (`check:i18n`).
- The share gate is `owner_org_id IS NULL OR shareable` (P3-1); every writer that shows an item to
  another org or associates one checks it on the row it writes (P3-2, P3-16).
- Trust boundary: no extension code from an org runs, and no component of an extension-bearing org
  upload is usable anywhere, until a super admin confirms that exact version's permission digest
  (§14.1 item 1, P3-9 to P3-13).
- Replay invariant (AGENTS.md, `replay-evals`): no rewrite of agent definitions or logged events;
  model-visible names unchanged; ids in `agent_versions.definition`, `skills_catalog`,
  `user_message.skill`, `subagent_started` and `conversation_queue.skill` keep resolving. Run
  `packages/kernel/test/evals/reconstruct.test.ts` and `rename-compat.test.ts` before and after Task 8.
- Shared files never live under `kernel/<orgId>/`: promoted and org-plugin files are under
  `deployment/platform/…` or the catalog prefix (ruling A2).
- Multi-replica and kernel conventions (AGENTS.md): writes in `@Transactional()` methods; enqueues
  and Redis after commit (`afterCommit`); no `LockService` call inside a transaction; jobs and crons
  only under `WorkerModule`; job ids without `:`; every constructor parameter with `@Inject`; DTOs
  with `createZodDto` and `@ZBody` / `@ZParam`; new error codes registered with their HTTP status.
- Web (AGENTS.md "UI", `writing-web-ui`): pages from design templates and components, no styles;
  reads are `defineQuery` with keys from `lib/query/keys.ts` and a freshness class; writes are
  `useAppMutation` naming the keys they invalidate; new routes get a `lib/query/routes.ts` entry;
  zh and en messages.
- No SDK change in this phase (the API snapshot stays as is). Changesets: `@capybara-hq/kernel`
  minor, `@capybara-hq/web` minor (fixed with `@capybara-hq/capybara`).
- Single test: `pnpm exec vitest run <path>` from the worktree root.

## Review Focus

1. **Cross-org leaks.** An org-owned item that is not shareable (a plugin, a promoted or unpromoted
   skill, an agent template) never reaches another org: not in `GET orgs/:orgId/catalog`, the
   components lists, the agent editor pickers, `Skill` resolution or the requestable set, even when
   its stored `shown_to_others` is true (shown before shareable was turned off); an org already
   associated keeps it. Tests in Task 2 and Task 8.
2. **Extension trust boundary.** An org never gets code running without the super admin's
   confirmation: the first version, every later version carrying an extension, a pending version
   replaced by a newer upload (the old digest is stale), and dependencies (only confirmed,
   deployed items resolve). The scope sync, an org switch, the `platform-components-migrate` job,
   dependency resolution and the generic platform update route all skip or refuse a pending version.
   Tests in Task 4 and Task 6.
3. **Id stability on promotion.** After a skill is promoted, the owner's agents keep its org row id
   and see the same version number and content (no "Updated skills" line; the zero-drift fixtures
   unchanged); other orgs' agents reference the platform id; an owner's later version reaches both.
   Tests in Task 8.
4. **Name races.** Two orgs (or an org and the super admin) prepare the same plugin name, or two
   different plugins with one extension name: both reviews pass, the first confirm wins, the second
   gets 409 `plugin.name_taken` / `extension.name_conflict` naming the first owner, and nothing of the
   second is written. Tests in Task 4 and Task 6.
5. **Owner org deleted mid-upload.** A staging confirmed after its org was deleted answers 404 and
   writes nothing; a pending first upload of a deleted org is removed and its extension name released;
   a super admin confirmation racing the deletion answers 409 `catalog.item_removed` and leaves no
   extension installed; shared items are transferred with a platform notice. Tests in Task 9.

---

### Task 1: Schema for owners, sharing, pending uploads and notices

**Files:**
- Create: `packages/kernel/src/migrations/0083_org_owned_items.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`CatalogItemsTable`, `PluginImportStagingTable`,
  the `platform_*` tables, `SkillsTable`, `AgentTemplatesTable`, `OrgNoticesTable`, new
  `PlatformNoticesTable`, the `KernelSchema` map)
- Test: `packages/kernel/test/catalog/owner-schema-migration.test.ts`

**Interfaces — produces (columns, all nullable or defaulted; existing rows = platform-owned):**
- `catalog_items`: `owner_org_id text NULL REFERENCES orgs(id) ON DELETE SET NULL`,
  `shareable boolean NOT NULL DEFAULT false`, `awaiting_confirmation boolean NOT NULL DEFAULT false`,
  `pending_version text NULL`, `pending_by text NULL REFERENCES accounts(id) ON DELETE SET NULL`,
  `pending_at timestamptz NULL`; index `catalog_items_owner_idx (owner_org_id) WHERE owner_org_id IS
  NOT NULL AND deleted_at IS NULL`.
- `platform_skills`, `platform_agent_templates`: `owner_org_id text NULL REFERENCES orgs(id) ON
  DELETE SET NULL`, `origin_org_id text NULL` (no FK, immutable), `shareable boolean NOT NULL DEFAULT
  false`; their live-name indexes recreated as `((coalesce(plugin_name, '')), name,
  (coalesce(origin_org_id, ''))) WHERE deleted_at IS NULL` (P3-5).
- `platform_connector_templates`: `owner_org_id`, `shareable` (as above).
- `skills.shareable`, `agent_templates.shareable`: `boolean NOT NULL DEFAULT false` (P3-3, P3-6).
- `plugin_import_staging.org_id text NULL REFERENCES orgs(id) ON DELETE CASCADE` (P3-8).
- `org_notices.kind` CHECK: `('skill_renamed', 'item_shared', 'shared_item_updated',
  'upload_confirmed', 'upload_rejected')` (drop `org_notices_kind_check`, add it back).
- `platform_notices (id uuid PK, kind text NOT NULL CHECK (kind IN ('ownership_transferred')), detail
  jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), dismissed_at timestamptz NULL,
  dismissed_by text NULL REFERENCES accounts(id) ON DELETE SET NULL)`, index on `created_at DESC
  WHERE dismissed_at IS NULL`.

- [ ] **Step 1: Write the failing test** `owner-schema-migration.test.ts`: migrate to 0082, seed a
  catalog item, a platform skill named `report`, an org skill and an org notice; migrate to 0083.
  Assert: the item has `owner_org_id = null`, `shareable = false`, `awaiting_confirmation = false`;
  a second platform skill `report` with `origin_org_id = 'org-a'` inserts, a third with
  `origin_org_id = 'org-a'` violates the unique index; inserting an `org_notices` row of kind
  `item_shared` succeeds and kind `bogus` fails; re-running 0083's SQL is a no-op.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/owner-schema-migration.test.ts`;
  expected FAIL (column `owner_org_id` does not exist).
- [ ] **Step 3: Write the migration and the Kysely types** listed above, each column commented with
  `0083` and its ruling, as 0080 does.
- [ ] **Step 4: Run** the test and `pnpm check:migrations`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): owners, sharing and pending uploads in the schema`.

### Task 2: Owner in views and the share gate

**Files:**
- Create: `packages/kernel/src/catalog/ownership.ts`
- Modify: `catalog/scope.ts` (`requestable`), `catalog/scope-orgs.ts` (`addScopeOrg`),
  `catalog/catalog-scope.service.ts` (shown writer, scope writer), `catalog/component-scope.service.ts`
  (`writeShown`, `writeScope`, component add-org, `list`, `orgOwned`), `catalog/org-catalog.service.ts`
  (the requestable call sites at :127, :202, :306, :417), `catalog/catalog.service.ts`
  (`CatalogItemView`), `catalog/requests.service.ts` (`requestItem`, access approval),
  the error code registry
- Test: `packages/kernel/test/catalog/share-gate.test.ts`

**Interfaces — produces:**
- `type Owner = { kind: "platform" } | { kind: "org"; orgId: string; name: string }`
- `shareGate(row: { owner_org_id: string | null; shareable: boolean }): boolean`
- `assertShareable(row: { owner_org_id: string | null; shareable: boolean; name: string }): void` —
  throws 409 `catalog.not_shareable` ("<name> is owned by an organization that has not made it
  shareable").
- `ownersOf(db: KernelSchemaDb, orgIds: readonly string[]): Promise<Map<string, Owner>>` (deleted orgs
  included, by name).
- `requestable(item: { scope; builtin; shown_to_others; owner_org_id: string | null; shareable:
  boolean }, inList: boolean): boolean` — adds `&& shareGate(item)`.
- `CatalogItemView` gains `owner: Owner`, `shareable: boolean`, `awaitingConfirmation: boolean`,
  `pendingVersion: string | null`; `ComponentView` gains `owner: Owner`, `shareable: boolean`,
  `promoted: boolean` (ruling P2-11's `owner` id becomes `Owner`).
- Errors: `catalog.not_shareable` 409, `catalog.owner_required` 409 (removing the owner org from its
  item's list, P3-17).

- [ ] **Step 1: Write the failing tests** in `share-gate.test.ts` (org-owned items seeded directly in
  PG with `owner_org_id = orgA`, scope `named: [orgA]`):
  - `not shareable: hidden from other orgs even when shown_to_others` — `GET orgs/orgB/catalog` and
    `GET orgs/orgB/components?kind=skill` contain neither the plugin nor its component; a request for
    it → 404 or 409 as for an invisible item.
  - `not shareable: the super admin cannot show or associate` — `PUT admin/catalog/items/:id/shown
    {true}`, adding orgB to its list, `PUT …/scope {scope:"optional"}` and the component equivalents →
    409 `catalog.not_shareable`; removing orgs and `PUT …/disabled` succeed.
  - `shareable: shown and associable` — after `shareable = true`: shown → orgB sees 未开放，可申请;
    approving orgB's access request adds orgB.
  - `shareable turned off keeps associations` — orgB associated, then `shareable = false`: orgB still
    has it on; orgC's request → refused as not requestable.
  - `owner stays listed` — removing orgA from the list → 409 `catalog.owner_required`.
  - `views carry the owner` — `GET admin/catalog/items` shows `owner: { kind: "org", orgId: orgA,
    name: "A" }`; platform items `{ kind: "platform" }`.
- [ ] **Step 2: Run** the test; expected FAIL.
- [ ] **Step 3: Implement** `ownership.ts`, the gate in every writer listed above (the check runs on
  the row read `FOR UPDATE` in the writer's transaction), the view fields, the error codes.
- [ ] **Step 4: Run** the new test plus `packages/kernel/test/catalog/{requests,admin-scope,
  component-scope,scope}.test.ts`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): an owner on catalog items and a share gate`.

### Task 3: Org notices and platform notices

**Files:**
- Create: `packages/kernel/src/inbox/org-notices.ts`, `packages/kernel/src/inbox/platform-notices.ts`
- Modify: `inbox/inbox.service.ts` (read the new kinds), `inbox/platform-inbox.service.ts` and
  `platform-inbox.controller.ts` (item `ownership_transferred`, dismiss route), `catalog/scope-orgs.ts`
  and the scope / component writers (write `item_shared`)
- Test: `packages/kernel/test/inbox/owner-notices.test.ts`

**Interfaces — produces:**
- `type OrgNoticeKind = "skill_renamed" | "item_shared" | "shared_item_updated" | "upload_confirmed"
  | "upload_rejected"`; details:
  `item_shared: { ref: OwnedRef; name: string; org: { id: string; name: string } | "all_orgs" }`,
  `shared_item_updated: { ref: OwnedRef; name: string; from: string; to: string; owner: Owner }`,
  `upload_confirmed: { itemId: string; name: string; version: string }`,
  `upload_rejected: { itemId: string; name: string; version: string; reason: string | null }`.
- `type OwnedRef = { kind: "plugin" | "skill" | "agent_template"; id: string }` (exported from
  `catalog/ownership.ts`; for skills and templates the platform id once promoted).
- `addOrgNotice(db: KernelSchemaDb, orgId: string, kind: OrgNoticeKind, detail): Promise<void>` (the
  caller's transaction).
- `notifySharedUpdate(db, ref: OwnedRef, change: { name; from; to }): Promise<number>` — one
  `shared_item_updated` per live org where the item is on (P3-18), except the owner; returns the count.
- `addPlatformNotice(db, "ownership_transferred", detail: { ref: OwnedRef; name: string; fromOrg: {
  id: string; name: string }; reason: "owner_deleted" | "org_deleted"; usedBy: number })`.
- `PlatformInboxItem` gains `{ type: "ownership_transferred"; id; createdAt; notice }`;
  `POST /api/v1/admin/inbox/notices/:id/dismiss` (204; any super admin; already dismissed → 204).

- [ ] **Step 1: Write the failing tests**:
  - `association notifies the owner` — shareable org item; the super admin adds orgB → orgA's inbox
    has one `item_shared` naming B; approving orgC's access request → a second naming C; widening to
    `optional` → one naming `all_orgs`; a platform item writes none.
  - `notifySharedUpdate reaches the orgs using it` — on in orgB, switched off in orgC → only orgB
    gets the notice, never the owner.
  - `platform notice` — `addPlatformNotice` → `GET admin/inbox` lists `ownership_transferred`,
    count +1; dismiss → gone from list and count.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement**; the notice writes happen in the same transaction as the change.
- [ ] **Step 4: Run** the test plus `packages/kernel/test/catalog/platform-inbox.test.ts`,
  `apps/web` untouched; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): notices for shared items and the platform`.

### Task 4: Org plugin upload, first version without an extension

**Files:**
- Create: `packages/kernel/src/catalog/org-plugin-uploads.ts` (`OrgPluginUploads` provider),
  `packages/kernel/src/catalog/org-plugin-uploads.controller.ts`
- Modify: `catalog/plugin-import.ts` (owner mode in `prepare`, `writeStaging`, `staged`, `confirm`,
  `commit`, `resolveDependencies`; the name-owner check), `catalog/catalog-items.ts`
  (`assertPluginNameOwner` gains the owner), `extensions/installs.ts` (`ingest` in owner mode: store
  only), `orgs/roles.ts` (action `catalog.upload: "admin"`), `catalog/catalog.module.ts`,
  `apps/web/src/app/api/[...path]/route.ts` (`STREAMED_UPLOAD_PATHS` becomes a matcher that also
  accepts `^/api/v1/orgs/[^/]+/catalog/uploads/file$`), error registry
- Test: `packages/kernel/test/catalog/org-upload.test.ts`, `apps/web/test/api-proxy-upload.test.ts`
  (or the existing proxy test file)

**Interfaces — consumes:** `Owner`, `shareGate` (Task 2). **Produces:**
```
POST /api/v1/orgs/:orgId/catalog/uploads/file      application/octet-stream ≤ packages.maxBytes
     @OrgAction("catalog.upload") → { stagingId, review: PluginReview, update: PlatformUpdatePreview | null }
GET  /api/v1/orgs/:orgId/catalog/uploads/:stagingId   (same shape; another org's or a platform staging → 404)
POST /api/v1/orgs/:orgId/catalog/uploads/:stagingId/confirm
     { reviewHash, shareable?: boolean, pinnedSuggestions?: string[] }
     → { item: CatalogItemView, outcome: "installed" | "pending" | "updated" }
```
- `PluginImport.prepare(actor, bytes, source, { owner: { orgId } })` and
  `PluginImport.confirm(actor, stagingId, input, { owner: { orgId } })`: owner mode authorizes with
  `orgLock.lockAndAuthorize(orgId, actor, "catalog.upload")` (in the transaction, so an org deleted
  meanwhile fails) instead of the super-admin lock; source kind `file` only (P3-7).
- `commit` in owner mode: new item → `owner_org_id = orgId`, scope `named`, list `[orgId]`,
  `shown_to_others = false`, `shareable = input.shareable ?? false`; then `syncPlatform` writes the
  components with `owner_org_id` / `shareable` from the item; `CatalogScopeService.enqueue(itemId)`
  after commit (named → the scope sync installs it in the org).
- Checks at prepare and again in commit under the item-name lock (P3-14, P3-15, P3-13):
  `assertCustomAllowed(db, "customSkills")` and `("customConnectors")` → 403
  `catalog.custom_disabled`; a live item of that name with another owner → 409 `plugin.name_taken`
  `{ owner: Owner }`; `extension.name_conflict` gains `owner`; each dependency must resolve to a
  confirmed (`awaiting_confirmation = false`), non-disabled, non-deleted item usable by the org
  (scope `all` / `optional`, `named` with the org listed; org-owned ones only when shared with it) →
  else 409 `plugin.dependency_unavailable { dependencies: string[] }`. A platform (super admin) import
  of a name owned by an org → 409 `plugin.name_taken` too.
- Until Task 6, confirm of a package with an extension answers 501 `plugin.extension_upload_pending`
  (Task 6 removes this guard and the code).

- [ ] **Step 1: Write the failing tests** in `org-upload.test.ts` (fixture tgz from `packFixture` of a
  skills-only plugin, and one with a connector template):
  - `org admin uploads a declarative plugin` — prepare → review lists the skills; confirm → `outcome:
    "installed"`, item `owner = orgA`, scope `named: [orgA]`, `shareable` as sent; after the scope sync
    the skill is in orgA's usable set and absent from orgB's.
  - `member cannot upload` — 403; guest 403.
  - `staging is per org` — orgB's `GET …/uploads/:stagingId` of orgA's staging → 404;
    `GET admin/catalog/imports/:stagingId` of it → 404; the admin staging id on the org route → 404.
  - `custom deny refuses` — `customSkills = deny` → 403 `catalog.custom_disabled` at prepare; same for
    `customConnectors = deny` with a skills-only package.
  - `taken names name the owner` — a platform item `foo` → 409 `plugin.name_taken` with
    `owner.kind = "platform"`; an orgB item `bar` → `{ kind: "org", name: "B" }`; the super admin
    importing `bar` → 409 naming B.
  - `name race between two orgs` — orgA and orgB both prepare `baz`; orgA confirms; orgB's confirm →
    409 `plugin.name_taken` naming A; no `baz` item or version written for B; B's staging row remains
    until it expires.
  - `dependency must be usable by the org` — a dependency named for orgC only → 409
    `plugin.dependency_unavailable`; an optional platform dependency → accepted.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** the owner mode and the routes; the upload route's body handling is the
  one `POST admin/catalog/import/file` uses (raw stream, `packages.maxBytes`).
- [ ] **Step 4: Run** the test plus `packages/kernel/test/catalog/{plugin-import,
  plugin-review-hash,catalog}.test.ts` and the web proxy test (an org upload path streams, a
  non-matching path does not); expected PASS.
- [ ] **Step 5: Commit** `feat: org admins upload plugins without an extension`.

### Task 5: Owner updates without an extension

**Files:**
- Modify: `catalog/plugin-upgrade.ts` (`PlatformPluginUpdater`), `catalog/org-plugin-uploads.ts`,
  `catalog/plugin-import.ts` (owner commit of a new version)
- Test: `packages/kernel/test/catalog/org-upload-update.test.ts`

**Interfaces — consumes:** Task 4's owner mode, `notifySharedUpdate` (Task 3). **Produces:**
- `PlatformPluginUpdater.previewForOwner(orgId: string, itemId: string, version: string):
  Promise<PlatformUpdatePreview>` and `updateAsOwner(orgId: string, actor: string, itemId: string,
  version: string, diffHash: string): Promise<PlatformUpdateResult>` — authorize the org admin of the
  owner org (not the super admin), refuse a target with an extension (that path is Task 6), otherwise
  the platform update as today.
- The org prepare of an existing own item fills `update` with `previewForOwner`; the org
  `reviewHash` for a new version covers the update's `diffHash` (one hash, P3-12).
- Org confirm of a new version without an extension: commit the version, then `updateAsOwner`;
  `outcome: "updated"`; in the update's transaction `notifySharedUpdate(plugin)` and, for each
  changed component, nothing more (one notice per plugin).
- A failed update leaves the version imported (`latest_version` moved, platform version not); the
  same tgz uploaded again yields a review whose confirm retries the update.

- [ ] **Step 1: Write the failing tests**:
  - `owner update applies at once and reaches every org` — orgA's plugin shared with orgB (on);
    orgA uploads v2 adding a skill → `outcome: "updated"`, the skill is usable in A and B; B has one
    `shared_item_updated` (from 1.0.0 to 2.0.0); A none.
  - `a version dropping the extension applies at once` — v1 confirmed with an extension (seeded
    through Task 6's path or directly), v2 without → updated; the extension is uninstalled.
  - `a failed update retries on re-upload` — an update that fails (a skill clash in orgB, P2-3) →
    error, platform version unchanged; after removing the clash, uploading the same tgz again and
    confirming → updated.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `packages/kernel/test/catalog/platform-update.test.ts`; expected
  PASS.
- [ ] **Step 5: Commit** `feat(kernel): owner updates of org plugins`.

### Task 6: Org uploads with an extension: pending until the super admin confirms

**Files:**
- Modify: `catalog/plugin-import.ts` (owner commit with an extension: no `approve`, no `deploy`,
  name claim), `catalog/catalog-scope.service.ts` (`confirmPermissions` for org-owned pending items,
  new `reject`), `catalog/admin-catalog.controller.ts` (`POST items/:id/reject`),
  `catalog/org-plugin-uploads.controller.ts` (`DELETE …/owned-plugins/:id/pending`),
  `catalog/scope-sync.ts`, `catalog/org-catalog.service.ts`, `catalog/plugin-install.ts`,
  `catalog/platform-migration.ts`, `catalog/plugin-upgrade.ts` (generic update refuses a pending
  version), `catalog/catalog.service.ts` (`pending` filter), `inbox/platform-inbox.service.ts`
  (`org_upload_pending`), error registry
- Test: `packages/kernel/test/catalog/org-upload-extension.test.ts`

**Interfaces — consumes:** Tasks 2-5. **Produces:**
- Owner commit with an extension (P3-10): first version → item with `awaiting_confirmation = true`,
  `pending_version = version`, `pending_by`, `pending_at`, no `syncPlatform`, no scope sync enqueue;
  new version → version row written, `pending_version = version`; both: the package stored, the
  extension name claimed in `extension_name_owners` under the install lock (another package owns it →
  409 `extension.name_conflict` with `owner`), no permission snapshot, no install. `outcome:
  "pending"`. A second upload while pending replaces `pending_version` (P3-11).
- `isUsable(item): boolean` = `!awaiting_confirmation && !deleted && !disabled`, in
  `catalog/ownership.ts`; read by the scope sync, the org switch and install, the org catalog list
  (awaiting items only for the owner, `state: "awaiting_confirmation"`), dependency resolution, the
  migration job (skips awaiting items) and the scope writers (409 `catalog.item_pending`).
- `CatalogScopeService.confirmPermissions(actor, itemId, permissionsHash)` for an org-owned item with
  `pending_version`: the digest of the **pending** version's package; first version → install,
  approve, enable, `syncPlatform`, clear pending, enqueue the scope sync; new version → approve the
  new package, then the platform update to `pending_version` (as `update` with a computed `diffHash`),
  clear pending, `notifySharedUpdate`; both → `upload_confirmed` to the owner. Each step re-reads the
  item `FOR UPDATE` and stops with 409 `catalog.item_removed` when it is gone (P3-21).
- `CatalogScopeService.reject(actor, itemId, reason: string | null)` and the owner's withdraw: first
  version → item soft-deleted, name claim released when nothing is installed under it; new version →
  pending cleared (the version row stays, never applied); `upload_rejected` to the owner (not on a
  withdraw). Nothing pending → 409 `extension.not_pending`.
- `PUT admin/catalog/items/:id/update` with `version = pending_version` of an org item → 409
  `catalog.item_pending`.
- Platform inbox: pending org-owned items are `{ type: "org_upload_pending"; id; createdAt; item:
  CatalogItemView }` and no longer `permission_confirmation`.

- [ ] **Step 1: Write the failing tests** (fixture: a plugin with an extension registering one tool and
  one skill, versions 1.0.0 and 2.0.0 with different code):
  - `first version stays pending and unusable` — confirm → `outcome: "pending"`; no
    `extension_installs` row; the extension's tool and the skill absent in orgA (usable sets, tool
    list); running the scope sync job and the `platform-components-migrate` job changes nothing;
    `GET orgs/orgA/catalog` shows it awaiting; orgB sees nothing; `GET admin/catalog/items?
    pending=true` and `GET admin/inbox` show it with `owner` A as `org_upload_pending`.
  - `pending items are not dependencies` — another orgA upload depending on it → 409
    `plugin.dependency_unavailable`.
  - `super admin confirm deploys it` — confirm with the digest → installed, enabled, skill usable in A
    after the sync; A has `upload_confirmed`.
  - `every new version with an extension waits` — v2 uploaded → `pending`; the running extension is
    still v1's sha; the generic update route to 2.0.0 → 409 `catalog.item_pending`; confirm → v2's
    sha installed; orgB (shared, on) has `shared_item_updated`.
  - `a replaced pending version is stale` — v2 pending, then v3 uploaded; confirming with v2's digest
    → 409 `extension.approval_stale`; with v3's → installs v3.
  - `reject and withdraw` — reject v1 with a reason → item gone, A has `upload_rejected` with the
    reason, another org can now upload the name; withdraw of a pending v2 → pending cleared, v1 keeps
    running, no notice.
  - `extension name race` — orgA's `p1` and orgB's `p2` both carry extension `x`; A confirms first;
    B's confirm → 409 `extension.name_conflict` naming A; nothing of `p2` written.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement**; remove Task 4's 501 guard.
- [ ] **Step 4: Run** the test plus `packages/kernel/test/catalog/{scope-sync,platform-migration,
  platform-update,platform-inbox}.test.ts`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): org uploads with an extension wait for the super admin`.

### Task 7: Org-owned plugins: 可共享, delete and transfer

**Files:**
- Create: `packages/kernel/src/catalog/owned-items.ts` (`OwnedItems` provider),
  `packages/kernel/src/catalog/owned-plugin-cleanup.ts` (queue consumer and daily sweep, provided only
  by a module that only `WorkerModule` imports)
- Modify: `catalog/org-plugin-uploads.controller.ts`, `catalog/catalog.module.ts` and the worker
  module wiring, `catalog/job-ids.ts`, error registry (`catalog.preview_stale` 409)
- Test: `packages/kernel/test/catalog/owned-plugins.test.ts`

**Interfaces — consumes:** Tasks 2, 3, 6. **Produces:**
```
PUT  /api/v1/orgs/:orgId/owned-plugins/:id/shareable        { shareable: boolean }   (catalog.upload)
POST /api/v1/orgs/:orgId/owned-plugins/:id/delete/preview   → { outcome: "removed" | "transferred",
     orgs: { id: string; name: string }[], agents: { id: string; name: string }[], previewHash }
POST /api/v1/orgs/:orgId/owned-plugins/:id/delete           { previewHash }  → 204
```
(another org's or a platform item → 404; a stale hash → 409 `catalog.preview_stale`).
- `OwnedItems.setShareable(orgId, actor, ref: OwnedRef, shareable: boolean)` — writes the item and
  (for a plugin) all its component rows in one transaction (P3-2).
- `OwnedItems.usedByOthers(ref: OwnedRef): Promise<{ id: string; name: string }[]>` (P3-18).
- `@Transactional({ propagation: "mandatory" }) OwnedItems.transferOrRemove(ref: OwnedRef, reason:
  "owner_deleted" | "org_deleted", actor: string | null): Promise<"transferred" | "removed">` —
  transferred: `owner_org_id = null` on the item and its components, the former owner removed from
  the list (and its switches), `addPlatformNotice`; removed: soft delete as `catalog.remove` does, plus
  `afterCommit` enqueue of job `owned-plugin-cleanup-<itemId>` on `cap-kernel-maintenance`.
- `OwnedPluginCleanup.run(itemId)`: uninstalls the item's extension when no live item references its
  name and releases the name claim; idempotent. A daily `@LockedCron` `owned-plugin-cleanup-sweep`
  runs it for every removed org-owned item whose extension is still installed.

- [ ] **Step 1: Write the failing tests**:
  - `shareable toggles the plugin and its components` — `PUT …/shareable {true}` → item and its
    platform skill rows `shareable = true`; a member → 403; orgB on orgA's item → 404.
  - `delete an unshared plugin removes it` — preview `outcome: "removed"`, `orgs: []`, `agents` lists
    orgA's agent using its skill; delete → item gone; the cleanup job (run in the test) uninstalls its
    extension.
  - `delete a shared plugin transfers it` — on in orgB → preview `transferred`, `orgs: [B]`; delete →
    `owner = platform`, orgA no longer listed (its skill gone from A), orgB unchanged; `GET
    admin/inbox` has `ownership_transferred` (reason `owner_deleted`); the extension stays installed.
  - `stale preview` — orgC turned it on after the preview → 409 `catalog.preview_stale`.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement**; `pnpm check:kernel-conventions` passes (`kc-worker-only`).
- [ ] **Step 4: Run** the test and `pnpm check:kernel-conventions`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): org-owned plugins can be shared, deleted or transferred`.

### Task 8: Promote on share for org skills and agent templates

**Files:**
- Create: `packages/kernel/src/catalog/component-promotion.ts` (`ComponentPromotion` provider)
- Modify: `catalog/component-scope.service.ts` (resolve an org row id, promote before show or
  associate, P3-23), `catalog/platform-components.ts` (`addOwnerVersion`), `skills/skills.service.ts`
  (`createVersionFromFiles` branch, `upload` accepts `shareable`, delete branch),
  `skills/changes.service.ts` (`SkillWrite` approvals use the same writer), `skills/skills.controller.ts`
  (`PUT :id/shareable`), `agents/templates.controller.ts` (`PUT :id/shareable`), `skills/usable.ts`
  and `agents/templates.ts` (a linked copy owned by the org is listed once), error registry
  (`catalog.not_owned` 409)
- Test: `packages/kernel/test/skills/promote-on-share.test.ts`

**Interfaces — consumes:** Tasks 2, 3, 7. **Produces:**
```
PUT /api/v1/orgs/:orgId/skills/:id/shareable            { shareable }  (skills.manage)
PUT /api/v1/orgs/:orgId/agent-templates/:id/shareable   { shareable }  (catalog.upload)
```
(only rows the org owns, P3-6: a linked copy of another owner's item or an agent-scope skill → 409
`catalog.not_owned`).
- `@Transactional({ propagation: "mandatory" }) ComponentPromotion.promote(kind: "skill" |
  "agent_template", orgRowId: string): Promise<string>` — idempotent (an already linked owned row
  returns its platform id); writes the platform row (`owner_org_id` = `origin_org_id` = the org,
  `shareable` from the org row, `scope_mode "own"`, scope `named`, `component_scope_orgs = [org]`,
  `shown_to_others = false`, `current_version` = the org row's), one version row at that number with
  files copied to `deployment/platform/{skills,agent-templates}/<id>/<version>/`, links the org row
  (no pin). The file copy runs before the transaction commits its link; a failed copy throws and
  nothing is linked.
- Admin `PUT admin/components/:kind/:id/shown {true}`, scope with orgs, add-org: an org row id →
  `assertShareable(orgRow)` then `promote`, then the action on the platform id; the response carries
  the platform `id`.
- `PlatformComponents.addOwnerVersion(kind, platformId, files, actor): Promise<number>` — the owner's
  new version (P3-4); `createVersionFromFiles` on an org row linked to a platform row owned by the
  same org calls it, then `notifySharedUpdate`.
- Owner skill delete on a promoted skill → `OwnedItems.transferOrRemove({ kind: "skill", id:
  platformId }, "owner_deleted", actor)` and the org row soft-deleted as today.

- [ ] **Step 1: Run** `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts
  packages/kernel/test/evals/rename-compat.test.ts`; record PASS as the baseline.
- [ ] **Step 2: Write the failing tests** in `promote-on-share.test.ts`:
  - `toggle only on owned rows` — `PUT …/shareable` on orgA's own skill → 200; on a linked copy of a
    platform skill → 409 `catalog.not_owned`; on an agent-scope skill → 409.
  - `unshared skills stay org rows` — `GET admin/components?kind=skill` lists it with `owner` A,
    `promoted: false`; `PUT admin/components/skill/<orgRowId>/shown {true}` while not shareable → 409
    `catalog.not_shareable`.
  - `promotion keeps ids and versions` — skill `report` at version 3 in orgA, used by agent X and
    pinned in X; shareable, then the super admin adds orgB → a platform skill with `current_version =
    3`, files under `deployment/platform/skills/`; the org row links to it; X's next run snapshot has
    the same skill id, version 3 and body, and no "Updated skills" line; orgB's agent can select the
    platform id and `Skill` loads the same body; the platform id is in orgA's usable set once (the
    copy), not twice.
  - `owner updates reach both` — orgA uploads `report` again (zip) → platform version 4; X sees
    version 4; orgB's agent sees 4; orgB has `shared_item_updated`; the org row has no pin.
  - `two orgs share one name` — orgA and orgB each promote their own `report` → two platform rows;
    associating orgB's with orgA → 409 `plugin.skill_conflict` (rule 10).
  - `owner deletes a shared skill` — B uses it → transferred to the platform, platform notice; A's row
    deleted; B keeps it.
  - `agent templates` — the same promotion for an org template keeps the id `subagent_started`
    recorded; a resumed child finds it.
- [ ] **Step 3: Run**; expected FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the new test, `packages/kernel/test/skills`, `packages/kernel/test/subagents`
  and the two evals tests of Step 1; expected PASS with the evals output unchanged.
- [ ] **Step 6: Commit** `feat(kernel): promote org skills and agent templates when shared`.

### Task 9: Org deletion transfers or removes what the org owns

**Files:**
- Modify: `orgs/orgs.service.ts` (`softDeleteIn` calls `OwnedItems.onOrgDeleted`), `catalog/owned-items.ts`,
  `orgs/orgs.module.ts` (imports the provider's module; no cycle: `OwnedItems` must not inject
  `OrgsService`)
- Test: `packages/kernel/test/orgs/org-delete-owned.test.ts`

**Interfaces — consumes:** Tasks 6, 7, 8. **Produces:**
- `@Transactional({ propagation: "mandatory" }) OwnedItems.onOrgDeleted(orgId: string, actor: string):
  Promise<{ transferred: number; removed: number }>` — locks the org's owned items `FOR UPDATE`; for
  each plugin and promoted component: `transferOrRemove(ref, "org_deleted", actor)`; an awaiting
  first version → removed (claim released by the cleanup job); a pending new version of a
  transferred item → pending cleared; unpromoted org rows are left (they go with the org as today).

- [ ] **Step 1: Write the failing tests**:
  - `shared items survive their org` — orgA owns a plugin on in orgB and a promoted skill used in orgB,
    plus an unshared plugin; delete orgA → the shared ones are platform-owned and still usable in B;
    two `ownership_transferred` notices (reason `org_deleted`); the unshared plugin is removed and its
    extension uninstalled after the cleanup job; storage purge of `kernel/<orgA>/` leaves the
    promoted files readable.
  - `upload confirmed after its org was deleted` — orgA prepares, the org is deleted, then confirm →
    404; no item written.
  - `pending upload of a deleted org` — awaiting first version; delete orgA → item removed, its
    extension name free for another org; `GET admin/inbox` no longer lists it.
  - `confirmation racing the deletion` — run `confirmPermissions` with the org deletion committed
    between its install step and its final step (a test seam hook or two transactions driven by the
    test) → 409 `catalog.item_removed`; after the cleanup job no extension of that name is installed.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `packages/kernel/test/orgs`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): an org's shared items outlive the org`.

### Task 10: 新建技能 from text

**Files:**
- Modify: `skills/skills.controller.ts` (`POST /orgs/:orgId/skills` body union), `skills/skills.service.ts`
  (`createFromText`), `skills/package.ts` (reuse `readSkillPackage` on the built files)
- Test: `packages/kernel/test/skills/create-from-text.test.ts`

**Interfaces — produces:**
- Body `CreateSkillBody = { uploadId: string; shareable?: boolean } | { name: string; description:
  string; body: string; shareable?: boolean }` (`createZodDto`; `description` ≤ the manifest limit,
  `body` ≤ the `SKILL.md` limit `readSkillPackage` applies).
- `SkillsService.createFromText(orgId, actor, input: { name; description; body; shareable? }):
  Promise<SkillView>` — builds `SKILL.md` as
  `---\nname: <name>\ndescription: <description as a YAML string>\n---\n\n<body>`, validates it with
  `readSkillPackage`, then the same path as an upload (`assertCustomAllowed(db, "customSkills")`,
  ruling P2-3, one live name per org with the same error code the zip upload answers today).

- [ ] **Step 1: Write the failing tests** — `creates a skill from text` (the skill's version 1
  `SKILL.md` round-trips name, description and body; `Skill` loads it in an agent of the org);
  `description with a colon stays valid YAML`; `customSkills deny → 403`; `a platform skill offered to
  the org with that name → 409 plugin.skill_conflict`; `an invalid name → 400 validation_failed`;
  `shareable: true is stored`; `the upload form still works`.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `packages/kernel/test/skills`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): create a skill from text`.

### Task 11: Web, workspace 插件: upload, pending, 可共享 and delete

**Files:**
- Create: `apps/web/src/components/PluginReviewBody.tsx` (the review body extracted from
  `app/(app)/admin/plugins/import/view.tsx`, used by both), `apps/web/src/components/OrgPluginUploadDialog.tsx`,
  `apps/web/src/components/OwnedItemDeleteDialog.tsx`
- Modify: `app/(app)/plugins/view.tsx`, `app/(app)/plugins/[itemId]/view.tsx`,
  `app/(app)/admin/plugins/import/view.tsx`, `lib/catalog.ts` (`uploadOrgPluginPackage`,
  `confirmOrgUpload`, `setOwnedShareable`, `previewOwnedDelete`, `deleteOwned`, `withdrawPending`),
  `lib/query/keys.ts`, `lib/query/routes.ts` if a route reads more, `messages/{zh,en}.json`
- Test: `apps/web/test/org-plugin-upload.test.tsx`

**Interfaces — consumes:** Tasks 4-7 routes; `CatalogItemView.owner / shareable /
awaitingConfirmation / pendingVersion`.

UI (zh copy fixed here; en equivalents in the messages):
- 插件 page head action **上传插件包** (org admins only; accepts `.tgz` and `.zip`; a `.zip` goes to
  the skill upload and lands on 技能). The dialog: upload → review (`PluginReviewBody` in org mode:
  no scope picker; 范围：仅本组织; a 可共享 switch, default off; with an extension the notice
  「此插件包含扩展，扩展代码在平台内核进程中运行。超级管理员确认后才会启用。」) → confirm. Outcome
  `pending` → toast 「已提交，等待超级管理员确认」.
- Row and detail state **等待超级管理员确认** for awaiting items; for a pending new version
  「新版本 {version} 等待超级管理员确认」; action 撤回 (withdraw).
- Owned plugin detail: chip 本组织上传; 可共享 switch with the help text 「开启后，超级管理员可以向其他
  组织展示或开放此插件。关闭不影响已开放的组织。」; 删除 opens `OwnedItemDeleteDialog` with the
  preview (「其他组织仍在使用，删除后将转为平台所有：{orgs}」 or 「删除后不可恢复」, plus the agents
  that lose it).
- Error refusals show the owner: 「名称已被 {owner} 使用」 (owner 平台 or the org name).
- Members see the states, no actions.

- [ ] **Step 1: Write the failing tests** (`renderRouteWithCache`): admin sees 上传插件包, member does
  not; the dialog's confirm posts `reviewHash` and `shareable`; an awaiting item shows 等待超级管理员确认
  and 撤回; the shareable switch calls the route and invalidates the plugin queries; delete shows the
  transferred wording with the org names; `plugin.name_taken` shows the owner's name.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/org-plugin-upload.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement**; admin import still renders through `PluginReviewBody`.
- [ ] **Step 4: Run** the test, `apps/web/test/admin.test.tsx`, `pnpm check:web-ui`,
  `pnpm check:i18n`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): org plugin uploads on the workspace 插件 page`.

### Task 12: Web, workspace 技能 / 智能体模板 / inbox: 新建技能, 可共享, notices

**Files:**
- Create: `apps/web/src/components/SkillCreateDialog.tsx`
- Modify: `app/(app)/skills/view.tsx`, `app/(app)/skills/[id]/view.tsx`,
  `app/(app)/agent-templates/view.tsx`, `app/(app)/inbox/view.tsx` (new notice kinds),
  `lib/skills.ts` (`createSkillFromText`, `setSkillShareable`), `lib/agent-templates.ts`
  (`setTemplateShareable`), `lib/inbox.ts`, `lib/query/keys.ts`, `messages/{zh,en}.json`
- Test: `apps/web/test/skills.test.tsx`, `apps/web/test/inbox.test.tsx`

UI:
- 技能 page head: **新建** next to 上传 (org admins). `SkillCreateDialog`: 名称, 描述, 内容
  (SKILL.md 正文, multiline), 可共享 switch; submit → the skill detail.
- The org's own skills and templates: 可共享 switch (detail inspector); not shown on linked copies or
  platform items. Deleting a shared skill shows the transfer wording of Task 11.
- Inbox items: `item_shared` 「{org} 现在可以使用 {name}」 / 「所有组织现在可以使用 {name}」;
  `shared_item_updated` 「{owner} 更新了 {name}：{from} → {to}」; `upload_confirmed`
  「超级管理员已确认 {name} {version}」; `upload_rejected` 「超级管理员未通过 {name} {version}」 with the
  reason when present.

- [ ] **Step 1: Write the failing tests**: 新建 is admin-only; the dialog posts `{ name, description,
  body, shareable }` and navigates to the new skill; the 可共享 switch appears on an own skill and not
  on a platform one; each new inbox kind renders its text.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): create skills from text and share org items`.

### Task 13: Web, admin console: owners, the share gate, 待确认 and the inbox

**Files:**
- Modify: `app/(app)/admin/plugins/view.tsx` (owner chip, tab filter 组织创建 includes org plugins),
  `app/(app)/admin/plugins/[itemId]/view.tsx` (scope actions gated), `app/(app)/admin/plugins/pending/view.tsx`
  (owner org, `from → to`, 拒绝 with a reason), `components/AdminComponents.tsx` (`useOwnerTabs`:
  org items actionable when shareable), `components/PluginScopeDialog.tsx`,
  `app/(app)/admin/inbox/view.tsx` (`org_upload_pending`, `ownership_transferred` with 知道了),
  `lib/catalog.ts` (`rejectPending`), `lib/admin-inbox.ts` (`dismissPlatformNotice`),
  `messages/{zh,en}.json`
- Test: `apps/web/test/admin-components.test.tsx`, `apps/web/test/admin.test.tsx` (pending)

UI:
- Org-owned rows show 归属：{org}; when not shareable the show / associate / widen actions are absent
  and the row says 「该组织未开放共享」; narrowing and 停用 stay.
- 待确认 rows of org uploads: 「{org} 上传」, 新插件 or 「更新 {from} → {to}」, the extension
  notice, actions 确认 and 拒绝 (a dialog with an optional 原因).
- Admin inbox: 「{org} 上传了 {name}，等待确认」; 「{name} 已转为平台所有（{org} 已删除它 / {org}
  已被删除），仍有 {count} 个组织在使用」 with 知道了 (dismiss).

- [ ] **Step 1: Write the failing tests**: a non-shareable org skill has no 向其他组织显示 action; a
  shareable one does and calling it invalidates the components list (the id may change to the
  platform id); the pending tab shows the owner org and 拒绝 posts the reason; the inbox renders both
  new kinds and dismisses.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): org-owned items in the admin console`.

### Task 14: Docs, changesets, verify

**Files:** `AGENTS.md` (the catalog and plugins bullets: org uploads, owner, share gate, pending
confirmation, transfer), `.agents/skills/writing-plugins/SKILL.md` (org upload routes, owner mode,
pending state, P3-10 to P3-14), `.agents/skills/writing-kernel-api/SKILL.md` only if a convention
changed, `.agents/skills/replay-evals/SKILL.md` (promotion keeps id and version: no drift),
`docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` (status: phase 3
implemented, migration 0083; rulings added during implementation appended to §14.2),
`.changeset/org-uploads-sharing.md` (`@capybara-hq/kernel` minor, `@capybara-hq/web` minor).

- [ ] **Step 1:** Update the docs; keep `check:skills-frontmatter` and `check:terms` green.
- [ ] **Step 2:** Run `pnpm -s verify --json`; expected every check passes (lint, typecheck, check,
  the affected tests).
- [ ] **Step 3: Commit** `docs: org uploads, sharing and new skills`.
