# Account profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository it runs under the `wave-planned-subagent-development` skill.

**Goal:** A person changes their own display name and avatar at `/account/profile`, and every
place that shows a person shows a circle avatar beside the name.

**Architecture:**
- `accounts.avatar` (jsonb) plus a new `account_avatar_uploads` table hold the uploaded image,
  whose object lives under `deployment/account-avatars/<accountId>/<uploadId>`. The SSO fallback is
  read from `identities.profile.avatarUrl`.
- One kernel helper turns a row into `avatarUrl`
  (`/api/v1/accounts/<id>/avatar?v=<ver>` or `null`), and one batched lookup turns account ids into
  `PersonRef { id, name, avatarUrl }`. Every person-carrying response uses one of the two.
- One guarded route 302s to a short presigned GET or the SSO https URL.
- The design package gains `Avatar shape="circle"` and `PersonName`, plus person slots in the
  conversation components. The web gets the profile page and moves every person surface onto a
  shared `Person` wrapper.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely / PostgreSQL, zod (`createZodDto`),
vitest, Next + TanStack Query web, `@capybara-hq/design` (jsdom tests, reference set, `/dev/ui`).

**Spec:** `docs/superpowers/specs/2026-11-20-account-profile-design.md`.

## Global Constraints

**Run and test rules:**
- Run tests from the worktree root: `pnpm exec vitest run <path>`.
- A new kernel unit test joins `packages/kernel/test/unit-tests.json` in the same commit.
  Integration is the default; no container tests are planned.
- No fixed sleeps and no per-test timeouts. Integration tests use one app per file.

**Code rules:**
- English comments, identifiers and test titles. Translate the comments and titles you edit
  (`pnpm check:english-comments --base origin/main`).
- Kernel: `@Injectable` providers with explicit `@Inject` on every constructor parameter; DTOs via
  `createZodDto` with `@ZBody` / `@ZParam`; writes in `@Transactional()`; audit through
  `audit(this.db.db, …)` inside the transaction; new error codes registered in
  `packages/kernel/src/errors.ts` `ERROR_CODES` (`pnpm check:kernel-conventions`).
- Web: no styles in `apps/web`; every read is a `defineQuery`, every write a `useAppMutation`; thin
  `page.tsx` + client `view.tsx` (`pnpm check:web-ui`). Design changes go into
  `docs/design/spec.md` first, with reference blocks and catalog blocks.
- UI text through i18n in zh and en (`pnpm check:i18n`). zh says 个人资料 / 头像 / 名称, never 企业
  or the Latin word `agent`.

**Values from the spec:**

| Item | Value |
|---|---|
| Upload types | `image/png`, `image/jpeg`, `image/webp` (reuse `AGENT_AVATAR_CONTENT_TYPES`) |
| Upload max | 2 MB (`AGENT_AVATAR_MAX_BYTES` = 2 × 1024 × 1024) |
| Unbound upload expiry | 24 h (`AGENT_AVATAR_TTL_HOURS`) |
| Pending uploads per account | 10 (mirrors `MAX_PENDING_AGENT_AVATARS`) |
| Presigned GET | 300 s (`AGENT_AVATAR_DOWNLOAD_TTL_SECONDS`), `disposition: "inline"`, `responseContentType` from the row |
| Avatar route cache header | `cache-control: private, max-age=60` |
| Object key | `account-avatars/<accountId>/<uploadId>` on `StorageService.deployment()` (full key `deployment/account-avatars/…`) |
| `avatarUrl` | `/api/v1/accounts/<id>/avatar?v=<ver>`; `<ver>` = first 10 chars of base64url sha256 of `upload:<uploadId>` or `sso:<url>`; `null` = draw the initial |
| Display name on PATCH | trimmed, 1–64 code points, checked only when the trimmed value differs from the stored one (trimmed) |
| Audit | `account.profile_updated`, actor = the account; `detail` = `{ displayName?: <new name>, avatar?: "upload" \| "removed" }` (never the image) |
| Person sizes | `PersonName` 16 in lines, cells and options; 24 in rows that lead with the person; sidebar row 24, me panel 40, profile page 64 |
| Departed person | zh `已离开的成员`, en `Former member`, with the initial |

**Process:**
- Migration: next free number at implementation time (today `0169`). Check
  `git ls-tree origin/main packages/kernel/src/migrations/` first; `pnpm check:applied-migrations --base origin/main`.
- Changesets: `@capybara-hq/kernel` patch (Task 12, covering Tasks 1, 3, 4, 6 and 7) and
  `@capybara-hq/web` patch (fixed with `@capybara-hq/capybara`; Task 12, covering design and web).
- Visual baselines and reference PNGs: only through the `reference-update` and `visual-update`
  workflows, never committed from a local render.

## Review Focus

1. **A viewer who may not read the image gets an `avatarUrl`:** a guest sees an approval decided by
   a super admin outside the org, so the route answers 404. Expected: the initial shows, with no
   broken image and no retry loop. Task 2 tests `PersonName` falling back on `onImageError`;
   Task 4 tests the 404.
2. **Legacy long names:** an SSO account named with 80 characters changes only its avatar, or
   resends its unchanged name. Expected: the save passes. Task 3 tests both cases, on
   `/me/profile` and on the admin PATCH.
3. **Replacing twice, or two tabs saving:** two PATCHes bind two different uploads. Expected:
   exactly one upload is bound, every other upload of the account has an expiry, and the cleanup
   deletes the orphan objects. Task 3 tests sequential replace plus the expiry of the loser.
4. **Hostile or stale SSO values:** an `http:` URL, a malformed URL, a `javascript:` URL, or a
   newer identity without an avatar next to an older one with an avatar. Expected: only `https:`
   counts, and the most recently refreshed identity with an https avatar wins. Task 1 unit-tests
   the helper; Task 1 integration-tests the ordering.
5. **A live event naming someone the page has not resolved:** an admin stops the run while the
   owner watches. Expected: the row names the admin once the events tail is refetched, and never
   shows a raw id. Task 11 tests that an unknown id in an SSE frame triggers the refetch and that a
   still-unknown id renders "已离开的成员".

---

