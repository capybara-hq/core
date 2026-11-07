# @capybara-hq/capybara

## 0.1.0-rc.6

### Minor Changes

- d423777: Agent templates: the 智能体 page has the tabs 智能体 and 模板 and shows both as cards
  (`/agent-templates` redirects to `/agents?tab=templates`), the admin 智能体模板 list uses cards too.
  A template card and the new template page (`/agents/templates/<id>`: the read view for members, the
  editor for org admins) open 用它创建, a dialog with the 带入 / 待配置 / 不可用 preview; the new agent
  shows its template and a 待配置 notice in Tools where an admin configures each connector (an existing
  one, one more from the template, or the prefilled custom form) and a member sends or repeats a
  request. Org admins save an agent as a template from its card or page, and the inbox shows
  connector setup requests with the same configure dialog.
- 90c6125: Bootstrap plugins: `openai-compatible` and `object-store-s3` move to 0.1.0-rc.1, and the manifest preinstalls `anthropic`, `openai`, `connector-mcp`, `connector-openapi`, `jina`, `sandbox-docker` and `todo` as optional entries (installed and enabled on the deployment, off in each organization until an org admin switches them on). `marketplace.commit` and the compose sandbox build contexts move to the plugins commit that lists them.
- 9f554a3: Org members can read the org's 扩展 page: `GET /api/v1/orgs/:orgId/extensions` is the new action
  `org.extensions.read` (member and up); a member gets each extension's state without its config, the
  secrets' state, the config schema or the permission list, admins keep the full view. The page
  hides every switch and config control for members.
- 2321382: A platform inbox for the super admin: `GET /api/v1/admin/inbox` (with `total`, and `GET /api/v1/admin/inbox/count` for the sidebar) lists the orgs' requests to the platform (`access` / `import`), plugins whose extension permissions wait for a confirmation, open plugin scope sync failures, including dependencies a platform update added that could not be installed (recorded per item and org in the new table `plugin_scope_sync_failures`, migration 0083, until a later sync of the pair does not fail) and the latest platform components migration run when it failed plugins or is stuck. The admin console gets a 收件箱 page (`/admin/inbox`) and a sidebar item with its count; each item links to the page where it is acted on.
- a965a1a: Plugin scope: enterprise plugins have a scope (all, optional, named orgs), built-in and disabled states, and the org switch, requests (access, import, enable) and a scope sync worker replace the catalog policy, grants and the install-deployment step. Importing a plugin installs its extension; the admin plugin and extension pages and the workspace plugin and extension pages move accordingly.
- 7278dec: Plugin scope phase 2: a plugin's skills, agent templates and connector templates are platform
  components, stored once for the deployment (migration 0081: `platform_skills`,
  `platform_agent_templates`, `platform_connector_templates` and their versions, files under
  `deployment/platform/`) and resolved at read time in each org where they are on; an org install no
  longer copies skills or agent templates. A component follows its plugin's scope or has its own
  (`/api/v1/admin/components/*`, preview then confirm), org admins switch single components off or on
  (`PUT /api/v1/orgs/:orgId/components/:kind/:id/switch`), and a super admin uploads a new component
  version on its own. The worker job `platform-components-migrate` (migration 0082) links org copies
  made by earlier installs to their platform components under their own ids (agent definitions and
  conversation logs are not rewritten; a copy changed in the org is pinned to its version) and renames,
  in its first run only, an org's own skill whose name a platform skill on in the org has, with an inbox
  notice. The per-org plugin upgrade routes are removed: the super admin updates a platform plugin once
  (`POST /api/v1/admin/catalog/items/:id/update/preview`, `PUT …/update` with `diffHash`), which moves
  its extension, components and every org install; connectors follow their template through
  `platform_template_id`, and an org creates connectors for added templates with
  `POST /api/v1/orgs/:orgId/catalog/:itemId/connectors`. The admin console gets 技能, 连接器模板 and
  智能体模板 pages with scope dialogs and version history, and the plugin detail's platform update
  preview.
  An org install or switch takes no `version` any more (400): an org installs the platform version, and
  dependencies resolve to their platform version (refused when it does not satisfy the range). A
  version-pinned org copy follows its platform component's availability (disable, switch-off, scope
  removal, uninstall) and counts in the previews' affected agents. The marketplace import default and
  the market row's version use one order.
