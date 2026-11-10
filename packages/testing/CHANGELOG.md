# @capybara-hq/testing

## 0.1.0-rc.14

### Patch Changes

- ac81136: Add the client extension fixtures `fake-client` and `fake-client-broken`.
- 353bb95: The fake-client fixture tests check every client integrity value against the sha384 of the packed
  file's bytes.
- c5e26cd: The `fake-client` fixture's `hud` reads its server view's data from `useView().view` (it read the
  view state itself and always showed `hud -`), and `fake.css` also decorates the composer's buttons
  (`[data-cap-part~="composer"] [data-cap-part~="button"]`).
- Updated dependencies [c4b4f6f]
- Updated dependencies [571318f]
- Updated dependencies [f172ba6]
- Updated dependencies [f2786a6]
- Updated dependencies [b03397f]
- Updated dependencies [56fc173]
- Updated dependencies [ad030b1]
- Updated dependencies [232191e]
- Updated dependencies [bb622c4]
- Updated dependencies [38e9f9b]
- Updated dependencies [44fe453]
- Updated dependencies [8a3472b]
- Updated dependencies [afeb135]
- Updated dependencies [363a2d3]
- Updated dependencies [914e022]
- Updated dependencies [89278e7]
- Updated dependencies [ef60eb4]
- Updated dependencies [460567f]
- Updated dependencies [ec5f411]
- Updated dependencies [107a004]
- Updated dependencies [25e6ef3]
- Updated dependencies [e531e6d]
- Updated dependencies [810e10a]
- Updated dependencies [eaa7768]
- Updated dependencies [5d464ce]
- Updated dependencies [8c49d09]
  - @capybara-hq/kernel@0.1.0-rc.15
  - @capybara-hq/plugin-sdk@0.1.0-rc.11
  - @capybara-hq/plugin-tools@0.1.0-rc.12

## 0.1.0-rc.13

### Patch Changes

- ba8ebaf: The fake-im fixture's setup guide is a v2 Markdown document (`guides/fake-im-app.md` and its zh
  translation) instead of the v1 steps and template files.
- 2f01b01: `fake-im` registers setup checks for the kernel's check runner tests (`pass`, `fail`, `proxy`,
  `throw`, `hang`, `ignore-signal`, `long`, `echo-secret`, `pad-to-limit`), and
  `startFakeChannelServer` records the `proxy` check's `POST /checks` calls (`checks`) and can hold
  their answers (`holdChecks`).
- Updated dependencies [848fb39]
- Updated dependencies [2f01b01]
- Updated dependencies [155c1cf]
- Updated dependencies [70a50f5]
- Updated dependencies [6622107]
- Updated dependencies [ba8ebaf]
- Updated dependencies [70a50f5]
- Updated dependencies [aa81e5a]
- Updated dependencies [2219734]
  - @capybara-hq/kernel@0.1.0-rc.14
  - @capybara-hq/plugin-tools@0.1.0-rc.11
  - @capybara-hq/plugin-sdk@0.1.0-rc.10

## 0.1.0-rc.12

### Patch Changes