## Wave plan (copy to the ledger)

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Data, helper, `/me` + admin `avatarUrl` | — | migration, kernel-schema.ts, new identity/account-avatar.ts, external.ts, me.controller.ts (GET), admin.controller.ts | high (migration) | 1 | alone, most capable |
| 2 Avatar circle, PersonName, shell rows | — | docs/design/spec.md, reference/src, design display/shell, design tests, dev catalog | normal | 1 | batch |
| 3 Uploads, `PATCH /me/profile`, name rule, cleanup | 1 | new identity/account-avatars.service.ts, me.controller.ts, me.schemas.ts, accounts.ts, admin.schemas.ts, errors.ts, exclusions.ts, worker.module.ts, identity.module.ts | high (storage, multi-replica) | 2 | alone, most capable |
| 5 Design person slots | 2 | docs/design/spec.md, conversation bubble / hitl / run-row, select, schedule-calendar, design tests, catalog | normal | 2 | batch |
| 6 `avatarUrl` on person-carrying responses | 1 | members, audit-log, shares, admin-agents, admin-connectors, catalog requests, skill changes, schedules, devices | normal | 2 | batch |
| 7 Person shapes for id-only responses | 1 | approvals, questions, background store, conversations controller/service, trajectory | normal | 2 | batch |
| 4 Avatar read route (trust boundary) | 1, 3 | new identity/account-avatar.controller.ts, http/api.module.ts, exclusions.ts, ui embed test | **high** | 3 | **alone, most capable** |
| 8 Profile page, `Person` wrapper, shell wiring | 2, 3 | app/(app)/account/profile, settings-nav.ts, routes.ts, lib/session.ts, lib/profile.ts, components/Person.tsx, messages | normal | 3 | batch |
| 9 Web: settings and admin surfaces | 5, 6, 8 | members, admin accounts, owner pickers, agent owner, audit, shares, admin connectors, inbox requesters, schedules, devices | normal | 4 | batch |
| 10 Web: conversation surfaces | 5, 7, 8 | ApprovalCard, QuestionCard, SubagentWait, Thread, TrajectoryParts, trajectories view, who-waits, lib/conversations/approvals/questions/trajectories | normal | 4 | batch |
| 11 Live-frame person refetch | 10 | useConversation / stream wiring | normal | 5 | batch |
| 12 Docs, changesets, baselines, verify | all | skills, changesets, catalog accepted list | normal | 5 | controller |

Wave 2 note: Task 3 owns `packages/kernel/src/platform/exclusions.ts` for its two routes; Task 4
adds its own entry in wave 3. Task 8 owns `apps/web/messages/{zh,en}.json`; Tasks 9 and 10 add
keys only if they cannot reuse existing ones, and then in the fix dispatch after the wave.

---

### Task 1: Data, avatar helper, `avatarUrl` on `Account` views (high risk: migration)

**Files:**
- Create: `packages/kernel/src/migrations/0171_account_avatar.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts`: `AccountsTable.avatar`, the new
  `AccountAvatarUploadsTable`, `IdentitiesTable.updated_at`.
- Create: `packages/kernel/src/identity/account-avatar.ts`
- Modify: `packages/kernel/src/identity/external.ts`: `refreshIdentity` (~:258) and
  `insertIdentity` set `updated_at = now()`.
- Modify: `packages/kernel/src/identity/me.controller.ts` (`GET /me` returns `AccountView`).
- Modify: `packages/kernel/src/admin/admin.controller.ts` (accounts list / create / update return
  `AccountView`).
- Modify: `packages/kernel/src/platform/ops/accounts.ops.ts`, if it returns the controller's
  shape.
- Test: `packages/kernel/test/identity/account-avatar.test.ts` (unit; add to
  `packages/kernel/test/unit-tests.json`), `packages/kernel/test/identity/account-people.test.ts`
  (integration), `packages/kernel/test/migrations/0171.test.ts`

**Interfaces:**
- Produces (all in `identity/account-avatar.ts`):

  ```ts
  export type AccountAvatar = { kind: "upload"; uploadId: string };
  export interface PersonRef { id: string; name: string; avatarUrl: string | null }
  export type AccountView = Account & { avatarUrl: string | null;
    /** Where the shown image comes from: the person's upload, or the identity source (e.g. "lark:t1"). */
    avatarSource: { kind: "upload" } | { kind: "identity"; source: string } | null };
  /** Pure: own upload first, else an https SSO URL, else null. */
  export function accountAvatarUrl(row: { id: string; avatar: AccountAvatar | null;
    ssoAvatarUrl: string | null }): string | null;
  /** The https `avatarUrl` of the account's most recently refreshed non-local identity, or null. */
  export function safeSsoUrl(raw: unknown): string | null;
  /** The row keys `avatarColumns(eb, alias, as)` adds, typed from the prefix literal. */
  export type AvatarColumnsRow<P extends string> =
    { [K in `${P}_avatar`]: AccountAvatar | null } & { [K in `${P}_sso_avatar_url`]: string | null };
  /** Kysely select fragment for any query already joined to `accounts` as `alias`:
   *  `<alias>.avatar` as `<as>_avatar` and a correlated subquery as `<as>_sso_avatar_url`.
   *  The required prefix keeps two people in one row (and other `avatar` columns) apart. */
  export function avatarColumns<P extends string>(eb: ExpressionBuilder<KernelDatabase, any>,
    alias: string, as: P): readonly [/* `${P}_avatar` */, /* `${P}_sso_avatar_url` */];
  /** Reads what `avatarColumns(eb, alias, as)` added to a row: the person's avatarUrl. */
  export function personAvatarUrl<P extends string>(row: AvatarColumnsRow<P>, as: P, id: string):
    string | null;
  /** One query: ids → PersonRef (missing ids are absent from the map). */
  export function loadPeople(db: Kysely<KernelDatabase>, ids: readonly string[]):
    Promise<Map<string, PersonRef>>;
  export function withAvatarUrls(db: Kysely<KernelDatabase>, accounts: readonly Account[]):
    Promise<AccountView[]>;
  ```
- The SSO subquery: `identities` where `account_id = <alias>.id`, `source <> 'local'`,
  `profile->>'avatarUrl' LIKE 'https://%'`, order `updated_at DESC NULLS LAST, created_at DESC`,
  limit 1. The TS side still parses it with `safeSsoUrl` (`new URL(…).protocol === "https:"`).
