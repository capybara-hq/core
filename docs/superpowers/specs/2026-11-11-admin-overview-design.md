# Admin console overview: what waits, how the platform runs, what it uses, what changed

- Date: 2026-11-11, written against `main` at `78a2249dd` (latest kernel migration 0108).
- Status: approved 2026-11-11 (every open question answered "as recommended", §13). Plan:
  `docs/superpowers/plans/2026-11-11-admin-overview.md`.
- Related: the platform inbox (plugin component management spec
  `2026-11-05-plugin-component-management-design.md` §5.1 rule 5, §13.5), the `Platform` tool
  (`2026-11-07-platform-tool-design.md`, `check:platform-ops`), the web query cache
  (`writing-web-ui` skill), design spec `docs/design/spec.md` §5.6 (Overview), §6.8 (Charts),
  §6.14 (StatCards), environments (`2026-11-07-environments-design.md`), model prices (C2).
- Markers: **(decided, 2026-11-11)** is the maintainer's approved direction; **(designer's call)**
  is decided here and may be overturned in review; **(D1)**–**(D6)** are the decisions in §13.
  Items without a marker restate current code (each verified by reading it; file paths given).

## 1. Why

`/admin` (`apps/web/src/app/(app)/admin/view.tsx`) is four StatCards (extensions needing action,
pending catalog requests, orgs, accounts) and the callout 「超级管理员不能查看会话内容。」. A super
admin who opens the console learns nothing about *what* needs them, whether the platform is
healthy, how much it is used, or what other super admins changed.

The maintainer approved a richer page with four parts, top to bottom **(decided, 2026-11-11)**:

1. **待处理**: inbox items by type, extensions needing attention by name and reason, plugins with
   a newer marketplace version, model providers with problems; each links to where it is handled.
2. **运行状况**: kernel version, live replicas by role, BullMQ backlog and recent failures, channel
   connections online / offline, devices online, running sandbox instances.
3. **用量** (last 7 days): runs and model tokens per day as a line chart (cost labelled 估算), and
   orgs ranked by usage. Aggregates only.
4. **最近的平台操作**: the last 10 platform-level audit events, with a link to the full log.

组织 and 账号 stay as small stats in the first row; the other two numbers fold into part 1. The
"super admins cannot read conversations" notice becomes a footnote line.

## 2. Non-goals

- No conversation content, prompts, tool output, file names or per-account usage anywhere on the
  page or in its routes. The rule "super admins cannot read conversations" is unchanged.
- No alerting, paging or e-mail. The page shows state; it notifies nobody.
- No metrics store (Prometheus etc.); everything is read from PG / Redis at request time, bounded.
- No per-org admin overview (the workspace has no home page; spec §5).
- No new actions on the overview: every item links to the page that already acts on it.

## 3. Page layout

`OverviewPage` (spec §5.6), top to bottom:

| Row | Content | Phase |
|---|---|---|
| Header | path `admin`, title 概览, description; `metrics` = StatCards: **待处理** (total, links `/admin/inbox`), **组织**, **账号**; phase 3 adds **近 7 天运行** (4 cards; StatCards allows ≤ 5) | 1 (+3) |
| Section 待处理 | four groups inside one Card (§6.1) | 1 |
| Section 运行状况 | one Card, key-value and small tables (§6.2) | 2 |
| Section 用量 | one Card: the trend chart and the org ranking (§6.3) | 3 |
| Section 最近的平台操作 | one Card: 10 rows + 查看全部 → `/admin/audit` (§6.4) | 1 |
| Footnote | `Text variant="prose" tone="muted"` 「超级管理员不能查看会话内容；以上用量只含汇总数字。」 | 1 |

Each section is a Card (one box, groups inside it are `Subsection` / `ItemList` / unframed
`DataTable`; never a box in a box, `web-ui-box-in-box`). Each section reads its own query and owns
its loading, empty and error state (§8.3), so one failing source never blanks the page.

