import { Global, Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { KERNEL_QUEUES } from "../queue/queue-names.js";
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
 * Every kernel queue is registered here, so OutboxModule has its own Queue instance per kernel
 * queue (one more Redis connection per queue per process, closed by `QueueShutdown` like the
 * others): a row may name any of them, the dispatcher is a producer on every role, and the feature
 * modules that register the same queues are not all present on every role.
 */
@Global()
@Module({
  imports: [QueueModule.registerQueue(...KERNEL_QUEUES)],
  providers: [
    OutboxService,
    OutboxDispatcher,
    { provide: OUTBOX_FAST_PATH, inject: [OutboxDispatcher], useFactory: outboxFastPath },
  ],
  exports: [OutboxService, OutboxDispatcher, OUTBOX_FAST_PATH],
})
export class OutboxModule {}
