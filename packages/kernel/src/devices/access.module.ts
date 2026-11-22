import { Module } from "@nestjs/common";
import { DeviceAccess } from "./access.js";
import { DeviceProviderSelectionModule } from "./device-provider-selection.module.js";
@Module({
  imports: [DeviceProviderSelectionModule],
  providers: [DeviceAccess],
  exports: [DeviceAccess],
})
export class DeviceAccessModule {}
