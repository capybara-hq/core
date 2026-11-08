import { Module } from "@nestjs/common";
import { DevicesModule } from "../devices/devices.module.js";
import { DeviceAuthService } from "./device-auth.js";
import { LocalDevicesModule } from "./local-devices.module.js";

/**
 * Device sign-in (environments spec §13.3): {@link DeviceAuthService} behind
 * `DeviceAuthController`. Kept apart from {@link LocalDevicesModule}, which `DevicesModule`
 * imports (deleting a device revokes its machine), while sign-in needs both.
 */
@Module({
  imports: [LocalDevicesModule, DevicesModule],
  providers: [DeviceAuthService],
  exports: [DeviceAuthService],
})
export class DeviceAuthModule {}
