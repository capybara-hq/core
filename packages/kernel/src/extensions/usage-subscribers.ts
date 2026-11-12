import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { enabledExtensionsQuery } from "./enabled.js";

/**
 * Plugins that subscribe to `usage.report` according to deployment state: an approved permission
 * snapshot that declares the `usage.report` hook, for a plugin the deployment still knows: an enabled
 * install, or a config-declared plugin with a replica status row that is not `unloaded`. With `orgId`, only plugins
 * the organization enabled (org config rows and required bootstrap plugins).
 */
export async function queryUsageSubscribers(
  db: KernelSchemaDb,
  orgId?: string,
): Promise<Set<string>> {
  let q = db
    .selectFrom("extension_permission_snapshots as s")
    .select("s.plugin")
    .where(sql<boolean>`s.permissions -> 'permissions' -> 'hooks' ? 'usage.report'`)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom("extension_installs as i")
            .select(sql`1`.as("one"))
            .whereRef("i.name", "=", "s.plugin")
            .where("i.desired_state", "=", "enabled"),
        ),
        // config-declared plugins still declared (and not unloaded) on some replica; installs are
        // covered by desired_state above (their replica rows linger as `unloaded` when disabled)
        eb.exists(
          eb
            .selectFrom("extension_replica_status as r")
            .select(sql`1`.as("one"))
            .whereRef("r.plugin", "=", "s.plugin")
            .where("r.source", "=", "config")
            .where("r.state", "<>", "unloaded"),
        ),
      ]),
    );
  if (orgId !== undefined) {
    q = q.where("s.plugin", "in", enabledExtensionsQuery(db, orgId));
  }
  return new Set((await q.execute()).map((r) => r.plugin));
}

/** How long one replica trusts its answer to "does any plugin subscribe" (spec §8.1). */
export const USAGE_SUBSCRIBERS_TTL_MS = 30_000;

/**
 * Test seam (`KernelOverride`): the clock {@link UsageSubscribers} ages its cached answer with
 * (default `Date.now`); the kernel never provides it.
 */
export const USAGE_SUBSCRIBERS_CLOCK = Symbol("USAGE_SUBSCRIBERS_CLOCK");

/**
 * Whether the deployment has at least one `usage.report` subscriber ({@link queryUsageSubscribers}
 * without an org), which decides whether a usage write owes a delivery (transactional outbox spec
 * §8.1): a usage event written while no plugin subscribes is never reported, later subscribers
 * included. The answer comes from PG, not from this replica's loaded handlers, so a replica that
 * has no handler still owes the delivery another replica makes.
 *
 * Per-process memoisation of that PG read: kept {@link USAGE_SUBSCRIBERS_TTL_MS} and cleared on
 * `PLUGINS_CHANGED` (`ExtensionLifecycle` calls {@link invalidate}), so an enabled subscriber is
 * seen at once, or within 30 s when the bus message is lost. It holds no state another request or
 * replica relies on.
 */
@Injectable()
export class UsageSubscribers {
  private cached: { any: boolean; at: number } | undefined;
  /** Bumped by {@link invalidate}: a read that started before it does not refill the cache. */
  private generation = 0;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Optional()
    @Inject(USAGE_SUBSCRIBERS_CLOCK)
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether any plugin subscribes (cached; the read joins the caller's transaction, if any). */
  async any(): Promise<boolean> {
    const at = this.now();
    const c = this.cached;
    if (c !== undefined && at - c.at < USAGE_SUBSCRIBERS_TTL_MS) return c.any;
    const generation = this.generation;
    const any = (await queryUsageSubscribers(this.kdb.db)).size > 0;
    if (generation === this.generation) this.cached = { any, at };
    return any;
  }

  /** Forgets the cached answer (a plugin was installed, enabled, upgraded or removed). */
  invalidate(): void {
    this.generation++;
    this.cached = undefined;
  }
}

/** {@link UsageSubscribers}: below the extension host, so the model broker and the runtime use it. */
@Module({
  providers: [UsageSubscribers],
  exports: [UsageSubscribers],
})
export class UsageSubscribersModule {}
