import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { DeviceProviderSelection } from "./device-provider-selection.js";
import { deviceNotFound } from "./errors.js";

/**
 * The device's provider is off in its org or not installed, or the device has none (503). Its
 * files and instance are kept: nothing is demoted, recreated or moved to another provider.
 */
export const deviceUnavailable = (provider: string | null): ApiError =>
  new ApiError(
    "device.unavailable",
    provider === null
      ? "This device has no provider; delete it and create a new one"
      : `This device's provider ${provider} is off in this organization or not installed; its files are kept, and the device works again once an org admin switches the provider back on`,
  );

/**
 * The device's instance row names another provider than the device's own (503): never written by
 * this kernel (a device is bound to its provider for life), so nothing is taken over.
 */
export const deviceInstanceForeign = (provider: string, instanceProvider: string): ApiError =>
  new ApiError(
    "device.unavailable",
    `This device's provider is ${provider}, but its instance was made by ${instanceProvider}; it cannot be used as it is: delete it and create a new one`,
  );

/**
 * Who may use a device (spec §4.2 item 12): in phase 1 only the owner of a personal
 * device. Anyone else gets `device.not_found`, never `forbidden`, so ids cannot be
 * probed. Read live on every call (PG, no cache); phase 3 adds project membership.
 */
@Injectable()
export class DeviceAccess {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(DeviceProviderSelection)
    private readonly selection: Pick<DeviceProviderSelection, "isOnInOrg">,
  ) {}

  /**
   * The device if `accountId` may use it in `orgId` now: `device.not_found` when it is
   * missing, deleted, in another org or someone else's; `device.unavailable` when it has no
   * provider, its provider (`devices.provider`, fixed at creation) does not serve the org now
   * ({@link DeviceProviderSelection.isOnInOrg}: off in the org, not installed, invalid config),
   * or its instance row names another provider (never written by this kernel). Whether a dial-in
   * device's machine is online is its provider's concern, not access.
   */
  async usable(
    orgId: string,
    accountId: string,
    deviceId: string,
  ): Promise<{ id: string; provider: string }> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_instances as i", "i.device_id", "e.id")
      .select(["e.id", "e.provider", "i.provider as instance_provider"])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw deviceNotFound();
    const provider = row.provider;
    if (provider === null) throw deviceUnavailable(null);
    if (row.instance_provider !== null && row.instance_provider !== provider) {
      throw deviceInstanceForeign(provider, row.instance_provider);
    }
    if (!(await this.selection.isOnInOrg(orgId, provider))) throw deviceUnavailable(provider);
    return { id: row.id, provider };
  }
}
