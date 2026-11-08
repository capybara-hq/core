import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { isInternalProvider, SandboxProviders } from "../sandbox/providers.js";
import { deviceNotFound } from "../sandbox/sandbox.service.js";

/** What decides a device's provider: its own record and its instance row's (if any). */
export interface ProviderFacts {
  /** `devices.provider`: the provider current when it was created. */
  provider: string | null;
  /** `device_instances.provider`; null without an instance row. */
  instanceProvider: string | null;
  /** The instance row's `fs_status`; null without an instance row. */
  fsStatus: "none" | "ready" | "lost" | null;
  /** The instance row records an instance handle. */
  hasInstance: boolean;
}

/**
 * The provider a device works with: a kernel-internal one (`@local`) as recorded; for a
 * cloud device the one keeping its files or instance once it has any (they are never
 * migrated, spec §4.2 item 13); before that, the current cloud provider (its first use creates
 * them there), else the one recorded at creation. The same rule as `SandboxService`'s use.
 */
export function deviceProvider(f: ProviderFacts, current: string | undefined): string | null {
  if (f.provider !== null && isInternalProvider(f.provider)) return f.provider;
  const holdsResources = f.fsStatus !== null && (f.fsStatus !== "none" || f.hasInstance);
  if (holdsResources) return f.instanceProvider;
  return current ?? f.provider;
}

/**
 * The device's provider is not the current one, or there is no provider (503); for an
 * internal provider (`@local`), this kernel does not serve it.
 */
export const deviceUnavailable = (provider: string | null): ApiError =>
  new ApiError(
    "device.unavailable",
    provider === null
      ? "No cloud sandbox is available in this deployment; ask the super admin to enable a sandbox plugin"
      : isInternalProvider(provider)
        ? `This device runs on a connected machine (${provider}), which this deployment does not serve`
        : `This device is kept by the sandbox provider ${provider}, which is not the current provider; it can be used again once ${provider} is the deployment's sandbox provider`,
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
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud" | "forName">,
  ) {}

  /**
   * The device if `accountId` may use it in `orgId` now: `device.not_found` when it is
   * missing, deleted, in another org or someone else's; `device.unavailable` when its
   * provider is not the current one (or there is none). A local device is usable while
   * `@local` is registered: whether its machine is online is the relay's concern, not access.
   */
  async usable(
    orgId: string,
    accountId: string,
    deviceId: string,
  ): Promise<{ id: string; provider: string | null }> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_instances as i", "i.device_id", "e.id")
      .select(["e.id", "e.provider", "i.provider as instance_provider", "i.fs_status", "i.handle"])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw deviceNotFound();
    if (row.provider !== null && isInternalProvider(row.provider)) {
      if (this.providers.forName(row.provider) === undefined) {
        throw deviceUnavailable(row.provider);
      }
      return { id: row.id, provider: row.provider };
    }
    const current = this.providers.cloud()?.plugin;
    const provider = deviceProvider(
      {
        provider: row.provider,
        instanceProvider: row.instance_provider,
        fsStatus: row.fs_status,
        hasInstance: row.handle !== null,
      },
      current,
    );
    if (current === undefined || provider !== current) throw deviceUnavailable(provider);
    return { id: row.id, provider };
  }
}
