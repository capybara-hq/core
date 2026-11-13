import { Module, type Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AdminController } from "../admin/admin.controller.js";
import { AdminModule } from "../admin/admin.module.js";
import { AdminAgentsController } from "../admin/admin-agents.controller.js";
import { AdminConnectorsController } from "../admin/admin-connectors.controller.js";
import { AdminAuditController } from "../admin/audit.controller.js";
import { AdminExtensionsController } from "../admin/extensions.controller.js";
import { OutboxDeadController } from "../admin/outbox-dead.controller.js";
import { AdminOverviewController } from "../admin/overview.controller.js";
import { SetupController } from "../admin/setup.controller.js";
import { AgentsController } from "../agents/agents.controller.js";
import { AgentsModule } from "../agents/agents.module.js";
import { ModelsController } from "../agents/models.controller.js";
import { PendingConnectorsController } from "../agents/pending-connectors.controller.js";
import { ReadinessController } from "../agents/readiness.controller.js";
import {
  AgentSaveAsTemplateController,
  AgentTemplatesController,
} from "../agents/templates.controller.js";
import { BackgroundController } from "../background/background.controller.js";
import { BackgroundModule } from "../background/background.module.js";
import { AdminCatalogController } from "../catalog/admin-catalog.controller.js";
import { AppearanceModule } from "../catalog/appearance.service.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import {
  AdminComponentsController,
  OrgComponentsController,
} from "../catalog/component-scope.controller.js";
import {
  MarketplacesController,
  OrgMarketplacesController,
} from "../catalog/marketplaces.controller.js";
import {
  AdminCatalogRequestsController,
  OrgCatalogController,
} from "../catalog/org-catalog.controller.js";
import {
  OrgExtensionConfigsController,
  OrgExtensionOverridesController,
  OrgExtensionToolSwitchesController,
} from "../catalog/org-extension.controller.js";
import {
  OrgOwnedPluginsController,
  OrgPluginUploadsController,
} from "../catalog/org-plugin-uploads.controller.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { ChannelConnectionsController } from "../channels/connections.controller.js";
import { AdminClientController, OrgClientController } from "../client/client.controller.js";
import { ClientModule } from "../client/client.module.js";
import { ClientDeliveryController } from "../client/client-delivery.controller.js";
import { AttachmentsController } from "../conversations/attachments.controller.js";
import { ConversationsController } from "../conversations/conversations.controller.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { DevicesController } from "../devices/devices.controller.js";
import { DevicesModule } from "../devices/devices.module.js";
import { EvalsModule } from "../evals/evals.module.js";
import { EvalRunsController } from "../evals/runs.controller.js";
import { EvalSetsController } from "../evals/sets.controller.js";
import { TrajectoryController } from "../evals/trajectory.controller.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ExtensionPointDefaultsController } from "../extensions/point-defaults.controller.js";
import { FilesModule } from "../files/files.module.js";
import { FilePreviewersController } from "../files/previewers.controller.js";
import { GitModule } from "../git/git.module.js";
import { AuthController } from "../identity/auth.controller.js";
import { AuthGuard } from "../identity/auth.guard.js";
import { IdentityModule } from "../identity/identity.module.js";
import { InitialPasswordsController } from "../identity/initial-passwords.controller.js";
import { MeController } from "../identity/me.controller.js";
import {
  BindController,
  MeIdentitiesController,
  SsoController,
} from "../identity/sso.controller.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { PlatformInboxController } from "../inbox/platform-inbox.controller.js";
import { DeviceAuthController } from "../local-devices/device-auth.controller.js";
import { DeviceAuthModule } from "../local-devices/device-auth.module.js";
import { ModelEnablementController } from "../models/enablement.controller.js";
import { ModelsModule } from "../models/models.module.js";
import { ModelPurposesController } from "../models/purposes.controller.js";
import { DirectorySyncController } from "../orgs/directory-sync.controller.js";
import { InvitationsController } from "../orgs/invitations.controller.js";
import { OrgsController } from "../orgs/orgs.controller.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { OrgSettingsController } from "../orgs/settings.controller.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { ConversationStreamController } from "../runtime/stream.controller.js";
import { SchedulesController } from "../schedules/schedules.controller.js";
import { SchedulesModule } from "../schedules/schedules.module.js";
import { SetupModule } from "../setup/setup.module.js";
import { SetupChecksController } from "../setup/setup-checks.controller.js";
import { SetupGuidesController } from "../setup/setup-guides.controller.js";
import { AgentSkillsController } from "../skills/agent-skills.controller.js";
import { InboxController, SkillChangesController } from "../skills/changes.controller.js";
import { InvocableSkillsController } from "../skills/invocable.controller.js";
import { SkillsController } from "../skills/skills.controller.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { OrgThemesController } from "../themes/themes.controller.js";
import { ThemesModule } from "../themes/themes.module.js";
import {
  PlatformThemeController,
  ThemeDeliveryController,
} from "../themes/themes-public.controller.js";
import { ApprovalsController, ToolGrantsController } from "../tools/approvals.controller.js";
import { ConnectorContentController } from "../tools/connector-content.controller.js";
import { ConnectorsController } from "../tools/connectors.controller.js";
import { ExtensionToolsController } from "../tools/extension-tools.controller.js";
import {
  OAuthCallbackController,
  OAuthConnectController,
} from "../tools/oauth/oauth.controller.js";
import { QuestionsController } from "../tools/questions.controller.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AdminUiController } from "../ui/admin-ui.controller.js";
import { SlotsController } from "../ui/slots.controller.js";
import { UiModule } from "../ui/ui.module.js";
import { UiController } from "../ui/views.controller.js";

