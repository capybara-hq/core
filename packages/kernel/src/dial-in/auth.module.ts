import { Module } from "@nestjs/common";
import { DevicesModule } from "../devices/devices.module.js";
import { DialInAuthService } from "./auth.service.js";
import { DialInModule } from "./dial-in.module.js";

/**
 * Device sign-in (environments spec §13.3): {@link DialInAuthService} behind
 * `DialInAuthController`. Kept apart from {@link DialInModule}, which `DevicesModule` imports
 * (through the local devices: deleting a device revokes its machine), while sign-in needs both.
 */
@Module({
  imports: [DialInModule, DevicesModule],
  providers: [DialInAuthService],
  exports: [DialInAuthService],
})
export class DialInAuthModule {}
