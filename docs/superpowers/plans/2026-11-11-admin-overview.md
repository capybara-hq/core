# Admin Console Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. With more than five tasks, plan waves with `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-number `/admin` page with the four approved parts (待处理, 运行状况, 用量,
最近的平台操作), each block loading and failing on its own, shipped in three phases.

**Architecture:** One kernel route per block under `/api/v1/admin/overview/*` plus `/admin/audit`,
each mirrored by a `read` Platform operation; replica liveness from a new per-process Redis
presence heartbeat; usage aggregated in SQL on time indexes and cached in Redis for 5 minutes. The
web page is an `OverviewPage` whose sections are a new design `OverviewSection` each on its own
query; usage is drawn by a new design `TrendChart` (two aligned panels, one x-axis).

**Tech Stack:** TypeScript, NestJS + Kysely (kernel), PostgreSQL, Redis / BullMQ, Next + TanStack
Query (apps/web), `@capybara-hq/design`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-admin-overview-design.md` (section numbers below are
its sections). The maintainer answered the open questions on 2026-11-11 (spec §13, D1–D6, all as
recommended): D1 → Task 3.2 (two stacked panels), D2 → Tasks 1.3 / 1.8 (minimal `/admin/audit` in
phase 1), D3 → Task 1.1 (`org_id IS NULL`), D4 → Tasks 1.4 / 2.3 / 3.3 (read operations), D5 → no
audit on reads, D6 → Task 3.1 (eval runs counted).

**Branches:** one stacked PR per phase: `feat/admin-overview-p1` from `feat/admin-overview`,
`-p2` from p1, `-p3` from p2 (each PR's base is the previous branch). Migration numbers 0109 and
0110 were checked free against `main` (latest 0108) on 2026-11-11.

## Global Constraints

- Every new route: `@SuperAdmin()` controller, schemas in `admin/overview.schemas.ts` (or
  `admin/audit.schemas.ts`), listed in a `*_ROUTES` array registered in `ROUTE_SCHEMAS`
  (`platform/route-schemas.ts`), and an operation in `platform/ops/admin.ops.ts`
  (`authz: { superAdmin: true }`, `confirm: "read"`). `pnpm check:platform-ops` green.
- No conversation content in any answer (spec §9): no job data, no `failedReason`, no audit
  `detail` (only `viaAgent`), no raw provider / extension error text.
- Multi-replica: no in-process shared state; Redis keys `capk:…` with TTL; `@Cacheable` for the
  usage aggregate; the presence loop reports only its own process.
- Migrations: next free numbers (main is at 0108), schema `capybara`, `IF NOT EXISTS`, expand-only.
- Web: `apps/web` writes no styles; reads are `defineQuery` with a freshness class; each section is
  its own `useQuery`; `check:web-ui`, `check:i18n` (zh + en; zh says 平台 / 超级管理员 / 智能体).
- Design: new components go to `packages/design` first with `/dev/ui` entries and spec states;
  reference PNGs only through the `reference-update` workflow, web baselines only through
  `visual-update`.
- Run tests from the repo root: `pnpm exec vitest run <path>`. Commit after each task
  (Conventional Commits, body ≤ 100 chars per line); one changeset per package per phase PR.

## Review Focus

1. Privacy (spec §9): diff every new answer type against the list; tests assert the absent fields.
2. `ReplicaPresence` (Task 2.1) is the only new per-process loop: Redis server clock, TTL on both
   keys, stop on shutdown, no transaction, review alone on the most capable model.
3. Usage SQL (Task 3.1): bounded window, the indexes used (`EXPLAIN` test), `statement_timeout`,
   time-zone day edges.
4. Platform parity for every new or changed route.

## Waves

| Wave | Tasks (disjoint files, parallel) | Review |
|---|---|---|
| Phase 1 · A | 1.1 (migration + audit service), 1.2 (inbox `byType`), 1.5 (design `OverviewSection`) | batched |
| Phase 1 · B | 1.3 (audit route + op), 1.4 (overview + attention routes + ops) | batched, privacy focus |
| Phase 1 · C | 1.6 (web loaders / queries / routes), then 1.7, 1.8, 1.9 (sections, audit page, inbox filter) | batched |
| Phase 1 · D | 1.10 (i18n, visual, changesets, PR) | final |
| Phase 2 | 2.1 (presence, alone) → 2.2 (health service) → 2.3 (route + op) → 2.4 (web) | 2.1 alone |
| Phase 3 | 3.1 (usage SQL + migration) ∥ 3.2 (design `TrendChart`) → 3.3 (route + op) → 3.4 (web) | 3.1 alone |

---

## Phase 1: 待处理, 最近的平台操作, stats

### Task 1.1: Platform audit index and reader

**Files:**
- Create: `packages/kernel/src/migrations/0109_audit_platform_idx.sql`
- Create: `packages/kernel/src/admin/platform-audit.service.ts`
- Modify: `packages/kernel/src/admin/admin.module.ts` (provide it)
- Test: `packages/kernel/test/admin/platform-audit.test.ts`

- [ ] **Step 1: Write the failing test.** Seed `audit_events` with platform rows (`org_id` null),
  org rows, a row whose actor account is deleted, a row with `detail: { via: "agent", ... }`, a
  legacy `app.created` row. Assert `PlatformAuditService.list({ limit: 3 })` returns only platform
  rows, newest `id` first, `next` = last id, `list({ after: next })` continues, no `detail` key on
  any event, `viaAgent: true` on the agent row, `actor: { id, name: null, email: null }` for the
  deleted account, `actor: null` for a kernel row, legacy action mapped through
  `LEGACY_AUDIT_ACTIONS`.
- [ ] **Step 2: Run it, expect failure** (`pnpm exec vitest run packages/kernel/test/admin/platform-audit.test.ts`).
- [ ] **Step 3: Migration.**

```sql
-- 0109: platform-level audit events (org_id null), newest first, for the admin overview and
-- /admin/audit (spec 2026-11-11-admin-overview-design.md §5.4).
CREATE INDEX IF NOT EXISTS audit_events_platform_idx
  ON capybara.audit_events (id DESC) WHERE org_id IS NULL;
