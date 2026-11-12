import { randomUUID } from "node:crypto";
import {
  type DeviceFeature,
  type DeviceLocalPolicySummary,
  type DevicePolicyArgs,
  type DevicePolicyStatus,
  ToolError,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { currentStore, TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { deviceNotFound } from "../sandbox/sandbox.service.js";
import { MachinesService } from "./machines.js";
import { DEVICE_OP_RESOLVE_JOB, deviceOpResolveJobId } from "./policy-op-jobs.js";
import { isolationOf, type PendingPolicyOp, pendingPolicyOpsOf } from "./policy-summary.js";
import { LIST_TTL_MARGIN_MS, LocalDeviceRelay, ON_MACHINE_PREFIX } from "./relay.js";

/** How long the machine may take to apply a policy change. */
export const POLICY_DEADLINE_MS = 30_000;

/** How long the machine may take to answer a `policyStatus` (it only reads its op log). */
const STATUS_DEADLINE_MS = 10_000;

/** How long an op left `unknown` waits for the machine's hello to report it (from its intent). */
export const UNKNOWN_OP_MS = 24 * 3_600_000;

/** A policy change as callers ask for it: the op id and the source are added here. */
type PolicyChange = Omit<DevicePolicyArgs, "source" | "opId">;

/** The prefix the relay puts before a machine's `policy`-kind refusal. */
const REFUSED_PREFIX = "Refused by the machine's local policy: ";

/**
 * Test seam (`KernelOverride`): called right after the `policy` op's call returned, before its
 * outcome is recorded; throwing stands for a crash between the call and the resolve transaction.
 * The kernel never provides it.
 */
export const DEVICE_POLICY_AFTER_CALL = Symbol("DEVICE_POLICY_AFTER_CALL");

/** What became of a policy change. */
export type PolicyChangeOutcome =
  | { applied: true; policy: DeviceLocalPolicySummary }
  | { applied: false; reason: "offline" | "refused" | "unsupported"; message: string };

/**
 * An op whose intent is recorded ({@link DevicePolicyService.begin}): the call sends `args` to
 * the device's machine.
 */
export interface PolicyIntent {
  orgId: string;
  deviceId: string;
  machineId: string;
  opId: string;
  args: DevicePolicyArgs;
}

/**
 * What became of a sent op, as recorded by {@link DevicePolicyService.settleIn}: `applied` (with
 * the policy the machine wrote, when it said), `refused` (the machine's message), `not_received`
 * (the machine never got it and never will), `unknown` (no answer).
 */
export type PolicyOpResult =
  | { outcome: "applied"; policy?: DeviceLocalPolicySummary }
  | { outcome: "refused"; message: string }
  | { outcome: "not_received" }
  | { outcome: "interrupted" }
  | { outcome: "unknown" };

/** What a machine says of an op id ({@link DevicePolicyService.outcomeOf}). */
export type PolicyOpStatus = DevicePolicyStatus | { outcome: "offline" };

const OFFLINE_MESSAGE =
  "The device's machine is offline, so its policy was not changed. Start capybara-device on it.";
const UNSUPPORTED_MESSAGE =
  "The device's capybara-device program cannot change its policy from the platform. Update capybara-device on the machine.";
const UNCONFIRMED_MESSAGE =
  "The device's machine did not confirm the policy change; the platform checks it again shortly.";
const INTERRUPTED_MESSAGE =
  "capybara-device stopped while applying the policy change, and the change is not in the device's policy now.";
/** The longest text of the machine's own error the caller is told (as its op log keeps it). */
const MAX_MACHINE_MESSAGE = 500;
const NOT_RECEIVED_MESSAGE = "The device's machine never received the policy change.";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Changes a local device's policy on its machine (network ask-to-allow spec §5.2; sandbox dev
 * tiers spec §7.3: its hosts, its `tier`, and `isolation` back to `sandbox`): the kernel→device
 * `policy` op over the {@link LocalDeviceRelay}. The machine is the authority: it refuses
 * widening unless its owner allows remote grants, validates every host and answers with the
 * policy as written, which the kernel then keeps on the active machine's row (§5.4).
 *
 * Intent first (transactional outbox spec §7): {@link begin} writes the intent in a transaction
 * before anything is sent (the entry on the machine row's `pending_policy_ops`, the audit
 * `device.policy_requested` and the `device-op-resolve` job owed for when the op can no longer
 * reach the machine); the call sends the op with its id (no transaction open); {@link settleIn}
 * records the outcome: `device.policy_changed` (applied), `device.policy_failed` (refused, never
 * received) or `device.policy_unknown` (no answer: the entry stays, `unknown`, for the machine's
 * next hello or the resolver). A crash between the call and the resolve transaction leaves the
 * intent and its owed job, whose resolver asks the machine what became of the op (never sends it
 * again). Callers decide who may change a device's policy (the device owner, in a signed-in
 * session); this service checks only that the device is a live device of the org.
 */
