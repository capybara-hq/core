import {
  DEVICE_SERVICE_RESTORE_MAX_AGE_MS,
  encodeConversationDeleted,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { isUnreachable } from "../background/stop.js";
import { queryDeclaredDeviceServices } from "../extensions/deployed-snapshots.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform, withOrgScope } from "../infra/database/org-scope.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SandboxService } from "../sandbox/sandbox.service.js";

/** The sweep of owed conversation notices (`@LockedInterval`, every {@link NOTICE_SWEEP_MS}). */
export const CONVERSATION_NOTICE_SWEEP_JOB = "device-conversation-notice-sweep";
/** The sweep's period. */
export const NOTICE_SWEEP_MS = 30_000;
/** The longest one attempt holds its row (the lease); an attempt's own deadline stays under it. */
export const NOTICE_CLAIM_MS = 60_000;
/** One attempt's deadline: the lease wait, the status checks and the requests. */
export const NOTICE_ATTEMPT_TIMEOUT_MS = 20_000;
/** One service request's deadline. */
export const NOTICE_REQUEST_TIMEOUT_MS = 10_000;
/** The first retry delay after a failed attempt; it doubles up to {@link NOTICE_BACKOFF_MAX_MS}. */
export const NOTICE_BACKOFF_MS = 30_000;
export const NOTICE_BACKOFF_MAX_MS = 120_000;
/** The most owed notices one sweep attempts. */
export const NOTICES_PER_SWEEP = 16;
/** An owed notice older than this is dropped (a device away that long ran its own idle close). */
export const NOTICE_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** The longest failure detail kept on the row. */
const FAILURE_MAX = 300;

/** What one attempt did with its notice. */
export type NoticeOutcome =
  /** Another attempt holds it, or it was delivered already. */
  | "skipped"
  /** Delivered (or no longer deliverable: the device is gone): the row is deleted. */
  | "delivered"
  /** Still owed: a service was not running inside the restore window, or the attempt failed. */
  | "owed";

interface NoticeRow {
  id: string;
  org_id: string;
  device_id: string;
  conversation_id: string;
  created_at: Date;
  attempts: number;
  acked_services: string[];
}

/** What reaching the device found. */
interface Reach {
  /** Service ids that answered the notice in this attempt. */
  acked: string[];
  /** Whether every declared service not acked yet was found stopped or absent (none failed). */
  reached: boolean;
  failure?: { unreachable: boolean; detail: string };
}

/**
 * Delivers the kernel's conversation-deleted notice to a device's services (close tabs on delete
 * design §4.3). A notice row is owed by the conversation's deletion
 * ({@link oweConversationDeletedNotice}); one attempt:
 *
 * 1. claims the row for {@link NOTICE_CLAIM_MS} (a row lease, never a lock inside a transaction):
 *    a row another attempt holds, or one already delivered, is skipped, so replicas never deliver
 *    one notice at once;
 * 2. a device that is gone (no row, deleted) ends the notice; a device whose provider is not
 *    loaded on this replica keeps it owed;
 * 3. on the device's current instance only, while it runs (`ifRunning`: never created, resumed or
 *    started), each declared device service ({@link queryDeclaredDeviceServices}) that has not
 *    acked yet: a running one gets the kernel's body ({@link encodeConversationDeleted}) and acks
 *    by answering; a stopped one stays pending;
 * 4. delivered (row deleted) once every declared service acked, or once the restore window
 *    (`DEVICE_SERVICE_RESTORE_MAX_AGE_MS`) since the deletion has passed and the attempt reached the
 *    device; otherwise owed, with the next turn after the sweep period (pending services) or a
 *    backoff (a failure; an unreachable device stays owed whatever the window).
 *
 * The body is built here, from the row's conversation id, and nowhere else.
 */
