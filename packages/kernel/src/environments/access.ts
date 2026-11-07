import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { SandboxProviders } from "../sandbox/providers.js";
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
 * The provider an environment works with: the one keeping its files or instance once it has any
 * (they are never migrated, spec §4.2 item 13); before that, the current provider (its first use
 * creates them there), else the one recorded at creation. The same rule as `SandboxService`'s use.
 */
export function environmentProvider(f: ProviderFacts, current: string | undefined): string | null {
  const holdsResources = f.fsStatus !== null && (f.fsStatus !== "none" || f.hasInstance);
  if (holdsResources) return f.instanceProvider;
  return current ?? f.provider;
}

/** The environment's provider is not the current one, or there is no provider (503). */
export const environmentUnavailable = (provider: string | null): ApiError =>
  new ApiError(
    "environment.unavailable",
    provider === null
      ? "No cloud sandbox is available in this deployment; ask the super admin to enable a sandbox plugin"
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
    @Inject(SandboxProviders) private readonly providers: Pick<SandboxProviders, "current">,
  ) {}

  /**
   * The environment if `accountId` may use it in `orgId` now: `environment.not_found` when it is
   * missing, deleted, in another org or someone else's; `environment.unavailable` when its
   * provider is not the current one (or there is none).
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
    const current = this.providers.current()?.plugin;
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
