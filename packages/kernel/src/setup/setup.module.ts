import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { KernelChecks } from "./kernel-checks.js";
import { SetupCheckRegistry } from "./setup-check-registry.js";
import { SetupChecksService } from "./setup-checks.service.js";
import { SetupGuidesService } from "./setup-guides.service.js";

/**
 * Setup guide checks (spec 2026-11-09-setup-guides-v2-design.md §10): the registry of kernel and
 * extension checks, the kernel's own `capybara:*` checks (registered on init) and the service that runs them (cache, single flight, cooldown, the org's
 * concurrency cap, the time limit, redaction), and the org's guide list (`SetupGuidesService`). Its
 * controllers are the api role's; the `Platform` tool's `setup` operations use the same services.
 */
@Module({
  imports: [ExtensionsModule, ChannelsModule, ToolsModule, CatalogModule],
  providers: [SetupCheckRegistry, SetupChecksService, SetupGuidesService, KernelChecks],
  exports: [SetupCheckRegistry, SetupChecksService, SetupGuidesService],
})
export class SetupModule {}