```

- [ ] **Step 4: Service.** `list({ after?: string; limit: number }): Promise<{ events: PlatformAuditEvent[]; next: string | null }>`;
  `selectFrom("audit_events as a").leftJoin("accounts as ac", "ac.id", "a.actor_account_id")`,
  `where("a.org_id", "is", null)`, `after` → `where("a.id", "<", after)`, `orderBy("a.id", "desc")`,
  `limit(limit + 1)`; select `a.detail->>'via'` only (never the whole `detail`).
- [ ] **Step 5: Run the test, expect pass; `EXPLAIN` in the test asserts `audit_events_platform_idx`.**
- [ ] **Step 6: Commit** `feat(kernel): read platform-level audit events`.

### Task 1.2: Inbox counts by type

**Files:**
- Modify: `packages/kernel/src/inbox/platform-inbox.service.ts` (`PlatformInboxView.byType`)
- Modify: `packages/kernel/src/platform/ops/inbox.ops.ts` (result passes it through)
- Test: `packages/kernel/test/catalog/platform-inbox.test.ts` (extend), `packages/kernel/test/platform/ops-inbox.test.ts` (extend)

- [ ] **Step 1: Failing test:** a seeded inbox with two requests, one permission confirmation, one
  org upload, one scope sync failure, one notice → `byType` equals
  `{ catalog_request: 2, permission_confirmation: 1, org_upload_pending: 1, scope_sync_failed: 1, platform_migration: 0, ownership_transferred: 1 }`
  and `total` is their sum; with more than 100 items `byType` still counts all (not the page).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** from the counts `list()` already computes (`requestCount`, the pending
  list split by `owner.kind`, `failureCount`, `run`, `noticeCount`).
- [ ] **Step 4: Run, expect pass. Commit** `feat(kernel): platform inbox counts by type`.

### Task 1.3: `GET /admin/audit` and `admin.audit`

**Files:**
- Create: `packages/kernel/src/admin/audit.schemas.ts` (`AuditListQuery = { after?: digits ≤ 20, limit: 1..100 default 20 }`, `AUDIT_ROUTES`)
- Create: `packages/kernel/src/admin/audit.controller.ts` (`@Controller("api/v1/admin/audit") @SuperAdmin()`)
- Modify: `packages/kernel/src/admin/admin.module.ts`, `packages/kernel/src/platform/route-schemas.ts`,
  `packages/kernel/src/platform/ops/admin.ops.ts`
- Test: `packages/kernel/test/admin/audit.http.test.ts`, `packages/kernel/test/platform/ops-admin.test.ts` (extend)

- [ ] **Step 1: Failing tests:** super admin 200 with `{ events, next }`; org owner 403; service
  token 403; `limit=0` / `limit=101` / `after=abc` 400 `validation_failed`; the op `admin.audit`
  returns the same rows and its description says "pass the returned next as params.after".
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** the controller calling `PlatformAuditService.list`, the route schema
  entry, the operation (input `AuditListQuery`, `mirrors: ["GET /api/v1/admin/audit"]`).
- [ ] **Step 4: Run tests + `pnpm check:platform-ops`, expect pass. Commit**
  `feat(kernel): platform audit log route and operation`.

### Task 1.4: Overview stats and `GET /admin/overview/attention`

**Files:**
- Create: `packages/kernel/src/admin/overview.schemas.ts` (`OVERVIEW_ROUTES`)
- Create: `packages/kernel/src/admin/overview.service.ts` (`AdminOverviewService`: `stats()`, `attention()`)
- Create: `packages/kernel/src/admin/overview.controller.ts` (`@Controller("api/v1/admin/overview") @SuperAdmin()`)
- Modify: `packages/kernel/src/admin/admin.controller.ts` (remove `overview()`; the new controller owns `GET /admin/overview`)
- Modify: `packages/kernel/src/admin/admin.schemas.ts` (move the overview route entry), `packages/kernel/src/platform/ops/admin.ops.ts` (`admin.overview` calls the service; new `admin.attention`)
- Test: `packages/kernel/test/admin/admin.http.test.ts` (overview shape), `packages/kernel/test/admin/attention.http.test.ts`

- [ ] **Step 1: Failing tests** (spec §11): overview `{ orgs, accounts, attentionTotal }`; attention
  reasons per extension status (`config`, `load_failed`, `approval`, `dependency`, `conflict`,
  `converging`, `legacy_format`, and `config` for `configValid: false`); a catalog item with
  `newerInMarketplace` listed with `version` / `marketplaceVersion`; providers `list_failed` and
  `no_chat_model` (fake providers from `@capybara-hq/testing`), `org_configured` not listed; caps of
  20 with `more`; a provider registry throwing → `providers: []`, `unavailable: ["providers"]`, the
  other lists intact; no field named `detail` / `error` / `message` in the answer.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** `AdminOverviewService` from `ExtensionAdmin.list()`,
  `CatalogService.list()`, `ProviderRegistry.listWithStatus()` + `ModelEnablement` (as
  `admin.controller.ts` reads them today), `ExtensionDisplayNames` / `PluginIcons`; each source in
  its own `Promise.allSettled` slot. `stats()` = orgs + accounts + `PlatformInboxService.count()` +
  the three attention list lengths.
- [ ] **Step 4: Operations** `admin.overview` (run → `stats()`), `admin.attention` (rows
  `{ id, name, state, reason, next }`, `next` naming the console page).
- [ ] **Step 5: Run tests + `pnpm check:platform-ops` + `pnpm check:kernel-conventions`. Commit**
  `feat(kernel): admin overview attention route`.

### Task 1.5: Design `OverviewSection`

**Files:**
- Create: `packages/design/src/templates/overview-section.tsx`; export from `templates/index.ts` and the package index
- Modify: `packages/design/src/styles/*.css` (section error line, reusing `cb-load-failed` styles), `docs/design/spec.md` §5.6 (paragraph + `<!-- states: overview-section -->` `default`, `loading`, `error`)
- Modify: `packages/design/src/fixtures/*` (fixture), `apps/web/src/dev/catalog/*` (`/dev/ui` entry), `docs/design/reference/src/*` (reference source; PNGs by workflow)
- Test: `packages/design/test/overview-section.test.tsx`

- [ ] **Step 1: Failing test:** `state="loading"` renders the skeleton of the given `BlockShape[]`
  with `aria-busy`; `state="error"` renders the summary, 重试 calls `onRetry`, 原始错误 toggles the
  detail; `ready` renders children inside a Card (box scope provided: `findNestedBoxes` finds no
  nested box with an `ItemList` child, finds one with a nested `Card`).
- [ ] **Step 2: Run, expect failure. Step 3: implement. Step 4: run, pass;
  `pnpm --filter @capybara-hq/design typecheck`. Commit** `feat(design): OverviewSection`.

### Task 1.6: Web loaders, queries, route table

**Files:**
- Modify: `apps/web/src/lib/admin.ts` (`AdminOverview` new shape, `getAdminAttention`, `listPlatformAudit`), `apps/web/src/lib/admin-inbox.ts` (`byType`, `platformInboxTypeHref`)
- Modify: `apps/web/src/lib/query/keys.ts`, `apps/web/src/lib/query/admin.ts` (`adminAttentionQuery`, `platformAuditQuery`)
- Modify: `apps/web/src/lib/query/routes.ts` (`/admin`: overview, inbox, audit; new `/admin/audit`)
- Test: `apps/web/test/admin-ssr.test.tsx` (extend)

- [ ] **Step 1: Failing test:** `renderRouteWithCache("/admin")` → the stats, inbox rows and audit
  rows paint with `expectNoFirstPaintFetch()` for them; attention is read after mount.
- [ ] **Step 2–4:** implement, run, pass. **Commit** `feat(web): admin overview queries`.

### Task 1.7: Page and sections 待处理 / 最近的平台操作

**Files:**
- Modify: `apps/web/src/app/(app)/admin/view.tsx`, `apps/web/src/app/(app)/admin/page.tsx` (doc comment)
- Create: `apps/web/src/app/(app)/admin/overview/AttentionSection.tsx`, `.../AuditSection.tsx`, `.../audit-actions.ts` (action → i18n key)
- Test: `apps/web/test/admin.test.tsx` (extend)

- [ ] **Step 1: Failing tests:** stats 待处理 / 组织 / 账号 with links; each inbox type row with its
  count and link; extension rows with reason words and `/admin/extensions/<name>`; update rows with
  `v1.2.0 → v1.3.0`; provider rows; all empty → 没有需要处理的事项; attention 500 → that section's
  error and 重试 while stats and audit render; audit rows (系统 for a null actor, 经由智能体 meta,
  unknown action in mono) and 查看全部; the footnote; non-super-admin → `NoAccess`, no `/admin/*` read.
- [ ] **Step 2–4:** implement with `OverviewSection`, `ItemList`, unframed `DataTable`, `DateTime`,
  `versionLabel`; run; `pnpm check:web-ui`. **Commit** `feat(web): admin overview attention and audit`.

### Task 1.8: `/admin/audit` page and sidebar entry

**Files:**
- Create: `apps/web/src/app/(app)/admin/audit/page.tsx`, `apps/web/src/app/(app)/admin/audit/view.tsx`
- Modify: the admin sidebar nav (`apps/web/src/components/shell/*` admin context items)
- Test: `apps/web/test/admin-audit.test.tsx`

- [ ] **Step 1: Failing test:** ListPage with the table, 加载更多 reads `after=<next>` and appends,
  empty state, `NoAccess` for others, sidebar shows 审计日志 for super admins.
- [ ] **Step 2–4:** implement, run, pass. **Commit** `feat(web): platform audit log page`.

### Task 1.9: Inbox `?type=` filter

**Files:**
- Modify: `apps/web/src/app/(app)/admin/inbox/page.tsx`, `.../inbox/view.tsx`, route entry key unchanged (filter is client-side on the cached list)
- Test: `apps/web/test/admin.test.tsx` (extend; the inbox page's tests live there)

- [ ] **Step 1: Failing test:** `/admin/inbox?type=scope_sync_failed` lists only those items, with a
  clear-filter link; an unknown type is ignored.
- [ ] **Step 2–4:** implement, run, pass. **Commit** `feat(web): filter the platform inbox by type`.

### Task 1.10: Copy, visuals, changesets, PR

**Files:**
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json` (`admin.overview.*`, `admin.audit.*`)
- Create: `apps/web/visual/admin-overview.spec.ts` (desktop + 390 px)
- Create: `.changeset/*.md` (kernel, design, web)

- [ ] **Step 1:** `pnpm check:i18n`, `pnpm check`, `pnpm lint`, `pnpm typecheck`, `pnpm verify`.
- [ ] **Step 2:** open the phase 1 PR; trigger `reference-update` (OverviewSection) and
  `visual-update` (admin overview); maintainer signs off the PNGs.

---

## Phase 2: 运行状况

### Task 2.1: `ReplicaPresence` (review alone)

**Files:**
- Create: `packages/kernel/src/infra/presence/replica-presence.ts`, `.../presence.module.ts`
- Modify: `packages/kernel/src/kernel.module.ts` (import for every role), `packages/kernel/src/channels/supervisor.ts` (expose `heldCount()`), `packages/kernel/src/local-devices/local-device-gateway.ts` (expose `connectionCount()`)
- Test: `packages/kernel/test/infra/replica-presence.test.ts`

- [ ] **Step 1: Failing test** with `createDualReplicaHarness`: replica A `roles: ["api"]`, B
  `["worker","gateway"]` → `ReplicaPresence.live()` lists both with roles, `KERNEL_VERSION`,
  `startedAt`; both keys have a TTL (`PTTL > 0`); closing A removes it at once; a replica whose loop
  is stopped without cleanup (test seam) is gone after 3 intervals (seam `PRESENCE_INTERVAL_MS`
  set to 200 ms); `channelsHeld` / `devicesConnected` sum across replicas.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** (spec §5.1): one Lua script (`redis.call("TIME")` for the score,
  `ZADD`, `HSET`, `PEXPIRE` ×2, `ZREMRANGEBYSCORE`); a `setTimeout` chain started in
  `onApplicationBootstrap` after the start gate, `unref`; `beforeApplicationShutdown` stops the
  loop and `ZREM` + `DEL`s; errors logged at warn, never thrown.
- [ ] **Step 4: Run tests, `pnpm check:kernel-conventions`. Commit**
  `feat(kernel): replica presence heartbeat`.

### Task 2.2: Health service

**Files:**
- Create: `packages/kernel/src/admin/health.service.ts` (`AdminHealthService.read()`)
- Modify: `packages/kernel/src/admin/admin.module.ts` (inject the eight kernel queues by name via `getQueueToken`, or one read-only `Queue` per name on the BullMQ connection)
- Test: `packages/kernel/test/admin/health.test.ts`

- [ ] **Step 1: Failing test:** seeded BullMQ jobs (waiting, delayed, a failed one now and one
  25 h ago by `finishedOn`) → counts and `failedLastDay: 1`; channel rows of each status and mode
  with presence `channelsHeld` → `online` / `offline` / `webhook` / `disabled` / `error`; local
  devices with `devicesConnected`; `environment_instances` running / suspended by provider; Redis
  down → `unavailable: ["redis"]`, PG numbers present; the answer has no job data.
- [ ] **Step 2–4:** implement, run, pass. **Commit** `feat(kernel): admin health read`.

### Task 2.3: `GET /admin/overview/health` and `admin.health`

**Files:**
- Modify: `packages/kernel/src/admin/overview.controller.ts`, `overview.schemas.ts`, `platform/ops/admin.ops.ts`
- Test: `packages/kernel/test/admin/health.http.test.ts`, `packages/kernel/test/platform/ops-admin.test.ts`

- [ ] **Step 1–4:** failing tests (200 shape, 403 for others and service tokens, op parity),
  implement, run with `pnpm check:platform-ops`. **Commit** `feat(kernel): admin health route`.

### Task 2.4: Web 运行状况

**Files:**
- Modify: `apps/web/src/lib/admin.ts`, `lib/query/admin.ts`, `keys.ts` (`adminHealthQuery`, `live`)
- Create: `apps/web/src/app/(app)/admin/overview/HealthSection.tsx`
- Modify: `apps/web/src/app/(app)/admin/view.tsx`, `apps/web/messages/*.json`, `apps/web/visual/admin-overview.spec.ts`
- Test: `apps/web/test/admin.test.tsx` (extend)

- [ ] **Step 1: Failing tests:** roles line, a zero-worker `fail` line, mixed versions warn, queue
  table with readable names and `fail` failure counts, connection numbers, `unavailable` rows read
  暂时无法读取, polling every 30 s (`refetchInterval`, fake timers), error / retry in place.
- [ ] **Step 2–4:** implement, run, `pnpm check:web-ui`, `check:i18n`. **Commit**
  `feat(web): admin overview health`. Open the phase 2 PR (changesets; `visual-update`).

---

## Phase 3: 用量

### Task 3.1: Usage aggregate and indexes (review alone)

**Files:**
- Create: `packages/kernel/src/migrations/0110_usage_time_idx.sql`
- Create: `packages/kernel/src/admin/usage.service.ts` (`AdminUsageService.week(tz)`, `@Cacheable({ key: "admin-usage:#{0}:#{1}", ttl: 300 })` on an inner method taking `(tz, firstDay)`)
- Modify: `packages/kernel/src/errors.ts` (`admin.usage_unavailable` → 503)
- Test: `packages/kernel/test/admin/usage.test.ts`

- [ ] **Step 1: Failing test** (spec §11): two orgs, runs and usage events and `model_usage` rows
  across 8 days; `tz = "Asia/Shanghai"` vs `"UTC"` day edges; cost with prices, without one
  (`costPartial`), currency from settings; top 10 + `otherOrgs`; a second call hits the cache (spy on
  the inner query); `EXPLAIN` uses the three indexes; a forced `statement_timeout` → `ApiError`
  `admin.usage_unavailable`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Migration** `runs_created_idx ON capybara.runs (created_at)` and
  `model_usage_time_idx ON capybara.model_usage (occurred_at)`.
- [ ] **Step 4: Implement** the three grouped queries (spec §5.4) in one read transaction with
  `SET LOCAL statement_timeout = '10s'`, price groups with `costOf` + `PricesService.list()`.
- [ ] **Step 5: Run, pass. Commit** `feat(kernel): seven-day usage aggregate`.

### Task 3.2: Design `TrendChart`

**Files:**
- Create: `packages/design/src/display/trend-chart.tsx`, `packages/design/src/display/format.ts` (`formatCompact`)
- Modify: `packages/design/src/display/index.ts`, `packages/design/src/styles/display.css`, `docs/design/spec.md` §6.8 (paragraph + `<!-- states: trend-chart -->`), fixtures, `/dev/ui` catalog, `docs/design/reference/src/*`
- Test: `packages/design/test/trend-chart.test.tsx`, `packages/design/test/format.test.ts`

- [ ] **Step 1: Failing tests** (spec §10.1, §11): points per panel, `current` in accent
  (`data-kind`), gaps for `null`, all-zero empty line, hidden table with every value, keyboard
  ←/→/Home/End/Esc and the live region, `role="img"` summaries, `formatCompact` zh / en.
- [ ] **Step 2–4:** implement with tokens only (no literals; `pnpm check:tokens`), run, pass.
  **Commit** `feat(design): TrendChart`. Trigger `reference-update`; maintainer sign-off before 3.4
  merges.

### Task 3.3: `GET /admin/overview/usage` and `admin.usage`

**Files:**
- Modify: `overview.controller.ts`, `overview.schemas.ts` (`UsageQuery = { tz: IanaTimeZone }`), `platform/ops/admin.ops.ts`
- Test: `packages/kernel/test/admin/usage.http.test.ts` (dual replica: the cached answer served by the other replica), `ops-admin.test.ts`

- [ ] **Step 1–4:** failing tests (shape, bad `tz` 400, 403s, 503 on timeout, op parity), implement,
  run with `pnpm check:platform-ops`. **Commit** `feat(kernel): admin usage route`.

### Task 3.4: Web 用量

**Files:**
- Modify: `apps/web/src/lib/admin.ts`, `lib/query/admin.ts`, `keys.ts` (`adminUsageQuery(tz)`, `deployment`)
- Create: `apps/web/src/app/(app)/admin/overview/UsageSection.tsx`
- Modify: `apps/web/src/app/(app)/admin/view.tsx` (4th stat 近 7 天运行 from the usage query), `apps/web/messages/*.json`, `apps/web/visual/admin-overview.spec.ts`
- Test: `apps/web/test/admin.test.tsx` (extend)

- [ ] **Step 1: Failing tests:** the chart's panels from the answer, the 7-day total line, 估算 on
  every cost, the partial-cost note linking `/admin/models`, the ranking table with 其他, empty week,
  503 → that section's error, the query key holds the viewer's zone.
- [ ] **Step 2–4:** implement, run, `pnpm check:web-ui`, `check:i18n`, `pnpm verify`. **Commit**
  `feat(web): admin overview usage`. Open the phase 3 PR (changesets; `visual-update`).
