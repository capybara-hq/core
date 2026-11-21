import { Module } from "@nestjs/common";
import { QueueModule } from "../infra/queue/queue.module.js";
import { PUSH_QUEUE } from "./jobs.js";
import { PushPreferencesService } from "./preferences.service.js";
import { PushHostModule } from "./provider-host.js";
import { PushRegistrationsService } from "./registrations.service.js";
import { PushTokenStore } from "./token-store.js";

/** The push queue (`cap-push-deliver`): registered on every role, since every role owes jobs. */
const PUSH_QUEUE_MODULE = QueueModule.registerQueue(PUSH_QUEUE);

/**
 * Push registrations and preferences (mobile app spec §9.3, §9.4) and the push queue; the
 * controller is the API's, the queue's consumer the worker role's (`PushWorkersModule`).
 */
@Module({
  imports: [PushHostModule, PUSH_QUEUE_MODULE],
  providers: [PushTokenStore, PushRegistrationsService, PushPreferencesService],
  exports: [PushTokenStore, PushRegistrationsService, PushPreferencesService, PUSH_QUEUE_MODULE],
})
export class PushModule {}
