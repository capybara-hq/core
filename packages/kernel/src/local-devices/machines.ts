import { randomBytes } from "node:crypto";
import type {
  DeviceFeature,
  DeviceHello,
  DeviceLocalPolicySummary,
  DeviceStopArgs,
  ExtensionContext,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { audit } from "../identity/audit.js";
import { sha256Hex } from "../identity/hash.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { LOCAL_PROVIDER } from "../sandbox/providers.js";
import { deviceNotFound } from "../sandbox/sandbox.service.js";
import { deviceRevokedTopic } from "./keys.js";
import { DEVICE_OP_RESOLVE_JOB, deviceOpReportedJobId } from "./policy-op-jobs.js";
import {
  deviceFeaturesOf,
  localPolicyDiff,
  localPolicyOf,
  opExplains,
  opVisibleIn,
  pendingPolicyOpsOf,
  type ReportedPolicyOp,
} from "./policy-summary.js";
import { LocalDeviceRelay } from "./relay.js";

/** The machine credential's prefix (`cap_dev_` plus 32 random bytes, base64url). */
export const MACHINE_CREDENTIAL_PREFIX = "cap_dev_";
const CREDENTIAL_RE = /^cap_dev_[A-Za-z0-9_-]{43}$/;

/** How long the `stop` frame told to a revoked machine may take (it only closes the connection). */
const STOP_DEADLINE_MS = 30_000;

/** What a machine credential stands for. */
export interface MachineIdentity {
  machineId: string;
  orgId: string;
  deviceId: string;
  accountId: string;
}

/** The machine connected to a device (its unrevoked row). */
export interface ActiveMachine {
  id: string;
  orgId: string;
  accountId: string;
  name: string;
  os: string;
  arch: string;
  programVersion: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  /** The features its program reported in its last hello (known ones only). */
  features: DeviceFeature[];
  /** Its local network policy as last reported (hello or `policy` op); null when unknown. */
  localPolicy: DeviceLocalPolicySummary | null;
}

/**
 * Connected machines and their credentials (environments spec §13.2). One active machine per
 * local device: issuing a credential revokes the device's previous machine. A
 * credential is `cap_dev_` plus 32 random bytes; only its sha256 is stored. It is accepted only
 * by the device connection route ({@link authenticate}), never by `/api`: it is no `Principal`.
 *
 * A revoked machine is told so after the commit: `stop { reason }` relayed while a replica holds
 * its connection (fire-and-forget, ruling R14) and `device.revoked.<deviceId>` published with
 * `{ machineId }`, so the holder closes that machine's connection.
 */
@Injectable()
export class MachinesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LocalDeviceRelay) private readonly relay: Pick<LocalDeviceRelay, "holderLive" | "send">,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * A new machine for the device and its credential (returned once). Revokes the
   * device's active machine first. Joins the caller's transaction (the device confirmation),
   * which has already checked the device is the person's own live local device.
   */
  @Transactional()
  async issue(input: {
    orgId: string;
    deviceId: string;
    accountId: string;
    name: string;
    os: string;
    arch: string;
    programVersion: string;
  }): Promise<{ machineId: string; credential: string }> {
    // the machine the device was last served from (revoked or not)
    const prev = await this.db
      .selectFrom("device_machines")
      .select(["name", "os", "arch"])
      .where("device_id", "=", input.deviceId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    // another machine has other files (maintainer decision 2026-11-08)
    const moved = prev !== undefined && !sameMachine(prev, input);
    // no stop frame: it would wait on the list and could reach the replacement machine instead
    await this.revokeActive(input.deviceId, null);
    await this.resetInstance(input.deviceId, moved);
    const credential = MACHINE_CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
    const row = await this.db
      .insertInto("device_machines")
      .values({
        org_id: input.orgId,
        device_id: input.deviceId,
        account_id: input.accountId,
        credential_hash: sha256Hex(credential),
        name: input.name,
        os: input.os,
        arch: input.arch,
        program_version: input.programVersion,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { machineId: row.id, credential };
  }

  /**
   * Ruling R23: the new machine may serve the device from another directory or mode (other
   * roots), and a login recreates a directory that was lost (ruling R24). So the instance row
   * forgets its instance (status `none`, no handle) and its files count as there again; the next
   * use creates a fresh instance on the machine (with its roots: a new `device_paths` event
   * follows). The fence moves on, so a lifecycle holder of the old instance fails its next write.
   * The reset count (`fs_resets`) moves on when the files the next instance sees are not the old
   * ones, so conversations that used the old files are told their files were reset, not that they
   * were kept: lost files come back as an empty directory, and another machine (`moved`: name, OS
   * or arch differ from the device's previous machine) has other files. Another directory on
   * the same machine is known only from the new machine's first hello ({@link recordHello}).
   */
  private async resetInstance(deviceId: string, moved: boolean): Promise<void> {
    await this.db
      .updateTable("device_instances")
      .set((eb) => ({
        status: "none",
        handle: null,
        fs_status: sql<"none" | "ready">`CASE WHEN fs_handle IS NULL THEN 'none' ELSE 'ready' END`,
        running_since: null,
        suspended_at: null,
        destroyed_at: sql<Date>`now()`,
        generation: eb("generation", "+", 1),
        fs_resets: moved
          ? sql<number>`fs_resets + 1`
          : sql<number>`CASE WHEN fs_status = 'lost' THEN fs_resets + 1 ELSE fs_resets END`,
      }))
      .where("device_id", "=", deviceId)
      .execute();
  }

  /**
   * Who a machine credential stands for, or null: the machine is not revoked, its device is
   * live, the org is not deleted (ruling R12), and the person is an active account still a member
   * of the org. Read live on every call (a connection re-checks it as it sees fit).
   */
  async authenticate(credential: string): Promise<MachineIdentity | null> {
    if (!CREDENTIAL_RE.test(credential)) return null;
    const row = await this.db
      .selectFrom("device_machines as m")
      .innerJoin("devices as e", "e.id", "m.device_id")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .innerJoin("memberships as ms", (j) =>
        j.onRef("ms.org_id", "=", "m.org_id").onRef("ms.account_id", "=", "m.account_id"),
      )
      .innerJoin("accounts as a", "a.id", "m.account_id")
      .select(["m.id", "m.org_id", "m.device_id", "m.account_id"])
      .where("m.credential_hash", "=", sha256Hex(credential))
      .where("m.revoked_at", "is", null)
      .whereRef("e.org_id", "=", "m.org_id")
      .where("e.deleted_at", "is", null)
      .where("e.source", "=", "local")
      .where("o.deleted_at", "is", null)
      .where("a.status", "=", "active")
      .executeTakeFirst();
    return row
      ? {
          machineId: row.id,
          orgId: row.org_id,
          deviceId: row.device_id,
          accountId: row.account_id,
        }
      : null;
  }

  /**
   * Stores what the program reported in its hello frame and marks the machine seen. On the
   * machine's first hello, when it is the same machine as the device's previous one (else
   * {@link issue} already counted the reset) but serves another directory or mode (other roots,
   * ruling R23), the device's files are other files: `fs_resets` moves on (maintainer
   * decision 2026-11-08), so conversations get the files-reset notice. A previous machine that
   * never said hello has no known roots: nothing to compare. The reported features (known ones
   * only) and local policy summary (null when absent or malformed) replace the stored ones, so a
   * program downgraded to one without them is no longer sent what it cannot do. The summary is the
   * device's mode and sandbox-mode allowlist; a change of what the owner sets, made on the machine
   * while it was away, is audited `device.policy_changed` / `device.mode_changed`
   * ({@link reportedPolicy}). The outcomes of its recent policy ops (`recentOps`) backfill the
   * platform's ops still pending on the row ({@link backfillOps}).
   */
  @Transactional()
  async recordHello(
    machineId: string,
    hello: DeviceHello,
    rawPolicy: unknown = hello.policy,
  ): Promise<void> {
    const self = await this.db
      .selectFrom("device_machines")
      .select([
        "device_id",
        "org_id",
        "account_id",
        "name",
        "os",
        "arch",
        "roots",
        "created_at",
        "local_policy",
        "pending_policy_ops",
      ])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (self === undefined) return;
    if (self.roots === null) {
      const prev = await this.db
        .selectFrom("device_machines")
        .select(["name", "os", "arch", "mode"])
        .select(sql<boolean>`roots = ${JSON.stringify(hello.roots)}::jsonb`.as("same_roots"))
        .where("device_id", "=", self.device_id)
        .where("id", "!=", machineId)
        .where("created_at", "<=", self.created_at)
        .where("roots", "is not", null)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
      if (
        prev !== undefined &&
        sameMachine(prev, self) &&
        (!prev.same_roots || prev.mode !== hello.mode)
      ) {
        await this.db
          .updateTable("device_instances")
          .set({ fs_resets: sql<number>`fs_resets + 1` })
          .where("device_id", "=", self.device_id)
          .execute();
      }
    }
    const policy = await this.reportedPolicy(machineId, self, hello.policy, rawPolicy);
    await this.db
      .updateTable("device_machines")
      .set({
        program_version: hello.programVersion,
        os: hello.os,
        arch: hello.arch,
        mode: hello.mode,
        roots: JSON.stringify(hello.roots),
        session_isolation: hello.sessionIsolation,
        features: deviceFeaturesOf(hello.features),
        local_policy: jsonOrNull(policy),
        last_seen_at: sql<Date>`now()`,
      })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .execute();
    if (hello.recentOps !== undefined) {
      await this.backfillOps(machineId, self, hello.recentOps, localPolicyOf(hello.policy));
    }
  }

  /**
   * Hello backfill (transactional outbox spec §7): a pending op of the platform's whose outcome
   * the hello reports (`applied`, `refused`), or that it does not list although the op can no
   * longer reach the machine (`absent`: past its `resolveAt`), is marked `reported` and owes a
   * `device-op-resolve` job (`device-op-reported-<opId>`) that records the outcome. An op the
   * machine logged only as `started` (it stopped between the log and the answer) is judged once
   * past its `resolveAt` by the policy the hello reports: its change there → `applied`, else
   * `interrupted` (within the window, or with no readable policy, it is left). An expired entry
   * (past `until`) is skipped: the machine's reports are no longer the op's. Runs in the caller's
   * transaction, with the machine's row locked; an op already reported is not owed again.
   */
  private async backfillOps(
    machineId: string,
    self: { org_id: string; pending_policy_ops: unknown },
    recentOps: NonNullable<DeviceHello["recentOps"]>,
    policy: DeviceLocalPolicySummary | null,
  ): Promise<void> {
    const outcomes = new Map(recentOps.map((r) => [r.opId, r.outcome]));
    const now = Date.now();
    const reported = new Map<string, ReportedPolicyOp>();
    for (const op of pendingPolicyOpsOf(self.pending_policy_ops)) {
      if (op.reported !== undefined || op.until <= now) continue;
      const outcome = outcomes.get(op.id);
      if (outcome === "applied" || outcome === "refused") reported.set(op.id, { outcome });
      else if (now < op.resolveAt) continue;
      else if (outcome === undefined) reported.set(op.id, { outcome: "absent" });
      else if (policy !== null) {
        reported.set(op.id, { outcome: opVisibleIn(op, policy) ? "applied" : "interrupted" });
      }
    }
    if (reported.size === 0) return;
    const ops = Array.isArray(self.pending_policy_ops) ? self.pending_policy_ops : [];
    const next = ops.map((e: unknown) => {
      const id = (e as { id?: unknown } | null)?.id;
      const r = typeof id === "string" ? reported.get(id) : undefined;
      return r === undefined ? e : { ...(e as object), reported: r };
    });
    await this.db
      .updateTable("device_machines")
      .set({ pending_policy_ops: JSON.stringify(next) })
      .where("id", "=", machineId)
      .execute();
    for (const opId of reported.keys()) {
      await this.outbox.add({
        queue: MAINTENANCE_QUEUE_NAME,
        name: DEVICE_OP_RESOLVE_JOB,
        jobId: deviceOpReportedJobId(opId),
        data: { machineId, opId },
        orgId: self.org_id,
      });
    }
  }

  /**
   * Stores the local policy summary a connected program pushed after its hello (a `policy` frame:
   * its policy file changed on the machine: its mode or its sandbox-mode allowlist), read and
   * audited as the hello's ({@link recordHello}). A change the owner made on the machine is
   * audited `device.policy_changed` / `device.mode_changed`. The next sandbox call then records a
   * new `device_paths` event when the facts the model is told changed. A revoked machine is left
   * alone.
   */
  @Transactional()
  async recordPolicy(
    machineId: string,
    summary: DeviceLocalPolicySummary | undefined,
    rawPolicy: unknown = summary,
  ): Promise<void> {
    const self = await this.db
      .selectFrom("device_machines")
      .select(["device_id", "org_id", "account_id", "local_policy", "pending_policy_ops"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (self === undefined) return;
    const policy = await this.reportedPolicy(machineId, self, summary, rawPolicy);
    await this.db
      .updateTable("device_machines")
      .set({ local_policy: jsonOrNull(policy), last_seen_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /**
   * The summary to store for one a program reported (hello or `policy` frame): the parsed one, else
   * null. When both the stored and the reported summary are readable and what the owner sets
   * changed ({@link localPolicyDiff}) by no `policy` op the platform sent ({@link opExplains}: its
   * answer may come after the machine's own report), the owner changed it on the machine
   * (`capybara-device mode` / `capybara-device policy ...`): the host changes are audited
   * `device.policy_changed` and the mode change `device.mode_changed`, both `via: "device"`, so the
   * device page lists them beside the platform's changes; one an op explains is not audited here
   * (the op's answer is). A summary reported again is no change. Runs in the caller's transaction,
   * with the machine's row locked.
   */
  private async reportedPolicy(
    machineId: string,
    self: {
      device_id: string;
      org_id: string;
      account_id: string;
      local_policy: unknown;
      pending_policy_ops: unknown;
    },
    reported: DeviceLocalPolicySummary | undefined,
    _rawPolicy: unknown,
  ): Promise<DeviceLocalPolicySummary | null> {
    const summary = localPolicyOf(reported);
    const prev = localPolicyOf(self.local_policy);
    const diff = summary !== null && prev !== null ? localPolicyDiff(prev, summary) : null;
    if (diff !== null) {
      const now = Date.now();
      const byOp = pendingPolicyOpsOf(self.pending_policy_ops).some(
        (op) => op.until > now && opExplains(op, diff),
      );
      if (byOp) return summary;
      const base = {
        actorAccountId: self.account_id,
        orgId: self.org_id,
        target: self.device_id,
      };
      if (diff.add.length > 0 || diff.remove.length > 0) {
        await audit(this.db.db, {
          ...base,
          action: "device.policy_changed",
          detail: {
            add: diff.add,
            remove: diff.remove,
            by: self.account_id,
            via: "device",
            machineId,
            approvalId: null,
          },
        });
      }
      if (diff.mode !== undefined) {
        await audit(this.db.db, {
          ...base,
          action: "device.mode_changed",
          detail: {
            from: diff.mode.from,
            to: diff.mode.to,
            by: self.account_id,
            via: "device",
            machineId,
          },
        });
      }
      return summary;
    }
    return summary;
  }

  /** Marks the machine seen (a ping); writes at most once every 60 seconds. */
  async touch(machineId: string): Promise<void> {
    await this.db
      .updateTable("device_machines")
      .set({ last_seen_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("last_seen_at", "is", null),
          eb("last_seen_at", "<", sql<Date>`now() - interval '60 seconds'`),
        ]),
      )
      .execute();
  }

  /**
   * Disconnects the machine of one of the person's own live local devices (`DELETE
   * /orgs/:orgId/devices/:id/machine`): revokes it and audits
   * `device.machine_revoked`. Anyone else's device, a cloud one or a missing one →
   * `device.not_found`; no machine connected is a no-op.
   */
  @Transactional()
  async revoke(
    orgId: string,
    accountId: string,
    deviceId: string,
    actorTokenId?: string,
  ): Promise<void> {
    const env = await this.db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("source", "=", "local")
      .where("provider", "=", LOCAL_PROVIDER)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!env) throw deviceNotFound();
    const machineId = await this.revokeActive(deviceId, "revoked");
    if (machineId === null) return;
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.machine_revoked",
      target: deviceId,
      detail: { machineId },
    });
  }

  /**
   * Revokes the device's active machine, if any, in the caller's transaction, and after the
   * commit tells it to stop for `reason` (none: only its connection is closed) and closes its
   * connection. Returns the revoked machine's id. Used by {@link issue} (replaced: no stop),
   * {@link revoke} and the device's deletion (`deleted`).
   */
  async revokeActive(
    deviceId: string,
    reason: DeviceStopArgs["reason"] | null,
  ): Promise<string | null> {
    const row = await this.db
      .updateTable("device_machines")
      .set({ revoked_at: sql<Date>`now()` })
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) return null;
    const machineId = row.id;
    afterCommit(() => this.disconnect(deviceId, machineId, reason));
    return machineId;
  }

  /**
   * Revokes one machine by id (a sign-in whose credential never reached the program), with the
   * same post-commit disconnect as a replacement (no stop frame). True when it was active.
   */
  async revokeMachine(machineId: string): Promise<boolean> {
    const row = await this.db
      .updateTable("device_machines")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .returning("device_id")
      .executeTakeFirst();
    if (!row) return false;
    const deviceId = row.device_id;
    afterCommit(() => this.disconnect(deviceId, machineId, null));
    return true;
  }

  /** The device's active machine, or null. */
  async activeFor(deviceId: string): Promise<ActiveMachine | null> {
    const r = await this.db
      .selectFrom("device_machines")
      .select([
        "id",
        "org_id",
        "account_id",
        "name",
        "os",
        "arch",
        "program_version",
        "last_seen_at",
        "created_at",
        "features",
        "local_policy",
      ])
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return r
      ? {
          id: r.id,
          orgId: r.org_id,
          accountId: r.account_id,
          name: r.name,
          os: r.os,
          arch: r.arch,
          programVersion: r.program_version,
          lastSeenAt: r.last_seen_at,
          createdAt: r.created_at,
          features: deviceFeaturesOf(r.features),
          localPolicy: localPolicyOf(r.local_policy),
        }
      : null;
  }

  /**
   * After a revocation commits: `stop` is queued only while a replica holds the connection (an
   * offline machine must not find it on the list later), then the revocation is published.
   * Failures are logged; the revocation itself stands.
   */
  private async disconnect(
    deviceId: string,
    machineId: string,
    reason: DeviceStopArgs["reason"] | null,
  ): Promise<void> {
    try {
      if (reason !== null && (await this.relay.holderLive(deviceId))) {
        await this.relay.send(deviceId, "stop", { reason }, STOP_DEADLINE_MS);
      }
    } catch (err) {
      this.log.warn("could not tell a revoked machine to stop", { deviceId, machineId, err });
    }
    try {
      await this.bus.publish(deviceRevokedTopic(deviceId), { machineId });
    } catch (err) {
      this.log.warn("could not publish a machine revocation", { deviceId, machineId, err });
    }
  }
}

const jsonOrNull = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));

/** Two machine rows (or a login) name the same machine: same name, OS and arch. */
function sameMachine(
  a: { name: string; os: string; arch: string },
  b: { name: string; os: string; arch: string },
): boolean {
  return a.name === b.name && a.os === b.os && a.arch === b.arch;
}
