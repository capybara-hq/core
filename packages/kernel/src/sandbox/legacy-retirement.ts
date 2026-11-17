import { isDeviceBootId } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { isInternalProvider, LOCAL_PROVIDER } from "./providers.js";

/**
 * Legacy retirement (permission runtime cutover phase 8.5): the durable legacy-launch freeze and
 * the physical no-reuse obligations of old instance incarnations (migration 0156).
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
  state: "open" | "quarantined" | "resolved" | "abandoned";
  reason: string | null;
  attempts: number;
  /** A local incarnation's boot identity when recorded; null: none (never resolves by itself). */
  bootId: string | null;
  /** When it was recorded (a cloud `unknown` one resolves only if recorded after the freeze). */
  createdAt: Date;
}

/** {@link LegacyRetirementStore.recordBoot}'s answer. */
export type BootReport =
  /** First seen for the machine: its current boot now (a restart when one was seen before). */
  | "new"
  /** The machine's current boot again (a reconnect). */
  | "current"
  /** A boot seen before a later one (stale or replayed): ignored. */
  | "stale"
  /** Malformed, or the machine is unknown or revoked: ignored. */
  | "ignored";

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
  /**
   * True only with the freeze published and every obligation not abandoned resolved and settled.
   * Abandoned ones are excluded: see {@link cleanRetirement}.
   */
  retired: boolean;
  /** {@link retired} with no abandoned obligation either. */
  cleanRetirement: boolean;
  /** Obligations abandoned with their deleted devices: never evidence the processes ended. */
  abandoned: number;
  /** Members of abandoned obligations (left unsettled; not in {@link unsettledMembers}). */
  abandonedMembers: number;
  abandonedList: {
    deviceId: string;
    provider: string;
    instanceGeneration: string;
    local: boolean;
    bootKnown: boolean;
    abandonedAt: Date;
  }[];
  /**
   * The cloud pre-check (before the freeze, too): cloud devices with legacy rows whose incarnation
   * or provider is unknown. It reads the task rows, so it lists what the freeze will turn into
   * such obligations; it does not empty by itself. After the freeze such an obligation resolves
   * only once the device's current incarnation is destroyed with confirmation, it keeps no earlier
   * provider's instance (`prevHandle`) and it has an instance record that once had an instance
   * (`noInstance`); a device with either must be deleted and created again
   * (`device.recreate_required`).
   * `currentUnconfirmed`: the current row is not live and no destruction of it is recorded (the
   * inactivity sweep before 0156, or a failed create); the gate then destroys by the device's
   * instance name with the row's provider, which must be loaded (`device.unavailable` until then).
   */
  cloudUnknown: {
    deviceId: string;
    prevHandle: boolean;
    noInstance: boolean;
    currentUnconfirmed: boolean;
  }[];
  /**
   * The cutover pre-check (before the freeze, too): local devices with legacy rows whose processes
   * may still exist and whose current machine has no recorded boot identity. Their obligations
   * could never resolve by a restart: ship the boot-reporting device build and wait for these to
   * report before publishing the freeze.
   */
  localWithoutBoot: { deviceId: string; machineId: string | null }[];
  unresolved: {
    deviceId: string;
    provider: string;
    instanceGeneration: string;
    state: "open" | "quarantined";
    reason: string | null;
    /** A local incarnation with a recorded boot: a restart of that computer resolves it. */
    bootKnown: boolean;
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

/**
 * The incarnation a legacy row's obligation is keyed by: the one it started in, else the one its
 * dispatch was admitted for; a historical reservation without either is `unknown`, never the
 * instance current now (I2). Its own provider: local `@local`, else the admitted one, else the
 * instance row's only when it is that incarnation, else `unknown` (M6).
 */
function legacyKey(r: {
  sandbox_created_at: Date | string | null;
  legacy_dispatch_generation: string | null;
  legacy_dispatch_provider: string | null;
  source: string | null;
  instance_provider: string | null;
  instance_created_at: Date | null;
}): { provider: string; generation: string } {
  const generation =
    r.sandbox_created_at !== null
      ? generationOf(new Date(r.sandbox_created_at))
      : (r.legacy_dispatch_generation ?? "unknown");
  const current =
    r.instance_created_at !== null && generationOf(r.instance_created_at) === generation;
  const provider =
    r.source === "local"
      ? LOCAL_PROVIDER
      : (r.legacy_dispatch_provider ??
        (current && r.instance_provider ? r.instance_provider : "unknown"));
  return { provider, generation };
}

const toObligation = (r: {
  id: string;
  device_id: string;
  org_id: string;
  provider: string;
  instance_generation: string;
  state: "open" | "quarantined" | "resolved" | "abandoned";
  reason: string | null;
  attempts: number;
  boot_id: string | null;
  created_at: Date;
}): RetirementObligation => ({
  id: r.id,
  deviceId: r.device_id,
  orgId: r.org_id,
  provider: r.provider,
  instanceGeneration: r.instance_generation,
  state: r.state,
  reason: r.reason,
  attempts: r.attempts,
  bootId: r.boot_id,
  createdAt: r.created_at,
});

@Injectable()
export class LegacyRetirementStore {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
  ) {}

  /**
   * Publishes the legacy-launch freeze under the platform authority writer, then enumerates every
   * legacy row and revoked start until stable; idempotent. Returns when it was first published.
   * Never undone.
   */
  async freeze(by: string): Promise<Date> {
    const at = await this.publishFreeze(by);
    // enumerated before the freeze returns: no use may run between it and the first scan (the
    // gate also scans each device it serves, so a worker that never runs bypasses nothing)
    await this.scanUntilStable();
    return at;
  }

  @Transactional({ propagation: "requires_new" })
  private async publishFreeze(by: string): Promise<Date> {
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

  /** When the freeze was published; null before. */
  async frozenAt(): Promise<Date | null> {
    const row = await this.db
      .selectFrom("legacy_launch_freeze")
      .select("frozen_at")
      .where("id", "=", FREEZE_ID)
      .executeTakeFirst();
    return row?.frozen_at ?? null;
  }

  /**
   * The worker's sweep of obligations whose device is gone (its row missing, `deleted_at` set, or
   * its org soft-deleted), at most `limit` per call:
   * - a cloud one (any provider not kernel-internal) waits while the device's instance row exists:
   *   its destroy is still owed (the destroy job or the destruction sweep deletes the row when it
   *   is done) and records the destruction then;
   * - one whose exact incarnation has a recorded confirmed destruction resolves
   *   `provider-destroyed`, an already `abandoned` cloud one too (provider evidence, not a
   *   reopen);
   * - every other one becomes `abandoned`. Device ids are never reused, so no device can acquire
   *   that incarnation again, but abandonment is no evidence that its processes ended (they may
   *   still run on that computer); its members stay unsettled.
   * Returns the counts.
   */
  async abandonDeleted(limit: number): Promise<{ resolved: number; abandoned: number }> {
    let resolved = 0,
      abandoned = 0;
    // abandoned cloud obligations that gained a matching recorded destruction
    const evidenced = await this.db
      .selectFrom("device_retirement_obligations as o")
      .innerJoin("device_instance_destructions as x", (j) =>
        j
          .onRef("x.device_id", "=", "o.device_id")
          .onRef("x.provider", "=", "o.provider")
          .onRef("x.instance_generation", "=", "o.instance_generation"),
      )
      .select("o.id")
      .where("o.state", "=", "abandoned")
      .limit(limit)
      .execute();
    for (const r of evidenced) {
      const u = await this.db
        .updateTable("device_retirement_obligations")
        .set({
          state: "resolved",
          resolution: "provider-destroyed",
          resolved_at: sql<Date>`now()`,
          abandoned_at: null,
          last_error: null,
        })
        .where("id", "=", r.id)
        .where("state", "=", "abandoned")
        .executeTakeFirst();
      resolved += Number(u.numUpdatedRows);
    }
    const rows = await this.db
      .selectFrom("device_retirement_obligations as o")
      .leftJoin("devices as d", "d.id", "o.device_id")
      .leftJoin("orgs as g", "g.id", "d.org_id")
      .select(["o.id", "o.device_id", "o.provider", "o.instance_generation"])
      .where("o.state", "in", ["open", "quarantined"])
      .where((eb) =>
        eb.or([
          eb("d.id", "is", null),
          eb("d.deleted_at", "is not", null),
          eb("g.deleted_at", "is not", null),
        ]),
      )
      // a cloud destroy still owed keeps its instance row (R2-I2)
      .where((eb) =>
        eb.or([
          eb("o.provider", "like", "@%"),
          eb.not(
            eb.exists(
              eb
                .selectFrom("device_instances as i")
                .select("i.device_id")
                .whereRef("i.device_id", "=", "o.device_id"),
            ),
          ),
        ]),
      )
      .orderBy("o.created_at")
      .limit(limit)
      .execute();
    for (const r of rows) {
      if (await this.destructionRecorded(r.device_id, r.provider, r.instance_generation)) {
        await this.resolveDestroyed(r.id);
        resolved++;
        continue;
      }
      const u = await this.db
        .updateTable("device_retirement_obligations")
        .set({ state: "abandoned", abandoned_at: sql<Date>`now()` })
        .where("id", "=", r.id)
        .where("state", "in", ["open", "quarantined"])
        .executeTakeFirst();
      abandoned += Number(u.numUpdatedRows);
    }
    return { resolved, abandoned };
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
  async admitLegacyDispatch(
    orgId: string,
    taskId: string,
    /** The exact incarnation the launch dispatches into (read under its shared lease). */
    instance: { provider: string; generation: string },
  ): Promise<LegacyDispatchAdmission> {
    await this.locks.acquire({ orgId }, { kind: "admit" });
    if (await this.frozen()) return "frozen";
    const r = await this.db
      .updateTable("background_tasks")
      .set({
        legacy_dispatch: "dispatched",
        legacy_dispatch_provider: instance.provider,
        legacy_dispatch_generation: GENERATION_RE.test(instance.generation)
          ? instance.generation
          : null,
      })
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
  async scan(deviceId?: string): Promise<{ added: number }> {
    let added = 0;
    if (await this.frozen()) added += await this.scanLegacyTasks(deviceId);
    added += await this.scanRevokedStarts(deviceId);
    return { added };
  }

  /** Repeats {@link scan} until a pass adds nothing (at most `maxPasses`). */
  async scanUntilStable(
    maxPasses = 5,
    deviceId?: string,
  ): Promise<{ added: number; stable: boolean }> {
    let added = 0;
    for (let i = 0; i < maxPasses; i++) {
      const pass = await this.scan(deviceId);
      added += pass.added;
      if (pass.added === 0) return { added, stable: true };
    }
    return { added, stable: false };
  }

  /**
   * Legacy rows whose processes may still exist and that are not members yet (one device's, or
   * all). The `(status = 'running' OR kill_pending OR sid IS NULL)` conjunct is the partial index's
   * predicate (0156), stated as is so the planner can use it.
   */
  private legacyCandidates(deviceId?: string) {
    let q = this.db
      .selectFrom("background_tasks as t")
      .leftJoin("devices as d", "d.id", "t.device_id")
      .leftJoin("device_instances as i", "i.device_id", "t.device_id")
      .select([
        "t.id",
        "t.org_id",
        "t.device_id",
        "t.sandbox_created_at",
        "t.legacy_dispatch_generation",
        "t.legacy_dispatch_provider",
        "d.source",
        "i.provider as instance_provider",
        "i.created_at as instance_created_at",
      ])
      .where("t.launch_state", "=", "legacy")
      .where("t.device_id", "is not", null)
      .where(sql<boolean>`(t.status = 'running' OR t.kill_pending OR t.sid IS NULL)`)
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
      );
    if (deviceId !== undefined) q = q.where("t.device_id", "=", deviceId);
    return q;
  }

  private async scanLegacyTasks(deviceId?: string): Promise<number> {
    const rows = await this.legacyCandidates(deviceId)
      .orderBy("t.started_at", "asc")
      .orderBy("t.id", "asc")
      .execute();
    let added = 0;
    for (const r of rows) {
      const deviceId = r.device_id as string;
      const { provider, generation } = legacyKey(r);
      if (await this.addMember(deviceId, r.org_id, provider, generation, "legacy-task", r.id))
        added++;
    }
    return added;
  }

  /** Revoked managed starts on an incarnation that no longer runs, not members yet. */
  private revokedCandidates(deviceId?: string) {
    let q = this.db
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
      );
    if (deviceId !== undefined) q = q.where("o.device_id", "=", deviceId);
    return q;
  }

  private async scanRevokedStarts(deviceId?: string): Promise<number> {
    const rows = await this.revokedCandidates(deviceId).orderBy("o.operation_id").execute();
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
    // a local incarnation keeps the boot its machine reported last: only a later boot of that
    // machine proves its processes gone (none reported: never by itself)
    const boot = isCloudProvider(provider) ? null : await this.currentBoot(deviceId);
    await this.db
      .insertInto("device_retirement_obligations")
      .values({
        device_id: deviceId,
        org_id: orgId,
        provider,
        instance_generation: generation,
        boot_machine_id: boot?.machineId ?? null,
        boot_id: boot?.bootId ?? null,
      })
      .onConflict((oc) => oc.columns(["device_id", "provider", "instance_generation"]).doNothing())
      .execute();
    const obligation = await this.db
      .selectFrom("device_retirement_obligations")
      .select(["id", "state", "resolution"])
      .where("device_id", "=", deviceId)
      .where("provider", "=", provider)
      .where("instance_generation", "=", generation)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const r = await this.db
      .insertInto("device_retirement_members")
      .values({ obligation_id: obligation.id, kind, ref_id: refId })
      .onConflict((oc) => oc.columns(["kind", "ref_id", "obligation_id"]).doNothing())
      .returning("ref_id")
      .executeTakeFirst();
    // a restart covers only what ran before it: a member found later (a row of an old replica) on
    // the same local incarnation reopens the obligation against the current boot
    if (
      r !== undefined &&
      obligation.state === "resolved" &&
      obligation.resolution === "host-rebooted"
    ) {
      // read under the obligation's lock: a hello that resolved it meanwhile is seen (M1)
      const now = await this.currentBoot(deviceId);
      await this.db
        .updateTable("device_retirement_obligations")
        .set({
          state: "open",
          resolution: null,
          resolved_at: null,
          boot_machine_id: now?.machineId ?? null,
          boot_id: now?.bootId ?? null,
        })
        .where("id", "=", obligation.id)
        .execute();
    }
    return r !== undefined;
  }

  /** The device's active machine and the boot it reported last (null: no machine). */
  private async currentBoot(
    deviceId: string,
  ): Promise<{ machineId: string; bootId: string | null } | null> {
    const m = await this.db
      .selectFrom("device_machines")
      .select(["id", "boot_id"])
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return m ? { machineId: m.id, bootId: m.boot_id } : null;
  }

  /**
   * Records the OS boot identity an authenticated hello of `machineId` reported. The caller is the
   * gateway's hello record, after the connection authenticated with the machine's credential and
   * claimed the device, inside its transaction with the machine row locked. A boot first seen for
   * the machine becomes its current one; the current one again is a reconnect; one seen before a
   * later one (stale, replayed) changes nothing. A new or current boot then settles the device's
   * local obligations recorded under another boot of the computer ({@link settleRebooted}).
   */
  async recordBoot(machineId: string, bootId: unknown): Promise<BootReport> {
    if (!isDeviceBootId(bootId)) return "ignored";
    const machine = await this.db
      .selectFrom("device_machines")
      .select(["device_id", "boot_id"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!machine) return "ignored";
    const inserted = await this.db
      .insertInto("device_machine_boots")
      .values({ machine_id: machineId, boot_id: bootId })
      .onConflict((oc) => oc.columns(["machine_id", "boot_id"]).doNothing())
      .returning("seq")
      .executeTakeFirst();
    let report: BootReport;
    if (inserted !== undefined) {
      await this.db
        .updateTable("device_machines")
        .set({ boot_id: bootId })
        .where("id", "=", machineId)
        .execute();
      report = "new";
    } else if (machine.boot_id === bootId) report = "current";
    else return "stale";
    await this.settleRebooted(machine.device_id);
    return report;
  }

  /**
   * A hello without a boot identity: the machine has no current boot any more, so a boot it
   * reported earlier is never taken as the one its later work ran under (M2).
   */
  async clearBoot(machineId: string): Promise<void> {
    await this.db
      .updateTable("device_machines")
      .set({ boot_id: null })
      .where("id", "=", machineId)
      .execute();
  }

  /**
   * Resolves (`host-rebooted`) every unresolved local obligation of the device for which a current
   * (non-revoked) machine of the device has recorded a boot other than the obligation's: the
   * evidence is the OS instance, not the credential, so a re-login on the same computer reporting
   * the same boot changes nothing, and one after a restart (or any later boot) resolves it. A boot
   * that some machine of the device had already reported when the obligation's boot was first
   * seen is an older boot, never evidence (a replay through another credential). An obligation
   * without a recorded boot never resolves here. Returns how many resolved.
   */
  async settleRebooted(deviceId: string): Promise<number> {
    const r = await this.db
      .updateTable("device_retirement_obligations as o")
      .set({
        state: "resolved",
        resolution: "host-rebooted",
        resolved_at: sql<Date>`now()`,
        last_error: null,
      })
      .where("o.device_id", "=", deviceId)
      .where("o.state", "in", ["open", "quarantined"])
      .where("o.provider", "like", "@%")
      .where("o.boot_id", "is not", null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("device_machines as m")
            .select("m.id")
            .whereRef("m.device_id", "=", "o.device_id")
            .where("m.revoked_at", "is", null)
            .where("m.boot_id", "is not", null)
            .whereRef("m.boot_id", "<>", "o.boot_id")
            // not a boot the device's machines had already reported by the obligation's boot
            .where((inner) =>
              inner.not(
                inner.exists(
                  inner
                    .selectFrom("device_machine_boots as seen")
                    .innerJoin("device_machines as sm", "sm.id", "seen.machine_id")
                    .select("seen.boot_id")
                    .whereRef("sm.device_id", "=", "o.device_id")
                    .whereRef("seen.boot_id", "=", "m.boot_id")
                    .where((e) =>
                      e(
                        "seen.seq",
                        "<=",
                        e
                          .selectFrom("device_machine_boots as ob")
                          .innerJoin("device_machines as om", "om.id", "ob.machine_id")
                          .select((f) => f.fn.min("ob.seq").as("first"))
                          .whereRef("om.device_id", "=", "o.device_id")
                          .whereRef("ob.boot_id", "=", "o.boot_id"),
                      ),
                    ),
                ),
              ),
            ),
        ),
      )
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
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
        "boot_id",
        "created_at",
      ])
      .where("device_id", "=", deviceId)
      .where("state", "in", ["open", "quarantined"])
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toObligation);
  }

  /**
   * Whether the device has an unresolved obligation, or a candidate not enumerated yet (a legacy
   * row once frozen, a revoked start): the shared-path check. A candidate counts as unresolved, so
   * the device goes to the gate, which enumerates it under the exclusive lease (C1).
   */
  async hasUnresolved(deviceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("device_retirement_obligations")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("state", "in", ["open", "quarantined"])
      .limit(1)
      .executeTakeFirst();
    if (row !== undefined) return true;
    if ((await this.revokedCandidates(deviceId).limit(1).executeTakeFirst()) !== undefined)
      return true;
    return (
      (await this.frozen()) &&
      (await this.legacyCandidates(deviceId).limit(1).executeTakeFirst()) !== undefined
    );
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
      .where("state", "in", ["open", "quarantined"])
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
      .where("state", "in", ["open", "quarantined"])
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
      .where("state", "in", ["open", "quarantined"])
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
      .where("state", "in", ["open", "quarantined"])
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
      .select(["device_id", "provider", "instance_generation", "state", "reason", "boot_id"])
      .where("state", "in", ["open", "quarantined"])
      .orderBy("created_at", "asc")
      .execute();
    const withoutBoot = await this.db
      .selectFrom("background_tasks as t")
      .innerJoin("devices as d", "d.id", "t.device_id")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "d.id").on("m.revoked_at", "is", null),
      )
      .select(["t.device_id", "m.id as machine_id"])
      .distinct()
      .where("d.source", "=", "local")
      .where("d.deleted_at", "is", null)
      .where("t.launch_state", "=", "legacy")
      .where(sql<boolean>`(t.status = 'running' OR t.kill_pending OR t.sid IS NULL)`)
      .where(
        sql<boolean>`(
          (t.status = 'running' AND (t.sid IS NOT NULL OR t.legacy_dispatch <> 'reserved'))
          OR t.kill_pending
          OR (t.sid IS NULL AND t.legacy_dispatch <> 'reserved')
        )`,
      )
      .where((eb) => eb.or([eb("m.id", "is", null), eb("m.boot_id", "is", null)]))
      .orderBy("t.device_id")
      .execute();
    const abandonedRows = await this.db
      .selectFrom("device_retirement_obligations")
      .select(["device_id", "provider", "instance_generation", "boot_id", "abandoned_at"])
      .where("state", "=", "abandoned")
      .orderBy("abandoned_at", "asc")
      .execute();
    const abandonedMembers = await this.db
      .selectFrom("device_retirement_members as m")
      .innerJoin("device_retirement_obligations as o", "o.id", "m.obligation_id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("o.state", "=", "abandoned")
      .executeTakeFirstOrThrow();
    const cloudCandidates = await this.db
      .selectFrom("background_tasks as t")
      .innerJoin("devices as d", "d.id", "t.device_id")
      .leftJoin("device_instances as i", "i.device_id", "t.device_id")
      .select([
        "t.device_id",
        "t.sandbox_created_at",
        "t.legacy_dispatch_generation",
        "t.legacy_dispatch_provider",
        "i.provider as instance_provider",
        "i.created_at as instance_created_at",
        "i.prev_handle",
        "i.status as instance_status",
        "i.handle as instance_handle",
        "i.had_instance",
      ])
      .where("d.source", "=", "cloud")
      .where("d.deleted_at", "is", null)
      .where("t.launch_state", "=", "legacy")
      .where(sql<boolean>`(t.status = 'running' OR t.kill_pending OR t.sid IS NULL)`)
      .where(
        sql<boolean>`(
          (t.status = 'running' AND (t.sid IS NOT NULL OR t.legacy_dispatch <> 'reserved'))
          OR t.kill_pending
          OR (t.sid IS NULL AND t.legacy_dispatch <> 'reserved')
        )`,
      )
      .orderBy("t.device_id")
      .execute();
    const cloudUnknown = new Map<
      string,
      { prevHandle: boolean; noInstance: boolean; currentUnconfirmed: boolean }
    >();
    for (const r of cloudCandidates) {
      const key = legacyKey({ ...r, source: "cloud" });
      if (key.generation !== "unknown" && key.provider !== "unknown") continue;
      if (cloudUnknown.has(r.device_id as string)) continue;
      const live =
        r.instance_handle !== null &&
        (r.instance_status === "running" ||
          r.instance_status === "suspended" ||
          r.instance_status === "creating");
      const createdAt = r.instance_created_at;
      const noInstance = createdAt === null || r.had_instance !== true;
      const currentUnconfirmed =
        createdAt !== null &&
        !noInstance &&
        !live &&
        !(
          r.instance_provider !== null &&
          (await this.destructionRecorded(
            r.device_id as string,
            r.instance_provider,
            generationOf(createdAt),
          ))
        );
      cloudUnknown.set(r.device_id as string, {
        prevHandle: r.prev_handle !== null,
        noInstance,
        currentUnconfirmed,
      });
    }
    const open = n("open"),
      quarantined = n("quarantined"),
      abandoned = n("abandoned"),
      unsettledMembers = Number(unsettled.n);
    const retired = frozen && open === 0 && quarantined === 0 && unsettledMembers === 0;
    return {
      frozen,
      open,
      quarantined,
      resolved: n("resolved"),
      unsettledMembers,
      retired,
      cleanRetirement: retired && abandoned === 0,
      abandoned,
      abandonedMembers: Number(abandonedMembers.n),
      abandonedList: abandonedRows.map((r) => ({
        deviceId: r.device_id,
        provider: r.provider,
        instanceGeneration: r.instance_generation,
        local: isInternalProvider(r.provider),
        bootKnown: r.boot_id !== null,
        abandonedAt: r.abandoned_at as Date,
      })),
      cloudUnknown: [...cloudUnknown].map(([deviceId, flags]) => ({ deviceId, ...flags })),
      localWithoutBoot: withoutBoot.map((r) => ({
        deviceId: r.device_id as string,
        machineId: r.machine_id,
      })),
      unresolved: unresolved.map((r) => ({
        deviceId: r.device_id,
        provider: r.provider,
        instanceGeneration: r.instance_generation,
        state: r.state as "open" | "quarantined",
        reason: r.reason,
        bootKnown: r.boot_id !== null,
      })),
    };
  }
}
