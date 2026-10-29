---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
---

The kernel is being refactored into a standard NestJS application: shared infra modules (config,
logging, database with `@Transactional`, Redis) come first, with no change in behaviour.

The kernel is now built as one Nest application (`createKernelApp` / `startKernelApp`) whose
lifecycle owns the start order and the stop phases; `createKernel` remains as a facade over it.

Queue and schedule infra: BullMQ root configuration (`QueueModule`, `runJob`, `logJobFailure`), the cron
scheduler and `@LockedCron` (a try-once cross-replica lock around `@Cron`); lock renewal loss is now
reported before expiry.

Redis-backed rate limiting infra: `@nestjs/throttler` with a shared Redis storage (fail-open) and the
kernel's credential limits as named throttlers, applied per route with `@Throttled`.

Health is terminus-based (`HealthModule`, `/healthz` and `/readyz` with unchanged bodies, status
codes and replica header); readiness reads a `ShutdownState` the shutdown service will provide.

Zod DTOs: `createZodDto`, `@ZBody` / `@ZQuery` / `@ZParam` and a global validation pipe with the same
`validation_failed` error as `ZodPipe`; new `http.swagger` (default false) serves the OpenAPI document
at `/docs`.

Graceful shutdown: `GracefulShutdown` is the one shutdown state (readiness, the start abort, the 30 s
stop deadline that the stop phases and the Redis / pool closes now share, `trackInFlight` / `drain`);
event streams close when the shutdown begins and later ones end at once; the main Redis connection
closes with QUIT again. `startKernelApp` handles SIGTERM / SIGINT from before the start (a signal
during the start aborts it; a second signal exits at once). `capybara start` installs process
guards: unhandled rejections and uncaught exceptions are logged, more than 5 within 60 s exit.

The legacy service graph consumes the infra providers (one pool, Redis connection, bus and config
holder).

Breaking export rename: the `KernelDb` type (the `capybara` schema view, a `Kysely<KernelDatabase>`)
is now `KernelSchemaDb` in `@capybara-hq/kernel` and `@capybara-hq/testing`; `KernelDb` now names the
injectable, context-aware database handle class.

Storage, models and skills are Nest modules: `StorageService`, `PricesService`,
`ModelPurposesService`, `SkillsService`, `SkillChangesService` and one `SkillInvoker` are injectable
providers. Export change: the prefixing logic is the plain class `PrefixedStorage` (over a
`StorageSource`, formerly `StorageServiceDeps`), which `StorageService` extends; an extension's
`ctx.storage` and the CLI build a `PrefixedStorage`. The `storage-org-purge` job is an hourly
`@LockedCron` (same name); its old maintenance scheduler is removed when a worker starts.

Breaking export change: `ExtensionHost`'s third constructor argument now requires `registry` (an
`ExtensionRegistry`, the shared provider the host writes and other services read extension points
from); code that builds a host by hand passes `registry: new ExtensionRegistry()`.

`@Transactional` / `TransactionHost.run` accept `propagation: "mandatory"` (join the transaction in
context, throw outside one) for methods that rely on a lock their caller holds.