- `Account` (the principal's type) is unchanged: the per-request auth query gains nothing.

- [ ] **Step 1: Migration test** `0171.test.ts`. It runs twice and is idempotent;
  `accounts.avatar` is nullable jsonb; `account_avatar_uploads` columns are exactly those of spec
  §5.1 (`id text PK`, `account_id … REFERENCES accounts(id) ON DELETE CASCADE`,
  `storage_key text NOT NULL`, `content_type text NOT NULL`, `size bigint`,
  `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready'))`,
  `expires_at timestamptz NULL`, `created_at timestamptz NOT NULL DEFAULT now()`), plus an index on
  `(account_id)` and a partial index on `(expires_at) WHERE expires_at IS NOT NULL`;
  `identities.updated_at timestamptz NULL`; deleting an account cascades its upload rows.
- [ ] **Step 2: Unit tests** (`account-avatar.test.ts`):
  - an upload gives `/api/v1/accounts/a1/avatar?v=` plus 10 base64url chars;
  - the same upload id gives the same `v`, and another id gives another;
  - an upload wins over an SSO URL;
  - an SSO `https://idp/x.png` alone gives a URL whose `v` differs from the upload one;
  - `http://…`, `javascript:alert(1)`, `"not a url"` and `null` give `null`;
  - no avatar and no SSO gives `null`.
- [ ] **Step 3: Integration tests** (`account-people.test.ts`, PG only):
  - `loadPeople` returns name and `avatarUrl` for two accounts and omits an unknown id;
  - of two lark identities, the one refreshed later wins (`refreshIdentity` sets `updated_at`);
  - a newer identity without an avatar does not hide an older one with an https avatar;
  - a `local` identity is ignored;
  - `GET /api/v1/me` and `GET /api/v1/admin/accounts` carry `avatarUrl` and `avatarSource` (both
    `null` for a fresh local account; `{ kind: "identity", source: "lark:t1" }` with only an SSO
    avatar).
- [ ] **Step 4:** Run them:
  `pnpm exec vitest run packages/kernel/test/identity/account-avatar.test.ts packages/kernel/test/identity/account-people.test.ts packages/kernel/test/migrations/0171.test.ts`.
  Expected: FAIL.
- [ ] **Step 5:** Write the migration (only `ADD COLUMN IF NOT EXISTS` / `CREATE … IF NOT EXISTS`;
  no destructive statement), the schema types, the helper and the `updated_at` writes. Then wire
  `withAvatarUrls` into `GET /me` and the admin account routes.
- [ ] **Step 6:** Run the tests again, then `pnpm check:migrations`, `pnpm typecheck`. Expected:
  PASS.
- [ ] **Step 7:** Commit
  `feat(kernel): account avatar column, upload table and avatar URL helper`.

### Task 2: Avatar circle, `PersonName`, shell account rows (design)

**Files:**
- Modify: `docs/design/spec.md`:
  - §6.30: the person variant (`shape="circle"`, no presets; the initial `muted` on `selected`);
  - a new §6.50 PersonName with `<!-- states: person-name -->` and `<!-- size-table: person-name -->`;
  - §6.48 MePanel and the sidebar account row (§4 shell): the circle `Avatar` 40 / 24.
- Modify: `docs/design/reference/src/avatar.html` (blocks `avatar-person`); create
  `docs/design/reference/src/person-name.html` (blocks `person-name-sizes`,
  `person-name-image`, `person-name-ellipsis`, `person-name-secondary`).
- Modify: `packages/design/src/display/avatar.tsx` (`shape` prop); create
  `packages/design/src/display/person-name.tsx`; export from `packages/design/src/index.ts`.
- Modify: `packages/design/src/styles/display.css` (circle radius 50%, the person initial ink,
  `.cb-person-name`).
- Modify: `packages/design/src/shell/sidebar.tsx` (~:975-990) and
  `packages/design/src/shell/me-panel.tsx` (~:84-88): `account: { name; avatarUrl?: string | null; … }`
  draws `<Avatar shape="circle">`. Modify `packages/design/src/styles/sidebar.css`
  (`.cb-sidebar-avatar` retires).
- Modify: `apps/web/src/dev/catalog/reference-blocks.tsx` (RefBlocks with the same ids) and
  `apps/web/visual/accepted.ts` (`person-name`).
- Test: `packages/design/test/avatar.test.tsx`, create `packages/design/test/person-name.test.tsx`,
  `packages/design/test/sidebar.test.tsx`, `packages/design/test/me-panel.test.tsx`

**Interfaces:**
- Produces:

  ```ts
  // avatar.tsx
  shape?: "square" | "circle"   // default "square"; data-shape on the span
  // person-name.tsx
  export function PersonName(props: { name: string; avatarUrl: string | null;
    size: 16 | 24; secondary?: string }): JSX.Element
  ```
- `PersonName` renders `data-part="person-name"`: a circle `Avatar` (`value` =
  `avatarUrl ? { kind: "image", src: avatarUrl } : null`), `space.1` (16) / `space.2` (24), the name
  in one ellipsized span with `title` = the name, then the optional `secondary` (`muted`). It never
  wraps.

- [ ] **Step 1: Spec first.** Add §6.30's person bullet, §6.50 with its states (`sizes`, `image`,
  `ellipsis`, `secondary`) and a size table (`person-name avatar[data-size=16]` width 16,
  `[data-size=24]` width 24, `avatar[data-shape=circle]` `border-top-left-radius` 50%, the initial
  `color.muted` on `color.selected`, the name `type.small` at 16 and `type.body` at 24). Add the
  reference blocks.
- [ ] **Step 2: Failing tests:**
  - `shape="circle"` sets `data-shape="circle"` and never draws a preset (a preset value with
    circle draws the initial);
  - `PersonName` with `avatarUrl: null` draws the initial of `name`;
  - with a URL it draws an `img`, and firing `error` on it falls back to the initial without a
    second `img` (Review Focus 1);
  - the name carries `title`;
  - `secondary` renders after the name;
  - `findNestedBoxes(container)` is empty;
  - the sidebar account row and the me panel render `[data-part=avatar][data-shape=circle]` at 24 /
    40, and show the image when `avatarUrl` is given.
- [ ] **Step 3:** Run `pnpm exec vitest run packages/design/test/avatar.test.tsx packages/design/test/person-name.test.tsx packages/design/test/sidebar.test.tsx packages/design/test/me-panel.test.tsx`.
  Expected: FAIL.
