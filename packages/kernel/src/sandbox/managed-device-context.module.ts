import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { PermissionProfileStoreModule } from "../conversations/permission-profile-store.module.js";
import { DialInModule } from "../dial-in/dial-in.module.js";
import { ManagedDeviceContextRecorder } from "./managed-device-context.js";
import { OperationAuthorityModule } from "./operation-authority.module.js";
import { PermissionAuthorityModule } from "./permission-authority.module.js";
import { PermissionFactsModule } from "./permission-facts.module.js";
import { SandboxProviderRegistryModule } from "./providers.module.js";

/**
 * The managed device context writer (a leaf: no runtime or tools import), which `ToolsModule`
 * imports so `BuiltinTools` can hand it to the managed sandbox route.
 */
@Module({
  imports: [
    EventLogModule,
    PermissionProfileStoreModule,
    PermissionAuthorityModule,
    OperationAuthorityModule,
    PermissionFactsModule,
    SandboxProviderRegistryModule,
    DialInModule,
  ],
  providers: [ManagedDeviceContextRecorder],
  exports: [ManagedDeviceContextRecorder],
})
export class ManagedDeviceContextModule {}
