import { Global, Module } from "@nestjs/common";
import { OUTBOX_FAST_PATH, type OutboxFastPath, OutboxService } from "./outbox.service.js";

/** No fast path yet: the dispatcher (spec §3.3) replaces this provider. */
const noFastPath: OutboxFastPath = async () => {};

/**
 * Global: `OutboxService` (owed work written in the caller's transaction, transactional outbox
 * spec §3.2) and the fast path it hands each committed transaction's rows to.
 */
@Global()
@Module({
  providers: [OutboxService, { provide: OUTBOX_FAST_PATH, useValue: noFastPath }],
  exports: [OutboxService, OUTBOX_FAST_PATH],
})
export class OutboxModule {}