Identity, orgs and admin are Nest modules (`IdentityModule`, `OrgsModule`, `AdminModule`):
`AccountsService`, one `SessionService`, `ApiTokenService`, one `SettingsService`,
`ExternalIdentities`, `IdentityBinding`, `SsoFlow`, `OrgsService`, `OrgSettingsService`,
`MembersService`, `InvitationsService`, `SetupService`, `Offboarding` and `DirectorySync` are
injectable providers; their constructors take the kernel's providers (export change). The org row
lock and the enterprise admin lock are the providers `OrgLock` and `EnterpriseAdminLock`
(`propagation: "mandatory"`: they join the caller's transaction); transaction-scoped advisory locks
go through the infra `XactLock`. Export changes: `SetupService.createEnterpriseAdmin` /
`createEnterpriseAdminIfNone` moved to `AccountsService`; `LoginRateLimiter` is removed;
`standaloneDatabase(pool, log)` gives the database handles to code that runs outside the kernel
application (the CLI's `admin create` / `admin grant`, `@capybara-hq/testing`'s
`createLocalAccount`, whose signature is unchanged). The `directory-scan` and `offboard-sweep` jobs
are `@LockedCron` jobs (hourly at the top of the hour, every 10 minutes); their old maintenance
schedulers are removed when a worker starts. The credential routes (login, change password, setup
token, invitation accept) are limited by `CredentialThrottler` with the same limits, codes, bodies
and `retry-after`; their counters move to new Redis keys (`throttler:{cred:<group>}:…` instead of
`capk:login-fail:*` / `capk:rl:*`), so the counts reset once at deploy.

Directory sync: its per-(org, extension) run lock moved from `capk:directory-sync:<org>:<plugin>`
to the `LockService` key `lock:directory-sync:<org>:<plugin>`; during a rolling deploy an old and a
new replica may each run one sync of the same pair once (harmless: the dirty flag and idempotent
writes cover it). The hourly `directory-scan` now fires at the top of each hour. The lock
providers `SetupLock` and `ExternalIdentityLock` own the setup and external identity locks;
`Offboarding.afterCommit` is renamed `afterOffboard` (callers register it with the infra
`afterCommit`), and `standaloneDatabase` also returns `adminLock` / `setupLock`.

The extensions are a Nest module (`ExtensionsModule`): `ExtensionHost`, `ReplicaStatusStore`,
`ExtensionApprovals`, `ExtensionBlobs`, `ExtensionInstalls`, `ExtensionAdmin`, `ExtensionAdminOps`,
`ExtensionLifecycle`, `ExtensionDeploymentConfigService`, `OrgExtensionConfigs` and
`BootstrapService` are injectable providers; the host builds each extension's `ctx` from the
injected kernel services and reads its time limits and `extensionConfig` from the config (no SDK
or `ctx` change). Export changes: their constructors take the kernel's providers;
`ExtensionAdminOpsDeps`, `BootstrapServiceDeps`, `ExtensionLifecycleDeps` and `LifecycleHost` are
removed; `BootstrapService.run` takes the plugin import it uses (`imports`); `rewrapDataKeys` takes
the database handles (`{ db, txHost }`, e.g. from `standaloneDatabase`); `ExtensionCli` exposes the
command's application context (`app`) and `bootstrap` instead of `db` / `adminLock`.
`OrgExtensionConfigs.enabledDependents` / `disableIn` join the caller's transaction (no `trx`
argument) and `inTransaction` receives only `skipped`. The bootstrap step runs under the Redis lock
`lock:bootstrap` (`LockService`, 120 s TTL with renewal) instead of a PostgreSQL advisory lock, in
the kernel and in `capybara bootstrap` alike: **`capybara bootstrap` (compose `init`, a Kubernetes
init Job) now needs Redis**; the compose `init` service waits for valkey. During a rolling deploy an
old replica (advisory lock) and a new one (Redis lock) do not exclude each other; the step is
recorded once per manifest and its writes are idempotent. The `capybara extensions *`, `plugins *`
and `bootstrap` commands run on a Nest application context (`KernelCliModule`). The
`plugins-reconcile` job is a `@LockedInterval` (a new infra decorator for config-driven periods;
every `extensionHost.reconcileIntervalSeconds`, once per tick across replicas); its old maintenance
scheduler is removed when a worker starts. `LockService.acquire` accepts `signal` and an unbounded
`waitMs`. `ctx.lock` and the permission-denial / hook warn-once markers use the `LockService`
primitives (same keys).

