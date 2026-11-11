import { Global, Module } from "@nestjs/common";
import { ReplicaPresence } from "./replica-presence.js";

/**
 * Global: {@link ReplicaPresence}, on every role (each process reports itself; `KernelLifecycle`
 * starts and stops it), read by the admin health overview.
 */
@Global()
@Module({
  providers: [ReplicaPresence],
  exports: [ReplicaPresence],
})
export class PresenceModule {}
