import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { isInternalProvider, LOCAL_PROVIDER } from "./providers.js";

/**
 * Legacy retirement (permission runtime cutover phase 8.5): the durable legacy-launch freeze and
 * the physical no-reuse obligations of old instance incarnations (migration 0148).
 *
 * - **Freeze.** {@link freeze} writes the one freeze row under the platform authority writer (the
 *   exclusive platform permission lock). A legacy SID launch calls {@link admitLegacyDispatch}
 *   immediately before its dispatch, which takes the shared platform lock and refuses once the
 *   row exists; so when the freeze commits, every admission that passed before has committed its
 *   `dispatched` mark, and none passes after. A replica without this code is not fenced: it must
 *   be stopped or drained before the freeze (the rows it writes still read `unknown`, never
 *   "not dispatched", and the periodic re-scan picks them up).
 * - **Obligations.** {@link scan} enumerates, under the freeze, every legacy row whose processes
 *   may still exist (running with a SID, a reservation that may have dispatched, a stop in flight,
 *   `kill_pending` including terminal rows, a possibly dispatched launch that failed), and every
 *   revoked managed background start whose recorded generation no longer runs (the 8.4 handoff).
 *   Each becomes a member of the obligation of its device, provider and exact instance
 *   generation. A SID, PID or output text is never turned into an execution reference: it only
 *   names the row. Obligations live apart from the task rows, so output retention never removes
 *   them, and task finish and event semantics stay with the task's own finisher.
 * - **Resolution** is the sandbox service's, under the device's exclusive lifecycle lease
 *   (`SandboxService` gate): a cloud incarnation is destroyed whole by its provider (confirmed
 *   destruction, the file system kept) or found destroyed by a recorded confirmed destruction; a
 *   local one, a replaced cloud one without recorded destruction and an unknown one are
 *   quarantined. Nothing here resolves on a new generation, a restart, a local (no-op) destroy, a
 *   timeout or a process scan.
 */

/** The freeze's single row id. */
const FREEZE_ID = "platform" as const;

/** A generation as recorded: the decimal epoch millisecond, or `unknown`. */
const GENERATION_RE = /^[0-9]{1,16}$/;

/** An unresolved or resolved obligation as the gate reads it. */
export interface RetirementObligation {
  id: string;
  deviceId: string;
  orgId: string;
  provider: string;
  /** The exact instance generation (epoch ms as decimal text), or `unknown`. */
  instanceGeneration: string;
  state: "open" | "quarantined" | "resolved";
  reason: string | null;
  attempts: number;
}

/** {@link LegacyRetirementStore.admitLegacyDispatch}'s answer. */
export type LegacyDispatchAdmission =
  /** The launch may dispatch; its row is marked `dispatched` first. */
  | "admitted"
  /** The legacy-launch freeze is published: the launch must not dispatch. */
  | "frozen"
  /** The reservation is no longer a launchable legacy row (finished meanwhile). */
  | "gone";

/** What the release gate reads: unresolved obligations are reported, never called retired. */
export interface LegacyRetirementReport {
  frozen: boolean;
  open: number;
  quarantined: number;
  resolved: number;
  /** Members of resolved obligations whose own records are not settled yet. */
  unsettledMembers: number;
  /** True only with the freeze published and every obligation resolved and settled. */
  retired: boolean;
  unresolved: {
    deviceId: string;
    provider: string;
    instanceGeneration: string;
    state: "open" | "quarantined";
    reason: string | null;
  }[];
}

/** A member of an obligation (a legacy task row, or a revoked managed start). */
export interface RetirementMember {
  obligationId: string;
  kind: "legacy-task" | "revoked-start";
  refId: string;
}

/** Whether `provider` is a cloud provider (one whose whole-instance destroy is confirmed). */
export const isCloudProvider = (provider: string): boolean =>
  provider !== "unknown" && !isInternalProvider(provider);

/** The epoch millisecond of `d` as recorded generation text. */
const generationOf = (d: Date): string => String(d.getTime());

const toObligation = (r: {
  id: string;
  device_id: string;
  org_id: string;
  provider: string;
  instance_generation: string;
  state: "open" | "quarantined" | "resolved";
  reason: string | null;
  attempts: number;
}): RetirementObligation => ({
  id: r.id,
  deviceId: r.device_id,
  orgId: r.org_id,
  provider: r.provider,
  instanceGeneration: r.instance_generation,
  state: r.state,
  reason: r.reason,
  attempts: r.attempts,
});

