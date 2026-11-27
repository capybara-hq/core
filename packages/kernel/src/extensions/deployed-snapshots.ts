import { deviceServiceId } from "@capybara-hq/plugin-sdk";
import { type ExpressionBuilder, sql } from "kysely";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * The device service ids (`<extension>.<name>`, `deviceServiceId`) the deployment's approved
 * extensions declare in `permissions.deviceAccess.services`, by {@link deployedSnapshot} (the approved version is the one installed enabled or served),
 * whatever any org enabled. Sorted; a pair that is not a valid service id is left out.
 */
export async function queryDeclaredDeviceServices(db: KernelSchemaDb): Promise<string[]> {
  const rows = await db
    .selectFrom("extension_permission_snapshots as s")
    .select([
      "s.plugin",
      sql<unknown>`s.permissions -> 'permissions' -> 'deviceAccess' -> 'services'`.as("services"),
    ])
    .where(
      sql<boolean>`jsonb_typeof(s.permissions -> 'permissions' -> 'deviceAccess' -> 'services') = 'array'`,
    )
    .where(deployedSnapshot)
    .execute();
  const ids = new Set<string>();
  for (const r of rows) {
    if (!Array.isArray(r.services)) continue;
    for (const name of r.services) {
      if (typeof name !== "string") continue;
      try {
        ids.add(deviceServiceId(r.plugin, name));
      } catch {
        // an id the provider would refuse is never running
      }
    }
  }
  return [...ids].sort();
}

/**
 * Whether the approved permission snapshot `s` is of the version the deployment runs: an enabled
 * install of that version, or a replica status row (not `unloaded`) that loaded or still serves it
 * (an upgrade pending approval keeps serving the approved version; a config-declared plugin has
 * only replica rows). A snapshot approved for another version does not count.
 */
export function deployedSnapshot(
  eb: ExpressionBuilder<
    KernelDatabase & { s: KernelDatabase["extension_permission_snapshots"] },
    "s"
  >,
) {
  return eb.or([
    eb.exists(
      eb
        .selectFrom("extension_installs as i")
        .select(sql`1`.as("one"))
        .whereRef("i.name", "=", "s.plugin")
        .whereRef("i.version", "=", "s.version")
        .where("i.desired_state", "=", "enabled"),
    ),
    eb.exists(
      eb
        .selectFrom("extension_replica_status as r")
        .select(sql`1`.as("one"))
        .whereRef("r.plugin", "=", "s.plugin")
        .where("r.state", "<>", "unloaded")
        .where((r) =>
          r.or([
            r("r.version", "=", r.ref("s.version")),
            r("r.serving_version", "=", r.ref("s.version")),
          ]),
        ),
    ),
  ]);
}
