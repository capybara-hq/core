import { Module } from "@nestjs/common";
import { DialInModule } from "../dial-in/dial-in.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { PermissionFactsModule } from "../sandbox/permission-facts.module.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SandboxFileReader } from "../sandbox/sandbox-file-reader.js";
import { DeviceAccess } from "./access.js";
import { DeviceAccessModule } from "./access.module.js";
import { ConversationDevices } from "./conversation-devices.js";
import { DeviceProjectFilesService } from "./device-project-files.service.js";
import { DeviceProjectsService } from "./device-projects.service.js";
import { DeviceProviderSelectionModule } from "./device-provider-selection.module.js";
import { DevicesService } from "./devices.service.js";

/**
 * Devices (spec 2026-11-07-environments-design): a person's devices
 * ({@link DevicesService}), who may use one ({@link DeviceAccess}) and the one a
 * conversation works in ({@link ConversationDevices}). The instances and file systems are the
 * {@link SandboxModule}'s.
 */
@Module({
  // ExtensionsModule: the provider display names; DialInModule: deleting a dial-in device
  // revokes its machine, and whether its machine is online
  imports: [
    SandboxModule,
    SandboxProviderRegistryModule,
    ExtensionsModule,
    DialInModule,
    DeviceAccessModule,
    DeviceProviderSelectionModule,
    PermissionFactsModule,
  ],
  // SandboxFileReader lives here, not in SandboxModule: it needs ConversationDevices, and this
  // module already imports SandboxModule (the other way would be a module cycle)
  providers: [
    DevicesService,
    ConversationDevices,
    SandboxFileReader,
    DeviceProjectsService,
    DeviceProjectFilesService,
  ],
  exports: [
    DeviceAccessModule,
    DevicesService,
    ConversationDevices,
    SandboxFileReader,
    DeviceProjectsService,
    DeviceProjectFilesService,
  ],
})
export class DevicesModule {}