- 26e8757: Workspace platform components: the 技能 page lists the org's own skills and the platform skills offered to the org with their state and the org admin's switch (已启用 · 平台统一 for `all`), a new 智能体模板 page lists agent templates the same way, the plugin detail lists its components with per-component switches, and an installed plugin missing a connector offers 补充配置. The kernel adds `GET /orgs/:orgId/components`, serves a linked skill copy's detail as its platform skill, and names the missing connector templates in the org catalog detail. The agent editor treats linked copy ids as their platform skill or template; the inbox shows decided requests.

### Patch Changes

- e555e04: The agent map opens one sub-agent's summary (latest text, task, background tasks, tool calls newest
  first, Stop while it runs) and its read-only transcript; an `Agent` call block names the child's
  current tool and opens it in the map. A sub-agent's reports and its end show in the parent as notice
  lines, and a parent's messages in a sub-agent's transcript as bubbles labelled with the sender.
- 1556a45: The conversation page opens an agent map of the conversation's sub-agents (from the sub-agent
  group's header and a title-bar icon), kept in the URL hash; the org sub-agent limits dialog sets the
  nesting depth and counts dispatches and tokens over the whole tree since the person's latest message.
- 3a4b54b: The agent page's Tools section puts each tool's policy on its row (a new `ToolPolicyList`): the
  built-in tools stay in the card, and each extension or connector is one row with a summary that
  opens a Sheet with its tools, select-all and a filter. A connector can now be taken tool by tool.
  The connector detail's tools carry their display `title`.