@Injectable()
export class LegacyRetirementStore {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
  ) {}

  /**
   * Publishes the legacy-launch freeze under the platform authority writer; idempotent. Returns
   * when it was first published. Never undone.
   */
  @Transactional({ propagation: "requires_new" })
  async freeze(by: string): Promise<Date> {
    await this.locks.acquire({}, { kind: "write", level: "platform" });
    await this.db
      .insertInto("legacy_launch_freeze")
      .values({ id: FREEZE_ID, frozen_by: by.slice(0, 200) || "unknown" })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    const row = await this.db
      .selectFrom("legacy_launch_freeze")
      .select("frozen_at")
      .where("id", "=", FREEZE_ID)
      .executeTakeFirstOrThrow();
    return row.frozen_at;
  }

  async frozen(): Promise<boolean> {
    const row = await this.db
      .selectFrom("legacy_launch_freeze")
      .select("id")
      .where("id", "=", FREEZE_ID)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The check every legacy SID launch makes immediately before it dispatches its command: under
   * the shared platform authority lock (so a concurrent {@link freeze} waits for it), refuses once
   * the freeze is published; otherwise marks the reservation `dispatched` in the same transaction.
   */
  @Transactional({ propagation: "requires_new" })
  async admitLegacyDispatch(orgId: string, taskId: string): Promise<LegacyDispatchAdmission> {
    await this.locks.acquire({ orgId }, { kind: "admit" });
    if (await this.frozen()) return "frozen";
    const r = await this.db
      .updateTable("background_tasks")
      .set({ legacy_dispatch: "dispatched" })
      .where("id", "=", taskId)
      .where("org_id", "=", orgId)
      .where("status", "=", "running")
      .where("sid", "is", null)
      .where("launch_state", "=", "legacy")
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1 ? "admitted" : "gone";
  }

  /**
   * One enumeration pass: every legacy row (only once the freeze is published) and every revoked
   * managed start that may still own processes on an incarnation that no longer runs, recorded as
   * members of their obligations. Idempotent; returns how many new members it recorded. The
   * worker repeats it every tick, so a row an old unfenced replica writes later is still found.
   */
  async scan(): Promise<{ added: number }> {
    let added = 0;
    if (await this.frozen()) added += await this.scanLegacyTasks();
    added += await this.scanRevokedStarts();
    return { added };
  }

  /** Repeats {@link scan} until a pass adds nothing (at most `maxPasses`). */
  async scanUntilStable(maxPasses = 5): Promise<{ added: number; stable: boolean }> {
    let added = 0;
    for (let i = 0; i < maxPasses; i++) {
      const pass = await this.scan();
      added += pass.added;
      if (pass.added === 0) return { added, stable: true };
    }
    return { added, stable: false };
  }

  private async scanLegacyTasks(): Promise<number> {
    const rows = await this.db
      .selectFrom("background_tasks as t")
      .leftJoin("devices as d", "d.id", "t.device_id")
      .leftJoin("device_instances as i", "i.device_id", "t.device_id")
      .select([
        "t.id",
        "t.org_id",
        "t.device_id",
        "t.sandbox_created_at",
        "d.source",
        "i.provider as instance_provider",
        "i.created_at as instance_created_at",
        "i.status as instance_status",
      ])
      .where("t.launch_state", "=", "legacy")
      .where("t.device_id", "is not", null)
      .where(
        sql<boolean>`(
          (t.status = 'running' AND (t.sid IS NOT NULL OR t.legacy_dispatch <> 'reserved'))
          OR t.kill_pending
          OR (t.sid IS NULL AND t.legacy_dispatch <> 'reserved')
        )`,
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("device_retirement_members as m")
              .select("m.ref_id")
              .where("m.kind", "=", "legacy-task")
              .whereRef("m.ref_id", "=", "t.id"),
          ),
        ),
      )
      .orderBy("t.started_at", "asc")
      .orderBy("t.id", "asc")
      .execute();
    let added = 0;
    for (const r of rows) {
      const deviceId = r.device_id as string;
      const live =
        r.instance_created_at !== null &&
        r.instance_status !== null &&
        ["creating", "running", "suspended"].includes(r.instance_status);
      const generation =
        r.sandbox_created_at !== null
          ? generationOf(new Date(r.sandbox_created_at))
          : live && r.instance_created_at
            ? generationOf(r.instance_created_at)
            : "unknown";
      const current =
        r.instance_created_at !== null && generationOf(r.instance_created_at) === generation;
      const provider =
        r.source === "local"
          ? LOCAL_PROVIDER
          : current && r.instance_provider
            ? r.instance_provider
            : (r.instance_provider ?? "unknown");
      if (await this.addMember(deviceId, r.org_id, provider, generation, "legacy-task", r.id))
        added++;
    }
    return added;
  }

  private async scanRevokedStarts(): Promise<number> {
    const rows = await this.db
      .selectFrom("sandbox_operation_intents as o")
      .select(["o.operation_id", "o.org_id", "o.device_id", "o.provider", "o.instance_generation"])
      .where("o.method", "=", "backgroundStart")
      .where("o.state", "=", "revoked")
      .where("o.revoke_acknowledged", "=", false)
      .where("o.execution_ref", "is not", null)
      // the recorded incarnation is no longer the one running (replaced, destroyed, suspended):
      // the revoke worker cannot reach it there
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("device_instances as d")
              .select("d.device_id")
              .whereRef("d.device_id", "=", "o.device_id")
              .whereRef("d.provider", "=", "o.provider")
              .where("d.status", "=", "running")
              .where(
                sql<boolean>`floor(extract(epoch from d.created_at) * 1000)::bigint::text = o.instance_generation`,
              ),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("device_retirement_members as m")
              .select("m.ref_id")
              .where("m.kind", "=", "revoked-start")
              .whereRef("m.ref_id", "=", "o.operation_id"),
          ),
        ),
      )
      .orderBy("o.operation_id")
      .execute();
    let added = 0;
    for (const r of rows) {
      const generation = GENERATION_RE.test(r.instance_generation)
        ? r.instance_generation
        : "unknown";
      if (
        await this.addMember(
          r.device_id,
          r.org_id,
          r.provider,
          generation,
          "revoked-start",
          r.operation_id,
        )
      )
        added++;
    }
    return added;
  }

  /** The obligation of the incarnation (created when missing), with the member added. */
  @Transactional({ propagation: "requires_new" })
  private async addMember(
    deviceId: string,
    orgId: string,
    provider: string,
    generation: string,
    kind: RetirementMember["kind"],
    refId: string,
  ): Promise<boolean> {
    await this.db
      .insertInto("device_retirement_obligations")
      .values({
        device_id: deviceId,
        org_id: orgId,
        provider,
        instance_generation: generation,
      })
      .onConflict((oc) => oc.columns(["device_id", "provider", "instance_generation"]).doNothing())
      .execute();
    const obligation = await this.db
      .selectFrom("device_retirement_obligations")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("provider", "=", provider)
      .where("instance_generation", "=", generation)
      .executeTakeFirstOrThrow();
    const r = await this.db
      .insertInto("device_retirement_members")
      .values({ obligation_id: obligation.id, kind, ref_id: refId })
      .onConflict((oc) => oc.columns(["kind", "ref_id", "obligation_id"]).doNothing())
      .returning("ref_id")
      .executeTakeFirst();
    return r !== undefined;
  }

  /** The device's unresolved obligations (open and quarantined), oldest first. */
  async unresolved(deviceId: string): Promise<RetirementObligation[]> {
    const rows = await this.db
      .selectFrom("device_retirement_obligations")
      .select([
        "id",
        "device_id",
        "org_id",
        "provider",
        "instance_generation",
        "state",
        "reason",
        "attempts",
      ])
      .where("device_id", "=", deviceId)
      .where("state", "<>", "resolved")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toObligation);
  }

  /** Whether the device has an unresolved obligation (the shared-path check). */
  async hasUnresolved(deviceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("device_retirement_obligations")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("state", "<>", "resolved")
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * No trusted way to establish termination: the obligation is quarantined (the device stays
   * unavailable). A resolved obligation is left as it is.
   */
  async quarantine(id: string, reason: string): Promise<void> {
    await this.db
      .updateTable("device_retirement_obligations")
      .set((eb) => ({
        state: "quarantined",
        reason: reason.slice(0, 1000),
        attempts: eb("attempts", "+", 1),
        last_attempt_at: sql<Date>`now()`,
      }))
      .where("id", "=", id)
      .where("state", "<>", "resolved")
      .execute();
  }

  /** A failed destroy or verification: the obligation stays as it is, the attempt is recorded. */
  async noteFailure(id: string, error: unknown): Promise<void> {
    const text = error instanceof Error ? error.message : String(error);
    await this.db
      .updateTable("device_retirement_obligations")
      .set((eb) => ({
        attempts: eb("attempts", "+", 1),
        last_attempt_at: sql<Date>`now()`,
        last_error: text.slice(0, 1000),
      }))
      .where("id", "=", id)
      .where("state", "<>", "resolved")
      .execute();
  }

  /** The provider confirmed the incarnation destroyed: the obligation resolves. */
  async resolveDestroyed(id: string): Promise<void> {
    await this.db
      .updateTable("device_retirement_obligations")
      .set({
        state: "resolved",
        resolution: "provider-destroyed",
        resolved_at: sql<Date>`now()`,
        last_error: null,
      })
      .where("id", "=", id)
      .where("state", "<>", "resolved")
      .execute();
  }

  /**
   * Records the provider-confirmed destruction of a cloud incarnation. A kernel-internal
   * provider's destroy (a local machine: a no-op) is never evidence and is refused.
   */
  async recordDestruction(deviceId: string, provider: string, generation: string): Promise<void> {
    if (!isCloudProvider(provider))
      throw new Error(`A ${provider} destroy is not evidence of destruction`);
    if (!GENERATION_RE.test(generation)) throw new Error(`invalid generation ${generation}`);
    await this.db
      .insertInto("device_instance_destructions")
      .values({ device_id: deviceId, provider, instance_generation: generation })
      .onConflict((oc) => oc.columns(["device_id", "provider", "instance_generation"]).doNothing())
      .execute();
  }

  /** Whether a confirmed destruction of exactly that cloud incarnation was recorded. */
  async destructionRecorded(
    deviceId: string,
    provider: string,
    generation: string,
  ): Promise<boolean> {
    if (!isCloudProvider(provider) || !GENERATION_RE.test(generation)) return false;
    const row = await this.db
      .selectFrom("device_instance_destructions")
      .select("device_id")
      .where("device_id", "=", deviceId)
      .where("provider", "=", provider)
      .where("instance_generation", "=", generation)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Devices with an unresolved obligation the worker should try now: never attempted, or last
   * attempted longer ago than the backoff (30 s doubling per attempt, at most an hour).
   */
  async due(limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom("device_retirement_obligations")
      .select("device_id")
      .where("state", "<>", "resolved")
      .where(
        sql<boolean>`(last_attempt_at IS NULL OR last_attempt_at <
          now() - LEAST(3600, 30 * power(2, LEAST(attempts, 7))) * interval '1 second')`,
      )
      .groupBy("device_id")
      .orderBy(sql`min(last_attempt_at) ASC NULLS FIRST`)
      .orderBy("device_id")
      .limit(limit)
      .execute();
    return rows.map((r) => r.device_id);
  }

  /** Members of resolved obligations whose own records are not settled yet. */
  async unsettledMembers(limit: number): Promise<RetirementMember[]> {
    const rows = await this.db
      .selectFrom("device_retirement_members as m")
      .innerJoin("device_retirement_obligations as o", "o.id", "m.obligation_id")
      .select(["m.obligation_id", "m.kind", "m.ref_id"])
      .where("o.state", "=", "resolved")
      .where("m.settled", "=", false)
      .orderBy("m.created_at", "asc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({ obligationId: r.obligation_id, kind: r.kind, refId: r.ref_id }));
  }

  async markSettled(m: RetirementMember): Promise<void> {
    await this.db
      .updateTable("device_retirement_members")
      .set({ settled: true })
      .where("obligation_id", "=", m.obligationId)
      .where("kind", "=", m.kind)
      .where("ref_id", "=", m.refId)
      .execute();
  }

  /** The release gate's honest view (a quarantined device is unavailable, not retired). */
  async report(): Promise<LegacyRetirementReport> {
    const frozen = await this.frozen();
    const counts = await this.db
      .selectFrom("device_retirement_obligations")
      .select(["state", (eb) => eb.fn.countAll<string>().as("n")])
      .groupBy("state")
      .execute();
    const n = (s: string) => Number(counts.find((c) => c.state === s)?.n ?? 0);
    const unsettled = await this.db
      .selectFrom("device_retirement_members as m")
      .innerJoin("device_retirement_obligations as o", "o.id", "m.obligation_id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("o.state", "=", "resolved")
      .where("m.settled", "=", false)
      .executeTakeFirstOrThrow();
    const unresolved = await this.db
      .selectFrom("device_retirement_obligations")
      .select(["device_id", "provider", "instance_generation", "state", "reason"])
      .where("state", "<>", "resolved")
      .orderBy("created_at", "asc")
      .execute();
    const open = n("open"),
      quarantined = n("quarantined"),
      unsettledMembers = Number(unsettled.n);
    return {
      frozen,
      open,
      quarantined,
      resolved: n("resolved"),
      unsettledMembers,
      retired: frozen && open === 0 && quarantined === 0 && unsettledMembers === 0,
      unresolved: unresolved.map((r) => ({
        deviceId: r.device_id,
        provider: r.provider,
        instanceGeneration: r.instance_generation,
        state: r.state as "open" | "quarantined",
        reason: r.reason,
      })),
    };
  }
}