@Injectable()
export class ConversationNoticeDelivery {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(SandboxService)
    private readonly sandbox: Pick<
      SandboxService,
      "providerLoaded" | "currentInstance" | "ifRunning"
    >,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
  ) {}

  private get db() {
    return this.kdb.db;
  }

  /** One attempt at notice `noticeId` of org `orgId` (in that org's scope). */
  async attempt(orgId: string, noticeId: string): Promise<NoticeOutcome> {
    const row = await this.claim(orgId, noticeId);
    if (!row) return "skipped";
    try {
      return await this.deliver(row);
    } catch (err) {
      // a kernel failure (the database, a lease wait): owed, the sweep tries again
      await this.release(row, { unreachable: false, detail: errText(err) });
      this.log.warn("conversation notice attempt failed; it stays owed", {
        noticeId: row.id,
        deviceId: row.device_id,
        err,
      });
      return "owed";
    }
  }

  /**
   * One sweep: drops notices older than {@link NOTICE_MAX_AGE_MS}, then attempts up to
   * {@link NOTICES_PER_SWEEP} owed notices whose turn came and that no attempt holds, oldest turn
   * first: devices side by side, one device's notices one after another (a silent machine costs
   * one attempt's deadline per tick). Returns the outcomes by notice id.
   */
  async sweepOnce(): Promise<Map<string, NoticeOutcome>> {
    const rows = await this.due();
    const byDevice = new Map<string, { id: string; org_id: string }[]>();
    for (const r of rows) byDevice.set(r.device_id, [...(byDevice.get(r.device_id) ?? []), r]);
    const out = new Map<string, NoticeOutcome>();
    await Promise.all(
      [...byDevice.values()].map(async (list) => {
        for (const r of list) {
          // each notice in its own org's scope
          out.set(r.id, await withOrgScope(r.org_id, () => this.attempt(r.org_id, r.id)));
        }
      }),
    );
    return out;
  }

  /** Drops expired notices and lists the due ones, across every org (the platform scope). */
  // org-filter: deployment-wide conversation notice sweep: the expiry and the due list span every
  // org; each listed notice is then attempted in its own org's scope
  private due(): Promise<{ id: string; org_id: string; device_id: string }[]> {
    return asPlatform("deployment-wide conversation notice sweep across all orgs", async () => {
      const expired = await this.db
        .deleteFrom("device_conversation_notices")
        .where(
          "created_at",
          "<",
          sql<Date>`now() - ${NOTICE_MAX_AGE_MS}::bigint * interval '1 millisecond'`,
        )
        .returning(["id", "device_id"])
        .execute();
      if (expired.length > 0)
        this.log.info("owed conversation notices expired undelivered", { count: expired.length });
      return this.db
        .selectFrom("device_conversation_notices")
        .select(["id", "org_id", "device_id"])
        .where("next_attempt_at", "<=", sql<Date>`now()`)
        .where((eb) =>
          eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<", sql<Date>`now()`)]),
        )
        .orderBy("next_attempt_at", "asc")
        .orderBy("id", "asc")
        .limit(NOTICES_PER_SWEEP)
        .execute();
    });
  }

  /** Takes the row's lease, or null when another attempt holds it or it is gone. */
  private async claim(orgId: string, noticeId: string): Promise<NoticeRow | null> {
    const row = await this.db
      .updateTable("device_conversation_notices")
      .set({
        claimed_until: sql<Date>`now() + ${NOTICE_CLAIM_MS}::integer * interval '1 millisecond'`,
        attempts: sql<number>`attempts + 1`,
      })
      .where("id", "=", noticeId)
      .where("org_id", "=", orgId)
      .where((eb) =>
        eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<", sql<Date>`now()`)]),
      )
      .returning([
        "id",
        "org_id",
        "device_id",
        "conversation_id",
        "created_at",
        "attempts",
        "acked_services",
      ])
      .executeTakeFirst();
    return row ?? null;
  }

  private async deliver(row: NoticeRow): Promise<NoticeOutcome> {
    const device = await this.db
      .selectFrom("devices")
      .select(["id", "deleted_at"])
      .where("id", "=", row.device_id)
      .where("org_id", "=", row.org_id)
      .executeTakeFirst();
    if (!device || device.deleted_at !== null) {
      // a deleted device holds no services (its destroy is owed elsewhere)
      await this.remove(row);
      return "delivered";
    }
    if (!(await this.sandbox.providerLoaded(row.device_id))) {
      await this.release(row, { unreachable: false, detail: "provider not loaded" });
      return "owed";
    }
    const declared = await queryDeclaredDeviceServices(this.db);
    const pending = declared.filter((id) => !row.acked_services.includes(id));
    const reach =
      pending.length === 0 ? { acked: [], reached: true } : await this.reach(row, pending);
    const acked = [...new Set([...row.acked_services, ...reach.acked])].sort();
    if (declared.every((id) => acked.includes(id))) {
      await this.remove(row);
      return "delivered";
    }
    const windowPassed = Date.now() - row.created_at.getTime() >= DEVICE_SERVICE_RESTORE_MAX_AGE_MS;
    if (reach.failure === undefined && reach.reached && windowPassed) {
      await this.remove(row);
      return "delivered";
    }
    await this.release(row, reach.failure, acked);
    if (reach.failure && !reach.failure.unreachable)
      this.log.warn("conversation notice not delivered; it stays owed", {
        noticeId: row.id,
        deviceId: row.device_id,
        detail: reach.failure.detail,
      });
    return "owed";
  }

  /** Sends the notice to each pending service that runs on the device's running instance. */
  private async reach(row: NoticeRow, pending: string[]): Promise<Reach> {
    const current = await this.sandbox.currentInstance(row.device_id);
    // no instance: nothing runs (a resume within the window restores, so the caller keeps it owed)
    if (!current) return { acked: [], reached: true };
    const body = encodeConversationDeleted(row.conversation_id);
    const acked: string[] = [];
    let failure: Reach["failure"];
    const r = await this.sandbox
      .ifRunning(
        row.device_id,
        { createdAt: current.createdAt },
        async (p, h, signal) => {
          if (!p.serviceStatus || !p.serviceRequest) return;
          for (const id of pending) {
            try {
              const status = await p.serviceStatus(h, id, signal);
              if (status.state !== "running") continue;
              await p.serviceRequest(h, id, body, { timeoutMs: NOTICE_REQUEST_TIMEOUT_MS, signal });
              acked.push(id);
            } catch (err) {
              failure = { unreachable: isUnreachable(err), detail: errText(err) };
              // a machine that did not answer will not answer the next service either
              if (failure.unreachable) return;
            }
          }
        },
        AbortSignal.timeout(NOTICE_ATTEMPT_TIMEOUT_MS),
      )
      .catch((err: unknown) => {
        failure = { unreachable: isUnreachable(err), detail: errText(err) };
        return null;
      });
    if (r !== null && r.kind === "other_instance" && failure === undefined)
      failure = { unreachable: false, detail: "the device's instance changed" };
    return { acked, reached: failure === undefined, ...(failure && { failure }) };
  }

  private async remove(row: NoticeRow): Promise<void> {
    await this.db
      .deleteFrom("device_conversation_notices")
      .where("id", "=", row.id)
      .where("org_id", "=", row.org_id)
      .execute();
  }

  /** Frees the lease and sets the next turn: the sweep period, or a backoff after a failure. */
  private async release(
    row: NoticeRow,
    failure: { unreachable: boolean; detail: string } | undefined,
    acked: string[] = row.acked_services,
  ): Promise<void> {
    const delay =
      failure === undefined
        ? NOTICE_SWEEP_MS
        : Math.min(NOTICE_BACKOFF_MS * 2 ** Math.max(0, row.attempts - 1), NOTICE_BACKOFF_MAX_MS);
    await this.db
      .updateTable("device_conversation_notices")
      .set({
        claimed_until: null,
        next_attempt_at: sql<Date>`now() + ${delay}::integer * interval '1 millisecond'`,
        acked_services: acked,
        last_failure:
          failure === undefined ? null : failure.unreachable ? "unreachable" : failure.detail,
      })
      .where("id", "=", row.id)
      .where("org_id", "=", row.org_id)
      .execute();
  }
}

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, FAILURE_MAX);

/**
 * The sweep of owed conversation notices: once per tick across replicas (`@LockedInterval`),
 * provided only by the worker role (`WorkerModule`).
 */
@Injectable()
export class ConversationNoticeSweepJob {
  constructor(
    @Inject(ConversationNoticeDelivery)
    private readonly delivery: Pick<ConversationNoticeDelivery, "sweepOnce">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(CONVERSATION_NOTICE_SWEEP_JOB, () => NOTICE_SWEEP_MS)
  async sweep(): Promise<void> {
    await this.delivery.sweepOnce();
  }
}

/** The notice delivery (used by the maintenance worker's job and the worker's sweep). */
@Module({
  imports: [SandboxModule],
  providers: [ConversationNoticeDelivery],
  exports: [ConversationNoticeDelivery],
})
export class ConversationNoticesModule {}