- 8b10c58: The fake extensions declare UI slots; `fake-tools-ui` adds views for `agent.detail.section`, `org.settings.section` and `platform.page`.
- 18defa0: `platform.page` contributions are served to super admins on org-less routes under
  `/api/v1/admin/ui/` (`contributions`, `views/:plugin/:id`, `actions/:plugin/:id`,
  `embeds/:plugin/:id/token`, `stream`): the extension must be running (no org enablement applies)
  and gets the platform's deployment config. `UiRenderArgs` / `UiActionArgs` become unions narrowed
  on `scope`: the platform variant has `role: "superAdmin"` and no `orgId`. `EmbedClaims` gain
  `scope: "org" | "platform"` (`orgId` absent exactly for the platform scope); a platform token
  verifies only for a `platform.page` contribution while the account is still an active super admin,
  and an org token never verifies for one. `ctx.ui.invalidate` takes no `orgId` for a `platform.page`
  contribution (refreshing the admin console's stream) and throws when one is given.
- cf93278: The org UI routes gate every contribution by its slot: the slot's `minRole` (`org.settings.section`
  admin and above, `org.page` member and above, conversation and agent slots any member), then its
  scope (a readable conversation; an agent the caller can read in this org). `platform.page` is never
  listed or served through an org route. `GET /orgs/:orgId/ui/contributions` takes `?slot=` and lists
  `slot` and the resolved `after` anchor instead of `place`, ordered by extension name, then manifest
  order. Views, actions and embed tokens take `agentId` for `agent.detail.section`; embed claims carry
  it, and `ctx.ui.verifyEmbedToken` returns null when the current role no longer meets the slot's
  `minRole`. `UiRenderArgs` gains `slot`, `scope` and `agentId`; `EmbedClaims` gains `agentId`.
- Updated dependencies [ec79610]
- Updated dependencies [0a5b15d]
- Updated dependencies [c12e7a7]
- Updated dependencies [17fdfb1]
- Updated dependencies [0e765e2]
- Updated dependencies [adfc0af]
- Updated dependencies [d495d7d]
- Updated dependencies [18defa0]
- Updated dependencies [0a35407]
- Updated dependencies [cf93278]
- Updated dependencies [199f895]
  - @capybara-hq/plugin-sdk@0.1.0-rc.9
  - @capybara-hq/kernel@0.1.0-rc.13
  - @capybara-hq/plugin-tools@0.1.0-rc.10

## 0.1.0-rc.11

### Minor Changes

- e1f6143: Add the `fake-theme` fixture plugin (two themes, a font and a logo, no extension): `FAKE_PLUGINS`,
  `FakePluginName`, and `packFixture` / `fakeExtensionDir` accept it.

### Patch Changes

- Updated dependencies [bbd508e]
- Updated dependencies [00e742e]
- Updated dependencies [b2b3faa]
- Updated dependencies [f120273]
- Updated dependencies [2191e44]
- Updated dependencies [c489ee6]
- Updated dependencies [c1c7b0f]
- Updated dependencies [6d9a256]
- Updated dependencies [ff5e3bf]
- Updated dependencies [00e742e]
- Updated dependencies [0158d0c]
  - @capybara-hq/kernel@0.1.0-rc.11
  - @capybara-hq/plugin-sdk@0.1.0-rc.8
  - @capybara-hq/plugin-tools@0.1.0-rc.9

## 0.1.0-rc.10

### Patch Changes

- 7784331: `startFakeOAuthServer` takes `dialect: "slack"` (answers like Slack's `oauth.v2.user.access`:
  `ok: true`, `token_type: "user"`, every error as HTTP 200 `{ ok: false, error }` with
  `invalid_code` / `invalid_refresh_token` / `invalid_client_id`) and `tokenType`; each
  `tokenRequests` entry records the `error` it answered.
- 3cbf6e8: Kernel-generated IM text speaks the person's language, not the org's: `/new`, `/env`, bind prompts
  and card-click replies use the sender's platform language, else the bound person's latest web
  message language, else the org's; delivered cards and notices use the language recorded on the
  conversation's latest user message (in a group thread, the person who triggered the run).
  `ChannelSendArgs.locale` carries that language to the extension.
- 5ec789c: IM time zone and language per person: channel@1 `InboundSender` gains optional `timeZone` (IANA)
  and `locale` (`zh` / `en` or a BCP 47 tag). The kernel records on an IM `user_message` the
  platform's zone (when valid), else the account setting, else the org default, and the platform's
  language (`zh` / `zh-*` Chinese, any other tag English), else the UI language of the person's most
  recent web message in the org, else the org's `locale`. Any message without a language uses the
  latest web language the same way, and run start falls back to the author's settings for a message
  from an older log. The fake channel's sender profile takes `timeZone` and `locale`.
