import { Global, Module } from "@nestjs/common";
import { OutboxDispatcher } from "./outbox.dispatcher.js";
import { OUTBOX_FAST_PATH, type OutboxFastPath, OutboxService } from "./outbox.service.js";

/**
 * The fast path (spec §3.3): starts the dispatcher on a committed transaction's rows and returns
 * at once, so the commit's caller never waits on Redis (R9). `dispatchOwn` never throws; what it
 * does not deliver stays for the relay.
 */
export const outboxFastPath =
  (dispatcher: Pick<OutboxDispatcher, "dispatchOwn">): OutboxFastPath =>
  async (ids) => {
    void dispatcher.dispatchOwn(ids);
  };

/**
 * Global: `OutboxService` (owed work written in the caller's transaction, transactional outbox
 * spec §3.2), the `OutboxDispatcher` that delivers the rows (the relay drives it too) and the fast
 * path `add` hands each committed transaction's rows to.
 *
 * It registers no queue: the dispatcher adds through the instances the queues' owner modules
 * registered (one instance and connection per queue, as everywhere in the kernel), resolved at use
 * time, and leaves the rows of a queue whose owner this process does not load to one that does.
 */
@Global()
@Module({
  providers: [
    OutboxService,
    OutboxDispatcher,
    { provide: OUTBOX_FAST_PATH, inject: [OutboxDispatcher], useFactory: outboxFastPath },
  ],
  exports: [OutboxService, OutboxDispatcher, OUTBOX_FAST_PATH],
})
export class OutboxModule {}