- [ ] **Step 4:** Implement it, add the catalog blocks, then
  `COMPARE=person-name pnpm --filter @capybara-hq/web compare` (controller: a blind image review per
  writing-web-ui step 4).
- [ ] **Step 5:** Run the tests, `pnpm check:web-ui`, `pnpm check:tokens`, `pnpm typecheck`.
  Expected: PASS.
- [ ] **Step 6:** Commit `feat(design): circle person avatar and PersonName`.

### Task 3: Avatar uploads, `PATCH /me/profile`, name rule, cleanup (high risk)

**Files:**
- Create: `packages/kernel/src/identity/account-avatars.service.ts` (`AccountAvatarsService`,
  provided and exported by `IdentityModule` in `identity.module.ts`, which imports `StorageModule`)
- Modify: `packages/kernel/src/identity/me.controller.ts` (two routes),
  `packages/kernel/src/identity/me.schemas.ts` (`AvatarUploadSchema`, `ProfilePatchSchema`)
- Modify: `packages/kernel/src/identity/accounts.ts` (`updateAccount` / `applyUpdate` ~:490-660:
  the 64 rule when the name changes; a new `@Transactional` `updateProfile`)
- Modify: `packages/kernel/src/admin/admin.schemas.ts:26`: `UpdateAccountBody.displayName` becomes
  `.trim().min(1).max(1000)`, a body sanity bound; the 64 rule lives in the service.
- Modify: `packages/kernel/src/errors.ts` (`account.display_name_too_long` → 400)
- Modify: `packages/kernel/src/platform/exclusions.ts`, near the `/me` entries (~:525-555):
  - `PATCH /api/v1/me/profile`: `human-only`, "Changes the person's own name and avatar";
  - `POST /api/v1/me/avatar/uploads`: `transport`, "Creates a presigned avatar upload".
- Modify: `packages/kernel/src/roles/worker.module.ts` (provide `AccountAvatarCleanupJob`)
- Test: `packages/kernel/test/identity/account-profile.test.ts` (integration, fake-object-store on
  `startTestS3()`, set up like `packages/kernel/test/agents/avatar.test.ts`)

**Interfaces:**
- Consumes: Task 1's `AccountAvatar`, `AccountView`, `withAvatarUrls`, and the
  `account_avatar_uploads` table.
- Produces:

  ```ts
  class AccountAvatarsService {
    createUpload(accountId: string, input: { contentType: string; size: number }):
      Promise<{ uploadId: string; upload: PresignedUpload; expiresAt: string }>;
    /** Outside any transaction: HEAD the object, re-check size and type, mark ready, extend expiry. */
    prepare(accountId: string, uploadId: string): Promise<void>;
    /** @Transactional mandatory: lock the row, bind it (expires_at null), expire every other upload. */
    bind(accountId: string, uploadId: string | null): Promise<void>;
    /** Used by Task 4: presigned GET of the bound upload, null when it or its object is gone. */
    objectUrl(accountId: string, uploadId: string): Promise<string | null>;
    deleteExpired(): Promise<number>;
  }
  // AccountsService
  updateProfile(accountId: string, patch: { displayName?: string; avatar?: AccountAvatar | null },
    actorTokenId?: string): Promise<AccountView>;
  // me.controller.ts
  POST  /api/v1/me/avatar/uploads  body { contentType, size }  → { uploadId, upload, expiresAt }
  PATCH /api/v1/me/profile         body { displayName?, avatar?: { kind: "upload", uploadId } | null } → { account: AccountView }
  ```
- Errors: reuse `attachment.type_not_allowed`, `attachment.too_large`,
  `attachment.too_many_pending`, `attachment.not_ready` and `attachment.not_found` (same meanings as
  the agent avatar; the web already translates them); `storage.unavailable` (503) without a store;
  `account.display_name_too_long` for a changed name over 64 code points.
- Order in `PATCH /me/profile`:
  1. `prepare` runs outside the transaction (when `avatar.kind === "upload"`);
  2. then one transaction locks the account row (`FOR UPDATE`), applies the name rule, `bind`s,
     updates `accounts.avatar` / `display_name` / `updated_at`, and audits
     `account.profile_updated`;
  3. it returns `withAvatarUrls`.
  An empty body changes nothing and writes no audit row.
- Cleanup: `AccountAvatarCleanupJob` with
  `@LockedCron("0 * * * *", { name: "account-avatar-cleanup" })`, provided only under
  `WorkerModule`. `deleteExpired` claims rows with `expires_at < now()` (`FOR UPDATE SKIP LOCKED`,
  batches of 100), deletes each object from `storage.deployment()`, then the row. A failed object
  delete keeps the row for the next tick (the `attachments.deleteExpired` pattern). It does nothing
  without a store.
- Intent first: `createUpload` inserts the `pending` row (with `expires_at` = now + 24 h) before it
  returns the presigned upload, so a crash leaves only an expiring row.

- [ ] **Step 1: Failing tests** (`account-profile.test.ts`):
  - an upload of `image/png` 1000 B returns `upload.url`, and the row is `pending` with an expiry;
  - `image/gif` gives 400 `attachment.type_not_allowed`;
  - 2 MB + 1 gives 400 `attachment.too_large`;
  - an 11th pending upload gives `attachment.too_many_pending`;
  - after uploading real PNG bytes, the PATCH sets the avatar: `account.avatarUrl` starts with
    `/api/v1/accounts/<id>/avatar?v=`, the row is `ready` with `expires_at` null, and an audit row
    has `detail.avatar = "upload"` and no image data;
  - bytes that are not the declared image give 400 and leave the avatar unchanged;
  - another account's `uploadId` gives 404 `attachment.not_found`;
  - replacing the avatar with a second upload gives the first row an `expires_at <= now()`
    (Review Focus 3);
  - `avatar: null` clears it, and `avatarUrl` falls back to an SSO https URL when an identity has
    one, else `null`;
  - `displayName: "  Ada  "` saves `Ada`;
  - a changed 65-code-point name gives 400 `account.display_name_too_long`;
  - an account whose stored name has 80 chars may PATCH only the avatar, or resend the same name,
    on `/me/profile` and on `PATCH /admin/accounts/:id` (Review Focus 2);
  - without a store, the upload gives 503 `storage.unavailable` and a name-only PATCH still works;
  - a personal token may PATCH the profile, and a service token gets 403;
  - `deleteExpired` removes an expired unbound row and its object, and keeps a bound one;
  - deleting the account row cascades its upload rows.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/identity/account-profile.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement the service, the routes, the name rule, the error code, the exclusions
  and the job.