- d38fcfd: `capybara-plugin pack` (and so `capybara-plugin check`) ships a plugin's setup guide template
  files and refuses a missing, oversized or binary one, a placeholder the guide's place does not
  define (in a file or a step), and a `channel-connection` guide without an extension. The `fake-im`
  test plugin carries a channel setup guide with a file per inbound mode.
- Updated dependencies [6599de8]
- Updated dependencies [2de4f26]
- Updated dependencies [dbea14d]
- Updated dependencies [fa23383]
- Updated dependencies [eb83fb5]
- Updated dependencies [09dea3e]
- Updated dependencies [c85f0b6]
- Updated dependencies [cafa6e4]
- Updated dependencies [c3e12b3]
- Updated dependencies [60ce217]
- Updated dependencies [3cbf6e8]
- Updated dependencies [5ec789c]
- Updated dependencies [ff9cd78]
- Updated dependencies [2435645]
- Updated dependencies [2435645]
- Updated dependencies [2435645]
- Updated dependencies [ebe127f]
- Updated dependencies [48b244e]
- Updated dependencies [f74afee]
- Updated dependencies [d6fd4a9]
- Updated dependencies [d38fcfd]
- Updated dependencies [733a954]
- Updated dependencies [a4ab6e3]
- Updated dependencies [f035baa]
- Updated dependencies [0e8592b]
- Updated dependencies [cb6f42d]
  - @capybara-hq/kernel@0.1.0-rc.10
  - @capybara-hq/plugin-sdk@0.1.0-rc.7
  - @capybara-hq/plugin-tools@0.1.0-rc.8

## 0.1.0-rc.9

### Minor Changes

- e2ac9cc: Add `startFakeTelegram`, a fake Telegram Bot API (long polling, messages, callbacks) with update builders.

### Patch Changes

- Updated dependencies [b98e6d1]
  - @capybara-hq/kernel@0.1.0-rc.8
  - @capybara-hq/plugin-tools@0.1.0-rc.6

## 0.1.0-rc.8

### Minor Changes

- 40c8ee0: Tools are on by default: an agent has every builtin, every tool of the extensions enabled in the
  org and every tool of the org's connectors, and its definition stores only what it turns off
  (`disabledTools`, replacing the enabled `tools` list; migration 0092 rewrites stored agents and
  org-made templates to "nothing turned off"). A newly added builtin reaches existing agents; a
  connector the org sets up is on for every agent; tools that cannot run now are left out quietly.
  The Platform tool's agent operations and `platform.me` use the new shape. `createAgent` in
  `@capybara-hq/testing` takes `disabledTools`; model-fake calls a tool on its own only when a
  request offers exactly one.

### Patch Changes

- Updated dependencies [f31ec88]
- Updated dependencies [fac6134]
- Updated dependencies [58dc1ae]
- Updated dependencies [e0f22ae]
- Updated dependencies [489ef01]
- Updated dependencies [8a016b4]
- Updated dependencies [89b1439]
- Updated dependencies [71858cf]
- Updated dependencies [ca3c570]
- Updated dependencies [40c8ee0]
  - @capybara-hq/plugin-sdk@0.1.0-rc.5
  - @capybara-hq/kernel@0.1.0-rc.7
  - @capybara-hq/plugin-tools@0.1.0-rc.6

## 0.1.0-rc.7

### Minor Changes

- 4a92acb: The model-provider conformance suite runs embedding cases when the target sets `expect.embedding`.

### Patch Changes

- Updated dependencies [4a92acb]
  - @capybara-hq/plugin-sdk@0.1.0-rc.4
  - @capybara-hq/plugin-tools@0.1.0-rc.6
  - @capybara-hq/kernel@0.1.0-rc.6

## 0.1.0-rc.6

### Minor Changes

