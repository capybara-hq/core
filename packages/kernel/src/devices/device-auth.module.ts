import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module.js";
import { DeviceAuthService } from "./device-auth.js";
import { DevicesModule } from "./devices.module.js";

/**
 * Device sign-in (environments spec §13.3): {@link DeviceAuthService} behind
 * `DeviceAuthController`. Kept apart from {@link DevicesModule}, which `EnvironmentsModule`
 * imports (deleting an environment revokes its machine), while sign-in needs both.
 */
@Module({
  imports: [DevicesModule, EnvironmentsModule],
  providers: [DeviceAuthService],
  exports: [DeviceAuthService],
})
export class DeviceAuthModule {}
