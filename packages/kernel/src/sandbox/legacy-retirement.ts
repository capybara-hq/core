import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";

/**
 * Legacy retirement (permission runtime cutover phase 8.5): the durable legacy-launch freeze and
 * the physical no-reuse obligations of old instance incarnations (migration 0157).
 *
 * - **Freeze.** {@link freeze} writes the one freeze row under the platform authority writer (the
 *   exclusive platform permission lock). An R1 (protocol 2) kernel admitted each legacy SID
 *   launch under the shared platform lock immediately before its dispatch and refused once the
 *   row existed, marking an admitted reservation `dispatched` with the incarnation it dispatched
 *   into; this release launches no SID task, so it only reads those marks. A replica without the
 *   fence must be stopped or drained before the freeze (the rows it writes still read `unknown`,
 *   never "not dispatched", and the periodic re-scan picks them up).
 * - **Obligations.** {@link scan} enumerates, under the freeze, every legacy row whose processes
 *   may still exist (running with a SID, a reservation that may have dispatched, a stop in flight,
 *   `kill_pending` including terminal rows, a possibly dispatched launch that failed), and every
 *   revoked managed background start whose recorded generation no longer runs (the 8.4 handoff).
 *   Each becomes a member of the obligation of its device, provider and exact instance
 *   generation. A SID, PID or output text is never turned into an execution reference: it only
 *   names the row. Obligations live apart from the task rows, so output retention never removes
 *   them, and task finish and event semantics stay with the task's own finisher.
 * - **Resolution** is the sandbox service's, under the device's exclusive lifecycle lease
 *   (`SandboxService` gate), the same for every provider: an incarnation is destroyed whole by its
 *   provider (confirmed destruction, the file system kept) or found destroyed by a recorded
 *   confirmed destruction; a replaced one without recorded destruction and an unknown one are
 *   quarantined. Nothing here resolves on a new generation, a timeout or a process scan.
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
  /** When it was recorded (a cloud `unknown` one resolves only if recorded after the freeze). */
  createdAt: Date;
}

/** {@link LegacyRetirementStore.freeze}'s answer: the freeze is published and enumerated. */
export interface LegacyFreezeResult {
  /** When the freeze was first published (a rerun keeps it). */
  frozenAt: Date;
  /** New obligation members this run's enumeration recorded. */
  added: number;
  stable: true;
}

/** Where the freeze stands: published (`frozenAt`) and its enumeration completed (`enumeratedAt`). */
export interface LegacyFreezeState {
  frozenAt: Date | null;
  /** When the freeze's own enumeration last completed with a stable pass; null: never. */
  enumeratedAt: Date | null;
}

/**
 * The cutover barrier is not in place: legacy admission is still open (no freeze), or the freeze
 * is published but its enumeration never completed. Nothing that depends on closed admission
 * (the cloud snapshot) may run.
 */
export class CutoverBarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverBarrierError";
  }
}

/**
 * The freeze is published, but its enumeration kept finding new rows for every pass (legacy rows,
 * for example of a replica without the freeze code, or revoked managed starts). The freeze stays published (it
 * is never undone) and is not marked enumerated; stop that replica and run the freeze again.
 */
export class LegacyFreezeUnsettledError extends Error {
  constructor(passes: number, added: number) {
    super(
      `The legacy-launch freeze is published, but its enumeration did not settle after ${passes} ` +
        `passes (${added} new members): new legacy or revoked rows kept appearing. Stop every ` +
        "old replica, then run the freeze again",
    );
    this.name = "LegacyFreezeUnsettledError";
  }
}

/** The passes of the freeze's own enumeration before it is called unsettled. */
const FREEZE_SCAN_PASSES = 5;

/** What the report counts as a recent unmarked legacy row (database clock). */
const RECENT = "15 minutes";

/** The migration that added the legacy dispatch marker: rows after it without one are unfenced. */
const MARKER_MIGRATION = "0157_legacy_retirement.sql";

/**
 * The legacy rows whose processes may still exist: the partial index's predicate (0157) stated as
 * is, then the rows that may have dispatched or still owe a kill.
 */
const MAY_STILL_RUN = sql<boolean>`(t.status = 'running' OR t.kill_pending OR t.sid IS NULL)`;
const MAY_HAVE_DISPATCHED = sql<boolean>`(
  (t.status = 'running' AND (t.sid IS NOT NULL OR t.legacy_dispatch <> 'reserved'))
  OR t.kill_pending
  OR (t.sid IS NULL AND t.legacy_dispatch <> 'reserved')
)`;