The catalog is a Nest module (`CatalogModule`, with `CatalogImportModule` for the CLI):
`CatalogRequestsService`, `MarketplacesService`, `PluginImport`, `CatalogService`,
`PluginInstaller`, `PluginUpgrader` and `OrgCatalogService` are injectable providers. Export
changes: their constructors take the kernel's providers (`CatalogServiceDeps`,
`MarketplacesServiceDeps`, `PluginImportDeps`, `PluginInstallerDeps` and `OrgCatalogDeps` are
removed); `CatalogRequestsService.requestDeployment` / `resolveByInstall` and the installer's
`*In` methods join the caller's transaction (no `trx` argument); the item and version helpers moved
to `catalog/catalog-items.ts` and the version content readers to `catalog/catalog-content.ts`. Org
installs, upgrades and their rollbacks keep one transaction per step (each committed on its own,
the undo on failure relies on it). The catalog's advisory locks are lock providers
(`CatalogSourceLock`, `CatalogItemLock`; the extensions' `PluginInstallLock` /
`PluginApproveLock`), same keys. `catalogs-refresh` is a `@LockedInterval` (every
`marketplaces.refreshIntervalMinutes`) with the new `runOnStart` option: as the old scheduler's
first run did, it also runs once right after the start (once across replicas starting within a
minute of each other; a later restart runs it again). `app-staging-cleanup` is an hourly
`@LockedCron`; its first run moved from the scheduler's creation to the next top of the hour
(harmless: staging lives 24 hours). Their old maintenance schedulers are removed when a worker
starts. `LockedIntervalScheduler.periodOf(name)` returns a job's scheduled period. The
notifications after an org extension config write and after an extension install / state change
/ uninstall (and an org plugin uninstall's `afterDisable`) run as `afterCommit` hooks: a failing
hook is logged and no longer turns the committed request into a 500. The CLI's
Redis connection keeps reconnecting (a `capybara bootstrap` holding `lock:bootstrap` survives a
Redis blip), and a lost `LockService` lock aborts with `lock lost: <key>`.

Scheduled jobs stop cleanly: `ScheduledRuns` (new, `KernelScheduleModule`) tracks every
`@LockedCron` / `@LockedInterval` run (ticks and `runOnStart` runs). At shutdown the kernel stops
the timers, aborts the stop signal a job method receives as its argument, starts no new run and
waits for the runs in progress (bounded by the shared stop deadline, before the extension host,
Redis and the pool close), so a stop no longer logs "cron job failed" / a failed lock release and
leaves no run lock behind until its TTL. Failures caused by the stop are logged at WARN / INFO.

Tools and connectors are a Nest module (`ToolsModule`): `Credentials`, `ToolOutputs`,
`BuiltinTools` (the builtin tools, built once; their names, descriptions and schemas unchanged),
`ToolRegistry`, `ApprovalsService`, `QuestionsService`, `ToolDrift`, `Breaker`,
`ConnectorContent`, `ToolPipeline`, `ConnectorsService` and `OAuthFlow` are injectable providers.
Export changes: their constructors take the kernel's providers (`ApprovalsServiceDeps`,
`QuestionsServiceDeps`, `ToolDriftDeps`, `ConnectorContentDeps`, `ToolPipelineDeps`,
`ToolRegistryDeps`, `OAuthFlowDeps` and `CredentialsOAuthDeps` are removed; a hand-built pipeline
takes its test seams through `TOOL_PIPELINE_TEST_HOOKS`); the builtin tool factories take a config
holder (`{ get() }`) instead of a getter; the trx-taking methods join the caller's transaction (no
`trx` argument: `Credentials.setStatic` / `setOAuthClient` / `setOAuthTokens` / `clear` /
`clearConnector` / `clearAccount` / `status`, `ApprovalsService` / `QuestionsService`
`cancelPendingIn` / `cancelPendingFor`, `ToolDrift.apply`, `ToolPipeline.stopOpenAgentCalls`,
`ConnectorsService.applyTemplateIn` / `removeIn`); the OAuth paths moved to
`tools/oauth/flow-paths.ts` (re-exported by `flow.ts`); `deleteExpiredOutputs` moved to
`tools/outputs.ts`. A decided approval and an answered question are the in-process domain events
`approval.decided` / `question.answered` (`KernelEvents`), which resume the waiting run as before
(on the deciding replica; the wait sweep still resumes a run whose resume was lost). The
`drift-scan` job is a `@LockedInterval` (every `tools.driftIntervalHours`, and once right after the
start, as the old scheduler's first run; a repeated scan in a period enqueues nothing new) and
`output-cleanup` an hourly `@LockedCron` (its first run moved to the next top of the hour); their
old maintenance schedulers are removed when a worker starts. One-off `drift-connector` jobs keep
their names and job ids. The OAuth refresh lock uses the `LockService` lease primitives (same key).

Conversations and agents are Nest modules (`ConversationsModule`, `AgentsModule`, with the small
`EventLogModule`, `ConversationAccessModule`, `AttachmentsModule` and `AgentLookupModule` the
skills and tools import): `EventLog`, `ConversationAccess`, `AttachmentsService`,
`ConversationsService` (one instance: the API's, IM inbound's and the attachments' were three),
`ConversationQueue` (now in `conversations/queue.service.ts`), `ConversationOutputs`,
`ConversationArtifacts`, `ConversationFiles`, `ConversationSandboxStatus`, `AgentsService` (one
instance), `AgentLookup` (the viewer reads of agents), `AgentTemplatesService`, `TrajectoryService`,
`ConversationLock` and `ConversationStreams` are injectable providers. Export changes: their
constructors take the kernel's providers (`AttachmentsDeps`, `ConversationQueueDeps`,
`ConversationFilesDeps`, `ConversationArtifactsDeps`, `ConversationOutputsDeps`,
`ConversationSandboxStatusDeps`, `ResolveAttachments` and `BindFiles` are removed);
`EventLog.append(conversationId, events)` always appends in its own transaction and publishes after
the commit, and `EventLog.appendIn(conversationId, events)` appends in the caller's transaction
(it must hold one; the caller notifies after the commit), replacing the optional `trx` argument;
`AttachmentsService.bindForMessage` / `consumeSkillPackage` and `ConversationsService.bindIn` join
the caller's transaction (no `trx` argument); `ConversationsService.checkFilesSupported` is gone
(files are always supported); `paramIssues` and `SUBAGENT_ROSTER_MAX` moved to
`agents/definition.ts` and `visibleTo` / `isAgentVisibleTo` / `AGENT_VISIBILITIES` to
`agents/agent-lookup.ts` (all still re-exported by `agents.service.ts`). The event log's advance is
announced in-process as `conversation.event-appended` (`KernelEvents`), from which the channel
outbound delivery is enqueued, on the same replica, right after the bus publish, as the old direct
hook did. The conversation run lock is a lease of `LockService` (`LockService.hold`: same key
`capk:conv-run:<id>`, the run id as its value, renewed every TTL/3); a renewal that keeps failing
until the key would expire now marks the lease lost (handled as when another holder took the key)
instead of renewing on. The channel delivery lock is the same lease under its own prefix. The
hourly `attachment-cleanup` is a `@LockedCron` (its first run moved to the next top of the hour);
its old maintenance scheduler is removed when a worker starts.

The run runtime is a Nest module too (Task 3.6b). `ProviderRegistry`, `RunAbort`,
`KyselyCheckpointSaver`, `RunQueue`, `Waits`, `RunWorker`, `UsageReporter`, `TitleQueue` and the new
`RunFinish`, `StepLog`, `RunControl`, `RunJobs`, `RunSteps`, `AgentLoops`, `TitleGenerator` and
`SubagentsService` are injectable providers (their constructors take injected services, no deps
objects); `OrgQuota` is provided once per key prefix (`RUN_QUOTA`, `EVAL_QUOTA`) and keeps a slot
through `OrgQuota.enter` (a `LockService` lease handle, renewed every lease/3). The run queues,
`cap-kernel-usage-report` and `cap-kernel-titles` are consumed by `@Processor` workers whose options
come from the startup config (unchanged: `runtime.workerConcurrency`, `jobLockMs`,
`stalledIntervalMs`, `hooks.usageReportConcurrency`), built and started on the worker role only,
after the extensions loaded; queue names, job ids and job options are unchanged. At shutdown every
BullMQ queue and worker closes within what is left of the stop budget; one that cannot (Redis
down) is abandoned instead of holding the application's close. `wait-sweep` (every 10
minutes) and `usage-report-sweep` (every minute) are `@LockedCron` jobs; their old maintenance
schedulers are removed when a worker starts. `finishRun` / `finishRunIn` became
`RunFinish.finish` / `finishIn`, `onChildFinished` / `stopChildren` became `Waits.childFinished` /
`stopChildren`, `runTitleJob` takes the generator's writes, `recordHookDenial` and the model step's
deps take a `stepLog`, step deps and the sub-agent limits read a `KernelConfigService`-like
`config` (`get()`), and `pairStoppedForks` takes the context's handle. `KernelOptions` lost `loop`
and `runHooks`: tests override `AGENT_LOOP_FACTORY` / `RUN_HOOKS` through `overrides`. The model
list cache moved to `@Cacheable` (`cache:capk:models:…`; the old keys expire by TTL); it now
fails open: a Redis error lists the provider's models again, where it used to throw. A lost
conversation lease logs one `lock lost` line (with its key); conversation writes the caller notifies
after run in their own transaction.