- 789068d: The fake E2B server builds templates from an image and pauses sandboxes without memory, for the
  `sandbox@2` E2B provider of environments.

### Patch Changes

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
- Updated dependencies [fddab56]
- Updated dependencies [e40774d]
- Updated dependencies [99a00cd]
- Updated dependencies [e0a0d60]
- Updated dependencies [fddab56]
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
- Updated dependencies [6b4da7f]
- Updated dependencies [703c779]
- Updated dependencies [77de995]
- Updated dependencies [11f56fa]
- Updated dependencies [927fad3]
- Updated dependencies [7a1e1ae]
- Updated dependencies [0e38b13]
- Updated dependencies [cfee6f0]
- Updated dependencies [26e8757]
  - @capybara-hq/kernel@0.1.0-rc.5
  - @capybara-hq/plugin-sdk@0.1.0-rc.3
  - @capybara-hq/plugin-tools@0.1.0-rc.5

## 0.1.0-rc.5

### Patch Changes

- 7138d68: The fake git server no longer throws `ERR_HTTP_HEADERS_SENT` (an uncaught exception) when `git http-backend` cannot be spawned: the child's `error` and `close` events no longer both write the 502 head.
- @capybara-hq/plugin-tools@0.1.0-rc.4

## 0.1.0-rc.4

### Minor Changes

