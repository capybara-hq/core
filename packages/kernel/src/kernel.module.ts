import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { type DynamicModule, Global, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { AgentsModule } from "./agents/agents.module.js";
import type { KernelAppOptions } from "./app.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { ChannelRolesModule } from "./channels/channels.module.js";
import type { KernelConfig } from "./config/schema.js";
import { AttachmentsService } from "./conversations/attachments.service.js";
import { ConversationsModule } from "./conversations/conversations.module.js";
import { ConversationsService } from "./conversations/conversations.service.js";
import { EventLog } from "./conversations/event-log.js";
import { ExtensionsModule } from "./extensions/extensions.module.js";
import { ExtensionHost } from "./extensions/host.js";
import { OrgExtensionConfigs } from "./extensions/org-config.js";
import { ExtensionRegistry } from "./extensions/registry.js";
import { ReplicaStatusStore } from "./extensions/sources.js";
import { API_DEPS, ApiModule } from "./http/api.module.js";
import { ErrorFilter } from "./http/error.filter.js";
import { IdentityBinding } from "./identity/binding.js";
import { ExternalIdentities } from "./identity/external.js";
import { IdentityModule } from "./identity/identity.module.js";
import { SettingsService } from "./identity/settings.js";
import { CacheModule } from "./infra/cache/cache.module.js";
import { ConfigModule } from "./infra/config/config.module.js";
import { KernelConfigService } from "./infra/config/kernel-config.service.js";
import { DatabaseModule } from "./infra/database/database.module.js";
import { KernelDb } from "./infra/database/kernel-db.js";
import { TransactionHost } from "./infra/database/transaction-host.js";
import { KernelEvents, KernelEventsModule } from "./infra/events/kernel-events.js";
import { HealthController } from "./infra/health/health.controller.js";
import { HealthModule } from "./infra/health/health.module.js";
import { databaseCheck, HEALTH_CHECKS, redisCheck } from "./infra/health/health.options.js";
import { GracefulShutdownModule } from "./infra/lifecycle/graceful-shutdown.module.js";
import { LockModule } from "./infra/lock/lock.module.js";
import { LoggingModule } from "./infra/logging/logging.module.js";
import { QueueModule } from "./infra/queue/queue.module.js";
import { RedisModule } from "./infra/redis/redis.module.js";
import { KernelScheduleModule } from "./infra/schedule/schedule.module.js";
import { KernelThrottlerModule } from "./infra/throttler/throttler.module.js";
import { KERNEL_BUS, KERNEL_LOGGER, KERNEL_POOL, REDIS } from "./infra/tokens.js";
import { ValidationModule } from "./infra/validation/validation.module.js";
import { createLegacyGraph, type KernelTestHooks, type LegacyGraph } from "./kernel.js";
import { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
import { KERNEL_APP_OPTIONS, KERNEL_TEST_HOOKS, LEGACY_GRAPH } from "./lifecycle/tokens.js";
import type { KernelLogger } from "./log.js";
import { createConfiguredLogger } from "./log-config.js";
import { ModelsModule } from "./models/models.module.js";
import { PricesService } from "./models/prices.js";
import { ModelPurposesService } from "./models/purposes.js";
import { DirectorySync } from "./orgs/directory-sync.js";
import { OrgLock } from "./orgs/org-lock.js";
import { OrgsModule } from "./orgs/orgs.module.js";
import { KyselyCheckpointSaver } from "./runtime/checkpointer.js";
import { ConversationLock } from "./runtime/conversation-lock.js";
import { ProviderRegistry } from "./runtime/providers.js";
import { EVAL_QUOTA, type OrgQuota } from "./runtime/quota.js";
import { RunFinish } from "./runtime/run-finish.js";
import { RuntimeWorkersModule } from "./runtime/run-processors.js";
import { AgentLoops, RunSteps } from "./runtime/run-steps.js";
import { RuntimeModule } from "./runtime/runtime.module.js";
import { Waits } from "./runtime/waits.js";
import { SandboxModule } from "./sandbox/sandbox.module.js";
import { SandboxService } from "./sandbox/sandbox.service.js";
import { SkillsCatalogService } from "./skills/catalog.js";
import { SkillChangesService } from "./skills/changes.service.js";
import { SkillInvoker } from "./skills/invoke.js";
import { SkillsModule } from "./skills/skills.module.js";
import { SkillsService } from "./skills/skills.service.js";
import { StorageModule } from "./storage/storage.module.js";
import { StorageService } from "./storage/storage.service.js";
import { ApprovalsService } from "./tools/approvals.service.js";
import { ToolDrift } from "./tools/drift.js";
import { ToolPipeline } from "./tools/pipeline.js";
import { QuestionsService } from "./tools/questions.service.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolsModule } from "./tools/tools.module.js";

/**
 * Global: the legacy service graph (`LEGACY_GRAPH`, one factory provider over the infra modules)
 * with its inputs. Domains leave it one directory at a time (Phase 3): a converted domain's module
 * is imported here and its providers are injected into the factory (`ConvertedProviders`). The
 * application's `overrides` are registered here, after
 * the defaults, so they win.
 */
@Global()
@Module({})
class LegacyGraphModule {
  static forRoot(options: KernelAppOptions): DynamicModule {
    const overridden = (options.overrides ?? []).map((o) => o.provide as symbol);
    return {
      module: LegacyGraphModule,
      global: true,
      imports: [
        ExtensionsModule,
        StorageModule,
        ModelsModule,
        SkillsModule,
        IdentityModule,
        OrgsModule,
        ToolsModule,
        AgentsModule,
        ConversationsModule,
        RuntimeModule,
        SandboxModule,
      ],
      providers: [
        { provide: KERNEL_APP_OPTIONS, useValue: options },
        { provide: KERNEL_TEST_HOOKS, useValue: {} satisfies KernelTestHooks },
        {
          provide: LEGACY_GRAPH,
          inject: [
            KernelConfigService,
            KERNEL_LOGGER,
            KernelDb,
            KERNEL_BUS,
            KERNEL_TEST_HOOKS,
            TransactionHost,
            ExtensionRegistry,
            StorageService,
            PricesService,
            ModelPurposesService,
            SkillsService,
            SkillChangesService,
            SkillsCatalogService,
            SkillInvoker,
            SettingsService,
            ExternalIdentities,
            IdentityBinding,
            DirectorySync,
            OrgLock,
            KernelEvents,
            ExtensionHost,
            ReplicaStatusStore,
            OrgExtensionConfigs,
            ToolRegistry,
            ApprovalsService,
            QuestionsService,
            ToolDrift,
            ToolPipeline,
            EventLog,
            ConversationLock,
            AttachmentsService,
            ConversationsService,
            ProviderRegistry,
            Waits,
            RunFinish,
            KyselyCheckpointSaver,
            RunSteps,
            AgentLoops,
            EVAL_QUOTA,
            SandboxService,
          ],
          useFactory: (
            config: KernelConfigService,
            log: KernelLogger,
            kdb: KernelDb,
            bus: ExtensionContext["bus"],
            hooks: KernelTestHooks,
            txHost: TransactionHost,
            extensionRegistry: ExtensionRegistry,
            storage: StorageService,
            prices: PricesService,
            purposes: ModelPurposesService,
            skills: SkillsService,
            skillChanges: SkillChangesService,
            skillsCatalog: SkillsCatalogService,
            skillInvoker: SkillInvoker,
            settings: SettingsService,
            external: ExternalIdentities,
            binding: IdentityBinding,
            directory: DirectorySync,
            orgLock: OrgLock,
            events: KernelEvents,
            host: ExtensionHost,
            replicaStatus: ReplicaStatusStore,
            orgExtensionConfigs: OrgExtensionConfigs,
            toolRegistry: ToolRegistry,
            approvals: ApprovalsService,
            questions: QuestionsService,
            toolDrift: ToolDrift,
            toolPipeline: ToolPipeline,
            eventLog: EventLog,
            conversationLock: ConversationLock,
            attachments: AttachmentsService,
            conversations: ConversationsService,
            registry: ProviderRegistry,
            waits: Waits,
            runFinish: RunFinish,
            checkpoints: KyselyCheckpointSaver,
            steps: RunSteps,
            loops: AgentLoops,
            evalQuota: OrgQuota,
            sandbox: SandboxService,
          ): LegacyGraph =>
            createLegacyGraph(config, log, kdb, bus, hooks, {
              txHost,
              extensionRegistry,
              storage,
              prices,
              purposes,
              skills,
              skillChanges,
              skillsCatalog,
              skillInvoker,
              settings,
              external,
              binding,
              directory,
              orgLock,
              events,
              host,
              replicaStatus,
              orgExtensionConfigs,
              toolRegistry,
              approvals,
              questions,
              toolDrift,
              toolPipeline,
              eventLog,
              conversationLock,
              attachments,
              conversations,
              registry,
              waits,
              runFinish,
              checkpoints,
              steps,
              loops,
              evalQuota,
              sandbox,
            }),
        },
        ...(options.overrides ?? []).map((o) => ({
          provide: o.provide as symbol,
          useValue: o.useValue,
        })),
      ],
      // the overrides are exported too: a converted module's optional provider (e.g. the run
      // loop factory, `AGENT_LOOP_FACTORY`) resolves to them through this global module
      exports: [LEGACY_GRAPH, KERNEL_APP_OPTIONS, KERNEL_TEST_HOOKS, ...overridden],
    };
  }
}

/**
 * The kernel application's root module (nest kernel spec §2): the global infra (config, logging,
 * the shutdown state, database, Redis), the legacy service graph, the API when the roles include `api`, the health
 * endpoints and the global error filter on every role, and {@link KernelLifecycle}, which owns the
 * start order and the stop phases. `KernelLifecycle` sits in the root module on purpose: Nest runs
 * shutdown hooks from the root outwards, so its stop phases finish before the global infra closes
 * Redis and the pool.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class KernelModule {
  static forRoot(config: KernelConfig, options: KernelAppOptions = {}): DynamicModule {
    const logger = options.logger ?? createConfiguredLogger(config);
    return {
      module: KernelModule,
      imports: [
        LoggingModule.forRoot(config, { logger }),
        ConfigModule.forRoot(config, options.env !== undefined ? { env: options.env } : {}),
        GracefulShutdownModule,
        DatabaseModule,
        RedisModule,
        LockModule,
        CacheModule,
        KernelEventsModule,
        QueueModule.forRoot(),
        KernelScheduleModule,
        KernelThrottlerModule,
        HealthModule,
        ValidationModule,
        LegacyGraphModule.forRoot({ ...options, logger }),
        // KernelLifecycle's setup check, the extension host it drives and the catalog it syncs
        IdentityModule,
        ExtensionsModule,
        CatalogModule,
        // the run worker, usage.report and title consumers (started on the worker role)
        RuntimeWorkersModule.forRoot(config),
        // channels; the channel queue's consumer (worker role), the long-connection supervisor and
        // the webhook inbound (gateway role)
        ChannelRolesModule.forRoot(config),
        ...(config.roles.includes("api")
          ? [
              ApiModule.registerFrom({
                provide: API_DEPS,
                inject: [LEGACY_GRAPH],
                useFactory: (g: LegacyGraph) => g.apiDeps,
              }),
            ]
          : []),
      ],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_CHECKS,
          inject: [KERNEL_POOL, REDIS],
          // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
          useFactory: (pool: Kysely<any>, redis: Redis) => ({
            pg: databaseCheck(pool),
            redis: redisCheck(redis),
          }),
        },
        { provide: APP_FILTER, useClass: ErrorFilter },
        KernelLifecycle,
      ],
    };
  }
}
