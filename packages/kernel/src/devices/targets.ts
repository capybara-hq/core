import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";

/**
 * Whether a device environment can still be served: `active` (live and an unrevoked machine),
 * `revoked` (live, no active machine: disconnected or signed out) or `deleted` (missing or
 * deleted, or its org deleted).
 */
export type DeviceTargetState = "active" | "revoked" | "deleted";

const ROOT_KEYS = ["workspace", "skills", "tmp"] as const;

/** Whether two sets of roots name the same three directories. */
export const sameRoots = (a: SandboxRoots, b: SandboxRoots): boolean =>
  ROOT_KEYS.every((k) => a[k] === b[k]);

/**
 * Reads a device environment and its machine from PG for the relay and the `@device` provider.
 * The relay asks {@link state} when a machine has no connection, so a revoked machine or a deleted
 * environment fails a waiting call at once instead of after the reconnect grace (ruling R27).
 * Kept apart from `MachinesService` (which depends on the relay) so there is no dependency cycle.
 */
@Injectable()
export class DeviceTargets {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  async state(environmentId: string): Promise<DeviceTargetState> {
    const row = await this.db
      .selectFrom("environments as e")
      .innerJoin("orgs as o", "o.id", "e.org_id")
      .leftJoin("environment_machines as m", (j) =>
        j.onRef("m.environment_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select(["e.id", "m.id as machine_id"])
      .where("e.id", "=", environmentId)
      .where("e.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) return "deleted";
    return row.machine_id === null ? "revoked" : "active";
  }

  /** The org of a live environment, or null (missing or deleted). */
  async orgOf(environmentId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("environments")
      .select("org_id")
      .where("id", "=", environmentId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row?.org_id ?? null;
  }

  /**
   * The roots the environment's active machine last reported in its hello frame, or null (no
   * active machine, or none reported yet).
   */
  async machineRoots(environmentId: string): Promise<SandboxRoots | null> {
    const row = await this.db
      .selectFrom("environment_machines")
      .select("roots")
      .where("environment_id", "=", environmentId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const r = row?.roots as Partial<Record<(typeof ROOT_KEYS)[number], unknown>> | null | undefined;
    if (!r || typeof r !== "object") return null;
    if (!ROOT_KEYS.every((k) => typeof r[k] === "string")) return null;
    return r as SandboxRoots;
  }
}