/** What the release gate reads: unresolved obligations are reported, never called retired. */
export interface LegacyRetirementReport {
  frozen: boolean;
  /** When the freeze was published; null before. */
  frozenAt: Date | null;
  /**
   * When the freeze's own enumeration last completed stable; null while it never did (the cloud
   * snapshot refuses until then: run the freeze again).
   */
  freezeEnumeratedAt: Date | null;
  /**
   * Running legacy launches reserved by fenced code and never admitted for dispatch: the freeze
   * refuses their dispatch (the pending producers it fences).
   */
  fencedReservations: number;
  /**
   * Evidence of replicas without the 8.5 code (they are not fenced by the freeze): legacy rows
   * without the dispatch marker (`legacy_dispatch = 'unknown'`) started after migration 0157 was
   * applied (only such a replica writes them); how many of those started after the freeze, after
   * its enumeration (the barrier refuses then) and in the last 15 minutes by the database clock;
   * and the latest one's start. Nonzero `afterFreeze` or `recent`: an old replica still runs; stop
   * it. Rows of an old replica that never starts a legacy task are not detectable here.
   */
  unfencedWriters: {
    sinceMigration: number;
    afterFreeze: number;
    afterEnumeration: number;
    recent: number;
    latestAt: Date | null;
  };
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
   * inactivity sweep before 0157, or a failed create); the gate then destroys by the device's
   * instance name with the row's provider, which must be loaded (`device.unavailable` until then).
   */
  cloudUnknown: {
    deviceId: string;
    prevHandle: boolean;
    noInstance: boolean;
    currentUnconfirmed: boolean;
  }[];
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

/**
 * Whether `provider` names a provider (one whose whole-instance destroy is confirmed): any
 * recorded provider, the same for every one, never the `unknown` of an incarnation the kernel
 * cannot name.
 */
export const isKnownProvider = (provider: string): boolean => provider !== "unknown";

/** The epoch millisecond of `d` as recorded generation text. */
const generationOf = (d: Date): string => String(d.getTime());

/**
 * The incarnation a legacy row's obligation is keyed by: the one it started in, else the one its
 * dispatch was admitted for; a historical reservation without either is `unknown`, never the
 * instance current now (I2). Its own provider: the admitted one, else the instance row's only
 * when it is that incarnation, else `unknown` (M6).
 */
function legacyKey(r: {
  sandbox_created_at: Date | string | null;
  legacy_dispatch_generation: string | null;
  legacy_dispatch_provider: string | null;
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
    r.legacy_dispatch_provider ??
    (current && r.instance_provider ? r.instance_provider : "unknown");
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
  createdAt: r.created_at,
});

