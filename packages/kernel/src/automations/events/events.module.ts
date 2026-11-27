import { Module } from "@nestjs/common";
import { TRIGGER_EVENTS_BACKEND } from "./token.js";
import { TriggerEventsService } from "./trigger-events.service.js";

/**
 * `ctx.triggers` (collaboration spec §4.2): {@link TriggerEventsService}. The extension host finds
 * it at the time of use (`ModuleRef`, {@link TRIGGER_EVENTS_BACKEND}); the database and the outbox
 * it writes through are global modules.
 */
@Module({
  providers: [
    TriggerEventsService,
    { provide: TRIGGER_EVENTS_BACKEND, useExisting: TriggerEventsService },
  ],
  exports: [TriggerEventsService, TRIGGER_EVENTS_BACKEND],
})
export class TriggerEventsModule {}
