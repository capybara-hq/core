# File sharing and full HTML rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With 13 tasks, `wave-planned-subagent-development` governs the dispatch (wave table below).

**Goal:** The owner of a conversation shares one file of it as a snapshot through `/s/<code>`
(internal or external), and HTML renders fully (scripts, allowlisted CDNs) in the right panel and
on the share page inside a CSP-sandboxed kernel document.

**Architecture:** A new kernel `shares` module owns the `file_shares` table, snapshot copies
(object written before its row, deletions owed through the outbox), the org routes, the public
`/api/v1/s/:code/*` routes and a daily sweep. A new kernel `html` module serves an HTML file as a
stand-alone document at `/api/v1/html/:token` with a `sandbox` CSP and the platform CDN allowlist;
the right panel and the share page both iframe it. Every other format reuses the previewers through
one web body component fed by a conversation or a share data source; embed previewers on a share
get a share-scoped embed token (SDK change).

**Tech Stack:** TypeScript, Nest + Fastify kernel, Kysely / PostgreSQL, Redis, BullMQ outbox,
`@capybara-hq/plugin-sdk`, Next web app + `@capybara-hq/design`, Vitest (unit, integration,
container), Playwright (Chromium in CI; WebKit only for an optional local headless run), the plugins repository (`plugins/file-preview`).

**Spec:** [file sharing and full HTML rendering](../specs/2026-11-18-file-sharing-design.md). Its
"Approaches", decisions and "Left to the builder" are binding. Read it whole before any task, and
the skills of the area a task touches before that task:
[writing-kernel-api](../../../.agents/skills/writing-kernel-api/SKILL.md),
[writing-migrations](../../../.agents/skills/writing-migrations/SKILL.md),
[adding-config](../../../.agents/skills/adding-config/SKILL.md),
[writing-extension-ui](../../../.agents/skills/writing-extension-ui/SKILL.md),
[writing-web-ui](../../../.agents/skills/writing-web-ui/SKILL.md),
[writing-tools](../../../.agents/skills/writing-tools/SKILL.md),
[replay-evals](../../../.agents/skills/replay-evals/SKILL.md).

## Global Constraints

