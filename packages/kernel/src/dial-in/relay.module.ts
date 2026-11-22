import { Module } from "@nestjs/common";
import { DialInAccess } from "./access.js";
import { DialInRelay } from "./relay.js";
import { DeviceTargets } from "./targets.js";

/**
 * The caller side of the dial-in relay ({@link DialInRelay}, {@link DeviceTargets}) and the
 * extensions' access to it ({@link DialInAccess}, behind `ctx.dialIn`). It needs only the global
 * infrastructure (PG, Redis, locks, config), so the extension host's module can import it.
 */
@Module({
  providers: [DeviceTargets, DialInRelay, DialInAccess],
  exports: [DeviceTargets, DialInRelay, DialInAccess],
})
export class DialInRelayModule {}
