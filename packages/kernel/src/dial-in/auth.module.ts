import { Module } from "@nestjs/common";
import { DevicesModule } from "../devices/devices.module.js";
import { LocalDevicesModule } from "../local-devices/local-devices.module.js";
import { DialInAuthService } from "./auth.service.js";

/**
 * Device sign-in (environments spec §13.3): {@link DialInAuthService} behind
 * `DialInAuthController`. Kept apart from {@link LocalDevicesModule}, which `DevicesModule`
 * imports (deleting a device revokes its machine), while sign-in needs both.
 */
@Module({
  imports: [LocalDevicesModule, DevicesModule],
  providers: [DialInAuthService],
  exports: [DialInAuthService],
})
export class DialInAuthModule {}