Why one Card per part, not one per group: four parts is the approved structure; nested groups
inside a part are headings and hairlines, which is what "one box is enough" asks for
**(designer's call)**.

## 4. Data sources (verified)

### 4.1 Part 1: 待处理

| Item | Source today | Notes |
|---|---|---|
| Inbox items by type | `PlatformInboxService.list()` (`packages/kernel/src/inbox/platform-inbox.service.ts`), route `GET /api/v1/admin/inbox` | Types: `catalog_request`, `permission_confirmation`, `org_upload_pending`, `scope_sync_failed`, `platform_migration`, `ownership_transferred`. Already read live from PG; `total` counts everything. The web link per type is `platformInboxHref` (`apps/web/src/lib/admin-inbox.ts`). |
| Extensions needing attention | `ExtensionAdmin.list()` (`extensions/admin-view.ts`) → `AdminExtensionView[]` with `status: DeploymentExtensionStatus`, `configValid`, `displayName`, `icon`, `replicas[]` | `extensionNeedsAction(status)` (`extensions/permission-view.ts`) is what today's count uses: every status but `enabled` / `disabled`. |
| Plugins with a newer marketplace version | `CatalogService.list()` (`catalog/catalog.service.ts`) → `CatalogItemView` with `latestVersion`, `latestMarketplaceVersion`, `newerInMarketplace`, `marketplaceId` | Computed from marketplace entries already stored in PG; never auto-imported. |
| Model providers with problems | `ProviderRegistry.listWithStatus()` (`runtime/providers.ts`), as `GET /api/v1/admin/models` | `status: "error"` (list failed or timed out; the failure is remembered 15 s in Redis, the lists themselves 600 s); `org_configured` is not a problem. "No usable model": `status: "ok"` and no model with `kind === "chat"` that is not platform-disabled. |
| Pending catalog requests (today's 2nd number) | `CatalogRequestsService.countPendingDeployment()` | Already part of the inbox (`catalog_request`); folds into it. |

### 4.2 Part 2: 运行状况

| Item | Source today | Gap |
|---|---|---|
| Kernel version | `KERNEL_VERSION` (`packages/kernel/src/version.ts`) | none; per replica see below |
| Replicas by role | **Nothing tracks roles.** `extension_replica_status` (migration 0030, renamed 0041) has one row per (replica, extension) with `heartbeat_at`, refreshed on each extension reconcile (`ExtensionLifecycle.run`, `reconcileIntervalSeconds` 60 s, stale after 3 periods), but no role and no version, and its periodic trigger is a `@LockedInterval` that only runs while a worker is alive. The gateway writes `capk:gateway-replicas:<plugin>` ZSETs (`channels/supervisor.ts`), gateways only. | new: replica presence (§5.1) |
| Queue backlog and failures | The kernel queues are fixed names (`cap-kernel-runs`, `cap-kernel-subagent-runs`, `cap-kernel-channels`, `cap-kernel-maintenance`, `cap-kernel-plugin-scope`, `cap-kernel-titles`, `cap-kernel-usage-report`, `cap-kernel-evals`); no route reads them. Jobs keep `removeOnFail: 5000` (`infra/queue/queue.module.ts`). | new read (§5.2) |
| Channel connections | PG `channel_connections.status` (`active` / `disabled` / `error`) and `inbound_mode`; a long connection is held while the lease `capk:channel-lease:<id>` exists (`channels/supervisor.ts`) | online count (§5.1, §5.2) |
| Devices online | A local device is online while a replica holds `capk:device-lease:<deviceId>` (`DevicesService`, `local-devices/keys.ts`); `LocalDeviceGateway` keeps its connections in a per-process `Set` | online count (§5.1) |
| Running sandbox instances | PG `device_instances.status` (`running` / `suspended`), partial indexes `device_instances_running_idx` / `device_instances_live_idx` (migration 0088, table and indexes renamed in 0105) | none |

### 4.3 Part 3: 用量

| Item | Source today | Notes |
|---|---|---|
| Runs per day | `runs.created_at` (table `capybara.runs`), org via `conversations.org_id` | **No index on `runs.created_at`** (only `(conversation_id, created_at DESC)`): new index (§5.4). |
| Model tokens per day (chat) | `conversation_events` rows with `type = 'usage'`: payload `provider`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` (`conversations/events.ts`; `usageSums` in `conversations.service.ts` already sums them) | Partial index `conversation_events_usage_idx ON (created_at) WHERE type = 'usage'` exists (0040). |
| Model tokens per day (embeddings) | `model_usage` (0089): `org_id`, `provider`, `model`, `input_tokens`, `occurred_at` | Only `(org_id, occurred_at DESC)`: a global 7-day read needs `(occurred_at)` (§5.4). |
| Cost (估算) | `PricesService.list()` + `costOf(usage, price)` (`models/prices.ts`), currency = deployment setting `priceCurrency` | A model without a price has no cost; the page says so (partial). |

`model_usage` is not where chat usage lives (the task text named it): chat usage is in the event
log, embeddings in `model_usage`. Both are summed.

### 4.4 Part 4: 最近的平台操作

`capybara.audit_events` (migration 0003): `id bigserial`, `at`, `actor_account_id`, `actor_token_id`,
`org_id`, `action`, `target`, `detail jsonb`; written by `audit()` (`identity/audit.ts`) from ~70
call sites. **No route reads it**, and there is no audit page in apps/web. Index: only
`(org_id, at DESC)`.

"Platform-level" = `org_id IS NULL` **(D3)**: deployment settings, accounts,
marketplaces, catalog imports and scope, extensions and their deployment config, model prices and
purposes, bootstrap, setup. Org events (members, agents, tool calls, trajectory views) carry an
`org_id` and stay out.

## 5. Kernel

### 5.1 Replica presence (new, phase 2)

What exists cannot answer "which replicas are alive, in which role, on which version" (§4.2). The
minimal multi-replica-safe mechanism follows the gateway heartbeat already in production
(`channels/supervisor.ts`):

- `ReplicaPresence` (`packages/kernel/src/infra/presence/replica-presence.ts`), one `@Injectable`,
  provided by the global `PresenceModule` the kernel module imports, so **every process** runs it
  whatever its roles (it is not a shared periodic job, so it is not `@LockedInterval` and not under
  `WorkerModule`).
- Every 15 s (the `PRESENCE_INTERVAL_MS` test seam; a `setTimeout` chain with `unref`) it runs one
  Lua script on Redis. `KernelLifecycle` starts it as the last step of the start (after the start
  gate opened, the first beat at once) and stops it as the first stop phase (1 s budget), so the
  entry leaves before the long stop phases. The beat:
  `ZADD capk:replicas <redis TIME ms> <replicaId>`, `HSET capk:replica:<replicaId>` with `roles`,
  `version` (`KERNEL_VERSION`), `startedAt`, `httpReplicaId`, `channelsHeld`, `devicesConnected`,
  then `PEXPIRE` both keys to 3 × the interval and `ZREMRANGEBYSCORE` members older than that.
  Scores use the Redis server clock (replica clocks may drift), as the gateway ZSET does.
- `replicaId` is the process's existing id (`ReplicaStatusStore.replicaId`, the one the gateway
  heartbeat and extension status rows use), so the three views name a replica the same way.
- `startedAt` = when the process finished its start (the presence start).
- `channelsHeld` = the supervisor's held connections; `devicesConnected` = the
  `LocalDeviceGateway` connections that hold their device's lease (through `GatewayRole`; 0
  without the gateway role; the health answer clamps the sum to the local devices). Both are per-process facts the process reports about
  itself; summing them over live replicas gives the online counts without scanning lease keys.
- A graceful stop `ZREM`s and `DEL`s its own entry; a crash ages out in ≤ 45 s.
- Read: `ZRANGEBYSCORE capk:replicas (now − 45 s) +inf` then one pipelined `HGETALL` per live member.

Multi-replica review points: state lives only in Redis with TTLs (AGENTS.md); no process reads
another's memory; no lock and no transaction; the loop holds no cross-request state, it reports
the process's own. The `kc-lock` check flags `setInterval` in files importing ioredis outside
`infra/`; this lives in `infra/` and uses `setTimeout`, like the supervisor loop.

Why not PG: a write every 15 s per replica into a table is churn PG does not need, and the
extension status rows already show that piggybacking on reconcile ties liveness to a worker being
up **(designer's call)**.

### 5.2 Routes

All under `/api/v1/admin/*` on controllers with `@SuperAdmin()` (service tokens always 403). All
reads, no writes, no audit (reads of aggregates are not audited; D5). Schemas in
`admin/overview.schemas.ts`, listed in `OVERVIEW_ROUTES`, registered in `ROUTE_SCHEMAS`.

| Route | Phase | Answer | Cost and freshness |
|---|---|---|---|
| `GET /admin/overview` (changed) | 1 | `{ orgs, accounts, attentionTotal, partial }` | Counts only. `attentionTotal` = inbox total + extensions needing attention + newer plugins + provider problems (the 待处理 stat); an extension pending approval whose plugin already waits in the inbox (permission confirmation or org upload) is counted and listed once, as the inbox item. `partial` is true when an attention source was unavailable (its items are then not in `attentionTotal`). Drops `extensionsNeedingAction` / `catalogRequestsPending` (pre-0.1.0, no compat). |
| `GET /admin/inbox` (changed) | 1 | adds `byType: Record<PlatformInboxItem["type"], number>` | The service already counts each source; `permission_confirmation` vs `org_upload_pending` split from the pending list it already loads. |
| `GET /admin/overview/attention` (new) | 1 | `{ extensions: [{ name, displayName, icon, status, reason }], updates: [{ itemId, name, displayName, icon, version, marketplaceVersion, marketplaceId, marketplaceName }], providers: [{ plugin, displayName, icon, problem }] }` | `ExtensionAdmin.list()` + `CatalogService.list()` filtered on `newerInMarketplace` + `listWithStatus()` (Redis-cached lists, so no provider is called more than once per 600 s; a failure 15 s). Not cached further: everything is already PG or Redis-cached. Lists capped at 20 each with `more: n`. |
| `GET /admin/overview/health` (new) | 2 | `{ kernel: { version }, replicas: [{ id, roles, version, startedAt, httpReplicaId }], roles: { api, worker, gateway }, queues: [{ name, waiting, active, delayed, failed, failedLastDay }], channels: { online, offline, webhook, disabled, error }, devices: { online, local }, sandboxes: { running, suspended, byProvider: [{ provider, running }] } }` | Redis: one ZRANGE + n HGETALL; 8 × `getJobCounts` + 8 × `ZCOUNT bull:<q>:failed` over the last 24 h (the failed set's score is `finishedOn`; verified by a test, §11). PG: one grouped count on `channel_connections`, one on local `devices`, one on `device_instances` (partial indexes). Not cached (cheap, and stale health misleads). `waiting` = BullMQ `wait` + `prioritized`. Channels (connections not deleted, org not deleted): `online` = the live replicas' `channelsHeld`; `offline` = active long-connection connections minus `online` (≥ 0: waiting for a gateway, backing off, or the plugin is off in the org); `webhook` = active webhook-mode ones; `disabled` / `error` = that status, any mode. The queue counts read the queue instances their owners register (re-exported), no connection of their own. |
| `GET /admin/overview/usage?tz=<IANA>` (new) | 3 | `{ from, to, tz, currency, days: [{ date, runs, tokens: { input, output, cacheRead, cacheWrite, embedding }, cost }], costPartial, orgs: [{ orgId, name, runs, tokens, cost }] }` (orgs: top 10 by tokens, plus `otherOrgs` totals) | Bounded window: today and the 6 days before, in `tz`. Three grouped queries (§5.4) on time indexes; `@Cacheable` 300 s keyed by `tz` + the window's first day, so every replica serves the same cached answer and at most one recompute per 5 min per zone. Run with `SET LOCAL statement_timeout = '10s'`; a timeout is `admin.usage_unavailable` (503) and the block shows its error. |
| `GET /admin/audit?after=<id>&limit=<1..100>` (new) | 1 | `{ events: [{ id, at, actor: { id, name, email } \| null, viaToken, viaAgent, action, target }], next }` | Keyset on `id` descending, `org_id IS NULL`; new partial index (§5.4). `detail` is not returned except `detail.via === "agent"` → `viaAgent` (§9). Actor joined from `accounts` (a deleted account reads as its id). |

`tz` is `IanaTimeZone` (`time-zone.ts`); the web passes `useTimeZone()`. Days are calendar days in
that zone so the chart's x-axis matches the reader's dates **(designer's call)**.

Extension `reason` (from `status`, plus `configValid`): `pending_config` / `!configValid` →
`config` (缺少部署配置 / 配置无效), `failed` → `load_failed`, `pending_approval` → `approval`,
`dependency`, `conflict`, `converging` / `pending_migration` → `converging`, `legacy_format`. The raw
replica `detail` (already redacted when written) is not sent; it stays on the extension page.

Provider `problem`: `list_failed` (status `error`; the kernel's own English message is never shown
raw, mapped to a zh/en sentence) or `no_chat_model`.

What runs count: every run (sub-agent and eval runs included); tokens: every `usage` event
(compaction, titles, web fetch) plus embeddings. That is what the deployment pays for **(D6)**.

### 5.3 Platform tool operations (parity rule)

| Route | Operation / exclusion |
|---|---|
| `GET /admin/overview` | existing `admin.overview` (its `run` follows the new answer) |
| `GET /admin/inbox` | existing `inbox.list` (result gains `byType`) |
| `GET /admin/overview/attention` | new `admin.attention`, `authz: { superAdmin: true }`, `confirm: "read"`, input `{}`; rows `{ id, name, state, reason, next }` per the results rule (next: the console page) |
| `GET /admin/overview/health` | new `admin.health`, read; a super admin's agent can answer "is the worker up, is the run queue backing up" |
| `GET /admin/overview/usage` | new `admin.usage`, read, input `{ tz }` from the route schema (`omits: []`) |
| `GET /admin/audit` | new `admin.audit`, read, input `{ after?, limit? }` from the route's schema; keyset: "pass the returned next as params.after" |

All four are aggregates or platform records a super admin's own private agent may read (the
operations run only for super admins, through their own agent; Platform tool spec §6.1). None
touches a secret or another org's item beyond its name, which the admin console already shows. No
exclusion is needed **(D4)**.

### 5.4 Migrations (expand-only, next free numbers)

- Phase 1: `0109_audit_platform_idx.sql`:
  `CREATE INDEX IF NOT EXISTS audit_events_platform_idx ON capybara.audit_events (id DESC) WHERE org_id IS NULL;`
- Phase 3: `0110_usage_time_idx.sql`:
  `CREATE INDEX IF NOT EXISTS runs_created_idx ON capybara.runs (created_at);` and
  `CREATE INDEX IF NOT EXISTS model_usage_time_idx ON capybara.model_usage (occurred_at);`

Both run as plain `CREATE INDEX` (the migrator runs in a transaction, so not `CONCURRENTLY`). On a
large `runs` table this locks writes for the build; pre-0.1.0 there are no large deployments, and
the release note says so. Numbers move to the next free ones at implementation.

Usage queries (phase 3), each grouped in SQL, priced in TS:

```sql
-- chat tokens: day × org × provider × model
SELECT (date_trunc('day', e.created_at AT TIME ZONE $tz))::date AS day, c.org_id,
       e.payload->>'provider' AS provider, e.payload->>'model' AS model,
       sum((e.payload->>'inputTokens')::bigint) ..., sum(... cacheWriteTokens)
FROM capybara.conversation_events e JOIN capybara.conversations c ON c.id = e.conversation_id
WHERE e.type = 'usage' AND e.created_at >= $from AND e.created_at < $to
GROUP BY 1, 2, 3, 4;
-- runs: day × org (runs_created_idx); embeddings: day × org × provider × model (model_usage_time_idx)
```

The row count is bounded by days × orgs × models, not by events. Cost per group = `costOf` with the
group's price; a group without a price adds tokens but no cost and sets `costPartial`.
A `cost` (a day, an org, `otherOrgs`) is the sum of its priced groups, `null` when it used tokens
and none of them had a price (so "not priced" never reads as "free"), and `0` when it used no
tokens. Org `tokens` is the total of every kind, embeddings included. The window's bounds are the
zone's midnights computed by PG (`'<day>'::date::timestamp AT TIME ZONE <tz>`, DST-safe); "today"
comes from the kernel clock (`ADMIN_USAGE_TIMINGS` test seam, with the statement timeout). The
queries run in their own read-only transaction (`requires_new`) so the `SET LOCAL` never reaches a
caller's. The cached answer carries the prices and currency of when it was computed: a price
change shows within 300 s. Eval runs here are the full-run replay runs (they live in `runs`, in
`kind = 'eval'` conversations); step replays and the judge write no `usage` event and are not
counted.
A malformed token value in a `usage` payload (a string, null) counts 0 and a fraction is rounded,
so one bad event cannot fail the week. `tz` is normalized (`Intl` canonical name) before it is
echoed and keyed; a zone PG's tzdata does not know (SQLSTATE 22023) is `validation_failed` (400).
`week()` leaves any caller transaction (`runOutsideTransaction`), so the cache always applies. Each
statement is bounded, not the whole transaction: `transaction_timeout` needs PostgreSQL 17 and the
kernel supports 15.

If 7-day scans of `conversation_events` become slow at scale, the follow-up is a daily rollup
table written by a `@LockedCron` job; not built now (YAGNI, measured first) **(designer's call)**.

### 5.5 Errors

New codes in `ERROR_CODES`: `admin.usage_unavailable` (503, the aggregate timed out). The health
route degrades per source instead of failing: a Redis failure (a connection not ready, or no
answer within 3 s) gives
`replicas`, `roles`, `queues`, `channels.online` / `.offline` and `devices.online` null with
`unavailable: ["redis"]`, so PG-backed numbers still show; a PG failure symmetrically nulls the
channel, device and sandbox numbers with `unavailable: ["database"]` (also bounded by 3 s). Attention degrades per list the same way (`unavailable: ["providers"]`).

## 6. The four parts in the page

### 6.1 待处理 (phase 1)

One Card titled 待处理 with up to four `Subsection`s, each only when it has rows:

- **收件箱**: one `ItemList` row per inbox type with a count (平台目录申请 3, 权限确认 1, 范围同步失败 2,
  迁移需要查看 1, 所有权转移 1, 组织上传待确认 1); each row links to its page (the per-type target of
  `platformInboxHref`; for `scope_sync_failed` with several items, `/admin/inbox` filtered by type,
  §7.2). Meta: 查看收件箱 → `/admin/inbox`.
- **扩展**: one row per extension: plugin icon (`mark.image`), display name, the reason as a
  `StatusMark` + words (缺少部署配置 / 配置无效 / 加载失败 / 待批准权限 / 依赖缺失 / 冲突 / 正在收敛 /
  需要重新打包); links `/admin/extensions/<name>`.
- **插件更新**: one row per plugin: icon, name, `v1.2.0 → v1.3.0` (`versionLabel`), the marketplace
  name; links `/admin/plugins/<itemId>` (where 导入新版本 lives). Never auto-imported.
- **模型供应商**: one row per provider: icon, name, 列模型失败 / 没有可用的对话模型; links
  `/admin/models`.

When everything is empty: the `panel` `EmptyState` 「没有需要处理的事项。」 inside the Card. "+n 项"
row when a list is capped.

### 6.2 运行状况 (phase 2)

One Card titled 运行状况, three groups:

- **内核**: `KeyValue`: 版本 `v0.1.0`; 副本 `api 2 · worker 1 · gateway 1` (a role with zero live
  replicas is `fail` with 「没有在线的 worker：运行不会开始」, gateway 「渠道长连接不会建立」); when live replicas
  report different versions, a warn line 「副本版本不一致（滚动升级中？）」. A folded `DataTable`
  (副本, 角色, 版本, 启动于) lists the replicas.
- **队列**: an unframed `DataTable`: 队列 (a readable name: 运行, 子智能体运行, 渠道, 维护, 插件范围同步,
  标题, 用量上报, 评测), 等待, 进行中, 延迟, 24 小时内失败. A row with `failedLastDay > 0` shows the count in
  `fail`. No job data and no failure messages (§9).
- **连接**: `KeyValue`: 渠道 `在线 5 · 离线 1 · Webhook 2 · 已停用 1 · 出错 0` (plain numbers: the admin
  console has no channel page), 设备 `在线 3 / 本地 7`, 沙箱 `运行中 4 · 已挂起 2` with
  per-provider counts.

The block polls every 30 s while the page is visible (`refetchInterval`, query class `live`).

### 6.3 用量 (phase 3)

One Card titled 用量 · 近 7 天, head action: a muted 「费用为估算」 note.

- `TrendChart` (§10) with two aligned panels sharing the x-axis (the 7 dates): **运行** (count) and
  **Token** (sum of the five token kinds); today is the current point (accent). The tooltip / focus
  line reads `11-09 · 运行 128 · Token 3.4M · 估算 ¥12.30`. One measure per panel, never two
  y-scales (D1).
- Under it, a line 「7 天合计：运行 812 · Token 21.7M · 估算费用 ¥78.40」; with `costPartial`
  「（部分模型未设置价格，未计入）」 linking `/admin/models`.
- **组织排行**: unframed `DataTable` (组织, 运行, Token, 估算费用), top 10 by tokens, then a 其他 n 个组织
  row; the org name links `/admin/orgs`.

Empty (no runs in 7 days): the chart draws its flat zero state with 「近 7 天没有运行。」.

### 6.4 最近的平台操作 (phase 1)

One Card titled 最近的平台操作, actions: `LinkButton` 查看全部 → `/admin/audit`. An unframed
`DataTable` of 10 rows: 时间 (`DateTime`), 操作者 (name, or 系统 for the kernel; a `经由智能体` / `个人令牌`
meta), 操作 (a localized label per action, §8.4), 对象 (`target`, mono). Empty: compact
「还没有平台操作记录。」.

**`/admin/audit`** (phase 1, minimal): `ListPage` (records) + the same `DataTable`, 加载更多 by
cursor, no filters (D2). It lists only platform-level events (§4.4).

## 7. Web

### 7.1 Files

- `apps/web/src/lib/admin.ts`: loaders `getAdminOverview` (new shape), `getAdminAttention`,
  `getAdminHealth`, `getAdminUsage(tz)`, `listPlatformAudit(after?)`; types.
- `apps/web/src/lib/query/admin.ts` + `keys.ts`: `adminOverviewQuery` (`deployment`),
  `adminAttentionQuery` (`deployment`), `adminHealthQuery` (`live`, `refetchInterval: 30_000` in the
  view), `adminUsageQuery(tz)` (`deployment`; key holds `tz`), `platformAuditQuery(after?)`
  (`deployment`). `adminInboxQuery` is reused (`live`).
- `apps/web/src/lib/query/routes.ts`: `/admin` prefetches `adminOverviewQuery`, `adminInboxQuery`
  and `platformAuditQuery()` (PG-only, fast); attention (may wait on a provider list up to
  `models.listTimeoutMs`), health and usage are **not** prefetched: their Cards draw their own
  skeleton on the first paint, so a slow provider never delays the page **(designer's call)**.
  New entry `/admin/audit` prefetches `platformAuditQuery()`.
- `apps/web/src/app/(app)/admin/view.tsx`: the gate, the header from `adminOverviewQuery`, one
  component per section under `apps/web/src/app/(app)/admin/overview/`
  (`AttentionSection.tsx`, `HealthSection.tsx`, `UsageSection.tsx`, `AuditSection.tsx`), the
  footnote.
- `apps/web/src/app/(app)/admin/audit/page.tsx` + `view.tsx`; sidebar entry 审计日志 in the admin
  context (after 收件箱).
- `apps/web/src/lib/admin-inbox.ts`: `platformInboxTypeHref(type)` beside `platformInboxHref`.

### 7.2 States per block

- The header: `usePageQuery(adminOverviewQuery())`: loading → `OverviewPage loading={{ stats: 3, keep: true }}` with the sections rendered (each loading for itself); error → the stats row
  degrades to the `ErrorFrame` only if the overview read fails (it is two counts; this is the page's
  main read, as today).
- Each section: its own `useQuery` (with `retryOnMountOf` for a hydrated error), drawn by the new
  design `OverviewSection` (§10.2): `loading` → a skeleton shaped like the loaded block
  (`BlockShape[]`), `error` → the in-place error line 「无法加载运行状况 · 重试」 (an `ErrorDetail` with the
  raw text behind 原始错误), `empty` → its `panel` EmptyState, `ready` → content. A failing block
  never touches the others.
- Partial data (`unavailable: [...]`): the affected rows show 「暂时无法读取」 muted, the rest render.
- `/admin/inbox?type=<type>`: the inbox page gains a `type` filter from the search params so a
  per-type row lands on just those items (one `useMemo` filter on the cached list; no new route).

### 7.3 Phone (< 640)

Nothing page-specific (spec §4.3): StatCards go 2 × 2 (3 or 4 cards), Cards stack, `ItemList` rows
compact, `DataTable`s stack their rows (every column has a real `header`), the chart fills the
width with 7 points and its tooltip opens on tap, `KeyValue` wraps. Checked in the visual spec at
390 px.

## 8. Copy and i18n

### 8.1 Keys

`admin.overview.*` in `apps/web/messages/zh.json` / `en.json` (`pnpm check:i18n`): section titles,
group titles, the inbox type labels (shared with the inbox page where they exist), extension
reasons, provider problems, role names (api / worker / gateway stay as written: they are config
values; zh adds 「（接口）」「（后台任务）」「（长连接）」 as the meta), queue names, usage labels, the
footnote. zh says 平台 / 超级管理员 / 智能体, never 企业 or `agent`.

### 8.2 Numbers

Counts as today's overview formats them (grouped digits, `en-US` grouping in both locales);
tokens compact (`3.4M` / `340万` per locale) through a new design helper `formatCompact(n, locale)`
beside `versionLabel`; cost with the currency
(`priceCurrency`) and 2 decimals, always with 估算 / est.

### 8.3 Dates

`DateTime` for audit rows and replica start; chart dates `MM-DD` in the reader's zone (the same
`tz` the route used).

### 8.4 Audit actions

A label map for the platform-level actions (about 35: `deployment.settings.updated` →
「修改了部署设置」, `marketplace.added` → 「添加了市场」, `catalog.imported` → 「导入了插件」, …) in
`admin.audit.actions.*`; an action without a label shows the raw action in mono. Legacy names map
through `LEGACY_AUDIT_ACTIONS` server-side (`auditActionAliases` exists for this).

## 9. Privacy

- Usage is per day and per org; never per account, agent or conversation, and no model content.
  The super admin already sees every org's name (`/admin/orgs`).
- Queue rows carry counts only: no job data (which holds conversation and run ids), no
  `failedReason` (an error text may quote user input). Failures are diagnosed from logs.
- Extension and provider problems carry a reason category, never the raw error text (the
  extension page shows the redacted detail as today).
- Audit rows return `actor`, `action`, `target`, time and two flags; never `detail` (it may carry
  config field names or ids an overview has no need for). Org-level events are not returned.
- The footnote says it: 「超级管理员不能查看会话内容；以上用量只含汇总数字。」.
- Routes are `@SuperAdmin()`; service tokens 403; the web prefetches nothing from `/admin/*` for
  others (`useAdmin`).

## 10. Design package

### 10.1 `TrendChart` (new; spec §6.8)

Today §6.8 has `BarChart` (pixel blocks, no axes) and `Sparkline`; neither draws a time series with
labels, a tooltip or a table view. New `TrendChart` in `packages/design/src/display/trend-chart.tsx`:

```ts
TrendChart({
  label: string;                       // accessible name: 「近 7 天用量」
  x: { key: string; label: string }[]; // the dates, in order
  panels: {
    id: string; label: string;         // 运行 / Token
    values: (number | null)[];         // null = no data (gap)
    format(n: number): string;         // axis max and tooltip
  }[];
  current?: number;                    // index drawn in accent (today)
  extra?(i: number): ReactNode;        // more tooltip lines (估算费用), a hidden-table column too
  extraLabel?: string;                 // that column's header
  empty?: string;                      // the zero-state line
  defaultActive?: number;              // the point shown before any pointer or key (reference)
})
```

- **Form**: small multiples: one panel per measure, stacked, sharing the x-axis and its labels
  under the last panel. Never a second y-scale (D1).
- **Marks** in the E terminal style: a 2 px stepless polyline in `muted`, square 6 px point
  markers (`shape-rendering: crispEdges`), the `current` point and its segment in `accent`; a 0
  baseline in `line`; the y-axis shows only the panel's max (formatted) at the top-left in
  `small` `faint`; x labels `small` `faint`; no grid lines (§6.8). Panel title `small` `muted`
  left, the latest value right.
- **Hover / focus**: one crosshair (1 px `line-strong`) across both panels and one tooltip (the
  `panel` ground, `line-strong` border, `shadow-1`) with the date, each panel's formatted value and
  `extra(i)`. Hit targets are full-height columns. Keyboard: the chart is one focusable group;
  ←/→ move the point, Home/End jump, Esc hides; the tooltip text is mirrored in a polite live
  region. Touch: tap a column.
- **Accessibility**: `role="group"` with `aria-label`; each panel's SVG `role="img"` with a summary
  (「运行：最高 11-09 的 128，今天 64」); a visually hidden `<table>` with every value (the table view
  the dataviz rules ask for); color is never the only signal (the current point is also labelled
  in the tooltip and the table). Forced colors: strokes use `CanvasText` / `Highlight`.
- **Tokens**: only existing ones (`muted`, `accent`, `line`, `line-strong`, `faint`, `panel`,
  `shadow-1`, type `small`); no new color, so dark and light come from the theme and every org
  theme (themes spec) applies. Panel height 96 px at default density, 72 dense (steps of §2.5).
- Spec: §6.8 gains a TrendChart paragraph and `<!-- states: trend-chart -->` with `default`,
  `hover`, `current`, `empty`, `gap`, `phone`.

### 10.2 `OverviewSection` (new; spec §5.6)

The per-block frame so a page draws no state logic of its own:
`OverviewSection({ title, actions?, state: "loading" | "error" | "ready", loading?: BlockShape[], error?: { summary, detail?, onRetry }, children })`: a Card whose body is the skeleton, the
`LoadFailed`-style error line (icon, summary, 重试, the `ErrorDetail` toggle) or the children.
It is the Card (one box). States: `default`, `loading`, `error`. `OverviewPage` itself is unchanged.

### 10.3 Reference set and visual impact

- New reference PNGs (dark and light) for `trend-chart-*` and `overview-section-*`, drawn in
  `docs/design/reference/src/` from fixtures in `@capybara-hq/design/fixtures`; rendered **only**
  by the `reference-update` workflow; the maintainer signs them off (spec §9) before phase 3 ships
  the chart (phase 1 needs only `overview-section-*`).
- `/dev/ui` catalog entries for both.
- `apps/web/visual/` gains `admin-overview` baselines (desktop, 390 px; phase 1, then updated in
  phases 2 and 3) via the `visual-update` workflow; the existing `template-overview-*` baselines are
  unchanged.
- `findNestedBoxes` covers the new page (one Card per section, groups inside).

## 11. Tests

Kernel (`packages/kernel/test/admin/`, real PG + Redis):

- `overview.http.test.ts`: the new overview shape; a non-super-admin 403; a service token 403.
- `catalog/platform-inbox.test.ts` (extend): `byType` equals the per-type counts of a seeded inbox.
- `attention.http.test.ts`: a pending-config, a failed (fake failing extension fixture) and an
  invalid-config extension each give their reason; a catalog item with a newer marketplace entry
  appears with both versions; a fake provider whose `listModels` throws is `list_failed`, one listing
  only embedding models is `no_chat_model`; the caps and `more`.
- `audit.http.test.ts`: only `org_id IS NULL` rows, newest first, keyset paging with `after`/`next`,
  `detail` absent, `viaAgent` from `detail.via`, deleted actor, `limit` bounds 400.
- `presence.test.ts` (phase 2): **dual replica** (`createDualReplicaHarness`): a process with
  `roles: ["api"]` and one with `["worker","gateway"]` both appear with their roles and versions; a
  graceful close removes its entry at once; a killed one ages out after the window (fake Redis time
  via a short test interval seam `PRESENCE_INTERVAL_MS`); `channelsHeld` sums across replicas.
- `health.http.test.ts` (phase 2): queue counts against seeded BullMQ jobs, including a failed job
  older than 24 h not counted in `failedLastDay` (pins the `finishedOn` score assumption); channel,
  device and sandbox counts from seeded rows; Redis stopped → `unavailable: ["redis"]` and PG
  numbers still present.
- `usage.http.test.ts` (phase 3): seeded runs, usage events and `model_usage` across two orgs, two
  zones and the 7-day edge (an event at 23:30 UTC falls on the next day in `Asia/Shanghai`); cost
  with and without prices (`costPartial`); top 10 + others; the second call within 300 s is a cache
  hit, served by the other replica in a dual-replica run; `EXPLAIN` asserts the three queries use
  `conversation_events_usage_idx`, `runs_created_idx`, `model_usage_time_idx`.
- Platform: `test/platform/ops-admin.test.ts` for the four operations; `pnpm check:platform-ops`
  and the parity test green.
- Migrations: the existing migration tests (idempotent re-run).

Web (`apps/web/test/`):

- `admin.test.tsx` (extend) and `admin-ssr.test.tsx`: `renderRouteWithCache("/admin")` prefetches
  overview, inbox and audit with no first-paint fetch for them; attention / health / usage render
  their skeleton, then data; one of them failing (stub 500) shows that block's error and 重试
  while the other blocks and the stats render; 重试 refetches only that block; empty states;
  non-super-admin → `NoAccess` and no `/admin/*` read.
- `admin-audit.test.tsx`: list, 加载更多, empty.
- `admin.test.tsx` (extend): the inbox `?type=` filter.
- `check:web-ui`, `check:i18n`, `findNestedBoxes` on the rendered page.

Design (`packages/design/test/`):

- `trend-chart.test.tsx`: geometry (points, current, gaps, all zeros), the hidden table holds every
  value, keyboard (←/→/Home/End/Esc) moves the crosshair and updates the live region, the panel
  `role="img"` summaries, no second y-scale prop exists (type test).
- `overview-section.test.tsx`: the three states, retry callback, it provides the box scope.

## 12. Rollout

Each phase is one PR, shippable alone, with its changeset (`@capybara-hq/kernel`,
`@capybara-hq/design`, `@capybara-hq/web` as touched).

| Phase | Ships | Kernel | Design | Web |
|---|---|---|---|---|
| 1 | 待处理, 最近的平台操作, stats, footnote, `/admin/audit` | overview shape, inbox `byType`, `attention`, `audit` routes + ops, migration 0109 | `OverviewSection` (+ reference PNGs) | page rewrite, sections 1 and 4, audit page, sidebar entry, inbox `?type=` |
| 2 | 运行状况 | `ReplicaPresence`, `health` route + op | none | `HealthSection` (polls 30 s) |
| 3 | 用量 | `usage` route + op, `admin.usage_unavailable`, migration 0110 | `TrendChart` (+ reference PNGs, maintainer sign-off) | `UsageSection`, 4th stat 近 7 天运行 |

Phase 2 depends on nothing in phase 1 but the page frame; phase 3 likewise. Before phase 1 merges,
the page keeps working at every step (the old overview shape changes in the same PR as the view).

## 13. Decisions (maintainer, 2026-11-11)

The six open questions of the draft were answered "as recommended" on 2026-11-11:

1. **D1 – usage chart:** one `TrendChart` component drawing two stacked panels (运行, Token) that
   share the x-axis and one crosshair; never one chart with two y-axes (the eye would compare
   slopes the scales made up).
2. **D2 – audit log page:** a minimal `/admin/audit` ships in phase 1: platform events, keyset
   paging, no filters. Filters (action, actor, time) and org-level events wait for a request.
3. **D3 – platform-level events:** `org_id IS NULL` for v1 (exact, indexable, no role history). A
   super admin acting inside an org is recorded with that org's id and stays out; revisit with
   org audit pages.
4. **D4 – Platform operations:** health and usage (and attention, audit) are mirrored as read-only
   `read` Platform operations for the super admin's own agent; no exclusion.
5. **D5 – auditing reads:** viewing the overview, health or usage writes no audit event (aggregates,
   no content; unlike `trajectory.viewed`).
6. **D6 – eval runs:** usage includes eval runs (they cost real tokens); a later filter may split
   them.

## 14. Rejected alternatives

- **One `GET /admin/overview` returning everything**: one slow provider or a Redis hiccup would
  fail the whole page, and the blocks need different freshness (health 30 s polling, usage 5 min
  cache).
- **Replica liveness from `extension_replica_status`**: no role, no version, and its heartbeat
  depends on a worker's `@LockedInterval`; a dead worker would make every replica look dead.
- **Counting online channels / devices by scanning lease keys**: `SCAN` over the keyspace per page
  load; per-replica self-reported counts are O(replicas).
- **A rollup table for usage now**: more moving parts (a job, a migration, backfill) before a
  measured need; the indexed 7-day read is bounded and cached.