Channels are a Nest module (Task 3.7, `ChannelsModule` with `ChannelRolesModule` for the role
parts): `ChannelConnections`, `ChannelInbound`, `ChannelOutbound`, `ChannelWebhooks`,
`ChannelSupervisor` and the new `ChannelJobs` (the producer of `cap-kernel-channels`: delivery and
inbound jobs, `resumeConnection`), `AnonymousGuests` / `AnonymousGuestLock` and `GatewayCheckJob`
are injectable providers. Export changes: their constructors take the kernel's providers
(`ChannelConnectionsDeps`, `ChannelInboundDeps`, `ChannelOutboundDeps`, `ChannelSupervisorDeps`,
`ChannelWebhooksDeps`, `DirectorySyncScheduler`, `ChannelOutboundScheduler` and
`ChannelInboundQueue` are removed; `ChannelWebhooks.handleTimeoutMs` / `runtimeCacheMs` and
`ChannelSupervisor.onScan` are fields); `enqueue` / `enqueueInbound` / `resumeConnection` moved from
`ChannelOutbound` to `ChannelJobs`; `ensureAnonymousGuest(db, orgId)` became
`AnonymousGuests.ensure(orgId)`; `checkGatewayPresence` takes `locks` and a config holder
(`{ get() }`); `ApiDeps.channels` is gone (the API injects `ChannelConnections`). The channel queue
is consumed by a `@Processor` worker on the worker role (concurrency, job lock, stalled detection
and the delivery backoff unchanged); the supervisor and the webhook inbound exist on the gateway
role only and still start after the extensions loaded. Queue name, job ids and options, Redis keys
and lease names are unchanged. A channel long-connection lease is a `LockService` lease (same key
`capk:channel-lease:<id>`, renewed every TTL/3 and once per heartbeat round); a renewal that keeps
failing until the key would expire marks it lost and drops the connection, as before, now with one
`lock lost` line instead of `channel lease lost; disconnecting`. The inbound dedupe and the
no-gateway warning markers use the `LockService` lease primitives (same keys). `channel-gateway-check`
is a `@LockedCron` (every minute, once across replicas; its old maintenance scheduler is removed when
a worker starts).