- [ ] **Step 4:** Run the test,
  `pnpm exec vitest run packages/kernel/test/identity packages/kernel/test/admin/admin.http.test.ts`,
  `pnpm check:platform-ops`, `pnpm check:kernel-conventions`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): profile name and avatar uploads for the account`.

### Task 4: Avatar read route (HIGH: trust boundary; review alone on the most capable model)

**Files:**
- Create: `packages/kernel/src/identity/account-avatar.controller.ts`
  (`@Controller("api/v1/accounts")`)
- Modify: `packages/kernel/src/http/api.module.ts` (`CONTROLLERS`)
- Modify: `packages/kernel/src/platform/exclusions.ts`: `GET /api/v1/accounts/:accountId/avatar`,
  `transport`, "Streams avatar image bytes".
- Test: `packages/kernel/test/identity/account-avatar-access.test.ts` (integration),
  `packages/kernel/test/ui/embed.http.test.ts:224` (add the route to the "embed token is not a
  Bearer for /api" loop)

**Interfaces:**
- Consumes: `AccountAvatarsService.objectUrl` (Task 3), `safeSsoUrl` (Task 1).
- Produces: `GET /api/v1/accounts/:accountId/avatar`, with default auth (session or personal token;
  service tokens rejected by default; never `@Public()`).
- Access rule, one SQL check. Allowed when any of these holds:
  - the caller is the account;
  - `principal.account.isSuperAdmin`;
  - a membership of the caller and a membership of the target share an `org_id` whose org has
    `deleted_at IS NULL` (any role, guests included).

  Every other caller gets 404 `account.not_found`, the same response as for an unknown account or a
  person without an image, so existence never leaks.
- Resolution:
  1. a bound upload whose object is present → 302 to `objectUrl` (300 s presigned, inline, the
     row's type);
  2. else (no upload, object gone, or store unavailable) → the SSO https URL → 302;
  3. else 404.

  Every 302 carries `cache-control: private, max-age=60`. The `v` query parameter is ignored.

- [ ] **Step 1: Failing tests** (`account-avatar-access.test.ts`):
  - the account itself gets 302 to a presigned URL, and following it returns the PNG bytes;
  - a member of a shared org gets 302;
  - a guest of a shared org gets 302;
  - a member of another org only gets 404;
  - a super admin with no membership gets 302;
  - after the target leaves the only shared org, 404;
  - after the shared org is soft-deleted, 404;
  - an unknown account id gets 404 with the same body as the refused case;
  - a person with only an SSO https avatar gets 302 to that exact URL;
  - an SSO `http:` URL gives 404;
  - a bound upload whose object was deleted from the store falls back to the SSO URL, else 404;
  - the `cache-control` header equals `private, max-age=60`;
  - a service token gets 403;
  - no credentials gets 401;
  - in `embed.http.test.ts`, an embed token used as Bearer on `/api/v1/accounts/<id>/avatar`
    gets 401.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/identity/account-avatar-access.test.ts packages/kernel/test/ui/embed.http.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement the controller (the access check is one Kysely `exists` query, not a
  loop over orgs).
- [ ] **Step 4:** Run the tests,
  `pnpm exec vitest run packages/kernel/test/identity/public-routes.test.ts`,
  `pnpm check:platform-ops`, `pnpm check:kernel-conventions`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): guarded account avatar route`.

### Task 5: Person slots in existing design components

**Files:**
- Modify: `docs/design/spec.md`:
  - §6.16.6 User bubble: `author` (avatar 24 at the bubble's end side; `showName` puts the name
    above, as in the trajectory);
  - §6.16.11 / §6.16.12: the decider / answerer as a person;
  - §6.16.23 Run row: `statusText` may hold a person;
  - the Select section: options with a person;
  - the schedule calendar section: a block's creator chip is avatar-only, with the name in the
    tooltip.
  Add the matching reference blocks in `docs/design/reference/src/` (`user-bubble-author`,
  `approval-block-person`, `question-block-person`, `select-person`, `schedule-calendar-person`).
- Modify: `packages/design/src/conversation/bubble.tsx`,
  `packages/design/src/conversation/hitl.tsx`, `packages/design/src/conversation/run-row.tsx`,
  `packages/design/src/controls/select.tsx`,
  `packages/design/src/display/schedule-calendar.tsx`, plus their CSS.
- Modify: `apps/web/src/dev/catalog/conversation-blocks.tsx`,
  `apps/web/src/dev/catalog/schedule-calendar-blocks.tsx`, `reference-blocks.tsx`.
- Test: `packages/design/test/conversation-prose.test.tsx`, `packages/design/test/hitl.test.tsx`,
  `packages/design/test/run-row.test.tsx`, `packages/design/test/select.test.tsx`,
  `packages/design/test/schedule-calendar.test.tsx`

**Interfaces (consumed by Tasks 9 and 10):**

```ts
export type PersonLike = { name: string; avatarUrl: string | null };
// UserBubble
author?: PersonLike & { showName?: boolean };
// approval / question states: `who` becomes `string | PersonLike` (a string stays plain text: "你", "系统")
// RunRow
statusText?: ReactNode;
// SelectOption
person?: { avatarUrl: string | null };   // a 16 circle Avatar before the label, in trigger and menu
// ScheduleCalendarBlock
person?: PersonLike;                      // avatar 16 only; name in the block's title tooltip
```

- [ ] **Step 1: Spec and reference blocks** as listed above.
- [ ] **Step 2: Failing tests:**
  - a `UserBubble` with `author` renders a circle avatar 24 and, with `showName`, the name;
  - without `author` nothing changes;
  - an approval with `who: { name: "Ada", avatarUrl: null }` renders a `person-name` with "Ada";
  - `who: "你"` stays text;
  - a question card does the same;
  - `RunRow` accepts a node in `statusText`;
  - a `Select` option with `person` shows the avatar in the menu and the trigger;
  - a calendar block with `person` shows the avatar and puts the name in its `title`;
  - `findNestedBoxes` is clean in each.
