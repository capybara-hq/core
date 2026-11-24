import type {
  SandboxHandle,
  SandboxPermissionSupport,
  SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type UpdateObject } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { canonicalJson } from "../tools/canonical-json.js";
import { SandboxLockLostError } from "./leases.js";
import { PermissionCeilingWrites } from "./permission-ceiling-writes.js";
import { PermissionRuntimeReports } from "./permission-runtime-reports.js";

const rootKey = (r: SandboxRoots) => JSON.stringify([r.workspace, r.skills, r.tmp]);
/** The greatest epoch millisecond a JavaScript Date (and so a generation) can represent. */
export const MAX_GENERATION_MS = 8_640_000_000_000_000;
const GENERATION = /^[0-9]{1,16}$/;

/** A provider's permission support read from the instance being committed (B-15). */
export interface SupportReport {
  provider: string;
  version: string;
  report: SandboxPermissionSupport;
}

/** The instance a lifecycle holder probed: its handle, generation and limits before the probe. */
export interface ProbedInstance {
  handle: SandboxHandle;
  createdAt: number;
  limits: unknown;
}

/** Prior generation identity that cannot be ordered; conversion stops instead of guessing. */
export class InconsistentGenerationError extends Error {
  override name = "InconsistentGenerationError";
}

/**
 * Final handle publication only; provider IO stays under the caller's exclusive lease outside this
 * transaction. It also allocates the instance generation (permission runtime cutover B4): the
 * row's `created_at` is an exact epoch millisecond above the device's durable high-water mark.
 */
@Injectable()
export class PermissionInstanceWrites {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Inject(PermissionRuntimeReports) private readonly reports: PermissionRuntimeReports,
  ) {}
  /**
   * `evidence`: the permission support the lifecycle holder read from the new instance before this
   * commit, recorded with the kernel-built identity in this same transaction, so the committed
   * handle and its evidence appear together (B-15). Absent: none recorded (a failed read leaves
   * the instance unprobed).
   */
  @Transactional({ propagation: "requires_new" })
  async commitHandle(
    orgId: string,
    deviceId: string,
    generation: number,
    roots: SandboxRoots,
    set: UpdateObject<KernelDatabase, "device_instances">,
    signal: AbortSignal,
    evidence?: SupportReport,
  ): Promise<Date> {
    signal.throwIfAborted();
    await this.lockDevice(orgId, deviceId);
    await this.ceilings.lock({ orgId, deviceId }, "device");
    const row = await this.db
      .selectFrom("device_instances")
      .select(["generation", "permission_roots"])
      .where("device_id", "=", deviceId)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.generation !== generation)
      throw new SandboxLockLostError(deviceId, "generation");
    // a device that never had an instance has no committed roots: its first commit is what the
    // person consented to (a consent names the device and its project, never roots it could not
    // know yet), not a changed reach; a later instance on other roots is
    if (row.permission_roots !== null && rootKey(row.permission_roots) !== rootKey(roots))
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
      .where("org_id", "=", orgId)
      .where("generation", "=", generation)
      .returning("created_at")
      .executeTakeFirst();
    if (!updated) throw new SandboxLockLostError(deviceId, "generation");
    if (updated.created_at.getTime() !== createdAt.getTime())
      throw new Error("Instance generation was not stored exactly; check the database clock type");
    if (evidence)
      await this.reports.recordSupport(
        deviceId,
        evidence.provider,
        evidence.version,
        evidence.report,
      );
    return updated.created_at;
  }

  /**
   * Records an instance's permission support read after a resume, a limits change, a provider
   * version change or a new report revision, under the caller's lifecycle lease (B-15). Recorded only while the
   * row still holds exactly the probed instance (its handle and generation) with the limits read
   * before the probe: a holder whose lease was lost to one that replaced the instance or changed
   * its limits records nothing, so it never overwrites newer evidence. Never provider IO inside
   * the transaction.
   */
  @Transactional({ propagation: "requires_new" })
  async recordSupport(
    orgId: string,
    deviceId: string,
    held: ProbedInstance,
    support: SupportReport,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (!(await this.lockProbed(orgId, deviceId, held, support.provider))) return false;
    await this.reports.recordSupport(deviceId, support.provider, support.version, support.report);
    return true;
  }

  /**
   * Clears the recorded identity of the probed instance (same checks as {@link recordSupport}): a
   * resumed instance whose permission support could not be read is unprobed, never supported by
   * evidence from before its suspension.
   */
  @Transactional({ propagation: "requires_new" })
  async clearSupport(
    orgId: string,
    deviceId: string,
    held: ProbedInstance,
    provider: string,
  ): Promise<boolean> {
    if (!(await this.lockProbed(orgId, deviceId, held, provider))) return false;
    await this.reports.clearSupport(deviceId, provider);
    return true;
  }

  /**
   * The device row lock, before the authority writer lock (the device writers' order): the
   * support recorded is stored on the device row too ({@link PermissionRuntimeReports.recordSupport}).
   */
  private async lockDevice(orgId: string, deviceId: string): Promise<void> {
    await this.db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  }

  /** Takes the device writer lock; true while the row still holds exactly the probed instance. */
  private async lockProbed(
    orgId: string,
    deviceId: string,
    held: ProbedInstance,
    provider: string,
  ): Promise<boolean> {
    await this.lockDevice(orgId, deviceId);
    await this.ceilings.lock({ orgId, deviceId }, "device");
    const row = await this.db
      .selectFrom("device_instances")
      .select(["handle", "created_at", "provider", "instance_limits"])
      .where("device_id", "=", deviceId)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
    return (
      !!row?.handle &&
      row.provider === provider &&
      row.created_at.getTime() === held.createdAt &&
      canonicalJson(row.handle) === canonicalJson(held.handle) &&
      canonicalJson(row.instance_limits ?? null) === canonicalJson(held.limits ?? null)
    );
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
   * (instance, operation intents, managed tasks, runtime reports), so a deleted row, a
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

  // org-filter: only reached from commitHandle, which locked this device row by its org first;
  // the mark must count every recorded generation of the device
  private async initialHighWater(deviceId: string): Promise<number> {
    const [instance, intents, tasks, reports] = await Promise.all([
      this.db
        .selectFrom("device_instances")
        .select(["created_at", "had_instance"])
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
    for (const { g } of [...intents, ...tasks, ...reports]) {
      if (g === null) continue;
      if (!GENERATION.test(g) || Number(g) > MAX_GENERATION_MS)
        throw new InconsistentGenerationError(
          `Device ${deviceId} records an unordered instance generation; repair it before creating an instance`,
        );
      high = Math.max(high, Number(g));
    }
    return high;
  }
}
