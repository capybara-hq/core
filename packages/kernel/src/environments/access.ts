import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { isInternalProvider, SandboxProviders } from "../sandbox/providers.js";
import { environmentNotFound } from "../sandbox/sandbox.service.js";

/** What decides an environment's provider: its own record and its instance row's (if any). */
export interface ProviderFacts {
  /** `environments.provider`: the provider current when it was created. */
  provider: string | null;
  /** `environment_instances.provider`; null without an instance row. */
  instanceProvider: string | null;
  /** The instance row's `fs_status`; null without an instance row. */
  fsStatus: "none" | "ready" | "lost" | null;
  /** The instance row records an instance handle. */
  hasInstance: boolean;
}

/**
 * The provider an environment works with: a kernel-internal one (`@device`) as recorded; for a
 * cloud environment the one keeping its files or instance once it has any (they are never
 * migrated, spec §4.2 item 13); before that, the current cloud provider (its first use creates
 * them there), else the one recorded at creation. The same rule as `SandboxService`'s use.
 */
export function environmentProvider(f: ProviderFacts, current: string | undefined): string | null {
  if (f.provider !== null && isInternalProvider(f.provider)) return f.provider;
  if (holdsResources(f)) return f.instanceProvider;
  return current ?? f.provider;
}

/** It has files or an instance at some provider (a file system, even a lost one, or a handle). */
export const holdsResources = (f: ProviderFacts): boolean =>
  f.fsStatus !== null && (f.fsStatus !== "none" || f.hasInstance);

/** `environment_instances.status`. */
export type InstanceStatus = "none" | "creating" | "running" | "suspended" | "destroyed";

/**
 * For replacing a default (which one is the person's default): it holds healthy files or an
 * instance, or an instance row is under way (`creating`, `running`, `suspended`: a first use may
 * be creating the instance before any file system or handle is recorded). Lost files count as
 * none here, unlike {@link holdsResources}, which decides the provider.
 */
export const inUseForDefault = (f: ProviderFacts & { status: InstanceStatus | null }): boolean =>
  f.fsStatus === "ready" ||
  f.hasInstance ||
  (f.status !== null && f.status !== "none" && f.status !== "destroyed");

/**
 * The provider a former default belongs to (its label and the provider whose switch back restores
 * it): the one holding its resources once it holds any, else the one it was demoted from (the
 * marker). A former default demoted while empty and used afterwards keeps a stale marker; its
 * resources decide. null for an environment that is not a former default.
 */
export function demotedProvider(marker: string | null, f: ProviderFacts): string | null {
  if (marker === null) return null;
  return (holdsResources(f) ? f.instanceProvider : null) ?? marker;
}

/**
 * The environment's provider is not the current one, or there is no provider (503); for an
 * internal provider (`@device`), this kernel does not serve it.
 */
export const environmentUnavailable = (provider: string | null): ApiError =>
  new ApiError(
    "environment.unavailable",
    provider === null
      ? "No cloud sandbox is available in this deployment; ask the super admin to enable a sandbox plugin"
      : isInternalProvider(provider)
        ? `This environment runs on a connected machine (${provider}), which this deployment does not serve`
        : `This environment is kept by the sandbox provider ${provider}, which is not the current provider; it can be used again once ${provider} is the deployment's sandbox provider`,
  );

/**
 * Who may use an environment (spec §4.2 item 12): in phase 1 only the owner of a personal
 * environment. Anyone else gets `environment.not_found`, never `forbidden`, so ids cannot be
 * probed. Read live on every call (PG, no cache); phase 3 adds project membership.
 */
@Injectable()
export class EnvironmentAccess {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud" | "forName">,
  ) {}

  /**
   * The environment if `accountId` may use it in `orgId` now: `environment.not_found` when it is
   * missing, deleted, in another org or someone else's; `environment.unavailable` when its
   * provider is not the current one (or there is none). A `device` environment is usable while
   * `@device` is registered: whether its machine is online is the relay's concern, not access.
   */
  async usable(
    orgId: string,
    accountId: string,
    environmentId: string,
  ): Promise<{ id: string; provider: string | null }> {
    const row = await this.db
      .selectFrom("environments as e")
      .leftJoin("environment_instances as i", "i.environment_id", "e.id")
      .select(["e.id", "e.provider", "i.provider as instance_provider", "i.fs_status", "i.handle"])
      .where("e.id", "=", environmentId)
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw environmentNotFound();
    if (row.provider !== null && isInternalProvider(row.provider)) {
      if (this.providers.forName(row.provider) === undefined) {
        throw environmentUnavailable(row.provider);
      }
      return { id: row.id, provider: row.provider };
    }
    const current = this.providers.cloud()?.plugin;
    const provider = environmentProvider(
      {
        provider: row.provider,
        instanceProvider: row.instance_provider,
        fsStatus: row.fs_status,
        hasInstance: row.handle !== null,
      },
      current,
    );
    if (current === undefined || provider !== current) throw environmentUnavailable(provider);
    return { id: row.id, provider };
  }
}
