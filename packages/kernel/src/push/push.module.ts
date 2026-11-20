import { Module } from "@nestjs/common";
import { PushPreferencesService } from "./preferences.service.js";
import { PushHostModule } from "./provider-host.js";
import { PushRegistrationsService } from "./registrations.service.js";
import { PushTokenStore } from "./token-store.js";

/** Push registrations and preferences (mobile app spec §9.3, §9.4); the controller is the API's. */
@Module({
  imports: [PushHostModule],
  providers: [PushTokenStore, PushRegistrationsService, PushPreferencesService],
  exports: [PushTokenStore, PushRegistrationsService, PushPreferencesService],
})
export class PushModule {}
