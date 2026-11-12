import { Module } from "@nestjs/common";
import { OutboxRelay } from "./outbox.relay.js";

/**
 * The outbox relay (`@LockedInterval`), imported only by `WorkerModule`. Its dispatcher comes from
 * the global `OutboxModule`, which every role has (the fast path runs everywhere).
 */
@Module({ providers: [OutboxRelay] })
export class OutboxRelayModule {}