- 3c0ad62: A conversation's history loads from the end: the page paints the log's last page and reads earlier
  pages as the reader scrolls up, without moving what is on screen. `GET …/conversations/:id/events`
  takes `before=<seq>` or `before=end` for a turn-aligned page (it starts after a run's end) with
  `turnsBefore`, the runs started before it. Sub-agents, usage and background tasks are read from
  the server when the loaded part may hide them.
- abc772e: Switching on an extension whose org config has a required field that was never saved is refused
  with the plain 400 `extension.config_invalid` and its field issues before the plugin installs
  (no 502 `plugin.install_failed`); a `config` sent in the same PUT goes into the install. On the
  扩展 page the switch of such an extension waits for the config (先填写组织级配置再启用), the
  config form offers 保存并启用 (config and switch in one PUT), and a refused config marks the
  form's fields.
- 357c521: A sub-agent that handed back its report and then completed no longer sends its parent a separate
  "completed; its report was already delivered" notice: the finish is only logged, so it neither
  wakes an idle parent for an empty run nor pushes the report away from the end of the request. The
  conversation still shows the agent's "completed" entry.
- 9e90494: Bootstrap plugin `openai-compatible` moves to 0.1.0-rc.2: the DeepSeek dialect sends
  mid-conversation system notices (sub-agent reports, background notices, tool-change reminders) as
  in-place `[system]` user turns, so DeepSeek no longer moves them ahead of the conversation.
- 237c176: The model purpose APIs return `declaredByName`, the declaring extension's display name.
- bdd3fa3: A sub-agent stopped by its tree's token budget hands back what it found in one final tool-less
  call instead of ending with nothing. `subagents.maxTokensPerRun` and `subagents.maxDispatchesPerRun`
  accept 0 for no limit (deployment config and org override), and `GET /api/v1/admin/orgs` returns the
  deployment's defaults of the per-org limits (`limitDefaults`).
- 0e38b13: The deployment-level role "enterprise admin" is now "super admin" (breaking, no compatibility
  aliases). Migration `0080_rename_enterprise_admin.sql` renames `accounts.is_enterprise_admin` to
  `is_super_admin` and the stored deployment setting `orgCreation: "enterprise_admin"` to
  `"super_admin"`; historical audit rows are not rewritten. API: the account field
  `isEnterpriseAdmin` is `isSuperAdmin` (`GET /api/v1/me`, the admin account list and
  `PATCH /api/v1/admin/accounts/:id`), account creation takes `superAdmin`, `orgCreation` accepts
  `"anyone" | "super_admin"`, and the error code `account.last_enterprise_admin` is
  `account.last_super_admin`. Kernel exports: the `SuperAdmin` route decorator, `SuperAdminLock` /
  `SuperAdminLockModule`, `AccountsService.countSuperAdmins` / `createSuperAdmin` /
  `createSuperAdminIfNone` / `setSuperAdminByLogin`, `authorizeSuperAdmin`.
  
  Deploying: migration 0080 renames a column, so replace all replicas at once; a rolling upgrade
  across this version breaks the replicas still running the old code.
- cfee6f0: The model is told when its tool set changes mid-conversation: a step whose resolved tools differ
  from the previous request's logs a `tools_changed` event (added and removed tool names) before its
  request, rendered as a system message ("Your tools changed. Now available: … No longer available:
  …"). Step replay rebuilds it from the log with zero drift; the web timeline ignores it.
- e18ee24: UI terms: the web app reads and sends the kernel's renamed `isSuperAdmin` / `superAdmin` /
  `orgCreation: "super_admin"`. Chinese copy says 超级管理员 (was 企业管理员), 平台 for the deployment
  layer (平台目录, 已启用 · 平台统一, 平台提供的插件), 自定义市场源 for a non-official marketplace,
  智能体 for agent (nav 智能体, 新建智能体, 子智能体, 智能体模板), and the role names 组织所有者 /
  组织管理员 / 组织成员 / 访客; English says Super admin, Platform, Custom marketplaces and Org owner /
  Org admin / Org member / Guest. The CLI says "super admin" in `capybara admin create | grant |
  revoke` output and help (`super admin already exists; skipped`, `super admin created`).
- 47c4241: The workspace has no home page any more: the new conversation is the home. `/` redirects to `/chat`,
  新会话 is the current nav item there, and sign-in, setup, an org switch, the not-found page and the
  path's org scope all go to `/chat`. The sidebar reads 新会话 · 智能体 · 技能 · 连接器 · 更多; 技能 and
  连接器 left the 更多 flyout, which keeps 插件, 扩展, 智能体模板, 渠道, 评测与运行 and 组织设置.
- Updated dependencies [49ae0b5]
- Updated dependencies [f222ff8]
- Updated dependencies [d423777]
- Updated dependencies [3a4b54b]
- Updated dependencies [0f383d7]
- Updated dependencies [8f7a0a5]
- Updated dependencies [da49ebd]
- Updated dependencies [90c6125]
- Updated dependencies [16225b1]
- Updated dependencies [3c0ad62]
- Updated dependencies [789068d]
- Updated dependencies [7c8d05e]
- Updated dependencies [abc772e]
- Updated dependencies [8ee4c6c]
- Updated dependencies [2a12327]
- Updated dependencies [12fd552]
- Updated dependencies [3adad42]
- Updated dependencies [9f554a3]
- Updated dependencies [8fd18a1]
- Updated dependencies [9e90494]
- Updated dependencies [e40774d]
- Updated dependencies [99a00cd]
- Updated dependencies [e0a0d60]
- Updated dependencies [ffc33a2]
- Updated dependencies [45d7275]
- Updated dependencies [5ac4bba]
- Updated dependencies [2fb7d41]
- Updated dependencies [2321382]
- Updated dependencies [3c45446]
- Updated dependencies [cc21d5c]
- Updated dependencies [a965a1a]
- Updated dependencies [7278dec]
- Updated dependencies [bdf5eba]
- Updated dependencies [703c779]
- Updated dependencies [77de995]
- Updated dependencies [11f56fa]
- Updated dependencies [927fad3]
- Updated dependencies [7a1e1ae]
- Updated dependencies [0e38b13]
- Updated dependencies [cfee6f0]
- Updated dependencies [26e8757]
  - @capybara-hq/kernel@0.1.0-rc.5

## 0.1.0-rc.5

No changes in this release.

## 0.1.0-rc.4

### Patch Changes

- 49fa38b: A kernel whose stdout reader is gone no longer spins and ignores signals. When the reader of
  the console exits (the `tee` of `pnpm dev:kernel` stopped by Ctrl-C, a closed pipe), every log
  write failed with EPIPE as an uncaught exception, the process guard logged it (another write,
  another EPIPE), and the endless chain of errors held the CPU at 100% and starved the exit, the
  stop budget and a second signal. The logger now stops writing to a console stream after its first
  error, and the guard logs nothing more once it decided to exit. `pnpm dev:kernel`'s log file
  writer ignores Ctrl-C, so the shutdown's records reach `/tmp/capybara-dev-kernel.log` too.
- 4ef89b8: Readable logs in the octok layout.
  
  - **Pretty console:** `[2026-10-30 12:00:00.000 +0800] INFO: [pid=…] - [traceId=…] [reqId=…]
    [queue=…] [jobId=…] [runId=…] [context=…] [plugin=…] msg`, each bracket only when present, with the
    other fields as indented `key: value` lines below instead of trailing JSON, and an error's stack
    below its message. The access line reads `GET /api/v1/me 401 2ms`. The process roles are no longer
    on every line (the start line names them; JSON records keep `role`).
  - **Context per class:** every kernel class's records carry `context` = its class name (JSON too).
    `KernelLogger` gains `child(fields)`.
  - **Nest's own lines** (`Mapped {/api/v1/…, GET} route` and module loading at startup) are logged at
    `info` with Nest's context, as octok does; they were at `debug`.
  - **Colors:** `FORCE_COLOR=1` forces colors in pretty output, `NO_COLOR=1` turns them off.
    `pnpm dev:kernel` forces them in the terminal and strips them from `/tmp/capybara-dev-kernel.log`.
- Updated dependencies [ce0e90c]
- Updated dependencies [9d134ee]
- Updated dependencies [0344386]
- Updated dependencies [1e092a6]
- Updated dependencies [9e9ce5b]
- Updated dependencies [0ec51d1]
- Updated dependencies [8e43ed7]
- Updated dependencies [9b89920]
- Updated dependencies [258d286]
- Updated dependencies [69b3bbe]
- Updated dependencies [489d640]
- Updated dependencies [58d08b1]
- Updated dependencies [70688ca]
- Updated dependencies [49fa38b]
- Updated dependencies [0f1507e]
- Updated dependencies [80f4844]
- Updated dependencies [76da814]
- Updated dependencies [8e928cb]
- Updated dependencies [3455513]
- Updated dependencies [81adaff]
- Updated dependencies [4ef89b8]
- Updated dependencies [c01c117]
- Updated dependencies [f28ed05]
- Updated dependencies [2bd8351]
- Updated dependencies [c9c8625]
- Updated dependencies [8f7ba64]
  - @capybara-hq/kernel@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- Updated dependencies [8bf0b04]
- Updated dependencies [e1127f5]
- Updated dependencies [307c611]
- Updated dependencies [1beea7e]
- Updated dependencies [56e83dd]
- Updated dependencies [48d3983]
- Updated dependencies [a1bfe76]
- Updated dependencies [0f4b28a]
- Updated dependencies [8881b9a]
- Updated dependencies [32580d3]
- Updated dependencies [75b1aaf]
  - @capybara-hq/kernel@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- de0d460: The kernel is now one standard NestJS application (`createKernelApp` / `startKernelApp`): global
  infra modules (config, logging, the database with transactions, Redis, locks, cache, queues,
  schedules, throttling, health, validation), one module per domain whose services are injectable
  providers with one instance each, and the role modules `roles` selects (api, worker, gateway).
  One lifecycle provider owns the start order and the stop phases. Every concern is done one way,
  enforced by the new check `check:kernel-conventions`. Extensions are unchanged: they see only the
  SDK `ctx`, which the extension host builds from the injected services. HTTP routes, status codes,
  error codes and bodies, queue names, job ids, the event log, config keys and the SDK are unchanged
  except where noted below. The decisions made during the work are recorded in the appendix of the
  design spec (`docs/superpowers/specs/2026-10-28-nest-kernel-design.md`).
  
  **Operations**
  
  - **`capybara bootstrap` needs Redis.** The bootstrap step runs under the Redis lock
    `lock:bootstrap` (120 s TTL, renewed while it runs), in a starting kernel and in
    `capybara bootstrap` alike, instead of a PostgreSQL advisory lock, so compose `init` and a
    Kubernetes init Job need `CAPYBARA_REDIS__URL` as well as the database; the compose `init` service
    waits for valkey. During the rolling deploy that brings this change an old and a new process do
    not exclude each other; the step is recorded once per manifest and its writes are idempotent. The
    CLI's Redis connection keeps reconnecting, so a `capybara bootstrap` holding the lock survives a
    Redis blip.
  - **Periodic jobs** were BullMQ repeatable schedulers on the maintenance queue; they are now
    schedules inside the worker processes, each run once per period across all worker replicas
    (another replica's attempt logs at info). Names and periods are unchanged: `wait-sweep`,
    `usage-report-sweep`, `attachment-cleanup`, `storage-org-purge`, `sandbox-suspend-idle`,
    `sandbox-destroy-inactive`, `drift-scan`, `catalogs-refresh`, `output-cleanup`,
    `app-staging-cleanup`, `directory-scan`, `offboard-sweep`, `plugins-reconcile`,
    `channel-gateway-check`. A starting worker removes the old schedulers from Redis. They still run
    only on processes with the `worker` role, as do all queue consumers; an `api`- or `gateway`-only
    process builds no BullMQ worker and no scheduler.
    - A worker runs no periodic job before its start sequence (migrations, the bootstrap step, the
      extension load) has started its queue consumers; a tick that fires earlier is skipped with the
      info line `cron skipped: the scheduler is not started`. `catalogs-refresh` and `drift-scan` run
      once at that point, as their schedulers' first run did. At shutdown the schedules stop first and
      runs in progress are awaited within the stop budget, so a stop leaves no run lock behind.
    - Every hourly job now fires at the top of the hour (`attachment-cleanup`, `output-cleanup`,
      `app-staging-cleanup`, `directory-scan`, `storage-org-purge`, `sandbox-destroy-inactive`): the
      first run after an upgrade is at the next full hour. The 10-minute and 1-minute jobs fire on
      clock boundaries; their periods are unchanged.
    - A job whose run lock is lost (Redis outage, another holder) has its abort signal fired and a
      failure after the loss is logged at warn; only a job that reads the signal stops early (today
      `catalogs-refresh`). The others are idempotent sweeps and finish their pass.
    - A periodic job's name enqueued on `cap-kernel-maintenance` (by an operator or a test) runs that
      job once, as before; it is not a second schedule.
    - `sandbox-destroy-for`, `wait-timeout`, `drift-connector` and `directory-sync` stay one-off jobs
      on the maintenance queue (names, data, ids and retries unchanged: `drift-connector` still runs
      once), consumed by one maintenance processor on the worker role.
  - **Shutdown.** `capybara start` handles SIGTERM / SIGINT from before the start: a signal turns
    `/readyz` to 503 at once and aborts a start in progress at its next step; the stop phases, the
    queue and worker closes, and finally Redis, the bus and the pool (closed together) share the 30 s
    stop budget; a second signal exits 1 at once. Event streams close when the shutdown begins and
    later ones end at once. In-process events raised while the stop drains runs (a run finishing,
    an approval decided) are still handled, so IM final deliveries and resumes are not lost during a
    rolling deploy. With Redis unreachable the stop now uses the whole budget: queues and workers
    that cannot close are abandoned instead of holding the exit, and the pool still gets its share.
    The main Redis connection closes with QUIT.
  - **Unhandled errors.** `capybara start` logs an unhandled rejection or uncaught exception and exits
    1 only after more than 5 within 60 s (it exited on the first); other commands still exit on the
    first. A PostgreSQL restart while a pooled client is checked out is logged (`pg client error`,
    warn) instead of crashing the process.
  - **Leases give up on a deadline.** Every Redis lock and lease (the conversation run lease
    `capk:conv-run:<id>`, channel long-connection leases, sandbox and path leases, org run and eval
    quota slots) is renewed every third of its TTL and is lost at the send time of its last successful
    renewal + TTL − TTL/3, even with a renewal in flight, so a holder lets go one renewal period
    before the key can be taken elsewhere. Before, a conversation lease whose renewals failed until
    expiry kept running, so a second replica could start a second run on the conversation. After a
    Redis outage longer than about two thirds of a TTL a run is now re-queued (and resumes), a long
    connection reconnects, and a sandbox path lease is lost too; a lapsed quota slot lets the run or
    eval go on, so an org may briefly run more than its concurrency (for evals after an outage of
    about 40–60 s). A lost lease logs one `lock lost: <key>` warning (it replaces `channel lease lost;
    disconnecting`, `sandbox lease lost`, `sandbox path lease lost`, `org quota lease lost` and `eval
    quota renew failed`); a failed release logs `lock release failed` at warn (the key expires within
    its TTL). Keys and values are unchanged. A channel lease lost while its connection's config is
    read is no longer connected on. A shared sandbox lease renewed while it is being downgraded is
    no longer lost.
  - **Rate limits.** The credential limits (login, change password, setup token, invitation accept)
    keep their limits, codes, bodies and `retry-after`, and still fail closed when Redis is down;
    their counters move to `throttler:{cred:<group>}:…` (from `capk:login-fail:*` / `capk:rl:*`),
    so the counts reset once at deploy.
  - **Directory sync** takes its per-(org, extension) lock as `lock:directory-sync:<org>:<plugin>`
    (was `capk:directory-sync:<org>:<plugin>`): during a rolling deploy an old and a new replica may
    each run one sync of the same pair (harmless: the dirty flag and idempotent writes cover it).
  - **Model list cache** keys are `cache:capk:models:…` (old keys expire by TTL), and the cache fails
    open: a Redis error lists the provider's models again instead of failing the request.
  - **After-commit work.** Notifications after an org extension config write, an extension install,
    state change or uninstall, and an org plugin uninstall run after the commit; a failing one is
    logged and no longer turns the committed request into a 500. After-commit work always runs
    outside any transaction, and kernel bus handlers run outside any transaction and without the
    log context of the code that subscribed.
  - **New error code** `lock.acquire_failed` (409, with the lock key in `details[0].lockKey`; en and
    zh copy in the web app): raised when a kernel lock cannot be taken in time. No route raises it
    today.
  - **Validation.** The UI `:plugin/:id` and file preview `:plugin/:previewerId` routes validate their
    parameters with DTOs: `validation_failed` names the parameter in `details[].path` (was `""`);
    code and status are unchanged.
  - **Swagger.** New config `http.swagger` (default `false`, `CAPYBARA_HTTP__SWAGGER`) serves the
    OpenAPI document and UI at `/docs` (unauthenticated: development and trials only).
  - **CLI.** A kernel that cannot even be built now logs `kernel start failed` (was `cannot load
    configuration`); the exit code is still 1. `capybara admin create` / `admin grant` still need
    only PostgreSQL.
  
  **`@capybara-hq/kernel` API (breaking)**
  
  - Removed: `createKernel`, the `Kernel` facade type, `KernelOptions` and `KernelRuns`. Build the
    kernel with `createKernelApp(config, options)` (started, not listening, no signal handlers) or
    `startKernelApp(config, options)` (started, listening, SIGTERM / SIGINT handled), stop it with
    `closeKernelApp(app)`, reach its HTTP side with `kernelAppHttp(app)` / `kernelAppPort(app)` and a
    service with `app.get(Class)`. The options are `KernelAppOptions` (the old `KernelOptions` fields
    `loop`, `runHooks` and `evalHooks` are gone).
  - Removed: `createHttpApp`, `CreateHttpAppOptions` and `HealthOptions`; there is no standalone HTTP
    app any more, only the kernel application's (`KernelHttp` and `KernelHttpApp` stay).
  - `KernelAppOptions.overrides` is for the kernel's own tests only: it takes values for the named
    seam tokens of `KernelOverride` and refuses any other token when the application is built, so no
    kernel service can be replaced. The seam tokens are not exported.
  - The type `KernelDb` (the `capybara` schema view, a `Kysely<KernelDatabase>`) is renamed
    `KernelSchemaDb`; `KernelDb` is no longer exported.
  - Every exported service class (`ExtensionHost`, `ExtensionInstalls`, `ExtensionLifecycle`,
    `ExtensionAdminOps`, `BootstrapService`, `SandboxService`, `StorageService`, `AccountsService`,
    `SetupService`, `SessionService`, `SettingsService`, `OrgsService`, …) is a Nest provider whose
    constructor takes the kernel's providers: take instances with `app.get(Class)` from an
    application or a CLI context instead of constructing them. Removed with that:
    `BootstrapServiceDeps`, `ExtensionAdminOpsDeps`, `ExtensionLifecycleDeps`, `LifecycleHost`,
    `SandboxServiceDeps` and `StorageServiceDeps`. The prefixing storage is the plain class
    `PrefixedStorage` over a `StorageSource` (an extension's `ctx.storage` and the CLI use it), which
    `StorageService` extends.
  - Moved or changed: `SetupService.createEnterpriseAdmin` / `createEnterpriseAdminIfNone` are on
    `AccountsService`; `BootstrapService.run` takes the plugin import it uses (`imports`);
    `rewrapDataKeys(handles, keyring)` takes the database handles of an application context
    (`{ db, txHost }`) instead of a Kysely and opens its own transaction; `ExtensionCli` exposes the
    command's application context (`app`) and `bootstrap` instead of `db`; `ExtensionLifecycle` no
    longer publishes the periodic reconcile itself (the worker's `plugins-reconcile` job does).
  - New: the type `KernelOverride`; `openKernelCli(config, opts)` (a CLI command's application
    context; `redis: false` leaves Redis and the lock service out), `openKernelCliOverPool(pool,
    opts)` (a context over a pool the caller owns and keeps open), `KernelCliOptions` and
    `AccountsModule`; `handleShutdownSignals` with `ShutdownSignalOptions` / `ShutdownSignalHandle`,
    and `installProcessGuards` with `ProcessGuardDeps`, `GUARD_CIRCUIT_LIMIT` and
    `GUARD_CIRCUIT_WINDOW_MS`.
  
  **`@capybara-hq/testing` API (breaking)**
  
  - `startTestKernel(config, opts)` (options unchanged, no `overrides`) starts the kernel with
    `startKernelApp` on a signal source of its own (no process-wide handlers) and returns a
    `TestKernel` `{ app, http, port, close() }` instead of the `Kernel` facade; `port` is
    `number | undefined` (undefined after `close()`). `app` is the kernel's Nest application, for
    tests that can import kernel classes; a plugin test drives the kernel through `http` and the
    helpers of this package.
  - The `Kernel` and `KernelDb` re-exports are removed; `TestKernel`, `KernelApp` (the Nest
    application type) and `KernelSchemaDb` are exported. `login(k, …)` / `joinOrg(k, …)` take any
    `{ http }`.
  - `createDualReplicaHarness` keeps its API; each replica starts with `startKernelApp`, and the
    harness's stop sends SIGTERM to the replica's own signal source, so a replica stops through the
    same shutdown path as `capybara start`. `createLocalAccount` keeps its signature.
  - Migration for extension tests: type the kernel as `TestKernel` instead of `Kernel`, call
    `k.close()` instead of `k.stop()`, treat `k.port` as `number | undefined`, and import the type
    `KernelSchemaDb` instead of `KernelDb`; `k.http` is unchanged. The official plugins'
    (capybara-hq/plugins) tests need the same migration.
- Updated dependencies [e23c2b6]
- Updated dependencies [a0bc577]
- Updated dependencies [de0d460]
  - @capybara-hq/kernel@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- 4a7726f: `capybara` loads `.env` from the working directory before every command (variables already set in
  the environment win); `--env-file <path>` loads another file and `--no-env-file` none.
- 75d7a0c: `capybara start` logs with the configured format and outputs (`log.format`, `log.loki.*`) and
  flushes the Loki buffer before exiting. Optional OpenTelemetry tracing: with
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set, `capybara start`
  exports OTLP traces of HTTP, Nest, fetch, PostgreSQL, Redis and queue jobs, and log records carry
  `traceId` / `spanId`; without it no OpenTelemetry module is loaded.
- 6aaf28b: `capybara start` always runs the bootstrap step (when it is not done for the manifest), from the
  offline directory of config `bootstrap.dir` (default `./bootstrap`, `/app/bootstrap` in the image)
  or else downloading the pins from `packages.npmRegistry`; `--bootstrap-dir` is removed.
  `capybara bootstrap --dir` defaults to the same directory and downloads what it does not hold.
- 6ad094b: The kernel images no longer carry the bootstrap plugin packages: compose `init` (or the first
  `capybara start`) downloads them from npm (`CAPYBARA_PACKAGES__NPM_REGISTRY` for a mirror), and an
  offline deployment mounts a directory holding the pinned tgz files at `/app/bootstrap`
  (`CAPYBARA_BOOTSTRAP__DIR`). The `NPM_REGISTRY` and `NODE_USE_ENV_PROXY` build arguments are gone.
- Updated dependencies [75d7a0c]
- Updated dependencies [e69c9d6]
  - @capybara-hq/kernel@0.1.0-rc.1
