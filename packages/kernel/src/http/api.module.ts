import { Module, type Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
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
import { ChannelsModule } from "../channels/channels.module.js";
import { ChannelConnectionsController } from "../channels/connections.controller.js";
import { AttachmentsController } from "../conversations/attachments.controller.js";
import { ConversationsController } from "../conversations/conversations.controller.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { EvalsModule } from "../evals/evals.module.js";
import { EvalRunsController } from "../evals/runs.controller.js";
import { EvalSetsController } from "../evals/sets.controller.js";
import { TrajectoryController } from "../evals/trajectory.controller.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { OrgExtensionConfigsController } from "../extensions/org-config.controller.js";
import { FilesModule } from "../files/files.module.js";
import { FilePreviewersController } from "../files/previewers.controller.js";
import { AuthController } from "../identity/auth.controller.js";
import { AuthGuard } from "../identity/auth.guard.js";
import { IdentityModule } from "../identity/identity.module.js";
import { MeController } from "../identity/me.controller.js";
import {
  BindController,
  MeIdentitiesController,
  SsoController,
} from "../identity/sso.controller.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { ModelsModule } from "../models/models.module.js";
import { ModelPurposesController } from "../models/purposes.controller.js";
import { DirectorySyncController } from "../orgs/directory-sync.controller.js";
import { InvitationsController } from "../orgs/invitations.controller.js";
import { OrgsController } from "../orgs/orgs.controller.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { OrgSettingsController } from "../orgs/settings.controller.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { ConversationStreamController } from "../runtime/stream.controller.js";
import {
  AgentSkillsController,
  InboxController,
  SkillChangesController,
} from "../skills/changes.controller.js";
import { InvocableSkillsController } from "../skills/invocable.controller.js";
import { SkillsController } from "../skills/skills.controller.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ApprovalsController, ToolGrantsController } from "../tools/approvals.controller.js";
import { ConnectorContentController } from "../tools/connector-content.controller.js";
import { ConnectorsController } from "../tools/connectors.controller.js";
import {
  OAuthCallbackController,
  OAuthConnectController,
} from "../tools/oauth/oauth.controller.js";
import { QuestionsController } from "../tools/questions.controller.js";
import { ToolsModule } from "../tools/tools.module.js";
import { UiModule } from "../ui/ui.module.js";
import { UiController } from "../ui/views.controller.js";

/** Every controller of the kernel API. */
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
    ToolsModule,
    AgentsModule,
    ConversationsModule,
    RuntimeModule,
    ChannelsModule,
    EvalsModule,
    FilesModule,
    UiModule,
    InboxModule,
  ],
  controllers: CONTROLLERS,
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class ApiModule {}