- 3455513: Kernel: an org chooses the default provider of an `org-default` extension point (`web-search`,
  `web-fetch`): table `org_extension_point_defaults` (migration 0073), `ExtensionPointDefaults`
  (`resolve`, `list`, `setDefault`) and the routes `GET /api/v1/orgs/:orgId/extension-points`,
  `PUT …/extension-points/:point/default` and `GET …/extension-points/available`. Testing: the fake
  extensions `fake-web` and `fake-web-2` (scripted `web-search@1` / `web-fetch@1` providers).
  
  Kernel: the `web.*` config section (`web.search.maxResults`, `web.fetch.maxPageChars`,
  `web.fetch.maxAnswerTokens`, `web.fetch.cacheSeconds`, `web.fetch.timeoutMs`, all hot), `BuiltinTool.unavailable` may be
  async and receives `{ orgId }`, and builtin tools get `parentRunId` in their call context.
  
  Kernel: `WebSearch` and `WebFetch` are builtin tool names (`BUILTIN`, `WEB_TOOL_NAMES`) with the
  display kinds `search` / `read`; the Claude Code tool-name map lists both as same-name tools
  (new snapshots only) and Claude agent import maps `WebFetch` / `WebSearch` to them.
  
  Kernel: the builtin `WebSearch` tool (default `ask`, read-only, open-world): searches with the
  org's default `web-search@1` provider, filters the results again (absolute http(s) URLs, titled,
  unique, within `allowed_domains` / `blocked_domains` (IDN entries matched in punycode), at most
  `web.search.maxResults`) and heads
  every result with `Search date: YYYY-MM-DD (UTC).`; provider errors map to fixed texts. Calls to
  `web-search@1` and `web-fetch@1` providers are counted in flight and drained on disable / upgrade.
  
  Kernel: the builtin `WebFetch` tool (default `ask`, read-only, open-world): checks the URL
  (absolute https after upgrading `http`, no credentials, at most 2000 characters after
  normalization, a public host, also for the provider's final URL), fetches the page with the org's default `web-fetch@1`
  provider through a Redis page cache (`cache:web_page:<orgId>:<provider>:<sha256(url)>`, TTL
  `web.fetch.cacheSeconds`), returns the new URL for a redirect to another host (apex ↔ www is the
  same host), cuts pages to `web.fetch.maxPageChars` with a `[truncated]` marker, and runs under its
  own time limit `web.fetch.timeoutMs` (default 180 s) instead of `tools.timeoutMs`.
  
  Kernel: `WebFetch` answers the prompt from the page with one call on the new kernel model purpose
  `web_fetch` (label "Web page extraction"; unmapped, the calling conversation's model, a
  sub-agent's for a sub-agent's call): a fixed system prompt (`WEB_FETCH_SYSTEM_PROMPT`, plus the
  call's random page tag the page sits between, `webFetchSystemPrompt`), no tools, output capped at
  `web.fetch.maxAnswerTokens`; the page is cut with `[truncated]` to fit the target model's context
  window, read with the new `ModelPurposesService.chatLimits`. The result is the answer headed by the URL, never the
  page; a failure is a tool error and a `model.request` policy denial is the tool error "An org
  policy blocked reading this page; continue without it or ask the user." with its `hook.denied`
  audit row and `hook_denied` event. The call fires `model.request` / `model.response` with
  `purpose: "web_fetch"` and logs a `usage` event with `purpose: "web_fetch"` and the call's
  `callId` (reported through `usage.report`, counted on a sub-agent's parent run). `StepLog` has a
  module of its own (`StepLogModule`) and builtin tools get the run's hook scope in their call
  context.

### Patch Changes

- 00f36e5: `FakeChannelServer.failNext` takes an optional `chatId`: only requests to that chat count and
  fail, so a late delivery to another chat cannot take a failure meant for the request under test.
- 0ccc26e: `FakeChannelServer.failNext` takes a match object as its last argument: `{ chatId, textIncludes }`
  fails only requests to that chat whose message text contains the string. A string still means a
  chat id.
- b3312ae: Add the fake extension `fake-config-form` (display name 表单样例 / Form sample): an
  openai-compatible-shaped deployment config carrying config form hints, for config form tests.
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
- Updated dependencies [f015dff]
- Updated dependencies [3455513]
- Updated dependencies [81adaff]
- Updated dependencies [517ca1e]
- Updated dependencies [4ef89b8]
- Updated dependencies [c01c117]
- Updated dependencies [f28ed05]
- Updated dependencies [2bd8351]
- Updated dependencies [c9c8625]
- Updated dependencies [8f7ba64]
- Updated dependencies [8892d50]
  - @capybara-hq/kernel@0.1.0-rc.4
  - @capybara-hq/plugin-tools@0.1.0-rc.4
  - @capybara-hq/plugin-sdk@0.1.0-rc.2

## 0.1.0-rc.3

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
  - @capybara-hq/plugin-tools@0.1.0-rc.2

## 0.1.0-rc.2

### Patch Changes

- e69c9d6: The bootstrap step obtains its packages itself: once it is not done for the manifest, under the
  advisory lock and before writing anything, each pinned plugin comes from a `*.tgz` of the offline
  directory whose sha512 matches (any file name), else from `packages.npmRegistry`, verified against
  the pin (new error `bootstrap.download_failed`, 502). A done run reads no directory and no network.
  New config key `bootstrap.dir` (`CAPYBARA_BOOTSTRAP__DIR`, default `bootstrap`). `createKernel`
  takes `bootstrap: { dir? }` instead of `bootstrapDir`, and the dual-replica harness's
  `bootstrap.dir` is optional.
- Updated dependencies [75d7a0c]
- Updated dependencies [e69c9d6]
- Updated dependencies [6ad094b]
  - @capybara-hq/kernel@0.1.0-rc.1
  - @capybara-hq/plugin-tools@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- 1a22b92: `createDualReplicaHarness` works when `@capybara-hq/testing` is installed from npm: when an
  extension entry is a TypeScript file (the plugin under test by path, `fakeExtensionEntry(...)`),
  each replica runs under tsx, now a dependency of this package and resolved from it, so the
  plugin's `./x.js` imports map to `.ts` and the fake extensions under `node_modules` load. A plugin
  repository no longer needs `NODE_OPTIONS: "--import tsx"`; the plugin-tools README says so.
- Updated dependencies [1a22b92]
  - @capybara-hq/plugin-tools@0.1.0-rc.1
