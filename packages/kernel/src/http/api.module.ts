import type { Logger } from "@capybara-hq/plugin-sdk";
import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Redis } from "ioredis";
import { AdminController } from "../admin/admin.controller.js";
import { AdminModule } from "../admin/admin.module.js";
import { AdminExtensionsController } from "../admin/extensions.controller.js";
import { SetupController } from "../admin/setup.controller.js";
import { AgentsController } from "../agents/agents.controller.js";
import { AgentsModule } from "../agents/agents.module.js";
import { ModelsController } from "../agents/models.controller.js";
import { AgentTemplatesController } from "../agents/templates.controller.js";
import { AdminCatalogController } from "../catalog/admin-catalog.controller.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { MarketplacesController } from "../catalog/marketplaces.controller.js";
import {
  AdminCatalogRequestsController,
  OrgCatalogController,
} from "../catalog/org-catalog.controller.js";
import { CatalogRequestsService } from "../catalog/requests.service.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { ChannelConnectionsController } from "../channels/connections.controller.js";
import type { KernelConfig } from "../config/schema.js";
import { AttachmentsController } from "../conversations/attachments.controller.js";
import { ConversationsController } from "../conversations/conversations.controller.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { ConversationFiles } from "../conversations/files.js";
import type { Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { EvalsModule } from "../evals/evals.module.js";
import { EvalRunsController } from "../evals/runs.controller.js";
import { type EvalQueue, EvalRunsService } from "../evals/runs.service.js";
import { EvalSetsController } from "../evals/sets.controller.js";
import { EvalSetsService } from "../evals/sets.service.js";
import { TrajectoryController } from "../evals/trajectory.controller.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ExtensionHost } from "../extensions/host.js";
import { OrgExtensionConfigsController } from "../extensions/org-config.controller.js";
import { FilePreviewersController } from "../files/previewers.controller.js";
import { PreviewerRegistry } from "../files/previewers.js";
import { AuthController } from "../identity/auth.controller.js";
import { AuthGuard } from "../identity/auth.guard.js";
import { IdentityModule } from "../identity/identity.module.js";
import { MeController } from "../identity/me.controller.js";
import { SettingsService } from "../identity/settings.js";
import {
  BindController,
  MeIdentitiesController,
  SsoController,
} from "../identity/sso.controller.js";
import { InboxService } from "../inbox/inbox.service.js";
import { GracefulShutdown } from "../infra/lifecycle/graceful-shutdown.service.js";
import { KERNEL_BUS, REDIS } from "../infra/tokens.js";
import { ModelsModule } from "../models/models.module.js";
import { PricesService } from "../models/prices.js";
import { ModelPurposesController } from "../models/purposes.controller.js";
import { ModelPurposesService } from "../models/purposes.js";
import { DirectorySyncController } from "../orgs/directory-sync.controller.js";
import { InvitationsController } from "../orgs/invitations.controller.js";
import { OrgLock } from "../orgs/org-lock.js";
import { OrgsController } from "../orgs/orgs.controller.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { OrgSettingsController } from "../orgs/settings.controller.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { ConversationStreamController } from "../runtime/stream.controller.js";
import type { StreamBus } from "../runtime/stream.js";
import {
  AgentSkillsController,
  InboxController,
  SkillChangesController,
} from "../skills/changes.controller.js";
import { SkillChangesService } from "../skills/changes.service.js";
import { InvocableSkillsController } from "../skills/invocable.controller.js";
import { SkillsController } from "../skills/skills.controller.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { StorageService } from "../storage/storage.service.js";
import { ApprovalsController, ToolGrantsController } from "../tools/approvals.controller.js";
import { ApprovalsService } from "../tools/approvals.service.js";
import { ConnectorContentController } from "../tools/connector-content.controller.js";
import { ConnectorsController } from "../tools/connectors.controller.js";
import { ConversationToolInfo } from "../tools/info.js";
import {
  OAuthCallbackController,
  OAuthConnectController,
} from "../tools/oauth/oauth.controller.js";
import { QuestionsController } from "../tools/questions.controller.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolsModule } from "../tools/tools.module.js";
import { EmbedTokens } from "../ui/embed-token.js";
import { OrgUiStreams, orgMembership } from "../ui/ui-stream.js";
import { UiController } from "../ui/views.controller.js";
import { recordedCard, UiViews } from "../ui/views.js";
import {
  CONVERSATION_TOOLS,
  EMBED_TOKENS,
  EVAL_RUNS,
  EVAL_SETS,
  FILE_PREVIEWERS,
  INBOX,
  KERNEL_CONFIG,
  KERNEL_DB,
  ORG_UI_STREAMS,
  UI_VIEWS,
} from "./tokens.js";

/** The injection token of {@link ApiDeps} inside `ApiModule`. */
export const API_DEPS = Symbol("API_DEPS");

/** 内核 API 的依赖：由 createKernel 传入，ApiModule 据此构造各领域服务。 */
export interface ApiDeps {
  db: KernelSchemaDb;
  keyring: Keyring;
  /** 取当前配置（热更新后返回新配置）。 */
  config: () => KernelConfig;
  log: Logger;
  /** 评测队列的生产方（与 worker 同一队列名）。 */
  evalQueue: Pick<EvalQueue, "enqueue">;
}

/** 内核 API 的全部 controller；后续任务往这里追加。 */
const CONTROLLERS: Type[] = [
  AuthController,
  MeController,
  OrgsController,
  OrgSettingsController,
  InvitationsController,
  SetupController,
  AdminController,
  AdminExtensionsController,
  AdminCatalogController,
  MarketplacesController,
  OrgExtensionConfigsController,
  AgentsController,
  AgentTemplatesController,
  ModelsController,
  ConversationsController,
  AttachmentsController,
  SkillsController,
  SkillChangesController,
  AgentSkillsController,
  InvocableSkillsController,
  InboxController,
  ConversationStreamController,
  ConnectorContentController,
  ConnectorsController,
  ApprovalsController,
  ToolGrantsController,
  QuestionsController,
  OAuthConnectController,
  OAuthCallbackController,
  SsoController,
  BindController,
  MeIdentitiesController,
  ChannelConnectionsController,
  DirectorySyncController,
  UiController,
  FilePreviewersController,
  TrajectoryController,
  EvalSetsController,
  EvalRunsController,
  ModelPurposesController,
  OrgCatalogController,
  AdminCatalogRequestsController,
];

/**
 * Closes a stream registry's streams when the shutdown begins (readiness answers 503 from that
 * moment), and latches it: streams opened afterwards end at once, so the HTTP phase of the stop
 * never waits on an event stream. A standalone HTTP application (`createHttpApp` without the
 * kernel application, tests only) has no `GracefulShutdown`: its streams end with their connections.
 */
function closeOnShutdown<T extends { closeAll(): void }>(
  streams: T,
  shutdown: GracefulShutdown | undefined,
): T {
  if (shutdown?.signal.aborted) streams.closeAll();
  else shutdown?.signal.addEventListener("abort", () => streams.closeAll(), { once: true });
  return streams;
}

function serviceProviders(): Provider[] {
  return [
    { provide: KERNEL_DB, useFactory: (deps: ApiDeps) => deps.db, inject: [API_DEPS] },
    { provide: KERNEL_CONFIG, useFactory: (deps: ApiDeps) => deps.config, inject: [API_DEPS] },
    {
      provide: EVAL_SETS,
      useFactory: (
        db: KernelSchemaDb,
        config: () => KernelConfig,
        prices: PricesService,
        settings: SettingsService,
        orgLock: OrgLock,
      ) => new EvalSetsService(db, config, prices, settings, orgLock),
      inject: [KERNEL_DB, KERNEL_CONFIG, PricesService, SettingsService, OrgLock],
    },
    {
      provide: EVAL_RUNS,
      useFactory: (
        db: KernelSchemaDb,
        config: () => KernelConfig,
        registry: ProviderRegistry,
        prices: PricesService,
        settings: SettingsService,
        redis: Redis,
        purposes: ModelPurposesService,
        orgLock: OrgLock,
        deps: ApiDeps,
      ) =>
        new EvalRunsService({
          db,
          orgLock,
          redis,
          config,
          registry,
          prices,
          settings,
          queue: deps.evalQueue,
          purposes,
        }),
      inject: [
        KERNEL_DB,
        KERNEL_CONFIG,
        ProviderRegistry,
        PricesService,
        SettingsService,
        REDIS,
        ModelPurposesService,
        OrgLock,
        API_DEPS,
      ],
    },
    {
      provide: INBOX,
      useFactory: (
        requests: CatalogRequestsService,
        skillChanges: SkillChangesService,
        approvals: ApprovalsService,
      ) =>
        new InboxService({
          approvals,
          skillChanges,
          catalogRequests: requests,
        }),
      inject: [CatalogRequestsService, SkillChangesService, ApprovalsService],
    },
    {
      provide: CONVERSATION_TOOLS,
      useFactory: (
        db: KernelSchemaDb,
        conversations: ConversationsService,
        registry: ToolRegistry,
      ) =>
        new ConversationToolInfo({
          db,
          registry,
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
        }),
      inject: [KERNEL_DB, ConversationsService, ToolRegistry],
    },
    {
      provide: FILE_PREVIEWERS,
      useFactory: (
        db: KernelSchemaDb,
        files: ConversationFiles,
        storage: StorageService,
        host: ExtensionHost,
        deps: ApiDeps,
      ) =>
        new PreviewerRegistry({
          db,
          host,
          enabledPlugins: (orgId) => host.enabledPlugins(orgId),
          files,
          storage,
          log: deps.log,
        }),
      inject: [KERNEL_DB, ConversationFiles, StorageService, ExtensionHost, API_DEPS],
    },
    {
      provide: UI_VIEWS,
      useFactory: (
        conversations: ConversationsService,
        previewers: PreviewerRegistry,
        db: KernelSchemaDb,
        host: ExtensionHost,
        deps: ApiDeps,
      ) =>
        new UiViews({
          host,
          // org config rows plus the required bootstrap plugins
          enabledPlugins: (orgId) => host.enabledPlugins(orgId),
          canAccessConversation: (orgId, id, accountId) =>
            conversations.isAccessible(orgId, id, accountId),
          checkWritable: async (orgId, id, accountId) => {
            await conversations.writable(orgId, id, accountId);
          },
          previewEmbedAllowed: (t) => previewers.embedAllowed(t),
          recordedCard: (conversationId, callId) => recordedCard(db, conversationId, callId),
          log: deps.log,
        }),
      inject: [ConversationsService, FILE_PREVIEWERS, KERNEL_DB, ExtensionHost, API_DEPS],
    },
    {
      provide: EMBED_TOKENS,
      useFactory: (deps: ApiDeps) => new EmbedTokens(deps.keyring),
      inject: [API_DEPS],
    },
    {
      provide: ORG_UI_STREAMS,
      useFactory: (
        db: KernelSchemaDb,
        bus: StreamBus,
        config: () => KernelConfig,
        deps: ApiDeps,
        shutdown: GracefulShutdown | undefined,
      ) =>
        closeOnShutdown(
          new OrgUiStreams({ bus, memberRole: orgMembership(db), config, log: deps.log }),
          shutdown,
        ),
      inject: [
        KERNEL_DB,
        KERNEL_BUS,
        KERNEL_CONFIG,
        API_DEPS,
        { token: GracefulShutdown, optional: true },
      ],
    },
  ];
}

/**
 * 内核 API 模块（`/api/v1/*`），只在角色含 `api` 时挂载。
 * 全局守卫 `AuthGuard` 默认拒绝：未标注 `@Public()` 的路由一律要求凭据（含根模块的健康检查，它们显式标了 `@Public()`）。
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest 动态模块约定（`Module.register()` 返回 DynamicModule）
export class ApiModule {
  /** The API over the given dependencies. */
  static register(deps: ApiDeps): DynamicModule {
    return ApiModule.registerFrom({ provide: API_DEPS, useValue: deps });
  }

  /**
   * The API over dependencies another provider supplies (the kernel: its legacy graph, Task 1.2 of
   * the nest kernel plan; `deps` must provide {@link API_DEPS}).
   */
  static registerFrom(deps: Provider<ApiDeps> & { provide: typeof API_DEPS }): DynamicModule {
    return {
      module: ApiModule,
      // Converted domains (Phase 3): their controllers stay in CONTROLLERS, their services come
      // from these modules (Task 4.1 makes ApiModule static)
      imports: [
        StorageModule,
        ModelsModule,
        SkillsModule,
        IdentityModule,
        OrgsModule,
        AdminModule,
        ExtensionsModule,
        CatalogModule,
        ToolsModule,
        AgentsModule,
        ConversationsModule,
        RuntimeModule,
        ChannelsModule,
        EvalsModule,
      ],
      controllers: CONTROLLERS,
      providers: [deps, ...serviceProviders(), { provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
