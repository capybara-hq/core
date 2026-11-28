import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { AgentLookupModule } from "../agents/agent-lookup.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { DialInModule } from "../dial-in/dial-in.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { ProvidersModule } from "../runtime/providers.js";
import { NetworkGrantsModule } from "../sandbox/network-grants.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { AutomationToolsPort } from "../tools/builtins/automations.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AutomationsService } from "./automations.service.js";
import { AcceptanceModule } from "./events/acceptance.js";
import { AutomationStoreModule } from "./store.module.js";

/**
 * Automations for people (spec 2026-11-11): the service the HTTP API, the Platform operations
 * and the automation tools share. ToolsModule: grants resolve the agent's tools (`ToolRegistry`);
 * ExtensionRegistryModule: a group chat target needs its channel's `features.threads`. At start
 * it binds the service into the automation tools' port (`AutomationToolsPort`): the tools cannot
 * inject it, since this module imports theirs.
 */
@Module({
  imports: [
    AutomationStoreModule,
    OrgLockModule,
    AgentLookupModule,
    ConversationAccessModule,
    ExtensionRegistryModule,
    // event automations: the trigger sources of an org and their display names
    ExtensionsModule,
    ToolsModule,
    // a new-conversation task's model must resolve for the org
    ProvidersModule,
    // network grants: the org's effective egress
    SandboxModule,
    NetworkGrantsModule,
    DialInModule,
    // directed events: the person's acceptance rules and work offers (collaboration spec §4.4)
    AcceptanceModule,
  ],
  providers: [AutomationsService],
  exports: [AutomationsService, AutomationStoreModule, AcceptanceModule],
})
export class AutomationsModule implements OnModuleInit {
  constructor(
    @Inject(AutomationToolsPort) private readonly port: AutomationToolsPort,
    @Inject(AutomationsService) private readonly service: AutomationsService,
  ) {}

  onModuleInit(): void {
    this.port.bind(this.service);
  }
}