/** Every controller of the kernel API. */
const CONTROLLERS: Type[] = [
  AuthController,
  MeController,
  InitialPasswordsController,
  OrgsController,
  OrgSettingsController,
  InvitationsController,
  SetupController,
  AdminController,
  AdminAgentsController,
  AdminConnectorsController,
  AdminAuditController,
  AdminOverviewController,
  OutboxDeadController,
  AdminExtensionsController,
  AdminCatalogController,
  AdminComponentsController,
  MarketplacesController,
  OrgMarketplacesController,
  OrgExtensionConfigsController,
  OrgExtensionOverridesController,
  OrgExtensionToolSwitchesController,
  AgentsController,
  AgentTemplatesController,
  AgentSaveAsTemplateController,
  PendingConnectorsController,
  ModelsController,
  ModelEnablementController,
  ReadinessController,
  ConversationsController,
  BackgroundController,
  DevicesController,
  SchedulesController,
  AttachmentsController,
  SkillsController,
  SkillChangesController,
  AgentSkillsController,
  InvocableSkillsController,
  InboxController,
  PlatformInboxController,
  ConversationStreamController,
  ConnectorContentController,
  ConnectorsController,
  ApprovalsController,
  ToolGrantsController,
  QuestionsController,
  ExtensionToolsController,
  OAuthConnectController,
  OAuthCallbackController,
  SsoController,
  BindController,
  MeIdentitiesController,
  ChannelConnectionsController,
  DirectorySyncController,
  UiController,
  AdminUiController,
  SlotsController,
  FilePreviewersController,
  ExtensionPointDefaultsController,
  TrajectoryController,
  EvalSetsController,
  EvalRunsController,
  ModelPurposesController,
  OrgCatalogController,
  SetupChecksController,
  SetupGuidesController,
  OrgPluginUploadsController,
  OrgOwnedPluginsController,
  OrgComponentsController,
  AdminCatalogRequestsController,
  OrgThemesController,
  ThemeDeliveryController,
  PlatformThemeController,
  DeviceAuthController,
  ClientDeliveryController,
  OrgClientController,
  AdminClientController,
];

/**
 * The api role (nest kernel spec §2): the kernel API (`/api/v1/*`), imported by `KernelModule` only
 * when `roles` includes `api`. The global `AuthGuard` denies by default: every route without
 * `@Public()` requires credentials (the root module's health endpoints are marked `@Public()`).
 */
@Module({
  // Every domain module the controllers' services come from
  imports: [
    StorageModule,
    ModelsModule,
    SkillsModule,
    IdentityModule,
    OrgsModule,
    AdminModule,
    ExtensionsModule,
    CatalogModule,
    // a plugin's suggested appearance (its own module: it writes through the org settings)
    AppearanceModule,
    ToolsModule,
    AgentsModule,
    ConversationsModule,
    BackgroundModule,
    DevicesModule,
    DeviceAuthModule,
    RuntimeModule,
    ChannelsModule,
    EvalsModule,
    FilesModule,
    UiModule,
    InboxModule,
    ThemesModule,
    ClientModule,
    SetupModule,
    // scheduled tasks (the controller comes with the HTTP routes)
    SchedulesModule,
    // the git gateway (run tickets; the gateway route comes with it)
    GitModule,
  ],
  controllers: CONTROLLERS,
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class ApiModule {}