- [ ] **Step 3:** Run the five test files. Expected: FAIL.
- [ ] **Step 4:** Implement it, then
  `COMPARE=user-bubble,approval-block,question-block,select,schedule-calendar pnpm --filter @capybara-hq/web compare`
  (blind review by the controller).
- [ ] **Step 5:** Run the tests, `pnpm check:web-ui`, `pnpm check:ui-parts`, `pnpm typecheck`.
  Expected: PASS.
- [ ] **Step 6:** Commit `feat(design): person slots in bubbles, cards, rows, selects and calendar`.

### Task 6: `avatarUrl` on person-carrying responses

**Files** (each join that already reads `accounts.display_name` adds
`avatarColumns(eb, alias, "<person>")`, one prefix per person in the row, and maps the result with
`personAvatarUrl(row, "<person>", id)`):
- Modify: `packages/kernel/src/orgs/members.service.ts:59-81`:
  `Member.account.avatarUrl` (the org and admin member rows).
- Modify: `packages/kernel/src/admin/audit-log.service.ts:56-91`: `actor.avatarUrl`.
- Modify: `packages/kernel/src/shares/shares.service.ts:542-629`: `createdBy.avatarUrl`.
- Modify: `packages/kernel/src/agents/admin-agents.ts:260-310`: `ownerAvatarUrl`.
- Modify: `packages/kernel/src/tools/admin-connectors.ts:77-92,188`: `createdByAvatarUrl`.
- Modify: `packages/kernel/src/catalog/requests.service.ts:1061-1086,1208`:
  `requestedByAvatarUrl`.
- Modify: `packages/kernel/src/skills/changes.service.ts:530-534`: the requester's `avatarUrl`.
- Modify: `packages/kernel/src/schedules/scheduled-tasks.service.ts:947-1001`:
  `pausedBy: PersonRef | null`, plus `account: PersonRef | null` next to `accountId` on task views
  (the id-only case of spec §5.3, kept in this file's task).
- Modify: `packages/kernel/src/devices/devices.service.ts:212,1485-1498`: setting-change
  `by: PersonRef | null`.
- Test: extend `packages/kernel/test/orgs/members.test.ts`,
  `packages/kernel/test/admin/audit-log.test.ts`, the shares, admin-agents, admin-connectors,
  catalog-requests, skill-changes, schedules and devices tests that already assert the name field
  (find each with `grep -rln "createdByName\|requestedByName\|ownerName\|pausedBy" packages/kernel/test`).

**Interfaces:**
- Consumes: `avatarColumns(eb, alias, as)`, `personAvatarUrl(row, as, id)`, `AvatarColumnsRow`,
  `PersonRef` (Task 1).
- Produces: the field names above. Existing name fields stay as they are; only the avatar is added
  (and `PersonRef` where the response already had `{ id, name }`).

- [ ] **Step 1: Failing assertions.** In each listed test, give one account an upload avatar by
  setting `accounts.avatar` directly in SQL plus a ready upload row. Assert that its field equals
  `/api/v1/accounts/<id>/avatar?v=` + `expect.any(String)`, and that a second account's field is
  `null`.
- [ ] **Step 2:** Run the touched test files. Expected: FAIL.
- [ ] **Step 3:** Add the columns and the mapping. Each query stays one query: no N+1, no
  `loadPeople` where a join exists.
- [ ] **Step 4:** Run the touched test files, `pnpm check:platform-ops`, `pnpm typecheck`.
  Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): avatar URL on every person shape`.

### Task 7: Person shapes for id-only responses

**Files:**
- Modify: `packages/kernel/src/tools/approvals.service.ts:227,476`:
  `decidedByPerson: PersonRef | null` next to `decidedBy` (list and get).
- Modify: `packages/kernel/src/tools/questions.service.ts`:
  `answeredByPerson: PersonRef | null` next to `answeredBy`.
- Modify: `packages/kernel/src/background/store.ts:40,103,150` (or its controller view):
  `trigger: PersonRef | null` next to `triggerAccountId`.
- Modify: `packages/kernel/src/conversations/conversations.controller.ts:392-419`:
  `GET :id/events` returns `people: Record<string, PersonRef>`. It covers every account id the
  returned events name: `user_message.payload.authorAccountId`, `run_started.triggerAccountId`,
  `run_aborted.byAccountId`, and the `byAccountId` of decided approvals / answered questions.
- Modify: `packages/kernel/src/conversations/conversations.controller.ts:376-390`
  (`GET :id`): `owner: PersonRef | null` next to `conversation.accountId`.
- Modify: `packages/kernel/src/evals/trajectory.ts` and `trajectory.controller.ts:71`: the
  trajectory response gains `people: Record<string, PersonRef>` for the same id set, plus the runs'
  `triggerAccountId`.
- Test: `packages/kernel/test/conversations/` (the events HTTP test),
  `packages/kernel/test/tools/` (the approvals and questions HTTP tests), the trajectory test
  under `packages/kernel/test/evals/`, the background tasks test under
  `packages/kernel/test/background/`.

**Interfaces:**
- Consumes: `loadPeople(db, ids)` (`db` = `KernelDb.db`), `PersonRef` (Task 1).
- Produces: `decidedByPerson`, `answeredByPerson`, `trigger`, `owner`, and `people` maps on the
  events and trajectory responses.
- Event payloads in the log are never changed: `people` is a sidecar computed at read time (spec
  §5.4). No `DriftReason`, no request-building change.

- [ ] **Step 1: Failing tests:**
  - events of a conversation with a user message and a run stopped by an org admin give
    `people[ownerId].name` and `people[adminId].avatarUrl`;
  - an id whose account row is gone (delete it in SQL in the test) is absent from `people`;
  - an approval decided by an admin carries `decidedByPerson.name`;
  - a question answered by its starter carries `answeredByPerson`;
  - the trajectory response carries `people` for the trigger account;
  - a guest who can read the conversation's approvals gets `decidedByPerson` without
    `org.members.read`.
- [ ] **Step 2:** Run the touched files. Expected: FAIL.
- [ ] **Step 3:** Implement it with one `loadPeople` call per response.
- [ ] **Step 4:** Run the touched files and
  `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` (zero drift unchanged).
  Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): person shapes next to account ids in responses`.

### Task 8: Profile page, `Person` wrapper, shell wiring (web)

