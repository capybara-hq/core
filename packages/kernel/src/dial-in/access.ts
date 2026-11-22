import { Inject, Injectable } from "@nestjs/common";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { DialInRelay, type DialInRequestOptions } from "./relay.js";

/**
 * What `ctx.dialIn` is built from (`ctx/create-ctx.ts`): the relay, and the check that a device is
 * served by the calling extension. Kept below the extension host (its module imports nothing but
 * the global infrastructure), so the host can build every extension's `ctx` from it.
 */
@Injectable()
export class DialInAccess {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(DialInRelay)
    private readonly relay: Pick<DialInRelay, "request" | "online" | "capacity" | "stop">,
  ) {}

  /**
   * Whether `deviceId` is a live device (in a live org) whose `devices.provider` is `plugin`, and
   * `plugin` is enabled in the device's org. Read from PG at every call. The full availability
   * check (valid org and effective config, `DeviceProviderSelection.isOnInOrg`) runs at the
   * machine's hello; this one stays below the extension host's module.
   */
  async serves(plugin: string, deviceId: string): Promise<boolean> {
    const row = await this.kdb.db
      .selectFrom("devices as d")
      .innerJoin("orgs as o", "o.id", "d.org_id")
      .select(["d.org_id", "d.provider"])
      .where("d.id", "=", deviceId)
      .where("d.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row || row.provider !== plugin) return false;
    return isExtensionEnabled(this.kdb.db, row.org_id, plugin);
  }

  /** {@link DialInRelay.request} with only the options an extension may pass. */
  request(
    deviceId: string,
    body: unknown,
    opts: Pick<DialInRequestOptions, "timeoutMs" | "signal">,
  ): Promise<unknown> {
    return this.relay.request(deviceId, body, {
      timeoutMs: opts.timeoutMs,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  }

  online(deviceId: string): Promise<boolean> {
    return this.relay.online(deviceId);
  }

  capacity(deviceId: string): Promise<{ maxFrameBytes: number } | null> {
    return this.relay.capacity(deviceId);
  }

  stop(deviceId: string, reason: "drain" | "stop"): Promise<void> {
    return this.relay.stop(deviceId, reason);
  }
}