@Injectable()
export class DevicePolicyService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LocalDeviceRelay) private readonly relay: Pick<LocalDeviceRelay, "call" | "holderLive">,
    @Inject(MachinesService) private readonly machines: Pick<MachinesService, "activeFor">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional()
    @Inject(DEVICE_POLICY_AFTER_CALL)
    private readonly afterCall: (opId: string) => void = () => {},
  ) {}

  /**
   * Changes the policy: {@link begin}, the call, then the outcome recorded in its own transaction
   * (no transaction may be open). Never throws for an offline machine, a refusal or a program
   * without the `policyOpId` feature (nothing is sent to it); a device that is not a live device
   * of `orgId` is `device.not_found`.
   */
  async apply(input: {
    orgId: string;
    deviceId: string;
    change: PolicyChange;
    source: DevicePolicyArgs["source"];
    actorTokenId?: string;
  }): Promise<PolicyChangeOutcome> {
    const begun = await this.begin(input);
    if ("outcome" in begun) return begun.outcome;
    const { intent } = begun;
    const sent = await this.send(intent);
    this.afterCall(intent.opId);
    const out = await this.settle(intent, sent.result);
    if (sent.notFound) throw deviceNotFound();
    // unknown: the caller is told what the call saw (offline, or an answer the machine did not
    // confirm), not the recorded state's generic text
    return sent.result.outcome === "unknown" ? sent.outcome : (out ?? sent.outcome);
  }

  /**
   * Checks the device and its machine, then records the intent in its own transaction: the entry
   * (`sent`) on the machine's row, the audit `device.policy_requested` and the `device-op-resolve`
   * job owed for when the op can no longer reach the machine. No transaction may be open (the
   * call follows). Returns the intent, or why nothing will be sent (offline, unsupported).
   */
  async begin(input: {
    orgId: string;
    deviceId: string;
    change: PolicyChange;
    source: DevicePolicyArgs["source"];
    actorTokenId?: string;
  }): Promise<{ intent: PolicyIntent } | { outcome: PolicyChangeOutcome }> {
    if (currentStore()) {
      throw new Error(
        "DevicePolicyService.apply() must not run inside a transaction: the intent is recorded " +
          "first, the policy op sent, then the outcome recorded in a transaction.",
      );
    }
    assertHosts(input.change, input.source.approvalId !== undefined);
    const device = await this.db
      .selectFrom("devices as e")
      .innerJoin("orgs as o", "o.id", "e.org_id")
      .select("e.source")
      .where("e.id", "=", input.deviceId)
      .where("e.org_id", "=", input.orgId)
      .where("e.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    if (!device) throw deviceNotFound();
    if (device.source !== "local") return { outcome: unsupported() };
    const machine = await this.machines.activeFor(input.deviceId);
    if (machine === null) return { outcome: offline() };
    // only a program that logs op outcomes under their ids can tell what became of a lost answer
    if (!machine.features.includes("policyOpId")) return { outcome: unsupported() };
    // not connected: nothing is sent (a queued op would wait for a reconnect nobody watches)
    if (!(await this.relay.holderLive(input.deviceId))) return { outcome: offline() };
    const opId = randomUUID();
    const args: DevicePolicyArgs = { ...input.change, opId, source: input.source };
    const recorded = await this.recordIntent({ ...input, machineId: machine.id, opId });
    if (!recorded) return { outcome: offline() };
    return {
      intent: { orgId: input.orgId, deviceId: input.deviceId, machineId: machine.id, opId, args },
    };
  }

  /**
   * Sends the intent's `policy` op (no transaction may be open) and classifies the answer:
   * applied; refused (the machine's local policy refused it: its message); anything else is
   * `unknown`, left to the resolver's `policyStatus`: no answer, and an answer the kernel cannot
   * trust to mean "not applied" (a result it cannot read, the machine's own error). `notFound`:
   * the device was deleted meanwhile (recorded as unknown; the caller throws `device.not_found`).
   */
  async send(intent: PolicyIntent): Promise<{
    result: PolicyOpResult;
    outcome: PolicyChangeOutcome;
    notFound?: true;
  }> {
    if (currentStore()) {
      throw new Error(
        "DevicePolicyService.send() must not run inside a transaction: the outcome is recorded " +
          "afterwards, in its own transaction.",
      );
    }
    try {
      const { policy } = await this.relay.call(intent.deviceId, "policy", intent.args, {
        deadlineMs: POLICY_DEADLINE_MS,
        // the relay gives up by itself (deadline plus the reconnect grace)
        signal: new AbortController().signal,
      });
      return { result: { outcome: "applied", policy }, outcome: { applied: true, policy } };
    } catch (e) {
      if (e instanceof ApiError) {
        // device.offline (the wait ran out: the machine may still apply it), device.forbidden
        // (the machine was disconnected meanwhile), device.not_found (the device was deleted)
        return {
          result: { outcome: "unknown" },
          outcome: offline(),
          ...(e.code === "device.not_found" && { notFound: true as const }),
        };
      }
      if (e instanceof ToolError && e.message.startsWith(REFUSED_PREFIX)) {
        const message = e.message.slice(REFUSED_PREFIX.length);
        return {
          result: { outcome: "refused", message },
          outcome: { applied: false, reason: "refused", message },
        };
      }
      // an unreadable result (the machine may have applied it) or the machine's own error (it may
      // have failed after the write): what the machine logged under the op id tells
      this.log.warn("a device policy change was not confirmed by the machine", {
        deviceId: intent.deviceId,
        opId: intent.opId,
        error: errMsg(e),
      });
      const raw = errMsg(e);
      const message = (
        raw.startsWith(ON_MACHINE_PREFIX) ? raw.slice(ON_MACHINE_PREFIX.length) : raw
      ).slice(0, MAX_MACHINE_MESSAGE);
      return {
        result: { outcome: "unknown" },
        outcome: {
          applied: false,
          reason: "offline",
          message: `${UNCONFIRMED_MESSAGE} ${message}`,
        },
      };
    }
  }

  /**
   * What the machine says became of the op `opId` (a read-only `policyStatus`), or `offline` when
   * no replica holds its connection or it does not answer. Never sends the change.
   */
  async outcomeOf(deviceId: string, opId: string): Promise<PolicyOpStatus> {
    if (!(await this.relay.holderLive(deviceId))) return { outcome: "offline" };
    try {
      return await this.relay.call(
        deviceId,
        "policyStatus",
        { opId },
        { deadlineMs: STATUS_DEADLINE_MS, signal: new AbortController().signal },
      );
    } catch (e) {
      this.log.warn("could not ask a machine what became of a policy op", {
        deviceId,
        opId,
        error: errMsg(e),
      });
      return { outcome: "offline" };
    }
  }

  /**
   * Records what became of the op `opId` of machine `machineId`, in the caller's transaction (the
   * machine's row locked): `applied` → the policy the machine wrote (when given) kept on the row,
   * the entry removed, `device.policy_changed` (`late` when the op was left `unknown`); `refused`,
   * `not_received` or `interrupted` → the entry removed, `device.policy_failed` (`reason` the
   * outcome); `unknown` → the entry kept, `unknown` until a day after its intent,
   * `device.policy_unknown` (once; ignored once a hello reported the op). Returns the outcome for
   * the caller, or null when the op has no live entry (resolved already, or expired: a no-op).
   */
  @Transactional({ propagation: "mandatory" })
  async settleIn(
    ref: { machineId: string; opId: string },
    result: PolicyOpResult,
  ): Promise<PolicyChangeOutcome | null> {
    const row = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id", "local_policy", "pending_policy_ops", "revoked_at"])
      .where("id", "=", ref.machineId)
      .forUpdate()
      .executeTakeFirst();
    const op = pendingPolicyOpsOf(row?.pending_policy_ops).find((o) => o.id === ref.opId);
    // an expired entry no longer explains the machine's own reports (they are audited as the
    // owner's): recording the op too would list the change twice
    if (row === undefined || op === undefined || op.until <= Date.now()) return null;
    const auditOp = (action: string, extra: Record<string, unknown>) =>
      audit(this.db.db, {
        actorAccountId: op.source.accountId,
        ...(op.actorTokenId !== undefined && { actorTokenId: op.actorTokenId }),
        orgId: row.org_id,
        action,
        target: row.device_id,
        detail: { ...changeDetail(op), ...extra },
      });

    if (result.outcome === "unknown") {
      // a hello reported the op meanwhile (its job records it), or it is unknown already
      if (op.reported !== undefined || op.status === "unknown")
        return { applied: false, reason: "offline", message: OFFLINE_MESSAGE };
      await this.db
        .updateTable("device_machines")
        .set({
          pending_policy_ops: withOp(op.id, {
            status: "unknown",
            until: op.sentAt + UNKNOWN_OP_MS,
          }),
        })
        .where("id", "=", ref.machineId)
        .execute();
      await auditOp("device.policy_unknown", {});
      return offline();
    }

    const live = row.revoked_at === null;
    let isolationNow: "sandbox" | "none" | undefined;
    const policy = result.outcome === "applied" ? result.policy : undefined;
    if (policy !== undefined && live) {
      // the isolation the machine reports now, when it differs from the stored one: a tier change
      // turns an unsandboxed device's sandbox back on without asking for it (spec §5.4, §10.4)
      const before = isolationOf(row.local_policy) ?? "sandbox";
      if (policy.isolation !== before) isolationNow = policy.isolation;
    }
    await this.db
      .updateTable("device_machines")
      .set({
        // resolved: the op no longer explains a summary the machine reports
        pending_policy_ops: withoutOp(op.id),
        ...(policy !== undefined && live && { local_policy: JSON.stringify(policy) }),
      })
      .where("id", "=", ref.machineId)
      .execute();
    if (result.outcome === "applied") {
      await auditOp("device.policy_changed", {
        ...(isolationNow !== undefined && { isolation: isolationNow }),
        ...(op.status === "unknown" && { late: true }),
      });
      const stored = policy ?? (await this.machines.activeFor(row.device_id))?.localPolicy;
      return stored
        ? { applied: true, policy: stored }
        : { applied: false, reason: "offline", message: OFFLINE_MESSAGE };
    }
    const message =
      result.outcome === "refused"
        ? result.message
        : result.outcome === "interrupted"
          ? INTERRUPTED_MESSAGE
          : NOT_RECEIVED_MESSAGE;
    await auditOp("device.policy_failed", { reason: result.outcome, message });
    return result.outcome === "refused"
      ? { applied: false, reason: "refused", message }
      : offline();
  }

  /** The active machine's features and policy summary (null when no machine is connected). */
  async summary(
    deviceId: string,
  ): Promise<{ features: DeviceFeature[]; policy: DeviceLocalPolicySummary | null } | null> {
    const m = await this.machines.activeFor(deviceId);
    return m === null ? null : { features: m.features, policy: m.localPolicy };
  }

  /**
   * How long after its intent an op can no longer reach the machine: the call's deadline, the
   * reconnect grace and the request list's margin (the relay's list TTL), plus 5 s. A machine
   * that does not know the op id by then never will.
   */
  resolveDelayMs(): number {
    const graceMs = this.config.get().devices.local.reconnectGraceSeconds * 1000;
    return POLICY_DEADLINE_MS + graceMs + LIST_TTL_MARGIN_MS + 5_000;
  }

  /** {@link settleIn} in its own transaction (the {@link apply} path). */
  @Transactional()
  private settle(
    intent: PolicyIntent,
    result: PolicyOpResult,
  ): Promise<PolicyChangeOutcome | null> {
    return this.settleIn(intent, result);
  }

  /**
   * The intent transaction: locks the machine's row (still the device's active machine), appends
   * the entry (dropping the expired ones), audits `device.policy_requested` and owes the
   * `device-op-resolve` job. False when the machine was revoked meanwhile (nothing written).
   */
  @Transactional()
  private async recordIntent(input: {
    orgId: string;
    deviceId: string;
    machineId: string;
    opId: string;
    change: PolicyChange;
    source: DevicePolicyArgs["source"];
    actorTokenId?: string;
  }): Promise<boolean> {
    const locked = await this.db
      .selectFrom("device_machines")
      .select("id")
      .where("id", "=", input.machineId)
      .where("revoked_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (locked === undefined) return false;
    const now = Date.now();
    const resolveAt = now + this.resolveDelayMs();
    const { change, source } = input;
    const op: PendingPolicyOp = {
      id: input.opId,
      add: change.add ?? [],
      remove: change.remove ?? [],
      ...(change.tier !== undefined && { tier: change.tier }),
      ...(change.isolation !== undefined && { isolation: change.isolation }),
      source: {
        accountId: source.accountId,
        via: source.via,
        approvalId: source.approvalId ?? null,
      },
      ...(input.actorTokenId !== undefined && { actorTokenId: input.actorTokenId }),
      status: "sent",
      sentAt: now,
      resolveAt,
      // a summary the machine reports by itself may be this op's until it is resolved
      until: now + UNKNOWN_OP_MS,
    };
    await this.db
      .updateTable("device_machines")
      .set({
        pending_policy_ops: sql<string>`(
          SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(pending_policy_ops) e
          WHERE (e->>'until')::bigint > ${now}
        ) || jsonb_build_array(${JSON.stringify(op)}::jsonb)`,
      })
      .where("id", "=", input.machineId)
      .execute();
    await audit(this.db.db, {
      actorAccountId: source.accountId,
      ...(input.actorTokenId !== undefined && { actorTokenId: input.actorTokenId }),
      orgId: input.orgId,
      action: "device.policy_requested",
      target: input.deviceId,
      detail: changeDetail(op),
    });
    await this.outbox.add({
      queue: MAINTENANCE_QUEUE_NAME,
      name: DEVICE_OP_RESOLVE_JOB,
      jobId: deviceOpResolveJobId(input.opId),
      data: { machineId: input.machineId, opId: input.opId },
      runAt: new Date(resolveAt),
      orgId: input.orgId,
    });
    return true;
  }
}

const offline = (): PolicyChangeOutcome => ({
  applied: false,
  reason: "offline",
  message: OFFLINE_MESSAGE,
});
const unsupported = (): PolicyChangeOutcome => ({
  applied: false,
  reason: "unsupported",
  message: UNSUPPORTED_MESSAGE,
});

/** The audit detail of an op's change and source (every `device.policy_*` row of an op). */
function changeDetail(op: PendingPolicyOp): Record<string, unknown> {
  return {
    opId: op.id,
    add: op.add,
    remove: op.remove,
    // only when set (null: follow the org's default); the device page lists the change
    ...(op.tier !== undefined && { tier: op.tier }),
    ...(op.isolation !== undefined && { isolation: op.isolation }),
    by: op.source.accountId,
    via: op.source.via,
    approvalId: op.source.approvalId,
  };
}

/** The machine's pending ops with the fields `patch` merged into the op `opId`. */
const withOp = (opId: string, patch: Record<string, unknown>) =>
  sql<string>`(
    SELECT coalesce(jsonb_agg(CASE WHEN e->>'id' = ${opId} THEN e || ${JSON.stringify(patch)}::jsonb ELSE e END), '[]'::jsonb)
    FROM jsonb_array_elements(pending_policy_ops) e
  )`;

/** The machine's pending ops without `opId` (an expired one left for the next intent to drop). */
const withoutOp = (opId: string) =>
  sql<string>`(
    SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(pending_policy_ops) e
    WHERE e->>'id' <> ${opId}
  )`;

/**
 * Hosts the platform may send: an approval's `add` takes exact hosts only (a card never grants a
 * wildcard); the owner's own change on the device page (no approval) may add a wildcard (spec §7);
 * `remove` takes any valid entry (narrowing, a wildcard too).
 */
function assertHosts(change: PolicyChange, fromApproval: boolean): void {
  const bad = (h: string) => typeof h !== "string" || validateAllowHost(h).length > 0;
  for (const h of change.add ?? []) {
    if (bad(h) || (fromApproval && h.startsWith("*."))) {
      throw new Error(`not an exact host to add to a device policy: ${JSON.stringify(h)}`);
    }
  }
  for (const h of change.remove ?? []) {
    if (bad(h)) throw new Error(`not a host to remove from a device policy: ${JSON.stringify(h)}`);
  }
}
