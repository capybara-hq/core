import { randomUUID } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type UpdateObject } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { SandboxLockLostError } from "./leases.js";
import { PermissionCeilingWrites } from "./permission-ceiling-writes.js";
import { LOCAL_PROVIDER } from "./providers.js";

const rootKey = (r: SandboxRoots) => JSON.stringify([r.workspace, r.skills, r.tmp]);
/** The greatest epoch millisecond a JavaScript Date (and so a generation) can represent. */
export const MAX_GENERATION_MS = 8_640_000_000_000_000;
const GENERATION = /^[0-9]{1,16}$/;

/** Prior generation identity that cannot be ordered; conversion stops instead of guessing. */
export class InconsistentGenerationError extends Error {
  override name = "InconsistentGenerationError";
}

/**
 * Final handle publication only; provider IO stays under the caller's exclusive lease outside this
 * transaction. It also allocates the instance generation (permission runtime cutover B4): the
 * row's `created_at` is an exact epoch millisecond above the device's durable high-water mark, and
 * a local instance gets a fresh `awaiting-device` binding the lifecycle coordinator sends after
 * commit.
 */
@Injectable()
export class PermissionInstanceWrites {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
  ) {}
  @Transactional({ propagation: "requires_new" })
  async commitHandle(
    orgId: string,
    deviceId: string,
    generation: number,
    roots: SandboxRoots,
    set: UpdateObject<KernelDatabase, "device_instances">,
    signal: AbortSignal,
  ): Promise<Date> {
    signal.throwIfAborted();
    await this.ceilings.lock({ orgId, deviceId }, "device");
    const row = await this.db
      .selectFrom("device_instances")
      .select(["generation", "permission_roots", "provider"])
      .where("device_id", "=", deviceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.generation !== generation)
      throw new SandboxLockLostError(deviceId, "generation");
    if (rootKey(row.permission_roots ?? (await this.displayedRoots(deviceId))) !== rootKey(roots))
      await this.ceilings.publishLocked({ orgId, deviceId }, "device", true, true);
    signal.throwIfAborted();
    const createdAt = new Date(await this.allocateGenerationLocked(deviceId));
    const updated = await this.db
      .updateTable("device_instances")
      .set({
        ...set,
        created_at: createdAt,
        permission_roots: JSON.stringify(roots),
        generation: generation + 1,
      })
      .where("device_id", "=", deviceId)
      .where("generation", "=", generation)
      .returning(["created_at", "provider"])
      .executeTakeFirst();
    if (!updated) throw new SandboxLockLostError(deviceId, "generation");
    if (updated.created_at.getTime() !== createdAt.getTime())
      throw new Error("Instance generation was not stored exactly; check the database clock type");
    if ((updated.provider ?? row.provider) === LOCAL_PROVIDER)
      await this.awaitDevice(deviceId, String(createdAt.getTime()));
    return updated.created_at;
  }

  /**
   * The roots a person saw before the first instance: the machine's reported roots for a local
   * device (what the Full consent displayed), else the provider defaults. The first create that
   * lands on those roots is proof of what was consented to, not a changed reach.
   */
  private async displayedRoots(deviceId: string): Promise<SandboxRoots> {
    const machine = await this.db
      .selectFrom("device_machines")
      .select("roots")
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const reported = machine?.roots as Partial<SandboxRoots> | null | undefined;
    return reported && typeof reported === "object"
      ? { ...DEFAULT_SANDBOX_ROOTS, ...reported }
      : DEFAULT_SANDBOX_ROOTS;
  }

  /** Test seam: the database clock in epoch milliseconds. */
  protected async databaseNowMs(): Promise<number> {
    const r = await sql<{ ms: string }>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms`.execute(
      this.db.db,
    );
    return Number(r.rows[0]?.ms);
  }

  /**
   * `max(database now, highWater + 1)` under the device authority lock, committed with the
   * instance row. The mark is initialized once from every recorded generation of the device
   * (instance, bindings, operation intents, managed tasks, runtime reports), so a deleted row, a
   * rolled-back clock or two creates in one millisecond never reuse a generation.
   */
  private async allocateGenerationLocked(deviceId: string): Promise<number> {
    const mark = await this.db
      .selectFrom("device_generation_high_water")
      .select("high_water_ms")
      .where("device_id", "=", deviceId)
      .forUpdate()
      .executeTakeFirst();
    const high = mark ? Number(mark.high_water_ms) : await this.initialHighWater(deviceId);
    const next = Math.max(await this.databaseNowMs(), high + 1);
    if (!Number.isSafeInteger(next) || next > MAX_GENERATION_MS)
      throw new Error("Instance generation range is exhausted for this device");
    await this.db
      .insertInto("device_generation_high_water")
      .values({ device_id: deviceId, high_water_ms: next })
      .onConflict((oc) =>
        oc.column("device_id").doUpdateSet({ high_water_ms: next, updated_at: sql`now()` }),
      )
      .execute();
    return next;
  }

  private async initialHighWater(deviceId: string): Promise<number> {
    const [instance, bindings, intents, tasks, reports] = await Promise.all([
      this.db
        .selectFrom("device_instances")
        .select(["created_at", "had_instance"])
        .where("device_id", "=", deviceId)
        .execute(),
      this.db
        .selectFrom("device_instance_bindings")
        .select("instance_generation as g")
        .where("device_id", "=", deviceId)
        .execute(),
      this.db
        .selectFrom("sandbox_operation_intents")
        .select("instance_generation as g")
        .where("device_id", "=", deviceId)
        .execute(),
      this.db
        .selectFrom("background_tasks")
        .select("instance_generation as g")
        .where("device_id", "=", deviceId)
        .where("instance_generation", "is not", null)
        .execute(),
      this.db
        .selectFrom("device_permission_reports")
        .select("instance_generation as g")
        .where("device_id", "=", deviceId)
        .execute(),
    ]);
    let high = 0;
    for (const r of instance) if (r.had_instance) high = Math.max(high, r.created_at.getTime());
    for (const { g } of [...bindings, ...intents, ...tasks, ...reports]) {
      if (g === null) continue;
      if (!GENERATION.test(g) || Number(g) > MAX_GENERATION_MS)
        throw new InconsistentGenerationError(
          `Device ${deviceId} records an unordered instance generation; repair it before creating an instance`,
        );
      high = Math.max(high, Number(g));
    }
    return high;
  }

  /** The committed binding the coordinator sends; the previous one is the last installed. */
  private async awaitDevice(deviceId: string, instanceGeneration: string): Promise<void> {
    const previous = await this.db
      .selectFrom("device_instance_bindings")
      .select("instance_generation")
      .where("device_id", "=", deviceId)
      .where("status", "=", "installed")
      .orderBy(sql`instance_generation::bigint`, "desc")
      .limit(1)
      .executeTakeFirst();
    await this.db
      .insertInto("device_instance_bindings")
      .values({
        device_id: deviceId,
        instance_generation: instanceGeneration,
        binding_id: randomUUID(),
        provider: LOCAL_PROVIDER,
        previous_generation: previous?.instance_generation ?? null,
        status: "awaiting-device",
      })
      .execute();
  }
}
