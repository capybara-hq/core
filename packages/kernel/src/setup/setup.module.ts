import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { SetupCheckRegistry } from "./setup-check-registry.js";
import { SetupChecksService } from "./setup-checks.service.js";

/**
 * Setup guide checks (spec 2026-11-09-setup-guides-v2-design.md §10): the registry of kernel and
 * extension checks and the service that runs them (cache, single flight, cooldown, the org's
 * concurrency cap, the time limit, redaction). Its controller is the api role's; the `Platform`
 * tool's `setup` operations use the same service.
 */
@Module({
  imports: [ExtensionsModule, ChannelsModule, ToolsModule],
  providers: [SetupCheckRegistry, SetupChecksService],
  exports: [SetupCheckRegistry, SetupChecksService],
})
export class SetupModule {}