`LockService` lease loss is a deadline (R19): a holder gives up at the send time of its last
confirmed renewal (or of the acquire) + TTL − TTL/3 unless another renewal succeeds first, even
with a renewal still in flight, so it lets go one renewal period before the key can expire and be
taken elsewhere. This applies to every lock and lease (the conversation run lease, the org quota
slots, the channel long-connection leases); after a Redis blip longer than about two thirds of the
TTL a holder now gives up earlier than before (a run is re-queued, a long connection reconnects),
never later. A channel lease lost while its connection's config is read is no longer connected on.

The sandbox is a Nest module (Task 3.8, `SandboxModule`): `SandboxService`, `SandboxLeases`, the new
`SandboxProviders` (the `sandbox@1` provider from the extension registry), `SandboxJobs` (the
producer of `sandbox-destroy-for`) and `SandboxSweepJobs` are injectable providers. Export changes:
`SandboxServiceDeps` is removed (the constructor takes the kernel's providers; `SandboxLeases`'
`ttlMs` / `pollMs` / `pathTtlMs` are fields); `SANDBOX_SUSPEND_JOB` / `SANDBOX_DESTROY_JOB` are
exported from `sandbox/jobs.ts` (was `sandbox/lifecycle.ts`); `scheduleSandboxDestroy` and
`registerSandboxMaintenance` became `SandboxJobs.destroy` and `runSandboxDestroyFor`;
`Maintenance.schedule` is removed (no periodic maintenance job is left). `LockService` gains shared
leases (`tryShared` / `tryExclusive` / `sharedCount`, a `SharedLeaseHandle` with `downgrade`) and
the sandbox leases are built on them: same Redis keys and scripts, holder records, path leases,
fencing generation, `sandbox.maxConcurrentCommands` and `sandbox.lockWaitSeconds`. A held sandbox
or path lease is lost at the R19 deadline (a path lease whose renewals keep failing is now lost
too), with one `lock lost` line instead of `sandbox lease lost` / `sandbox path lease lost`.
`sandbox-suspend-idle` (every minute) and `sandbox-destroy-inactive` (hourly) are `@LockedCron`
jobs (once per tick across replicas, on every role until Task 4.1); their old maintenance
schedulers are removed when a worker starts. `sandbox-destroy-for` jobs now have a deterministic id
per batch, so a batch enqueued twice while queued is one job.