- Share link: `https://<deployment>/s/<code>`, code = 10 characters of `[A-Za-z0-9]` from a CSPRNG (rejection sampling, no modulo bias), unique.
- Snapshot object key `shares/<shareId>/<generation>` under `kernel/<orgId>/`; written **before** its row; deletions owed through the outbox, job id `share-object-delete-<shareId>-<generation>` (no `:` in queue names or job ids).
- Expiry choices `1 | 7 | 30 | null` days; external needs non-null ≤ `shareMaxExpiryDays` (default 30, range 1..365); UI defaults external 7, internal never.
- External sharing: platform `externalSharing: "allow" | "deny"` (default `deny`) AND org `externalSharing: "on" | "off"` (absent = off). Through the Platform tool or an API token both can only be turned off.
- Unknown, revoked, expired and "not a member" all answer 404 `share.not_found`; internal without a session 401 `share.sign_in_required`.
- Public share routes rate limited by named throttler `share-open` (per IP, 30 per 10 minutes, failed lookups count, successful ones are refunded, 429 `rate_limited`).
- `share.opened` audited at most once per share and viewer (account id, else IP hash) per 10 minutes (Redis marker with TTL via `LockService.lease`).
- HTML document token: stateless HMAC, keyring HKDF info `capybara-html/1`, TTL 300 s, claims `{ kind: "file", orgId, conversationId, fileId, accountId }` or `{ kind: "share", shareId, generation }`; re-checked live on use. HTML over `FILE_PREVIEW_MAX_BYTES` (20 MiB) is never rendered.
- HTML document headers exactly as spec §4 (CSP string, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cache-control: private, no-store`, `x-robots-tag: noindex`); the web iframe carries `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` and `referrerpolicy="no-referrer"`; `allow-same-origin` and `allow-top-navigation` are never granted.
- CDN allowlist: deployment setting `htmlRenderCdnAllowlist`, `https://` origins only (scheme + host + optional port, no path, no wildcard), default `https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net`, `https://unpkg.com`, `https://fonts.googleapis.com`, `https://fonts.gstatic.com`; no org level.
- Share bytes are streamed by the kernel, never a presigned URL; `/content` is always `application/octet-stream` with `content-security-policy: sandbox; default-src 'none'`.
- Multi-replica: no in-process state; Redis keys carry TTLs; the sweep is a `@LockedCron` provided only under `WorkerModule`; writes in `@Transactional()` methods; distributed locks never inside a transaction.
- Kernel conventions: `@Injectable` providers, explicit `@Inject` on every constructor parameter, DTOs via `createZodDto`, errors registered in `packages/kernel/src/errors.ts` (`pnpm check:kernel-conventions`).
- Web: pages are a design template + design components, no styles in `apps/web` (`pnpm check:web-ui`); the only iframes are design components; every read a `defineQuery`, every write `useAppMutation`.
- English comments, identifiers, model-visible text; UI text through i18n zh + en; zh says 平台 / 超级管理员 / 智能体, never 企业 or `agent` (`pnpm check:i18n`).
- A new unit or container kernel test joins `packages/kernel/test/unit-tests.json` or `packages/kernel/test/container-tests.json` in the same change; integration is the default (one app per file). Run tests from the root: `pnpm exec vitest run <path>`.
- Pre-0.1.0: no compatibility layers; migration 0160 is expand-only.
- Changesets: `@capybara-hq/plugin-sdk` minor (Task 1), `@capybara-hq/kernel` minor (kernel tasks, one changeset per task), `@capybara-hq/web` / `@capybara-hq/design` patch (web and design tasks); plugins repo: `@capybara-hq/plugin-file-preview` patch.
- Browser checks headless Chromium and WebKit only, never Firefox. CI stays Chromium-only (maintainer decision 2026-11-18: no WebKit in CI, `ci.yml` untouched).
- Each task ends with `pnpm verify --fast` green before handoff.

## Review Focus

1. **A file re-delivered after it was shared** (new version under the same `sourcePath`): the link keeps showing the snapshot, the panel marks the file as shared and offers Update to latest, refresh copies the newest *available* version (skipping removed ones) under the same code (Tasks 4, 8).
2. **A non-ASCII or quote-bearing file name** (`季度报告 "Q3".html`): `content-disposition` uses RFC 5987 `filename*=UTF-8''…` plus an ASCII fallback, the share page header and the HTML document title show it intact (Tasks 6, 11).
3. **HTML stored with a non-UTF-8 charset** (`text/html; charset=gbk`): the document is served with the bytes as stored and `charset=gbk` in `content-type`; without a charset parameter, `utf-8` (Task 5).
4. **An internal link opened by a member whose session's current org is another org**: membership is checked against the share's org, not the session's current org, so it opens; a non-member's session gets 404 (Task 6).
5. **A very large shared file** (hundreds of MB): the snapshot copy and `/content` stream end to end and never buffer the whole object in memory; HTML over 20 MiB is refused for rendering with a download offered (Tasks 4, 5, 6).

---

## Wave plan

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 SDK contracts | — | `packages/plugin-sdk` | normal | 1 | batched W1 |
| 2 Governance, data, errors | — | migration, kernel-schema, errors, config, settings, org settings, ops, web errors/audit i18n | **high** (governance switches, migration) | 1 | alone, most capable |
| 3 Design components | — | `packages/design`, `docs/design`, `apps/web/src/dev/catalog`, `apps/web/visual/accepted.ts`, `tools/checks/src/web-ui.ts` | normal | 1 | batched W1 |
| 12 Plugins repo: file-preview drops HTML | — | `capybara-hq/plugins` `plugins/file-preview` | normal | 1 | batched W1 |
| 4 Shares core | 2 | `packages/kernel/src/shares/*`, `conversations/files.ts`, outbox registry, maintenance, api.module, exclusions, route-schemas, platform ops | **high** (intent-first copy, outbox, multi-replica) | 2 | alone, most capable |
| 8 Web: file body, HTML built-in, Share dialog | 1, 2, 3 (+ 4, 5 shapes from this plan) | `apps/web/src/components/file-preview/*`, `FilePanel.tsx`, `lib/shares.ts`, `lib/html.ts`, `lib/file-source.ts`, `lib/files.ts`, query files, `apps/web/messages/*` (owner of all new share copy) | normal | 2 | batched W2 |
| 5 HTML document + CSP + Deliver sentence | 2, 4 | `packages/kernel/src/html/*`, api.module, exclusions, public-routes test, `tools/builtins/sandbox/deliver.ts` | **high** (trust boundary) | 3 | alone, most capable |
| 9 Lifecycle and sweep | 4 | `conversations/conversations.service.ts`, `orgs/offboarding.ts`, `shares/sweep.job.ts`, `roles/worker.module.ts` | **high** (multi-replica, data lifecycle) | 3 | alone, most capable |
| 10 Web: switches and Shares lists | 2, 8 | `settings/organization`, `admin/settings`, new `settings/shares`, `account/shares`, `settings-nav.ts`, `shell/path.ts`, `lib/query/routes.ts` | normal | 3 | batched W3 |
| 6 Public share routes | 4, 5 | `shares/share-open.controller.ts`, `shares/share-open.service.ts`, named throttlers, html document share kind, api.module, exclusions, public-routes test | **high** (public, unauthenticated) | 4 | alone, most capable |
| 11 Web: share page | 3, 8 (+ 6, 7 shapes) | `apps/web/src/app/(auth)/s/[code]/*`, `routes.ts` (`PUBLIC_PREFIXES`), `proxy.ts`, `EmbedTab.tsx`, `lib/query/routes.ts` | normal | 4 | batched W4 |
| 7 Share-scoped previewers | 1, 6 | `ui/embed-token.ts`, `ctx/create-ctx.ts`, `http/plugin-route-access.ts`, `extensions/host.ts`, `files/previewers.ts`, `shares/share-previews.controller.ts`, `shares/liveness.ts`, api.module, exclusions, public-routes test | **high** (embed token scope) | 5 | alone, most capable |
| 13 E2E, docs, AGENTS.md | all | `apps/web/e2e/file-sharing.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, AGENTS.md, docs, skills | normal | 6 | final whole-branch review |

Shared files and their owners: `apps/web/messages/{en,zh}.json` — Task 2 (errors, audit labels) in wave 1, Task 8 (every other new share key, listed in Task 8) in wave 2; Tasks 10 and 11 use Task 8's keys and report any missing key for the wave fix dispatch. `packages/kernel/src/http/api.module.ts`, `platform/exclusions.ts`, `test/identity/public-routes.test.ts` — one kernel route task per wave (4, 5, 6, 7). `apps/web/src/lib/query/routes.ts` — Task 10 (wave 3) then Task 11 (wave 4).

---

## Wave 1 — contracts

### Task 1: SDK — share-scoped embed claims, share caller, share preview args

**Files:**
- Modify: `packages/plugin-sdk/src/ui.ts` (`EmbedClaimsBase` … `EmbedClaims` `:546-584`, `EmbedInitContext` `:592`)
- Modify: `packages/plugin-sdk/src/http-access.ts` (`RouteCaller` `:28`)
- Modify: `packages/plugin-sdk/src/file-preview.ts` (`FilePreviewArgs` `:37`)
- Modify: `packages/plugin-sdk/agent-docs/extension-points/file-preview.md`
- Test: `packages/plugin-sdk/test/ui.test.ts`, `packages/plugin-sdk/test/file-preview.test.ts`
- Regenerate: `packages/plugin-sdk/api/*` (`pnpm gen:sdk-api`), `.changeset/file-share-sdk.md`

**Interfaces:**
- Produces (exact):
  ```ts
  export interface EmbedClaimsBase { plugin: string; contribution: string; exp: number }
  export interface OrgEmbedClaims extends EmbedClaimsBase { scope: "org"; orgId: string; accountId: string; role: UiRole; conversationId?: string; agentId?: string; fileId?: string }
  export interface PlatformEmbedClaims extends EmbedClaimsBase { scope: "platform"; accountId: string; role: "superAdmin"; orgId?: undefined; conversationId?: undefined; agentId?: undefined; fileId?: undefined }
  /** A share page's `file.preview` embed: no account, no role. */
  export interface ShareEmbedClaims extends EmbedClaimsBase { scope: "share"; orgId: string; shareId: string; generation: number; accountId?: undefined; role?: undefined; conversationId?: undefined; agentId?: undefined; fileId?: undefined }
  export type EmbedClaims = OrgEmbedClaims | PlatformEmbedClaims | ShareEmbedClaims;
  // EmbedInitContext gains
  | { scope: "share"; orgId?: undefined; conversationId?: undefined }
  // RouteCaller gains
  | { access: "embed"; scope: "share"; orgId: string; shareId: string; contribution: string; exp: number; config: unknown }
  // FilePreviewArgs becomes a union on `source`
  interface FilePreviewArgsBase { locale: Locale; signal: AbortSignal; file: { id: string; name: string; contentType: string; size: number }; read(): Promise<Uint8Array>; config?: unknown }
  export interface FilePreviewConversationArgs extends FilePreviewArgsBase { source: "conversation"; orgId: string; accountId: string; conversationId: string }
  export interface FilePreviewShareArgs extends FilePreviewArgsBase { source: "share"; orgId: string; shareId: string }
  export type FilePreviewArgs = FilePreviewConversationArgs | FilePreviewShareArgs;
  ```
- Decision (deviation from spec §7, recorded): the share claims also carry the signed `orgId`; verification checks it equals the share's org. `file.id` in the share variant is the share id.

- [ ] **Step 1: Failing tests** — in `ui.test.ts`, `it("narrows embed claims on scope, including share")`: a type-level and runtime check that `const c: EmbedClaims = { plugin: "p", contribution: "x", exp: 1, scope: "share", orgId: "o", shareId: "s", generation: 1 }` compiles and `// @ts-expect-error` on `c.accountId.length` without narrowing. In `file-preview.test.ts`, `it("FilePreviewArgs narrows on source")` with `// @ts-expect-error` reading `args.accountId` before `args.source === "conversation"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/ui.test.ts packages/plugin-sdk/test/file-preview.test.ts` — Expected: FAIL (typecheck of the test project: unknown scope `share`).
- [ ] **Step 3: Implement** the types above; doc comments say a share token is valid only for the `file.preview` slot, never for `/api`, and that a previewer needing the conversation declines `source: "share"` by throwing (the kernel then reports the failure and the page falls to the next previewer). Update `agent-docs/extension-points/file-preview.md` (share variant, decline rule) and run `pnpm gen:agent-docs`.
- [ ] **Step 4: Run** `pnpm gen:sdk-api && pnpm exec vitest run packages/plugin-sdk && pnpm check:sdk-api && pnpm check:agent-docs` — Expected: PASS; the API diff holds only the members above.
- [ ] **Step 5: Changeset** `@capybara-hq/plugin-sdk` minor: "Embed tokens and plugin route callers gain a `share` scope (file previewers on a share page); `FilePreviewArgs` is a union on `source` (`conversation` | `share`)." Run `pnpm typecheck` (kernel compiles: fix the two kernel spots that build `FilePreviewArgs`/`EmbedClaims` minimally — add `source: "conversation"` in `files/previewers.ts` render args and narrow `accountId` in `ui/embed-token.ts` `parseClaims`; no behaviour change).
- [ ] **Step 6: Commit** `git add packages/plugin-sdk packages/kernel/src/files/previewers.ts packages/kernel/src/ui/embed-token.ts .changeset/file-share-sdk.md && git commit -m "feat(sdk): share-scoped embed claims and file preview args"`

### Task 2: Governance switches, the table, errors (review alone)

**Files:**
- Create: `packages/kernel/src/migrations/0160_file_shares.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (add `FileSharesTable`, register `file_shares`)
- Modify: `packages/kernel/src/errors.ts`
- Modify: `packages/kernel/src/config/schema.ts` (new `sharing` section), regenerate `docs/config.md`
- Create: `packages/kernel/src/shares/settings.ts`
- Modify: `packages/kernel/src/identity/settings.ts` (`DEPLOYMENT_SETTINGS` `:234`, `DeploymentSettingsView` `:285`, `DEPLOYMENT_SETTINGS_PATCH` `:306`, `SettingsService.view/write`)
- Modify: `packages/kernel/src/orgs/settings.service.ts` (`OrgSettingsSchema` `:196`, `OrgSettingsPatchSchema` `:251`, `OrgSettingsDeployment` `:355`, `check` / `assertOnlyNarrows`)
- Modify: `packages/kernel/src/platform/ops/org-settings.ops.ts`, `packages/kernel/src/platform/ops/admin.ops.ts` (descriptions, `errors` entries)
- Modify: `apps/web/src/lib/audit-actions.ts`, `apps/web/messages/en.json`, `apps/web/messages/zh.json` (errors + audit labels only)
- Test: `packages/kernel/test/shares/sharing-settings.test.ts` (unit), `packages/kernel/test/shares/sharing-settings.http.test.ts` (integration), `packages/kernel/test/unit-tests.json`

**Interfaces:**
- Produces — table (`0160_file_shares.sql`, schema `capybara`, all `IF NOT EXISTS`):
  `id uuid PK`, `org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE`, `code text NOT NULL` (unique index `file_shares_code_key`), `conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE`, `file_id uuid NOT NULL`, `source_path text NULL`, `created_by uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`, `audience text NOT NULL CHECK (audience IN ('internal','external'))`, `name text NOT NULL`, `content_type text NOT NULL`, `size bigint NOT NULL`, `object_key text NULL` (null once freed), `generation int NOT NULL DEFAULT 1`, `expires_at timestamptz NULL`, `revoked_at timestamptz NULL`, `revoked_by uuid NULL REFERENCES accounts(id) ON DELETE SET NULL`, `revoke_reason text NULL CHECK (revoke_reason IN ('creator','admin','conversation_deleted','member_offboarded','creator_lost_access'))`, `last_opened_at timestamptz NULL`, `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`; indexes `(org_id, created_by)`, `(conversation_id)`, `(org_id) WHERE revoked_at IS NULL`. `last_opened_at` is an addition to the spec table (the Shares pages' "last opened" column).
- Produces — errors (`ERROR_CODES`): `"share.not_found": 404`, `"share.sign_in_required": 401`, `"share.external_not_allowed": 403`, `"share.expiry_too_long": 400`, `"share.file_unavailable": 410`, `"org.external_sharing_not_allowed": 400`, `"deployment.external_sharing_not_allowed": 400` (the last one: turning the platform switch on through a token or the Platform tool; not in the spec's list, mirrors `deployment.auto_mode_not_allowed`).
- Produces — config: `sharing.external: z.enum(["allow","deny"]).optional()` and `sharing.maxExpiryDays: z.number().int().min(1).max(365).optional()`, both `hot: true`, no schema default (env `CAPYBARA_SHARING__EXTERNAL`, `CAPYBARA_SHARING__MAX_EXPIRY_DAYS`).
- Produces — `packages/kernel/src/shares/settings.ts`:
  ```ts
  export const EXTERNAL_SHARING_SETTING = "externalSharing";
  export const SHARE_MAX_EXPIRY_SETTING = "shareMaxExpiryDays";
  export const SHARE_MAX_EXPIRY_DEFAULT = 30;
  export type SettingSource = "env" | "file" | "nacos" | "db" | "default";
  export interface ExternalSharingView { value: "allow" | "deny"; source: SettingSource }
  export interface ShareMaxExpiryView { value: number; source: SettingSource }
  export function readExternalSharing(db: KernelSchemaDb, config: Pick<KernelConfigService, "get" | "fieldSource">, log?: Pick<KernelLogger, "warn">): Promise<ExternalSharingView>; // invalid stored → deny + warn
  export function readShareMaxExpiry(db, config, log?): Promise<ShareMaxExpiryView>;           // invalid stored → 30 + warn
  export type ExternalSharingState = "allowed" | "platform_denied" | "org_off";
  export function effectiveExternalSharing(platform: "allow" | "deny", org: "on" | "off" | undefined): ExternalSharingState;
  export const HTML_CDN_ALLOWLIST_DEFAULT: readonly string[]; // the five origins
  export const CdnOrigin: z.ZodType<string>; // https only, host[:port], no path/query/fragment/wildcard, lower-cased
  export function readHtmlCdnAllowlist(db: KernelSchemaDb, log?): Promise<readonly string[]>; // invalid stored → default + warn
  ```
- Produces — deployment settings: `DEPLOYMENT_SETTINGS.htmlRenderCdnAllowlist: z.array(CdnOrigin).max(50).default([...HTML_CDN_ALLOWLIST_DEFAULT])`; patch keys `externalSharing: "allow" | "deny" | null`, `shareMaxExpiryDays: number | null` (null = default), `htmlRenderCdnAllowlist: string[]` (replaces whole); view gains `externalSharing: ExternalSharingView`, `shareMaxExpiryDays: ShareMaxExpiryView`. A field set in the startup config → 409 `deployment.setting_readonly`; `onlyNarrows` + `externalSharing` deny→allow → 400 `deployment.external_sharing_not_allowed`.
- Produces — org settings: `OrgSettingsSchema.externalSharing: z.enum(["on","off"]).optional().catch("off")`; patch `externalSharing: z.enum(["on","off"]).nullable().optional()` (null clears = off); `on` while the platform denies → 400 `org.external_sharing_not_allowed`; `onlyNarrows` + off→on → same code ("needs a person on the web"); `OrgSettingsDeployment` gains `externalSharing: ExternalSharingView` and `shareMaxExpiryDays: number`.
- Produces — audit keys in `AUDIT_ACTION_KEYS`: `"share.created": "shareCreated"`, `"share.refreshed": "shareRefreshed"`, `"share.revoked": "shareRevoked"`, `"share.opened": "shareOpened"`, with `admin.audit.actions.*` messages zh / en; error messages under `errors.share.*`, `errors.org.external_sharing_not_allowed`, `errors.deployment.external_sharing_not_allowed`.

- [ ] **Step 1: Failing unit tests** (`sharing-settings.test.ts`): `effectiveExternalSharing("deny","on") === "platform_denied"`, `("allow", undefined) === "org_off"`, `("allow","on") === "allowed"`; `CdnOrigin` accepts `https://cdn.jsdelivr.net`, `https://example.com:8443`, lower-cases `HTTPS://CDN.X.COM`; rejects `http://a.com`, `https://a.com/path`, `https://*.a.com`, `https://a.com?x`, `data:`, `https://user@a.com`.
- [ ] **Step 2: Failing integration tests** (`sharing-settings.http.test.ts`, one app): `GET /api/v1/admin/settings` shows `externalSharing: { value: "deny", source: "default" }`, `shareMaxExpiryDays: { value: 30, … }`, the default allowlist; `PUT` with a PAT turning `externalSharing` to `allow` → 400 `deployment.external_sharing_not_allowed`, turning it to `deny` succeeds; env-set `sharing.external` → `PUT` 409 `deployment.setting_readonly`; org `PATCH settings { externalSharing: "on" }` while platform denies → 400 `org.external_sharing_not_allowed`; platform allows, session PATCH `on` succeeds, PAT PATCH `on` from `off` → 400; `htmlRenderCdnAllowlist: ["http://x.com"]` → 400 `validation_failed`; migration applied (`file_shares` exists, `INSERT` with `audience='public'` violates the check).
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/shares/sharing-settings.test.ts packages/kernel/test/shares/sharing-settings.http.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement** the migration, schema types, errors, config fields, readers (mirror `sandbox/platform-full-access.ts`: env > file / Nacos > PG > default, invalid stored value fails closed), the deployment and org settings changes, the two ops' descriptions (“externalSharing may only be turned off through this tool”) and `errors` entries, the web audit labels and error messages. Add `sharing-settings.test.ts` to `unit-tests.json`.
- [ ] **Step 5: Run** the two tests, then `pnpm gen:config-docs && pnpm check:migrations && pnpm check:platform-ops && pnpm check:i18n && pnpm exec vitest run apps/web/test/audit-actions.test.ts tools/checks/test/platform-parity.test.ts` — Expected: PASS.
- [ ] **Step 6: Changeset** kernel minor ("external sharing switches, share expiry maximum, HTML CDN allowlist settings; `file_shares` table"); web patch (error and audit labels).
- [ ] **Step 7: Commit** `git add packages/kernel apps/web/src/lib/audit-actions.ts apps/web/messages docs/config.md .changeset && git commit -m "feat(kernel): external sharing switches, CDN allowlist and the file_shares table"`

### Task 3: Design — HTML frame, share action, copy field, shared file page

**Files:**
- Modify: `docs/design/spec.md` (§6 components with state lists and size tables, §5 template T14), `docs/design/reference/src/*` (reference blocks)
- Create: `packages/design/src/display/html-frame.tsx`, `packages/design/src/display/copy-field.tsx`, `packages/design/src/templates/shared-file-page.tsx`
- Modify: `packages/design/src/conversation/file-preview.tsx` (`FilePreviewHeader` `:44`, header row `:151-172`), `packages/design/src/display/index.ts`, `packages/design/src/templates/index.ts`, `packages/design/src/templates/names.ts`, `packages/design/src/i18n.ts`, `packages/design/src/styles/*.css`
- Modify: `tools/checks/src/web-ui.ts` (`WEB_UI_TEMPLATES`), `apps/web/src/dev/catalog/*`, `apps/web/visual/accepted.ts`
- Test: `packages/design/test/html-frame.test.tsx`, `packages/design/test/copy-field.test.tsx`, `packages/design/test/shared-file-page.test.tsx`, `packages/design/test/files.test.tsx` (header share action)

**Interfaces:**
- Produces:
  ```ts
  export const HTML_DOCUMENT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
  export function HtmlDocumentFrame(p: { src: string; title: string }): JSX.Element; // fills its container; sandbox fixed; referrerPolicy="no-referrer"; data-part="html-frame"
  export function CopyField(p: { label: string; value: string }): JSX.Element;      // read-only field + copy button; manual-select fallback like SecretReveal, no "shown once" copy
  // FilePreviewHeader gains
  onShare?(): void;   // a Share icon button before Download
  shared?: boolean;   // marker on the Share button (aria: "Shared")
  export function SharedFilePage(p: {
    name: string; badge: string;
    meta: string;                 // already localized "Shared by 张三 · expires 2026-11-25"
    onDownload?(): void;          // absent: no Download button
    state: "loading" | "ready";
    children?: ReactNode;         // the file body, full width, full remaining height
  }): JSX.Element;
  ```
  `PAGE_TEMPLATES` gains `"SharedFilePage"`; no workspace shell, no sidebar. The invalid-link page uses the existing `StatusPage` (`kind: "404"`).
- Decision: `apps/web` renders no iframe itself; the HTML document only appears through `HtmlDocumentFrame` (the rule in `display/embed.tsx`).

- [ ] **Step 1: Spec diff** — add the three components and the template with states (`html-frame`: ready; `copy-field`: idle, copied, manual; `file-preview` header: shared / not shared; `shared-file-page`: loading, ready, ready-no-download) and size tables in the §9.2 format; add the reference blocks; get the spec diff reviewed in the wave review.
- [ ] **Step 2: Failing jsdom tests** — `html-frame.test.tsx`: `it("fixes the sandbox and the referrer policy")` asserts `iframe.getAttribute("sandbox") === HTML_DOCUMENT_SANDBOX`, no `allow-same-origin`, `referrerpolicy="no-referrer"`, `title` set. `copy-field.test.tsx`: copy writes the value via `navigator.clipboard.writeText`; clipboard rejection selects the text and shows the manual hint. `files.test.tsx`: `onShare` renders a button labelled `files.share`, `shared` adds the marker. `shared-file-page.test.tsx`: renders name, meta, Download only with `onDownload`, `aria-busy` when loading; `findNestedBoxes` finds none.
- [ ] **Step 3: Run** `pnpm exec vitest run --project design packages/design/test/html-frame.test.tsx packages/design/test/copy-field.test.tsx packages/design/test/shared-file-page.test.tsx packages/design/test/files.test.tsx` — Expected: FAIL.
- [ ] **Step 4: Implement** the components (styles in `src/styles/*.css`, token colors only), i18n keys (`files.share`, `files.shared`, `copy.copy`, `copy.copied`, `copy.manual`, `sharedPage.download`), `WEB_UI_TEMPLATES`, catalog entries with `RefBlock`s, and `ACCEPTED`.
- [ ] **Step 5: Run** the design tests, `pnpm check:web-ui`, `pnpm exec vitest run tools/checks/test/web-ui.test.ts` — Expected: PASS. Then run the compare (`COMPARE=html-frame,copy-field,shared-file-page pnpm --filter @capybara-hq/web compare` in the pinned Linux image); the controller dispatches the blind image review; fix severe and moderate differences.
- [ ] **Step 6: Changeset** design patch. **Commit** `git add packages/design docs/design tools/checks/src/web-ui.ts apps/web/src/dev/catalog apps/web/visual/accepted.ts .changeset && git commit -m "feat(design): HTML document frame, copy field, share action and the shared file page"`
- [ ] **Step 7: After push** — trigger `reference-update` (reference PNGs) and `visual-update` (baselines) on the branch; the PR attaches the diffs.

### Task 12: Plugins repo — file-preview drops its HTML previewer (`capybara-hq/plugins`)

**Files (in `/Users/grant/Capybara/plugins`, a worktree from `origin/main`):**
- Modify: `plugins/file-preview/src/previewers.ts` (`PreviewerId` loses `"html"`, the `html` entry leaves `PREVIEWERS`)
- Delete: `plugins/file-preview/ui-src/renderers/html.ts`; modify `plugins/file-preview/ui-src/renderers/index.ts`
- Modify: `plugins/file-preview/test/html-svg.test.ts` (keep the SVG cases; rename to `svg.test.ts`), `plugins/file-preview/test/previewers.test.ts`, `plugins/file-preview/test/extension.test.ts`; delete hostile fixtures only the HTML renderer used (keep those `sanitize.test.ts` / SVG still read)
- Modify: `plugins/file-preview/README.md`, `.changeset/*` (patch, rc bump)

- [ ] **Step 1: Failing test** — `previewers.test.ts`: `it("never claims HTML")`: no previewer accepts `{ name: "r.html", contentType: "text/html", size: 1 }` (`previewerAccepts`), and the ui contributions have no `html` id.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/file-preview/test/previewers.test.ts` — Expected: FAIL.
- [ ] **Step 3: Remove** the previewer, its renderer and contribution; README says HTML is rendered by the kernel's built-in (full rendering, CDN allowlist) since kernel `<version of Task 5>`.
- [ ] **Step 4: Run** `pnpm exec vitest run plugins/file-preview && pnpm verify --fast` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(file-preview): drop the html previewer (the kernel renders HTML)"`; PR in the plugins repo after the core PR merges (the built-in already wins until a deployment upgrades).

---

## Wave 2 — shares core and the panel

### Task 4: Shares core — create, refresh, revoke, list (review alone)

**Files:**
- Create: `packages/kernel/src/shares/shares.module.ts`, `shares.service.ts`, `shares.controller.ts`, `shares.schemas.ts`, `share-code.ts`, `snapshot.ts`, `liveness.ts`, `share-objects.ts`
- Create: `packages/kernel/src/platform/ops/shares.ops.ts`
- Modify: `packages/kernel/src/conversations/files.ts` (`file()` returns `sourcePath`; new `latestAvailable`; `FileOutput.shared`)
- Modify: `packages/kernel/src/infra/outbox/registry.ts` (`OUTBOX_JOBS`), `packages/kernel/src/runtime/maintenance.ts` (dispatch)
- Modify: `packages/kernel/src/http/api.module.ts`, `packages/kernel/src/platform/exclusions.ts`, `packages/kernel/src/platform/route-schemas.ts`, `packages/kernel/src/platform/platform-ops.module.ts`, `packages/kernel/src/platform/operation.ts` (`conversations` domain description)
- Test: `packages/kernel/test/shares/share-code.test.ts` (unit), `packages/kernel/test/shares/shares.http.test.ts`, `packages/kernel/test/shares/shares.dual.test.ts` (container), `packages/kernel/test/platform/ops-shares.test.ts`, `unit-tests.json`, `container-tests.json`

**Interfaces:**
- Consumes: Task 2 table, errors, `readExternalSharing`, `readShareMaxExpiry`, `effectiveExternalSharing`, org settings reader.
- Produces:
  ```ts
  export function newShareCode(): string;                       // 10 × [A-Za-z0-9], crypto.randomBytes + rejection of bytes ≥ 248
  export const SHARE_CODE_RE = /^[A-Za-z0-9]{10}$/;
  export const SHARE_OBJECT_DELETE_JOB = "share-object-delete";
  export const shareObjectDeleteJobId = (shareId: string, generation: number) => `share-object-delete-${shareId}-${generation}`;
  export interface ShareObjectDeleteData { orgId: string; shareId: string; generation: number; objectKey: string }
  export type ShareState = "live" | "expired" | "revoked" | "suspended"; // suspended: external with the switch off, or the creator lost access
  export interface ShareView {
    id: string; code: string; audience: "internal" | "external";
    conversationId: string; fileId: string; sourcePath: string | null;
    name: string; contentType: string; size: number; generation: number;
    createdBy: { id: string; displayName: string }; createdAt: string;
    expiresAt: string | null; lastOpenedAt: string | null;
    state: ShareState; revokedAt: string | null; revokeReason: string | null;
    /** A newer available version of `sourcePath` exists (refresh offered). */
    newerVersion: boolean;
  }
  export interface SharePolicy { external: ExternalSharingState; maxExpiryDays: number }
  class SharesService {
    create(orgId: string, accountId: string, conversationId: string, fileId: string, body: { audience: "internal" | "external"; expiresInDays: 1 | 7 | 30 | null }, actor: { tokenId?: string }): Promise<ShareView>;
    refresh(orgId: string, accountId: string, shareId: string, actor): Promise<ShareView>;
    revoke(org: OrgContext, accountId: string, shareId: string, actor): Promise<void>;          // idempotent
    forFile(orgId: string, accountId: string, conversationId: string, fileId: string): Promise<{ shares: ShareView[]; policy: SharePolicy }>;
    list(org: OrgContext, accountId: string, scope: "mine" | "all"): Promise<{ shares: ShareView[] }>;
  }
  class ShareLiveness {   // one query; used by Tasks 5, 6, 7, 9
    byCode(code: string): Promise<LiveShare | null>;           // live = not revoked, not expired, org not deleted, creator passes ConversationAccess.isAccessible's predicates, external ⇒ effective switch allowed
    byId(shareId: string, generation?: number): Promise<LiveShare | null>;
  }
  interface LiveShare { id: string; orgId: string; code: string; audience: "internal" | "external"; conversationId: string; createdBy: string; createdByName: string; name: string; contentType: string; size: number; objectKey: string; generation: number; expiresAt: Date | null }
  // ConversationFiles
  file(...) → adds sourcePath: string | null  (null for uploads)
  latestAvailable(orgId: string, conversationId: string, viewer: string, sourcePath: string): Promise<{ id; name; contentType; size; objectKey } | null>;
  FileOutput.shared: boolean   // the viewer has a live share of this file's sourcePath (or attachment)
  ```
- Routes (`shares.controller.ts`, all `@OrgAction("agents.use")`, owner via `ConversationAccess.isAccessible`):
  `POST /api/v1/orgs/:orgId/conversations/:id/files/:fileId/shares` (201 `{ share }`),
  `GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/shares` (`{ shares, policy }`),
  `POST /api/v1/orgs/:orgId/shares/:shareId/refresh` (`{ share }`),
  `DELETE /api/v1/orgs/:orgId/shares/:shareId` (204),
  `GET /api/v1/orgs/:orgId/shares?scope=mine|all` (`{ shares }`; `all` needs `can(org.role, "org.update")`, else 403 `forbidden`). Decision: `scope=` replaces the spec's `mine=1|all` (unambiguous); recorded.
- Rules: removed file or upload mismatch → 410 `share.file_unavailable`; external without effective switch → 403 `share.external_not_allowed`; external with null expiry or expiry > max → 400 `share.expiry_too_long`; refresh by non-creator, revoke by neither creator nor org admin, unknown id → 404 `share.not_found`; refresh of an upload share → 400 `validation_failed`; refresh with no newer available version → 410 `share.file_unavailable`.
- Platform: ops `conversations.list-shares` (mirrors `GET /api/v1/orgs/:orgId/shares`, input `{ scope }`) and `conversations.revoke-share` (mirrors `DELETE …/shares/:shareId`, `confirm: "org"`); exclusions `POST …/files/:fileId/shares` and `POST …/shares/:shareId/refresh` (`human-only`: "Publishing a file outside the conversation is a person's act"), `GET …/files/:fileId/shares` (`internal`: "The right panel's per-file view; conversations.list-shares lists the same shares"; spec §10 omitted this route).
- Outbox: `"share-object-delete": { queue: "cap-kernel-maintenance", idempotent: "Deletes one object key; deleting a missing object is a no-op", processedIn: "packages/kernel/src/runtime/maintenance.ts", opts: { attempts: 10, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true } }`.

- [ ] **Step 1: Failing unit test** `share-code.test.ts`: 10 000 codes all match `SHARE_CODE_RE`, no duplicates; with `randomBytes` stubbed to `[248, 255, 0, …]` the rejected bytes are skipped (first char `A`).
- [ ] **Step 2: Failing integration tests** `shares.http.test.ts` (one app, fake object store, model-fake delivering files): owner creates internal never-expiring share → 201, `code` matches, object `shares/<id>/1` exists with the bytes, audit `share.created` (detail `{ shareId, audience }`); non-owner member → 404 `conversation.not_found`; external while denied → 403 `share.external_not_allowed`; allowed + `expiresInDays: null` → 400 `share.expiry_too_long`; max 7 + `30` → 400; removed file → 410; upload whose object changed → 410; files list returns `shared: true` for that file; a second delivery of the same `sourcePath` → `forFile` shows `newerVersion: true`; refresh copies v2 under the same code, `generation: 2`, outbox row `share-object-delete-<id>-1`; refresh skips a newest version whose object is gone; revoke by an org admin → 204, `revoke_reason = 'admin'`, outbox row for the current generation; revoke twice → 204 once audited; `GET /shares?scope=all` as member → 403; the `policy` block reflects `platform_denied` / `org_off` / `allowed`.
- [ ] **Step 3: Failing container test** `shares.dual.test.ts` (two replicas): object written before the row (a store spy records `put` before the `INSERT`, and a forced insert failure leaves the object and no row); a `share-object-delete` job delivered twice deletes once and succeeds twice; create on replica A, revoke on B.
- [ ] **Step 4: Failing ops test** `ops-shares.test.ts`: `conversations.list-shares` lists mine; `{ scope: "all" }` as member refused; `conversations.revoke-share` revokes.
- [ ] **Step 5: Run** `pnpm exec vitest run packages/kernel/test/shares packages/kernel/test/platform/ops-shares.test.ts` — Expected: FAIL.
- [ ] **Step 6: Implement.** `create`: resolve the file (`ConversationFiles.file`, which rechecks owner access and `storedMatches`), check rules, generate id and code, stream `get` → `put` into `shares/<id>/1` (pipe the `ReadableStream`, never buffer; re-check `attachmentContentMatches` on the got head for uploads) outside any transaction, then a `@Transactional()` insert + audit; on unique-code conflict retry with a new code (≤ 3). `refresh`: copy first, then a `@Transactional()` row update + `OutboxService.add` for the old generation + audit `share.refreshed`. `revoke`: `@Transactional()` update + outbox + audit `share.revoked` (detail `{ shareId, reason }`). Liveness reuses `access.ts` predicates (export `parentReachable` / `visibleTo` if needed) with `created_by` as the viewer. Register schemas in `route-schemas.ts`, controllers in `api.module.ts`, ops in `platform-ops.module.ts`.
- [ ] **Step 7: Run** the tests, then `pnpm check:platform-ops && pnpm check:kernel-conventions && pnpm exec vitest run tools/checks/test/platform-parity.test.ts packages/kernel/test/platform/agent-docs.test.ts packages/kernel/test/conversations/files.http.test.ts` — Expected: PASS.
- [ ] **Step 8: Changeset** kernel minor; **Commit** `git add packages/kernel .changeset && git commit -m "feat(kernel): share a conversation file as a snapshot"`

### Task 8: Web — one file body, the HTML built-in, the Share dialog

**Files:**
- Create: `apps/web/src/lib/file-source.ts`, `apps/web/src/lib/shares.ts`, `apps/web/src/lib/html.ts`, `apps/web/src/lib/query/shares.ts`
- Create: `apps/web/src/components/file-preview/FilePreviewBody.tsx`, `apps/web/src/components/file-preview/ShareDialog.tsx`
- Modify: `apps/web/src/components/conversation/FilePanel.tsx` (header + body split), `apps/web/src/lib/files.ts` (`builtinPreview` gains `"html"`; `FileOutput.shared`), `apps/web/src/lib/query/keys.ts`, `apps/web/src/lib/query/conversation.ts`
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (owner of the `shares` namespace and the settings switch labels)
- Test: `apps/web/test/file-panel.test.tsx`, `apps/web/test/share-dialog.test.tsx`, `apps/web/test/file-source.test.ts`

**Interfaces:**
- Consumes: Task 3 (`HtmlDocumentFrame`, `CopyField`, `FilePreviewHeader.onShare/shared`), Task 4 `ShareView` / `SharePolicy` and routes, Task 5 `POST …/files/:fileId/html-token` → `{ path: string; expiresIn: number }`, Task 6 share routes (shapes below), Task 7 share embed route.
- Produces:
  ```ts
  // lib/files.ts
  export const isHtmlFile = (f: { name: string; contentType: string }) => boolean; // base type text/html, or name ends .html / .htm
  builtinPreview(file) → "html" | "image" | "markdown" | "csv" | "tsv" | "text" | null   // "html" first
  // lib/file-source.ts
  export type FileSource =
    | { kind: "conversation"; orgId: string; conversationId: string; file: FileOutput }
    | { kind: "share"; code: string; meta: ShareMeta };
  export interface ShareMeta { name: string; contentType: string; size: number; sharedBy: string; expiresAt: string | null; audience: "internal" | "external"; render: "html" | "previewers" | "download"; previewers: FilePreviewerItem[] }
  export function sourceUrls(s: FileSource): { download: string; inline: string; content: string; html?: string }; // share: /api/v1/s/<code>/content?download=1, /inline, /content, /html
  // components/file-preview/FilePreviewBody.tsx
  export function FilePreviewBody(p: { source: FileSource; previewer: string | null; onPreviewers(options: { id: string; title: string }[]): void; onDownload(): void }): JSX.Element;
  // Previewer option order: "html" (Rendered) then "source" (the text built-in) for HTML files; otherwise extension previewers first, then the built-in; same rule for both sources.
  // components/file-preview/ShareDialog.tsx
  export function ShareDialog(p: { orgId: string; conversationId: string; file: FileOutput; open: boolean; onOpenChange(o: boolean): void }): JSX.Element;
  // lib/query/shares.ts (defineQuery / useAppMutation)
  fileSharesQuery(orgId, conversationId, fileId)  // freshness "live"
  orgSharesQuery(orgId, scope: "mine" | "all")    // freshness "live"
  shareMetaQuery(code), shareTextQuery(code), shareViewQuery(code, p, locale)  // keys.share(code).…, freshness "live"
  useCreateShare / useRefreshShare / useRevokeShare → invalidate fileShares, orgShares, the conversation's files list
  ```
- i18n keys added here (zh / en), used by Tasks 10 and 11 too: `shares.dialog.{title,audience,internal,external,externalOffPlatform,externalOffOrg,expiry,days1,days7,days30,never,create,link,copy,live,updateToLatest,revoke,revoked,expired,suspended,recent}`, `shares.panel.{share,shared,rendered,source,htmlTooLarge}`, `shares.page.{sharedBy,expires,neverExpires,download,invalidTitle,invalidBody,signIn}`, `shares.list.{title,file,owner,audience,expiry,lastOpened,revoke,empty,mineTitle}`, `orgSettings.externalSharing.{label,help,platformDenied}`, `admin.settings.sharing.{external,maxExpiryDays,cdnAllowlist,cdnHelp,readonly}`, `connections.nav.{shares,myShares}`.

- [ ] **Step 1: Failing tests** — `file-source.test.ts`: `isHtmlFile({ name: "a.HTM", contentType: "application/octet-stream" })` true, `text/html; charset=gbk` true, `a.html.txt` false; `sourceUrls` for a share. `file-panel.test.tsx`: an HTML file renders `HtmlDocumentFrame` with `src` = the minted `path` even when an extension previewer accepts it; the Source option shows the text built-in; an HTML file over 20 MiB shows `NoPreview` with `shares.panel.htmlTooLarge` and mints no token; the header shows Share for an available file, not for a removed one; `shared: true` marks it. `share-dialog.test.tsx`: External disabled with the platform reason when `policy.external === "platform_denied"`, with the org reason for `org_off`; expiry choices above `maxExpiryDays` are not offered and Never is not offered for external; create posts `{ audience, expiresInDays }` and shows `CopyField` with `${location.origin}/s/<code>`; the live list shows Copy, Update to latest only when `newerVersion`, Revoke.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/file-panel.test.tsx apps/web/test/share-dialog.test.tsx apps/web/test/file-source.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Move the body logic of `FilePanel.tsx` into `FilePreviewBody` behind `FileSource`; `FilePanel` keeps the header, the removed / loading / failed frames. The HTML token is minted with `useAppMutation` (`invalidates: () => []`, as `EmbedTab` mints embed tokens) and renewed on remount only (the token only loads the document). The dialog is built from design `Dialog`, `RadioGroup`, `Select`, `Field`, `Callout`, `CopyField`, `ObjectList`.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui && pnpm check:i18n` — Expected: PASS.
- [ ] **Step 5: Changeset** web patch; **Commit** `git add apps/web/src apps/web/test apps/web/messages .changeset && git commit -m "feat(web): HTML built-in previewer and the Share dialog"`

---

## Wave 3 — HTML document, lifecycle, settings pages

### Task 5: HTML document, its token and CSP; Deliver's sentence (review alone)

**Files:**
- Create: `packages/kernel/src/html/html-token.ts`, `html/csp.ts`, `html/html-type.ts`, `html/html-document.controller.ts`, `html/html-document.service.ts`, `html/html.module.ts`
- Modify: `packages/kernel/src/http/api.module.ts`, `platform/exclusions.ts`, `packages/kernel/test/identity/public-routes.test.ts`
- Modify: `packages/kernel/src/tools/builtins/sandbox/deliver.ts` (`SPEC.description` `:27`)
- Test: `packages/kernel/test/html/html-token.test.ts` (unit), `packages/kernel/test/html/csp.test.ts` (unit), `packages/kernel/test/html/html-document.http.test.ts`, `unit-tests.json`

**Interfaces:**
- Consumes: Task 2 `readHtmlCdnAllowlist`; Task 4 `ShareLiveness.byId`, `ConversationFiles.file`.
- Produces:
  ```ts
  export const HTML_KEY_INFO = "capybara-html/1";
  export const HTML_TOKEN_TTL_SECONDS = 300;
  export type HtmlClaims = { kind: "file"; orgId: string; conversationId: string; fileId: string; accountId: string; exp: number } | { kind: "share"; shareId: string; generation: number; exp: number };
  class HtmlTokens { issue(c: Omit<HtmlClaims, "exp">): { token: string; expiresAt: Date }; verify(token: unknown): HtmlClaims | null } // format and checks as EmbedTokens (strict base64url, constant-time over keyring keys, strict claim keys, skew 30 s)
  export class HtmlTokensModule {}                         // providers/exports HtmlTokens only (Tasks 6 imports it)
  export function htmlDocumentCsp(allowlist: readonly string[]): string;   // exact spec §4 string, directives joined with "; "
  export function isHtmlType(name: string, contentType: string): boolean;  // same rule as the web's isHtmlFile
  export function htmlContentType(stored: string): string;                // "text/html; charset=<stored charset or utf-8>"
  class HtmlDocumentService { serve(claims: HtmlClaims, reply: FastifyReply): Promise<void> } // Task 6 adds the share branch's resolution if not done here
  ```
- Routes: `POST /api/v1/orgs/:orgId/conversations/:id/files/:fileId/html-token` (`@OrgAction("agents.use")`, owner; not HTML → 400 `conversation.artifact_not_previewable`; > `FILE_PREVIEW_MAX_BYTES` → same code, message "too large to render"; → `{ path: "/api/v1/html/<token>", expiresIn: 300 }`); `GET /api/v1/html/:token` (`@Public()`; bad or expired token, or a live re-check failing → 404 `not_found` as a plain response; streams the object with the spec §4 headers). Exclusions: both `transport` ("Serves a sandboxed HTML document"; "Mints the HTML document's load token for the web panel"). `PUBLIC_ROUTES` gains `"GET /api/v1/html/:token"`.
- Deliver description gains, verbatim: "An HTML report should be one self-contained file: inline its own CSS and JS, load libraries from a public CDN, embed images as data URLs."

- [ ] **Step 1: Failing unit tests** — `csp.test.ts`: `htmlDocumentCsp(["https://cdn.jsdelivr.net"])` equals the spec §4 policy with the origin in `script-src`, `style-src`, `font-src`, `img-src` and nowhere else; contains `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` and neither `allow-same-origin` nor `allow-top-navigation`; `connect-src 'none'`, `frame-ancestors 'self'`. `htmlContentType("text/html; charset=GBK")` → `text/html; charset=gbk`; `("text/html")` → `text/html; charset=utf-8`. `html-token.test.ts`: round-trip both kinds; tampered signature, extra claim key, `kind: "other"`, expired beyond skew, `exp` too far ahead → null; a token signed with the previous master key verifies; an embed token never verifies as an HTML token (different HKDF info).
- [ ] **Step 2: Failing integration tests** `html-document.http.test.ts`: owner mints a token for a delivered `report.html`; `GET` the path → 200 with every spec §4 header exactly (`content-security-policy` equals `htmlDocumentCsp(defaults)`), body = stored bytes; changing the allowlist setting changes the next load's CSP; a non-owner minting → 404; a `.csv` → 400; a 21 MiB HTML → 400; a token for a file whose conversation was deleted after minting → 404; expired token (clock seam) → 404; GBK charset case (Review Focus 3).
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/html` — Expected: FAIL.
- [ ] **Step 4: Implement**; the `share` branch verifies `ShareLiveness.byId(shareId, generation)` and `isHtmlType` (a revoked share or a refreshed generation → 404); stream the body (no buffering beyond 20 MiB guard read from the recorded size).
- [ ] **Step 5: Deliver sentence with zero drift** — run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` before the edit (PASS), edit the description, run it again: Expected PASS with no new `DriftReason` (tool definitions come from the snapshot by `specHash`). Note in the commit body that "always allow" grants on `Deliver` are asked once again (the spec hash changes). Run `pnpm exec vitest run packages/kernel/test/tools` for the tool-design checks.
- [ ] **Step 6: Run** `pnpm exec vitest run packages/kernel/test/html packages/kernel/test/identity/public-routes.test.ts && pnpm check:platform-ops` — Expected: PASS.
- [ ] **Step 7: Changeset** kernel minor; **Commit** `git add packages/kernel .changeset && git commit -m "feat(kernel): serve HTML files as sandboxed documents with a CDN allowlist"`

### Task 9: Lifecycle revokes and the daily sweep (review alone)

**Files:**
- Create: `packages/kernel/src/shares/revoke.ts`, `packages/kernel/src/shares/sweep.job.ts`
- Modify: `packages/kernel/src/conversations/conversations.service.ts` (the delete transaction, after `unbindConversation` `:925`), `packages/kernel/src/orgs/offboarding.ts` (`offboard`, new step 11 in the doc list), `packages/kernel/src/roles/worker.module.ts`
- Test: `packages/kernel/test/shares/share-lifecycle.http.test.ts`, `packages/kernel/test/shares/sweep.dual.test.ts` (container), `container-tests.json`

**Interfaces:**
- Consumes: Task 4 `ShareLiveness`, `SHARE_OBJECT_DELETE_JOB`, `shareObjectDeleteJobId`, `OutboxService.add`.
- Produces:
  ```ts
  /** In the caller's transaction: marks matching live rows revoked with `reason` and owes each current object's deletion. Returns the count. */
  export function revokeSharesIn(db: KernelSchemaDb, outbox: Pick<OutboxService, "add">, where: { conversationId: string } | { orgId: string; createdBy: string }, reason: "conversation_deleted" | "member_offboarded" | "creator_lost_access"): Promise<number>;
  export const SHARE_SWEEP_JOB = "share-sweep";
  @LockedCron("40 3 * * *", { name: SHARE_SWEEP_JOB }) ShareSweepJob.sweep(): Promise<void>;
  ```
- Sweep, in order, outside transactions for storage calls: (1) revoke with `creator_lost_access` the unrevoked rows whose creator fails the liveness predicates (batched, `@Transactional` per batch, owing deletions); (2) delete objects of rows expired or revoked more than 7 days ago and clear `object_key` (rows kept); (3) per non-deleted org, list `shares/` and delete objects older than one hour whose key is no row's `object_key`.

- [ ] **Step 1: Failing integration tests** `share-lifecycle.http.test.ts`: deleting the conversation revokes its shares (`conversation_deleted`) in the same transaction (the link 404s at once, outbox row present); removing the member revokes theirs (`member_offboarded`), another member's shares untouched; disabling the creator's account stops the link at once without a revoke, re-enabling restores it (Review Focus: switch / cause goes away); external share stops when the org switch turns off and works again when on, while not expired; sweep revokes a share whose agent was deleted with `creator_lost_access`.
- [ ] **Step 2: Failing container test** `sweep.dual.test.ts`: the sweep runs once per tick across two replicas; an object 2 hours old under `shares/` with no row is deleted, one 10 minutes old is kept, a live share's object is kept; a share revoked 8 days ago loses its object and keeps its row with `object_key = null`.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/shares/share-lifecycle.http.test.ts packages/kernel/test/shares/sweep.dual.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement**; register `ShareSweepJob` under `WorkerModule` only.
- [ ] **Step 5: Run** the tests plus `packages/kernel/test/conversations/conversations.http.test.ts` and `packages/kernel/test/orgs` — Expected: PASS.
- [ ] **Step 6: Changeset** kernel minor; **Commit** `git add packages/kernel .changeset && git commit -m "feat(kernel): revoke shares with their conversation or member, and sweep snapshots daily"`

### Task 10: Web — switches and the Shares lists

**Files:**
- Modify: `apps/web/src/app/(app)/settings/organization/view.tsx`, `apps/web/src/app/(app)/admin/settings/view.tsx`, `apps/web/src/lib/org-settings.ts`, `apps/web/src/lib/admin.ts`
- Create: `apps/web/src/app/(app)/settings/shares/{page,view}.tsx`, `apps/web/src/app/(app)/account/shares/{page,view}.tsx`
- Modify: `apps/web/src/components/settings-nav.ts`, `apps/web/src/components/shell/path.ts`, `apps/web/src/lib/query/routes.ts` (two entries)
- Test: `apps/web/test/org-settings.test.tsx`, `apps/web/test/admin-settings.test.tsx`, `apps/web/test/shares-settings.test.tsx`

**Interfaces:**
- Consumes: Task 2 view / patch shapes, Task 8 `orgSharesQuery`, `useRevokeShare`, i18n keys.
- Produces: routes `/settings/shares` (admin: `orgSharesQuery(orgId, "all")`) and `/account/shares` (`orgSharesQuery(orgId, "mine")`), both `ListPage` + `DataTable` (file, owner, audience, expiry, last opened, Revoke with confirm).

- [ ] **Step 1: Failing tests** — org settings: the External sharing switch is disabled with `orgSettings.externalSharing.platformDenied` when `deployment.externalSharing.value === "deny"`; saving sends `PATCH { externalSharing: "on" }`. Admin settings: External sharing and max expiry controls; a `source` of `env` / `file` / `nacos` renders read-only; the allowlist editor rejects `http://` client-side and sends the whole list. Shares pages: admin sees all, member sees the nav item `myShares` but not `shares`; Revoke calls `DELETE` and the row moves to the revoked state.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/org-settings.test.tsx apps/web/test/admin-settings.test.tsx apps/web/test/shares-settings.test.tsx apps/web/test/query-routes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with design components only; route entries prefetch the list queries.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui && pnpm check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `git add apps/web .changeset && git commit -m "feat(web): external sharing switches and the Shares pages"`

---

## Wave 4 — public share routes and the share page

### Task 6: Public share routes (review alone)

**Files:**
- Create: `packages/kernel/src/shares/share-open.controller.ts`, `packages/kernel/src/shares/share-open.service.ts`
- Modify: `packages/kernel/src/infra/throttler/named-throttlers.ts` (`share-open`, table comment), `packages/kernel/src/shares/shares.module.ts`, `packages/kernel/src/html/html-document.service.ts` (share branch if Task 5 left a seam), `packages/kernel/src/http/api.module.ts`, `platform/exclusions.ts`, `packages/kernel/test/identity/public-routes.test.ts`
- Test: `packages/kernel/test/shares/share-open.http.test.ts`

**Interfaces:**
- Consumes: Task 4 `ShareLiveness.byCode`, `PreviewerRegistry` (`forShare` is Task 7: until then `previewers: []` from a seam `ShareOpenService.previewersFor(share)` that Task 7 fills), Task 5 `HtmlTokens`, `isHtmlType`, `ConversationFiles`-equivalent text reading (reuse `trimUtf8` / `readPrefix` by exporting them from `conversations/files.ts`).
- Produces (`@Public()`, all under `/api/v1/s/:code`):
  `GET /api/v1/s/:code` → `ShareMeta` (Task 8 shape; `render`: `html` when `isHtmlType` and size ≤ 20 MiB, else `previewers` when an extension previewer or a web built-in kind (image / text) takes it, else `download`);
  `GET /api/v1/s/:code/content` (`?download=1` adds `content-disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<pct-encoded>`), headers per spec §3;
  `GET /api/v1/s/:code/text?limit=` (as the panel's text route, ≤ 1 MiB, `text/plain; charset=utf-8`, `x-content-original-type`, `x-content-truncated`);
  `GET /api/v1/s/:code/inline` (only `image/png|jpeg|gif|webp`, streamed with its type, `nosniff`, `content-security-policy: sandbox; default-src 'none'`, `cache-control: private, no-store`; other types 404);
  `GET /api/v1/s/:code/html` → 302 `Location: /api/v1/html/<token>` (`kind: "share"`), `cache-control: no-store`.
  Every route: `CredentialThrottler.reserve(["share-open"], req, reply)` before the lookup, `succeeded` after a live hit; malformed code (fails `SHARE_CODE_RE`) counts as a miss. Internal: `req.principal` must be a session principal (`via` session) whose account is an active member of the share's org (not the session's current org), else no principal → 401 `share.sign_in_required`, a principal that is not a member → 404.
  `share.opened` on the metadata route only: `LockService.lease("capk:share-opened:<shareId>:<viewer>", "1", 600_000)` where viewer = account id or `sha256(ip)`; when it returns true, a `@Transactional()` write of the audit (`actorAccountId` the account or null, `orgId`, `target: shareId`, detail `{ shareId, audience }`) and `last_opened_at = now()`.
  Named throttler: `{ name: "share-open", group: "share-open", onSuccess: "refund", limit: 30, ttl: 600_000, code: "rate_limited", message: "Too many share link requests; try again later", getTracker: ip }`.
  Exclusions: the five routes, `transport` ("Public share link: …"). `PUBLIC_ROUTES` gains them.

- [ ] **Step 1: Failing integration tests** `share-open.http.test.ts`: external anonymous meta → 200 with `sharedBy` = creator display name, `render: "html"` for HTML; unknown, revoked, expired codes → 404 `share.not_found` with identical bodies; internal anonymous → 401; internal with a non-member session → 404; internal with a member session whose current org is another org → 200 (Review Focus 4); external after the org switch off → 404; `/content` headers exact, `?download=1` with `季度报告 "Q3".html` (Review Focus 2); `/text` of a binary file → 400 `conversation.artifact_not_previewable`; `/inline` of an SVG → 404; `/html` → 302 to a path whose `GET` returns the HTML document; 31 misses from one IP → the 31st is 429 `rate_limited` (`retry-after` set) while another IP still gets 404; a successful open does not count; `share.opened` written once for two opens within 10 minutes by the same viewer and twice for two IPs; the 300 MB fake object streams (`/content` reads through without the service buffering: a store whose body errors after the headers shows the response was already streaming — Review Focus 5).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/shares/share-open.http.test.ts packages/kernel/test/identity/public-routes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:platform-ops && pnpm check:kernel-conventions` — Expected: PASS.
- [ ] **Step 5: Changeset** kernel minor; **Commit** `git add packages/kernel .changeset && git commit -m "feat(kernel): public share link routes"`

### Task 11: Web — the share page `/s/[code]`

**Files:**
- Create: `apps/web/src/app/(auth)/s/[code]/page.tsx`, `apps/web/src/app/(auth)/s/[code]/view.tsx`
- Modify: `apps/web/src/lib/routes.ts` (`PUBLIC_PREFIXES` gains `"/s"`), `apps/web/src/proxy.ts` (`referrer-policy: no-referrer`, `x-robots-tag: noindex` on `/s/*` documents), `apps/web/src/lib/query/routes.ts` (`/s/[code]` entry), `apps/web/src/components/extension-ui/EmbedTab.tsx` (a `share` variant), `apps/web/src/lib/ui.ts` (`requestShareEmbedToken`)
- Test: `apps/web/test/share-page.test.tsx`, `apps/web/test/server-data.test.ts` (the `isPublicPath` cases)

**Interfaces:**
- Consumes: Task 3 `SharedFilePage`, `StatusPage`; Task 8 `FilePreviewBody`, `FileSource`, `shareMetaQuery`; Task 6 routes; Task 7 `POST /api/v1/s/:code/embed-token/:plugin/:previewerId` → `{ token, expiresIn, src }`.
- Produces: `EmbedTab` prop `share?: { code: string }` (mutually exclusive with `orgId`/`conversationId`): mints through `requestShareEmbedToken(code, plugin, previewerId)`, context `{ scope: "share" }`, ignores `navigate` messages (no app on the page). The page uses `EmbedTab` inside `BlockBoundary` directly (no `ExtensionSlot`; decision for the spec's "left to the builder" point). `page.tsx` exports `metadata = { robots: { index: false, follow: false } }`.

- [ ] **Step 1: Failing tests** `share-page.test.tsx` (`renderRouteWithCache`): `render: "html"` → `HtmlDocumentFrame` with `src="/api/v1/s/<code>/html"`; `render: "previewers"` with a view previewer → the rendered view from `/api/v1/s/<code>/previews/...`; with an embed previewer → `EmbedTab` in share mode; with only a built-in (CSV) → reads `/api/v1/s/<code>/text`; image → `src` `/api/v1/s/<code>/inline`; `render: "download"` → file card with Download linking `/api/v1/s/<code>/content?download=1`; 404 → `StatusPage` with `shares.page.invalidTitle`; 401 → navigates to `/login?returnTo=%2Fs%2F<code>`; the page renders no sidebar and requests no `/api/v1/orgs/*` route. `isPublicPath("/s/AbCdEfGh12")` true.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/share-page.test.tsx apps/web/test/query-routes.test.ts apps/web/test/server-data.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui && pnpm check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `git add apps/web .changeset && git commit -m "feat(web): the public share page"`

---

## Wave 5 — previewers for a share

### Task 7: Share-scoped embed tokens and view previewers (review alone)

**Files:**
- Modify: `packages/kernel/src/ui/embed-token.ts` (`CLAIM_KEYS`, `parseClaims`, `issue` signature), `packages/kernel/src/ctx/create-ctx.ts` (`KernelDeps`, `verifyEmbedToken` `:501`), `packages/kernel/src/extensions/host.ts` (pass `shares`), `packages/kernel/src/http/plugin-route-access.ts` (`embed()` `:114`), `packages/kernel/src/files/previewers.ts` (`forShare`, `renderShare`, `shareEmbed`), `packages/kernel/src/ui/views.ts` (`shareEmbedPath`), `packages/kernel/src/shares/liveness.ts` (`embedLive`; its own `ShareLivenessModule` so `ExtensionsModule` can import it without a cycle), `packages/kernel/src/shares/share-open.service.ts` (fill `previewersFor`)
- Create: `packages/kernel/src/shares/share-previews.controller.ts`
- Modify: `packages/kernel/src/http/api.module.ts`, `platform/exclusions.ts`, `packages/kernel/test/identity/public-routes.test.ts`
- Test: `packages/kernel/test/ui/embed-token.test.ts` (unit, extend), `packages/kernel/test/shares/share-embed.http.test.ts`

**Interfaces:**
- Consumes: Task 1 SDK types, Task 4 `ShareLiveness`, Task 6 `ShareOpenService`.
- Produces:
  ```ts
  // embed-token.ts: CLAIM_KEYS += "shareId", "generation"; share scope parsed strictly (no accountId / role / conversationId / agentId / fileId; generation a positive safe integer)
  EmbedTokens.issue(c: Omit<OrgEmbedClaims, "exp"> | Omit<PlatformEmbedClaims, "exp"> | Omit<ShareEmbedClaims, "exp">)
  // liveness.ts
  ShareLiveness.embedLive(plugin: string, c: ShareEmbedClaims): Promise<boolean>; // one query: live share, same generation and org, plugin enabled in the org
  // KernelDeps gains (required key, like hooks)
  shares: Pick<ShareLiveness, "embedLive">;
  // previewers.ts
  forShare(orgId: string, file: { name: string; contentType: string; size: number }): Promise<PreviewerItem[]>;
  renderShare(t: { orgId: string; shareId: string; file: LiveShare; plugin: string; id: string; locale: "zh" | "en" }): Promise<UiView>; // args { source: "share", orgId, shareId, file: { id: shareId, … }, read } reading the snapshot
  shareEmbed(orgId: string, file, plugin: string, previewerId: string): Promise<{ contribution: string } | null>;
  // views.ts
  shareEmbedPath(plugin: string, contribution: string): string; // the loaded file.preview embed's path, else 404 ui.not_found
  ```
- `verifyEmbedToken`: a share token verifies only when the contribution's slot is `file.preview` and `embedLive` holds; returned as is (no role). `PluginRouteAccess.embed` maps it to `RouteCaller` `{ access: "embed", scope: "share", orgId, shareId, contribution, exp, config }` (config = the org's effective config). Kernel `/api` routes never accept any embed token (unchanged guard; test it).
- Routes (`@Public()`, throttled like Task 6, live lookup by code): `POST /api/v1/s/:code/embed-token/:plugin/:previewerId` → `{ token, expiresIn: 300, src }` (the previewer must take the snapshot and be an embed, else 404 `ui.not_found`; CSRF header required as for every unsafe public route); `GET /api/v1/s/:code/previews/:plugin/:previewerId?locale=` → `{ view }` (errors as the panel's preview route). Exclusions `transport`; `PUBLIC_ROUTES` gains both.

- [ ] **Step 1: Failing unit tests** (`embed-token.test.ts`): share claims round-trip; a share token carrying `accountId`, or `fileId`, or `generation: 0`, or a missing `orgId` → null; an org token with `shareId` → null.
- [ ] **Step 2: Failing integration tests** `share-embed.http.test.ts` (fixture `preview-fake` from `packages/kernel/test/fixtures/plugins`, with one embed and one view previewer): the embed-token route answers a token whose claims are `scope: "share"`; `ctx.ui.verifyEmbedToken` accepts it for the `file.preview` contribution and refuses it for another slot's contribution; after revoke, and after refresh (generation 2), the old token → null and the plugin `embed` route → 401; with the plugin disabled in the org → null; the token as `Authorization: Bearer` on `/api/v1/orgs/:orgId/conversations` → 401 `auth.required`; the view previewer renders with `args.source === "share"` and `read()` returning the snapshot bytes; a previewer that throws on `source: "share"` → 502 `ui.render_failed`; the meta route now lists `previewers`.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/ui/embed-token.test.ts packages/kernel/test/shares/share-embed.http.test.ts packages/kernel/test/ui/embed.http.test.ts packages/kernel/test/files` — Expected: FAIL (first two), PASS (the existing ones).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the tests, `packages/kernel/test/identity/public-routes.test.ts`, `pnpm check:platform-ops`, `pnpm exec vitest run packages/kernel/test/ui` — Expected: PASS.
- [ ] **Step 6: Changeset** kernel minor; **Commit** `git add packages/kernel .changeset && git commit -m "feat(kernel): file previewers on a share page with share-scoped embed tokens"`

---

## Wave 6 — end to end and docs

### Task 13: E2E (Chromium); AGENTS.md and docs

**Files:**
- Create: `apps/web/e2e/file-sharing.spec.ts`
- Modify: `AGENTS.md` (new area rule line), `docs/architecture.md` (`shares` and `html` modules in the kernel map), `docs/guide/conversation-ui.md` (Share, HTML rendering), `docs/deploy/README.md` (external sharing switches, `sharing.*` config, CDN allowlist, residual risks from spec "Isolation without a second origin"), `.agents/skills/writing-extension-ui/SKILL.md` (share scope, previewers on a share page, HTML built-in wins), `.agents/skills/writing-kernel-api/SKILL.md` (the `share-open` throttler in the named-throttler list)

**Interfaces:**
- Consumes: everything above.
- AGENTS.md line (verbatim from spec): "**File sharing:** a share is a snapshot; external links need the platform and org switches; shared and rendered HTML is served only with the sandbox CSP and the CDN allowlist, never from a presigned URL on the app origin."

- [ ] **Step 1: Write the e2e** — `test.beforeEach`: `page.route("https://cdn.jsdelivr.net/npm/fake-chart@1.0.0/chart.js", r => r.fulfill({ contentType: "application/javascript", body: "<draws into #chart and sets data-drawn>" }))` so no real CDN is needed. Cases: (1) model-fake delivers `report.html` that loads that URL, tries `fetch("https://example.com/x")` and writes the outcome and `document.cookie` into the page: the panel's `HtmlDocumentFrame` shows `#chart[data-drawn]`, the fetch outcome is "blocked", the cookie text is empty; (2) the super admin allows external sharing, the org admin turns it on, the owner shares externally (7 days), a fresh browser context without cookies opens `/s/<code>` and sees the same drawn chart and the file name; (3) after Revoke the link shows the invalid page. Headless only.
- [ ] **Step 2: Run** `pnpm --filter @capybara-hq/web e2e -- --project=chromium file-sharing` — Expected: PASS. Once, locally and headless, also run the spec in WebKit (`npx playwright test --browser=webkit` style, no config or CI change) and note the result in the PR; a WebKit-only failure is reported, not a blocker.
- [ ] **Step 3: Docs** as listed; `pnpm check:agent-docs` (the spec already has `## AGENTS.md rules touched`), `pnpm check`.
- [ ] **Step 4: Run** `pnpm verify` — Expected: PASS.
- [ ] **Step 5: Commit** `git add apps/web/e2e AGENTS.md docs .agents/skills && git commit -m "test(web): file sharing end to end; docs"`

---

## Self-review notes

- Spec coverage: §1 Task 2 (table) + Task 4 (liveness); §2 Task 4; §3 Tasks 6, 7; §4 Task 5; §5 Tasks 8, 12; §6 Task 11; §7 Tasks 1, 7; §8 Tasks 2, 10; §9 Task 9 (+ org soft delete through `ShareLiveness`' `orgs.deleted_at IS NULL`); §10 Tasks 4–7; Errors Task 2; Tests outline across tasks; AGENTS.md line Task 13; Deliver sentence Task 5.
- Recorded deviations: share embed claims carry a signed `orgId`; list query `?scope=mine|all`; `last_opened_at` column; `deployment.external_sharing_not_allowed` error code; the per-file share list route is an `internal` exclusion; lifecycle revokes owe object deletion immediately (same as explicit revokes).