**Files:**
- Create: `apps/web/src/app/(app)/account/profile/page.tsx`, `view.tsx`
- Modify: `apps/web/src/components/settings-nav.ts:55-67`: `ACCOUNT_HOME = "/account/profile"`,
  with `profile` as the first entry.
- Modify: `apps/web/src/lib/query/routes.ts` (pattern `/account/profile`, no extra queries: `me`
  is the layout's).
- Modify: `apps/web/src/lib/session.ts` (`Account.avatarUrl: string | null`,
  `Account.avatarSource` as Task 1 defines it).
- Create: `apps/web/src/lib/profile.ts` (`createAvatarUpload`, `patchProfile`); reuse
  `apps/web/src/lib/avatar-crop.ts` and the agent upload helper in `apps/web/src/lib/agents.ts`
  (move the shared upload function to `lib/profile.ts` only if it is generic).
- Create: `apps/web/src/components/Person.tsx`
- Modify: the shell wiring that builds the sidebar / me panel `account` prop (pass
  `me.account.avatarUrl`).
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json`: `profile.*`, `people.departed`,
  `people.you`.
- Test: create `apps/web/test/account-profile.test.tsx`, extend `apps/web/test/account-ssr.test.tsx`

**Interfaces:**
- Consumes: Task 2 `PersonName`, `Avatar shape`; Task 3 routes; `meQuery` (`keys.account("self").me()`).
- Produces:

  ```ts
  // components/Person.tsx
  export function Person(props: { person: PersonRef | null | undefined; size: 16 | 24;
    viewerId?: string; secondary?: string }): JSX.Element
  // null/undefined → PersonName { name: t("people.departed"), avatarUrl: null };
  // person.id === viewerId → name t("people.you") with the person's avatar
  export type PersonRef = { id: string; name: string; avatarUrl: string | null };  // lib/people.ts
  ```
- The page is a `SettingsPage` with one `FormSection`:
  - the avatar at 64 (circle), with 上传 / 更换 and 移除;
  - the crop to a square before upload;
  - a `muted` line "来自<source>" when the shown avatar is the SSO one;
  - 名称 (a text field, max 64);
  - save through `useAppMutation`, invalidating `keys.account("self").me()` and the members
    queries.

  When `storage.unavailable` comes back, the upload action is disabled with a note.

- [ ] **Step 1: Failing tests** (`account-profile.test.tsx`, via `renderRouteWithCache`):
  - the page renders the name field with the current name and the initial avatar;
  - saving a new name PATCHes `{ displayName }` and invalidates `me`;
  - a 65-char name is refused before sending;
  - choosing a file uploads, then PATCHes `{ avatar: { kind: "upload", uploadId } }`;
  - 移除 sends `avatar: null`;
  - a 503 `storage.unavailable` on upload shows the unavailable note;
  - the account nav lists 个人资料 first;
  - `/account` lands on `/account/profile`;
  - `Person` with `null` renders 已离开的成员.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/account-profile.test.tsx apps/web/test/account-ssr.test.tsx`.
  Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
  Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): account profile page and person component`.

### Task 9: Web surfaces: settings and admin

**Files** (each swaps bare name text for `<Person>` / `PersonName` at the spec §7 size):
- `apps/web/src/app/(app)/settings/members/view.tsx:134-140` and the admin org members view (24)
- `apps/web/src/app/(app)/admin/accounts/view.tsx` (24)
- Owner pickers (`SelectOption.person`, 16):
  - `apps/web/src/components/ReassignOwnerDialog.tsx`;
  - `apps/web/src/components/agent/BasicsSection.tsx:448`;
  - `apps/web/src/components/agent/CreateFromTemplateDialog.tsx:275`;
  - the admin agent page picker.
- Agent owner, 16: `apps/web/src/components/AgentList.tsx:45-60`,
  `apps/web/src/app/(app)/admin/agents/view.tsx`, `admin/agents/[id]/view.tsx`.
- `apps/web/src/components/audit-log.tsx:26-30` (16).
- `apps/web/src/components/SharesTable.tsx:52` (16).
- `apps/web/src/app/(app)/admin/connectors/view.tsx`, `admin/connectors/[id]/view.tsx` (16).
- Inbox requesters, 16:
  - `apps/web/src/lib/catalog.ts:1575` (`requesterOf` returns a `PersonRef`);
  - `app/(app)/inbox/view.tsx`, `admin/inbox/view.tsx`, `admin/plugins/pending/view.tsx`;
  - `components/SkillChangeReview.tsx:35`.
- Schedules, 16: `app/(app)/settings/schedules/view.tsx`, `app/(app)/schedules/[id]/view.tsx`,
  `components/ScheduleCalendarView.tsx` (calendar `person`).
- `apps/web/src/components/DeviceModeSection.tsx:708` (16).
- The matching `apps/web/src/lib/*.ts` types (`lib/admin.ts`, `lib/catalog.ts`,
  `lib/schedules*.ts`, `lib/devices.ts`, `lib/shares*.ts`).
- Tests: `apps/web/test/members.test.tsx`, `admin-agents.test.tsx`, `admin-audit.test.tsx`,
  `admin-connectors.test.tsx`, `inbox.test.tsx`, `schedules.test.tsx`,
  `schedules-calendar.test.tsx`, `shares-settings.test.tsx`, `devices-mode.test.tsx`, and the
  admin accounts test.

**Interfaces:**
- Consumes: Task 5 slots, Task 6 fields, Task 8 `Person` / `PersonRef`.
- Schedules and owner pickers keep reading the members list, which now carries `avatarUrl`.

- [ ] **Step 1: Failing tests.** In each listed test, fixtures carry an `avatarUrl`. Assert that
  the row or cell contains `[data-part=person-name]` with an `img` whose `src` is that URL, and that
  a `null` avatar draws the initial.
- [ ] **Step 2:** Run the touched tests. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the touched tests, `pnpm check:web-ui`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): avatars on settings and admin person surfaces`.

### Task 10: Web surfaces: conversation, approvals, questions, trajectory

**Files:**
- `apps/web/src/components/ApprovalCard.tsx:47-132,256-371`: `Outcome` gains `byPerson`; `who`
  becomes `PersonLike | "你" | "系统"`.
- `apps/web/src/components/QuestionCard.tsx:273`, `components/conversation/SubagentWait.tsx:50`.
- `apps/web/src/components/conversation/Thread.tsx:80-95,475-480,587`: drop the local
  `useMemberNames`; `who` reads the events `people` map; the user bubble gets `author`.
- `apps/web/src/components/TrajectoryParts.tsx:102-151,341,360`: `people: Record<string, PersonRef>`;
  the "by" values and the trigger render `PersonName` 16; the bubbles get `author` with `showName`.
- `apps/web/src/app/(app)/trajectories/[conversationId]/view.tsx:37,69`: read `people` from the
  response, not `useMemberNames`.
- `apps/web/src/lib/query/who-waits.ts`: person from the response.
- `apps/web/src/lib/conversations.ts` (events response `people`, `owner`), `lib/approvals.ts`,
  `lib/questions.ts`, `lib/trajectories.ts`, and the conversation events query that stores
  `people`.
- Tests: `apps/web/test/approval-card.test.tsx`, `apps/web/test/tool-cards.test.tsx`,
  `apps/web/test/trajectories.test.tsx`, and the thread / timeline tests that render a stopped run.

**Interfaces:**
- Consumes: Task 5 (`author`, `who: PersonLike`, `statusText: ReactNode`), Task 7 fields, Task 8
  `Person`.
- `useMemberNames` stays only where a member-role viewer lists members (evals case view,
  schedules), and loses the trajectory and thread callers.

- [ ] **Step 1: Failing tests:**
  - an approval decided by another account shows its name and avatar, never the id;
  - decided by the viewer shows 你;
  - decided by nobody shows 系统;
  - a question answered by another account shows `PersonName`;
  - a run stopped by an admin shows the admin's `PersonName` in the run row;
  - an id absent from `people` shows 已离开的成员;
  - the user bubble shows the author's avatar 24 in the conversation, and avatar plus name in the
    trajectory;
  - a guest viewer (members query 403) still sees names (they come from the response).
- [ ] **Step 2:** Run the touched tests. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the touched tests, `pnpm check:web-ui`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): people with avatars in conversations, cards and trajectories`.

### Task 11: Live frames naming an unresolved person

**Files:**
- Modify: `apps/web/src/components/conversation/useConversation.ts` (or the SSE handler in
  `apps/web/src/lib/stream.ts`)
- Test: the existing `useConversation` tests (find them with
  `grep -rln useConversation apps/web/test`)

**Interfaces:**
- When a live event names an account id missing from the cached `people` map, schedule one refetch
  of the events tail (the existing events query, newest page). Its `people` covers the new event.
  At most one refetch is in flight per conversation.

- [ ] **Step 1: Failing tests** (Review Focus 5):
  - a `run_aborted` frame by an unknown id triggers exactly one events refetch, after which the
    row shows the name;
  - a second frame naming the same id while the refetch runs triggers nothing more;
  - an id still unknown after the refetch renders 已离开的成员.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(web): resolve people named by live conversation events`.

### Task 12: Docs, changesets, baselines, verify (controller)

- [ ] Skills, in the same change:
  - `.agents/skills/writing-kernel-api/SKILL.md`: one line on `PersonRef` / `avatarColumns`
    (every new person shape uses them);
  - `.agents/skills/writing-object-store-providers/SKILL.md`: add `deployment/account-avatars/`
    to the deployment prefix examples;
  - `.agents/skills/writing-web-ui/SKILL.md`: people are drawn with `Person` / `PersonName`, never
    bare name text.
- [ ] Changesets: `.changeset/account-profile-kernel.md` (`@capybara-hq/kernel` patch) and
  `.changeset/account-profile-web.md` (`@capybara-hq/web` patch).
- [ ] `pnpm check:english-comments --base origin/main`,
  `pnpm check:applied-migrations --base origin/main`, `pnpm check`.
- [ ] `pnpm verify` (full diff run).
- [ ] Trigger `reference-update` (new and changed reference blocks), then `visual-update` on the
  branch. Review the rendered PNGs.
- [ ] Final whole-branch review on the most capable model; the PR body lists the gap rulings
  applied (below).

---

## Decisions this plan takes where the spec is silent or loose (confirm in review)

1. **`identities.updated_at`** does not exist. The spec's "most recently updated identity" needs
   it, so Task 1 adds a nullable column, written by `refreshIdentity` / `insertIdentity`, and
   orders by `updated_at DESC NULLS LAST, created_at DESC`.
2. **Upload response shape.** The spec's `{ uploadId, url, headers }` (a presigned PUT) does not
   fit the store, which uses a POST policy (`PresignedUpload { method, url, headers, fields? }`).
   Task 3 returns `{ uploadId, upload, expiresAt }`, like the agent avatar.
3. **Account deletion and objects.** No route deletes an account that can own uploads (the only
   `DELETE FROM accounts` is the race undo in `external.ts:195`), so there is no outbox producer.
   The FK cascade removes the rows; no outbox job is added.
4. **Error codes.** The upload errors reuse the agent avatar's `attachment.*` codes. One new code:
   `account.display_name_too_long`.
5. **Admin PATCH bound.** `UpdateAccountBody.displayName` today is `max(100)`. Honouring "resending
   an unchanged longer name passes" needs a looser bound, so it becomes `max(1000)`, with the
   64-code-point rule in the service.
6. **"Characters"** means code points; "unchanged" compares trimmed values.
7. **Read route fallbacks.** An upload whose object is gone, or a store that is unavailable, falls
   through to the SSO URL, then 404 (no 503 on an image).
8. **Id-only shapes:**
   - REST records get inline `…Person` fields;
   - event-carrying responses (conversation events, trajectory) get a `people` sidecar map, so the
     log itself never changes;
   - "conversations `accountId` where a viewer other than the owner sees it" becomes `owner` on
     `GET :id` only.
9. **Live SSE frames** carry no person shapes. Task 11 refetches the events tail on an unknown id
   instead of adding a lookup route (the spec rules one out).
10. **`PATCH /me/profile` is not `@SessionOnly`.** A personal token is the person, as for
    `/me/preferences`. It is still a `human-only` Platform exclusion.
11. **The SSO "来自…" line** (spec §8 leaves it open). `AccountView` carries
    `avatarSource: { kind: "upload" } | { kind: "identity"; source } | null` (Task 1). The page
    labels the source the way the identities page does.