@Injectable()
// org-filter: deployment-wide retirement of legacy launches: the worker sweeps (retire-legacy-tasks
// job), the release-gate report and the cutover CLI span every org; the per-device and per-obligation
// calls come from SandboxService's retirement gate with kernel-held device and obligation ids
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
  async freeze(by: string): Promise<LegacyFreezeResult> {
    const frozenAt = await this.publishFreeze(by);
    // enumerated before the freeze returns: no use may run between it and the first scan (the
    // gate also scans each device it serves, so a worker that never runs bypasses nothing)
    const scan = await this.scanUntilStable(FREEZE_SCAN_PASSES);
    // A separate write after the scan (whose passes commit member by member): the mark only says
    // a whole enumeration completed stable; an unsettled run clears an earlier mark, so the
    // barrier never trusts an enumeration older than what this run found still moving.
    await this.db
      .updateTable("legacy_launch_freeze")
      .set({ enumerated_at: scan.stable ? sql<Date>`now()` : null })
      .where("id", "=", FREEZE_ID)
      .execute();
    if (!scan.stable) throw new LegacyFreezeUnsettledError(FREEZE_SCAN_PASSES, scan.added);
    return { frozenAt, added: scan.added, stable: true };
  }

  /** Whether the freeze is published and whether its enumeration completed. */
  async freezeState(): Promise<LegacyFreezeState> {
    const row = await this.db
      .selectFrom("legacy_launch_freeze")
      .select(["frozen_at", "enumerated_at"])
      .where("id", "=", FREEZE_ID)
      .executeTakeFirst();
    return { frozenAt: row?.frozen_at ?? null, enumeratedAt: row?.enumerated_at ?? null };
  }

  /**
   * The cutover barrier (B-10): legacy admission is closed (the freeze is published), the
   * freeze's own enumeration completed, and no unmarked legacy row (only an old, unfenced replica
   * writes one) started after that enumeration. Throws {@link CutoverBarrierError} otherwise. The
   * freeze is never undone; a later legacy row is still enumerated by the gate before any use.
   */
  async assertCutoverBarrier(): Promise<void> {
    const state = await this.freezeState();
    if (state.frozenAt === null)
      throw new CutoverBarrierError(
        "Legacy admission is still open: publish the legacy-launch freeze first " +
          "(capybara permissions cutover freeze)",
      );
    if (state.enumeratedAt === null)
      throw new CutoverBarrierError(
        "The legacy-launch freeze is published but its enumeration never completed: " +
          "run capybara permissions cutover freeze again",
      );
    const unfenced = await this.unfencedWriters(state);
    if (unfenced.afterEnumeration > 0)
      throw new CutoverBarrierError(
        `${unfenced.afterEnumeration} unmarked legacy row(s) started after the freeze's ` +
          "enumeration: an old, unfenced replica still runs. Stop it, then run capybara " +
          "permissions cutover freeze again",
      );
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
   * - one waits while the device's instance row exists:
   *   its destroy is still owed (the destroy job or the destruction sweep deletes the row when it
   *   is done) and records the destruction then;
   * - one whose exact incarnation has a recorded confirmed destruction resolves
   *   `provider-destroyed`, an already `abandoned` one too (provider evidence, not a
   *   reopen);
   * - every other one becomes `abandoned`. Device ids are never reused, so no device can acquire
   *   that incarnation again, but abandonment is no evidence that its processes ended (they may
   *   still run on that computer); its members stay unsettled.
   * Returns the counts.
   */
  async abandonDeleted(limit: number): Promise<{ resolved: number; abandoned: number }> {
    return asPlatform("retirement of legacy launches across every org", async () => {
      let resolved = 0,
        abandoned = 0;
      // abandoned obligations that gained a matching recorded destruction
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
        // a destroy still owed keeps its instance row (R2-I2)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("device_instances as i")
                .select("i.device_id")
                .whereRef("i.device_id", "=", "o.device_id"),
            ),
          ),
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
    });
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
   * One enumeration pass: every legacy row (only once the freeze is published) and every revoked
   * managed start that may still own processes on an incarnation that no longer runs, recorded as
   * members of their obligations. Idempotent; returns how many new members it recorded. The
   * worker repeats it every tick, so a row an old unfenced replica writes later is still found.
   */
  async scan(deviceId?: string): Promise<{ added: number }> {
    let added = await this.reopenLateMembers(deviceId);
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
   * predicate (0157), stated as is so the planner can use it.
   */
  // org-filter: a query fragment, not run here: its callers (the retirement sweep's methods)
  // execute it inside their asPlatform
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
        "i.provider as instance_provider",
        "i.created_at as instance_created_at",
      ])
      .where("t.launch_state", "=", "legacy")
      .where("t.device_id", "is not", null)
      .where(MAY_STILL_RUN)
      .where(MAY_HAVE_DISPATCHED)
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
    return asPlatform("retirement of legacy launches across every org", async () => {
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
    });
  }

  /** Revoked managed starts on an incarnation that no longer runs, not members yet. */
  // org-filter: a query fragment, not run here: its callers (the retirement sweep's methods)
  // execute it inside their asPlatform
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
    return asPlatform("retirement of legacy launches across every org", async () => {
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
    });
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
    return asPlatform("retirement of legacy launches across every org", async () => {
      await this.db
        .insertInto("device_retirement_obligations")
        .values({
          device_id: deviceId,
          org_id: orgId,
          provider,
          instance_generation: generation,
        })
        .onConflict((oc) =>
          oc.columns(["device_id", "provider", "instance_generation"]).doNothing(),
        )
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
      // an exact cancel covers only the refs it stopped, and the incarnation lives on (B-22): a
      // member found later (a row of an old replica) reopens the obligation; so does one found on
      // an incarnation an old replica resolved by a restart of its computer
      if (
        r !== undefined &&
        obligation.state === "resolved" &&
        (obligation.resolution === "host-rebooted" || obligation.resolution === "exact-cancelled")
      ) {
        await this.db
          .updateTable("device_retirement_obligations")
          .set({ state: "open", resolution: null, resolved_at: null })
          .where("id", "=", obligation.id)
          .execute();
      }
      return r !== undefined;
    });
  }

  /** The device's unresolved obligations (open and quarantined), oldest first. */
  async unresolved(deviceId: string): Promise<RetirementObligation[]> {
    return asPlatform("retirement of legacy launches across every org", async () => {
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
          "created_at",
        ])
        .where("device_id", "=", deviceId)
        .where("state", "in", ["open", "quarantined"])
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toObligation);
    });
  }

  /**
   * Whether the device has an unresolved obligation, or a candidate not enumerated yet (a legacy
   * row once frozen, a revoked start): the shared-path check. A candidate counts as unresolved, so
   * the device goes to the gate, which enumerates it under the exclusive lease (C1).
   */
  async hasUnresolved(deviceId: string): Promise<boolean> {
    return asPlatform("retirement of legacy launches across every org", async () => {
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
      // an exact-cancelled obligation a member was added to after the cancel (a rolling upgrade)
      const late = await this.db
        .selectFrom("device_retirement_obligations as o")
        .select("o.id")
        .where("o.device_id", "=", deviceId)
        .where("o.state", "=", "resolved")
        .where("o.resolution", "=", "exact-cancelled")
        .where(({ exists }) => exists(this.lateMember()))
        .limit(1)
        .executeTakeFirst();
      if (late !== undefined) return true;
      return (
        (await this.frozen()) &&
        (await this.legacyCandidates(deviceId).limit(1).executeTakeFirst()) !== undefined
      );
    });
  }

  /**
   * No trusted way to establish termination: the obligation is quarantined (the device stays
   * unavailable). A resolved obligation is left as it is.
   */
  async quarantine(id: string, reason: string): Promise<void> {
    return asPlatform("retirement of legacy launches across every org", async () => {
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
    });
  }

  /** A failed destroy or verification: the obligation stays as it is, the attempt is recorded. */
  async noteFailure(id: string, error: unknown): Promise<void> {
    return asPlatform("retirement of legacy launches across every org", async () => {
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
    });
  }

  /** The provider confirmed the incarnation destroyed: the obligation resolves. */
  async resolveDestroyed(id: string): Promise<void> {
    return asPlatform("retirement of legacy launches across every org", async () => {
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
    });
  }

  /**
   * The provider confirmed the exact cancellation of the revoked managed starts `covered` on the
   * resumed incarnation (B-22): under the obligation's row lock (the lock {@link addMember} takes
   * before it adds a member), resolves it as `exact-cancelled` and acknowledges those
   * revocations, only while every member is one of them. False (nothing changed) when a member
   * outside `covered` exists, which was never stopped: the caller destroys the incarnation
   * instead. Acknowledging here is what tells a member added later apart ({@link scan}).
   */
  @Transactional({ propagation: "requires_new" })
  async resolveCancelled(id: string, covered: readonly string[]): Promise<boolean> {
    return asPlatform("retirement of legacy launches across every org", async () => {
      const o = await this.db
        .selectFrom("device_retirement_obligations")
        .select(["state"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (o === undefined || (o.state !== "open" && o.state !== "quarantined")) return false;
      const members = await this.db
        .selectFrom("device_retirement_members")
        .select(["kind", "ref_id"])
        .where("obligation_id", "=", id)
        .execute();
      const set = new Set(covered);
      if (
        members.length === 0 ||
        members.some((m) => m.kind !== "revoked-start" || !set.has(m.ref_id))
      )
        return false;
      await this.db
        .updateTable("sandbox_operation_intents")
        .set({ revoke_acknowledged: true, updated_at: new Date() })
        .where("operation_id", "in", [...set])
        .where("state", "=", "revoked")
        .execute();
      await this.db
        .updateTable("device_retirement_obligations")
        .set({
          state: "resolved",
          resolution: "exact-cancelled",
          resolved_at: sql<Date>`now()`,
          last_error: null,
        })
        .where("id", "=", id)
        .execute();
      return true;
    });
  }

  /**
   * Reopens `exact-cancelled` obligations holding a member nobody stopped: a legacy row, or a
   * revoked start whose intent is not there acknowledged, a missing intent included (every
   * member the cancel covered was acknowledged with the resolution). A replica without the reopen in {@link addMember} (a
   * rolling upgrade) adds such members to a resolved obligation; the next scan of a new one
   * reopens it. Returns how many it reopened.
   */
  private async reopenLateMembers(deviceId?: string): Promise<number> {
    return asPlatform("retirement of legacy launches across every org", async () => {
      let q = this.db
        .updateTable("device_retirement_obligations as o")
        .set({ state: "open", resolution: null, resolved_at: null })
        .where("o.state", "=", "resolved")
        .where("o.resolution", "=", "exact-cancelled")
        .where(({ exists }) => exists(this.lateMember()));
      if (deviceId !== undefined) q = q.where("o.device_id", "=", deviceId);
      const r = await q.executeTakeFirst();
      return Number(r.numUpdatedRows);
    });
  }

  /**
   * A member of obligation `o` an exact cancel never covered (see {@link reopenLateMembers}),
   * correlated on `o.id`.
   */
  // org-filter: a correlated subquery fragment on o.id, run only inside the retirement sweep's
  // asPlatform
  private lateMember() {
    // fail closed: a revoked start is covered only when its intent exists acknowledged (a missing
    // intent row proves nothing was stopped)
    return this.db
      .selectFrom("device_retirement_members as lm")
      .select("lm.ref_id")
      .where(sql<boolean>`lm.obligation_id = o.id`)
      .where((eb) =>
        eb.or([
          eb("lm.kind", "=", "legacy-task"),
          eb.not(
            eb.exists(
              eb
                .selectFrom("sandbox_operation_intents as li")
                .select("li.operation_id")
                .whereRef("li.operation_id", "=", "lm.ref_id")
                .where("li.revoke_acknowledged", "=", true),
            ),
          ),
        ]),
      );
  }

  /** The members of one obligation, oldest first. */
  async membersOf(obligationId: string): Promise<RetirementMember[]> {
    const rows = await this.db
      .selectFrom("device_retirement_members")
      .select(["obligation_id", "kind", "ref_id"])
      .where("obligation_id", "=", obligationId)
      .orderBy("created_at", "asc")
      .orderBy("ref_id", "asc")
      .execute();
    return rows.map((r) => ({ obligationId: r.obligation_id, kind: r.kind, refId: r.ref_id }));
  }

  /**
   * Records the provider-confirmed destruction of an incarnation, the same for every provider (a
   * provider is trusted like every extension). An `unknown` provider names nothing and is refused.
   */
  async recordDestruction(deviceId: string, provider: string, generation: string): Promise<void> {
    if (!isKnownProvider(provider))
      throw new Error(`A ${provider} destroy is not evidence of destruction`);
    if (!GENERATION_RE.test(generation)) throw new Error(`invalid generation ${generation}`);
    await this.db
      .insertInto("device_instance_destructions")
      .values({ device_id: deviceId, provider, instance_generation: generation })
      .onConflict((oc) => oc.columns(["device_id", "provider", "instance_generation"]).doNothing())
      .execute();
  }

  /** Whether a confirmed destruction of exactly that incarnation was recorded. */
  async destructionRecorded(
    deviceId: string,
    provider: string,
    generation: string,
  ): Promise<boolean> {
    if (!isKnownProvider(provider) || !GENERATION_RE.test(generation)) return false;
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
    return asPlatform("retirement of legacy launches across every org", async () => {
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
    });
  }

  /** Members of resolved obligations whose own records are not settled yet. */
  async unsettledMembers(limit: number): Promise<RetirementMember[]> {
    const rows = await this.db
      .selectFrom("device_retirement_members as m")
      .innerJoin("device_retirement_obligations as o", "o.id", "m.obligation_id")
      .select(["m.obligation_id", "m.kind", "m.ref_id"])
      .where("o.state", "=", "resolved")
      .where("m.settled", "=", false)
      // a member an exact cancel never covered is not settled (acknowledged unstopped): the next
      // scan reopens its obligation
      .where(({ eb, exists, selectFrom }) =>
        eb.or([
          eb("o.resolution", "is", null),
          eb("o.resolution", "!=", "exact-cancelled"),
          exists(
            selectFrom("sandbox_operation_intents as ui")
              .select("ui.operation_id")
              .whereRef("ui.operation_id", "=", "m.ref_id")
              .where("ui.revoke_acknowledged", "=", true),
          ),
        ]),
      )
      .where(({ eb, and }) =>
        eb.not(and([eb("o.resolution", "=", "exact-cancelled"), eb("m.kind", "=", "legacy-task")])),
      )
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

  /**
   * Legacy rows without the dispatch marker started after the marker's migration was applied:
   * only a replica without the 8.5 code writes them (see {@link LegacyRetirementReport}).
   */
  private async unfencedWriters(
    state: LegacyFreezeState,
  ): Promise<LegacyRetirementReport["unfencedWriters"]> {
    return asPlatform("retirement of legacy launches across every org", async () => {
      // the migrator's own bookkeeping (schema `capybara`, `migrate()`): when 0157 was applied
      const applied = await sql<{ applied_at: Date }>`SELECT applied_at FROM capybara._migrations
      WHERE name = ${MARKER_MIGRATION}`.execute(this.db.db);
      const since = applied.rows[0]?.applied_at;
      if (since === undefined)
        return {
          sinceMigration: 0,
          afterFreeze: 0,
          afterEnumeration: 0,
          recent: 0,
          latestAt: null,
        };
      const after = (at: Date | null) => sql`CASE WHEN started_at > ${at}::timestamptz THEN 1 END`;
      const row = await this.db
        .selectFrom("background_tasks")
        .select((eb) => [
          eb.fn.countAll<string>().as("n"),
          eb.fn.count<string>(after(state.frozenAt)).as("after"),
          eb.fn.count<string>(after(state.enumeratedAt)).as("afterEnumeration"),
          // by the database clock, the one that stamped started_at
          eb.fn
            .count<string>(sql`CASE WHEN started_at > now() - ${RECENT}::interval THEN 1 END`)
            .as("recent"),
          eb.fn.max("started_at").as("latest"),
        ])
        .where("launch_state", "=", "legacy")
        .where("legacy_dispatch", "=", "unknown")
        .where("started_at", ">", since)
        .executeTakeFirstOrThrow();
      return {
        sinceMigration: Number(row.n),
        afterFreeze: Number(row.after),
        afterEnumeration: Number(row.afterEnumeration),
        recent: Number(row.recent),
        latestAt: (row.latest as Date | null) ?? null,
      };
    });
  }

  /** The release gate's honest view (a quarantined device is unavailable, not retired). */
  async report(): Promise<LegacyRetirementReport> {
    return asPlatform("retirement of legacy launches across every org", async () => {
      const freeze = await this.freezeState();
      const frozen = freeze.frozenAt !== null;
      const fenced = await this.db
        .selectFrom("background_tasks")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("launch_state", "=", "legacy")
        .where("status", "=", "running")
        .where("sid", "is", null)
        .where("legacy_dispatch", "=", "reserved")
        .executeTakeFirstOrThrow();
      const unfenced = await this.unfencedWriters(freeze);
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
        .where("state", "in", ["open", "quarantined"])
        .orderBy("created_at", "asc")
        .execute();
      const abandonedRows = await this.db
        .selectFrom("device_retirement_obligations")
        .select(["device_id", "provider", "instance_generation", "abandoned_at"])
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
        .where("d.deleted_at", "is", null)
        .where("t.launch_state", "=", "legacy")
        .where(MAY_STILL_RUN)
        .where(MAY_HAVE_DISPATCHED)
        .orderBy("t.device_id")
        .execute();
      const cloudUnknown = new Map<
        string,
        { prevHandle: boolean; noInstance: boolean; currentUnconfirmed: boolean }
      >();
      for (const r of cloudCandidates) {
        const key = legacyKey(r);
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
        frozenAt: freeze.frozenAt,
        freezeEnumeratedAt: freeze.enumeratedAt,
        fencedReservations: Number(fenced.n),
        unfencedWriters: unfenced,
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
          abandonedAt: r.abandoned_at as Date,
        })),
        cloudUnknown: [...cloudUnknown].map(([deviceId, flags]) => ({ deviceId, ...flags })),
        unresolved: unresolved.map((r) => ({
          deviceId: r.device_id,
          provider: r.provider,
          instanceGeneration: r.instance_generation,
          state: r.state as "open" | "quarantined",
          reason: r.reason,
        })),
      };
    });
  }
}
