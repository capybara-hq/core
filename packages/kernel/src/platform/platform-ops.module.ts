import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module.js";
import { BackgroundModule } from "../background/background.module.js";
import { AppearanceModule } from "../catalog/appearance.service.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { DevicesModule } from "../devices/devices.module.js";
import { EvalsModule } from "../evals/evals.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { FilesModule } from "../files/files.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { ProvidersModule } from "../runtime/providers.js";
import { SetupModule } from "../setup/setup.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ThemesModule } from "../themes/themes.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AccountsOperations } from "./ops/accounts.ops.js";
import { AdminOperations } from "./ops/admin.ops.js";
import { AgentSkillsOperations } from "./ops/agent-skills.ops.js";
import { AgentTemplatesOperations } from "./ops/agent-templates.ops.js";
import { AgentsOperations } from "./ops/agents.ops.js";
import { ApprovalsOperations } from "./ops/approvals.ops.js";
import { BackgroundOperations } from "./ops/background.ops.js";
import { CatalogAdminOperations } from "./ops/catalog-admin.ops.js";
import { ChannelsOperations } from "./ops/channels.ops.js";
import { ComponentsOperations } from "./ops/components.ops.js";
import { ConnectorsOperations } from "./ops/connectors.ops.js";
import { ConversationsOperations } from "./ops/conversations.ops.js";
import { DevicesOperations } from "./ops/devices.ops.js";
import { EvalsOperations } from "./ops/evals.ops.js";
import { ExtensionsOperations } from "./ops/extensions.ops.js";
import { ExtensionsAdminOperations } from "./ops/extensions-admin.ops.js";
import { InboxOperations } from "./ops/inbox.ops.js";
import { MarketplacesOperations } from "./ops/marketplaces.ops.js";
import { ModelsOperations } from "./ops/models.ops.js";
import { OrgPluginsOperations } from "./ops/org-plugins.ops.js";
import { OrgSettingsOperations } from "./ops/org-settings.ops.js";
import { OrgsOperations } from "./ops/orgs.ops.js";
import { PlatformOperationsProvider } from "./ops/platform.ops.js";
import { PluginsOperations } from "./ops/plugins.ops.js";
import { PreviewersOperations } from "./ops/previewers.ops.js";
import { RequestsOperations } from "./ops/requests.ops.js";
import { SetupOperations } from "./ops/setup.ops.js";
import { SkillsOperations } from "./ops/skills.ops.js";
import { ThemesOperations } from "./ops/themes.ops.js";
import { UiOperations } from "./ops/ui.ops.js";
import { PlatformModule } from "./platform.module.js";

/**
 * One provider per domain, each taking `PlatformOperations` as its first constructor argument:
 * the parity test in `tools/checks` builds the operations from it without a Nest app.
 */
export const PLATFORM_OPERATION_PROVIDERS = [
  PlatformOperationsProvider,
  SkillsOperations,
  AgentsOperations,
  AgentTemplatesOperations,
  PluginsOperations,
  MarketplacesOperations,
  RequestsOperations,
  ConnectorsOperations,
  ExtensionsOperations,
  ConversationsOperations,
  ComponentsOperations,
  // Task 7: admin accounts and orgs
  AccountsOperations,
  OrgsOperations,
  AdminOperations,
  // Task 8: admin catalog, extensions, marketplaces, models, org uploads
  CatalogAdminOperations,
  OrgPluginsOperations,
  ExtensionsAdminOperations,
  ModelsOperations,
  // Task 9: inbox and pending reads
  InboxOperations,
  ApprovalsOperations,
  // Task 10: channels, org settings
  ChannelsOperations,
  OrgSettingsOperations,
  // Task 11: evals, background tasks, file previewers
  EvalsOperations,
  BackgroundOperations,
  PreviewersOperations,
  // Task 11b: devices, agent skills
  DevicesOperations,
  AgentSkillsOperations,
  // themes (themes spec §9)
  ThemesOperations,
  // setup guide checks (setup guides v2 §12; plan task 13 adds the rest of the domain)
  SetupOperations,
  // UI slot catalog (UI slots spec §3)
  UiOperations,
] as const;

/**
 * The `Platform` tool's operations (ruling P2): one provider per domain, each registering its
 * operations into `PlatformOperations` from `onModuleInit`. It imports the domain modules, which
 * `PlatformModule` itself must not.
 */
@Module({
  imports: [
    PlatformModule,
    SkillsModule,
    AgentsModule,
    OrgsModule,
    CatalogModule,
    AppearanceModule,
    ExtensionsModule,
    ToolsModule,
    ConversationsModule,
    IdentityModule,
    ModelsModule,
    ProvidersModule,
    InboxModule,
    ChannelsModule,
    EvalsModule,
    DevicesModule,
    BackgroundModule,
    FilesModule,
    ThemesModule,
    SetupModule,
  ],
  providers: [...PLATFORM_OPERATION_PROVIDERS],
})
export class PlatformOpsModule {}
