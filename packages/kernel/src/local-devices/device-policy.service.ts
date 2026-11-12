import { randomUUID } from "node:crypto";
import {
  type DeviceFeature,
  type DeviceLocalPolicySummary,
  type DevicePolicyArgs,
  ToolError,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { currentStore, TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { deviceNotFound } from "../sandbox/sandbox.service.js";
import { MachinesService } from "./machines.js";
import { isolationOf, type PendingPolicyOp } from "./policy-summary.js";
import { LocalDeviceRelay, ON_MACHINE_PREFIX } from "./relay.js";

/** How long the machine may take to apply a policy change. */
export const POLICY_DEADLINE_MS = 30_000;

/**
 * How long a sent op may still explain a summary the machine reports by itself: its deadline and
 * the reconnect grace, with room for an answer that comes only with the next hello.
 */
/** A policy change as callers ask for it: the op id and the source are added here. */
type PolicyChange = Omit<DevicePolicyArgs, "source" | "opId">;

const PENDING_OP_MS = POLICY_DEADLINE_MS + 5 * 60_000;

/** The prefix the relay puts before a machine's `policy`-kind refusal. */
const REFUSED_PREFIX = "Refused by the machine's local policy: ";

/** What became of a policy change. */
export type PolicyChangeOutcome =
  | { applied: true; policy: DeviceLocalPolicySummary }
  | { applied: false; reason: "offline" | "refused" | "unsupported"; message: string };

const OFFLINE_MESSAGE =
  "The device's machine is offline, so its policy was not changed. Start capybara-device on it.";
const UNSUPPORTED_MESSAGE =
  "The device's capybara-device program cannot change its policy from the platform. Update capybara-device on the machine.";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Changes a local device's policy on its machine (network ask-to-allow spec §5.2; sandbox dev
 * tiers spec §7.3: its hosts, its `tier`, and `isolation` back to `sandbox`): the kernel→device
 * `policy` op over the {@link LocalDeviceRelay}. The machine is the authority: it
 * refuses widening unless its owner allows remote grants, validates every host and answers with
 * the policy as written, which the kernel then keeps on the active machine's row (§5.4) and
 * audits as `device.policy_changed`.
 *
 * The op is sent outside any transaction (a decision records its outcome afterwards, in its own
 * transaction); only the summary write and the audit row are transactional. Callers decide who
 * may change a device's policy (the device owner, in a signed-in session); this service checks
 * only that the device is a live device of the org.
 */
@Injectable()
export class DevicePolicyService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LocalDeviceRelay) private readonly relay: Pick<LocalDeviceRelay, "call" | "holderLive">,
    @Inject(MachinesService) private readonly machines: Pick<MachinesService, "activeFor">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Sends the `policy` op (no transaction may be open), stores the returned summary and audits
   * `device.policy_changed`. Never throws for an offline machine, a refusal or a program without
   * the `policyOp` feature (nothing is sent to it); a device that is not a live device of `orgId`
   * is `device.not_found`.
   */
  async apply(input: {
    orgId: string;
    deviceId: string;
    change: PolicyChange;
    source: DevicePolicyArgs["source"];
    actorTokenId?: string;
  }): Promise<PolicyChangeOutcome> {
    if (currentStore()) {
      throw new Error(
        "DevicePolicyService.apply() must not run inside a transaction: send the policy op " +
          "first, then record the decision in a transaction.",
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
    if (device.source !== "local") {
      return { applied: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };
    }
    const machine = await this.machines.activeFor(input.deviceId);
    if (machine === null) return { applied: false, reason: "offline", message: OFFLINE_MESSAGE };
    if (!machine.features.includes("policyOp")) {
      return { applied: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };
    }
    // not connected: nothing is sent (a queued op would wait for a reconnect nobody watches)
    if (!(await this.relay.holderLive(input.deviceId))) {
      return { applied: false, reason: "offline", message: OFFLINE_MESSAGE };
    }
    // noted before it is sent: the machine may report the change by itself (a `policy` frame)
    // before its answer is recorded, and the device page lists it once, as the platform's
    const opId = randomUUID();
    const args: DevicePolicyArgs = { ...input.change, opId, source: input.source };
    await this.notePending(machine.id, {
      id: opId,
      add: input.change.add ?? [],
      remove: input.change.remove ?? [],
      ...(input.change.tier !== undefined && { tier: input.change.tier }),
      ...(input.change.isolation !== undefined && { isolation: input.change.isolation }),
      until: Date.now() + PENDING_OP_MS,
    });
    let policy: DeviceLocalPolicySummary;
    try {
      ({ policy } = await this.relay.call(input.deviceId, "policy", args, {
        deadlineMs: POLICY_DEADLINE_MS,
        // the relay gives up by itself (deadline plus the reconnect grace)
        signal: new AbortController().signal,
      }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "device.offline") {
        // the op was sent and the wait ran out: the machine may still apply it, so the attempt is
        // audited unconfirmed; its next hello reports the policy as it is
        await this.record({ ...input, machineId: machine.id, opId, policy: null });
      } else {
        // refused or failed: nothing changed, so it explains no later change
        await this.dropPending(machine.id, opId);
      }
      return this.notApplied(input.deviceId, e);
    }
    await this.record({ ...input, machineId: machine.id, opId, policy });
    return { applied: true, policy };
  }

  /** The active machine's features and policy summary (null when no machine is connected). */
  async summary(
    deviceId: string,
  ): Promise<{ features: DeviceFeature[]; policy: DeviceLocalPolicySummary | null } | null> {
    const m = await this.machines.activeFor(deviceId);
    return m === null ? null : { features: m.features, policy: m.localPolicy };
  }

  /** Adds `op` to the machine's pending ops, dropping the expired ones. */
  @Transactional()
  private async notePending(machineId: string, op: PendingPolicyOp): Promise<void> {
    await this.db
      .updateTable("device_machines")
      .set({
        pending_policy_ops: sql<string>`(
          SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(pending_policy_ops) e
          WHERE (e->>'until')::bigint > ${Date.now()}
        ) || jsonb_build_array(${JSON.stringify(op)}::jsonb)`,
      })
      .where("id", "=", machineId)
      .execute();
  }

  /** Removes the pending op `opId` from the machine's row. */
  @Transactional()
  private async dropPending(machineId: string, opId: string): Promise<void> {
    await this.db
      .updateTable("device_machines")
      .set({ pending_policy_ops: withoutOp(opId) })
      .where("id", "=", machineId)
      .execute();
  }

  /**
   * Keeps the policy the machine wrote on its row and audits the change (`confirmed`); with no
   * policy (the answer never came) only audits the attempt, unconfirmed. The detail's `isolation`
   * is the one asked for, or the one the machine now reports when it changed (a tier change turns
   * the sandbox back on).
   */
  @Transactional()
  private async record(input: {
    orgId: string;
    deviceId: string;
    machineId: string;
    opId: string;
    change: PolicyChange;
    source: DevicePolicyArgs["source"];
    actorTokenId?: string;
    policy: DeviceLocalPolicySummary | null;
  }): Promise<void> {
    // the isolation the machine reports now, when it differs from the stored one: a tier change
    // turns an unsandboxed device's sandbox back on without asking for it (spec §5.4, §10.4)
    let isolationNow: "sandbox" | "none" | undefined;
    if (input.policy !== null) {
      const prev = await this.db
        .selectFrom("device_machines")
        .select("local_policy")
        .where("id", "=", input.machineId)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      const before = isolationOf(prev?.local_policy) ?? "sandbox";
      if (input.policy.isolation !== before) isolationNow = input.policy.isolation;
      await this.db
        .updateTable("device_machines")
        // answered: the op no longer explains a summary the machine reports
        .set({
          local_policy: JSON.stringify(input.policy),
          pending_policy_ops: withoutOp(input.opId),
        })
        .where("id", "=", input.machineId)
        .where("revoked_at", "is", null)
        .execute();
    }
    const { change, source } = input;
    await audit(this.db.db, {
      actorAccountId: source.accountId,
      ...(input.actorTokenId !== undefined && { actorTokenId: input.actorTokenId }),
      orgId: input.orgId,
      action: "device.policy_changed",
      target: input.deviceId,
      detail: {
        add: change.add ?? [],
        remove: change.remove ?? [],
        // only when set (null: follow the org's default); the device page lists the change
        ...(change.tier !== undefined && { tier: change.tier }),
        ...((isolationNow ?? change.isolation) !== undefined && {
          isolation: isolationNow ?? change.isolation,
        }),
        by: source.accountId,
        via: source.via,
        approvalId: source.approvalId ?? null,
        confirmed: input.policy !== null,
      },
    });
  }

  /** The outcome of a failed op: offline, or the machine's refusal; a deleted device is thrown. */
  private notApplied(deviceId: string, e: unknown): PolicyChangeOutcome {
    if (e instanceof ApiError) {
      if (e.code === "device.not_found") throw e;
      // device.offline, or device.forbidden (the machine was disconnected meanwhile)
      return { applied: false, reason: "offline", message: OFFLINE_MESSAGE };
    }
    if (e instanceof ToolError && e.message.startsWith(REFUSED_PREFIX)) {
      return { applied: false, reason: "refused", message: e.message.slice(REFUSED_PREFIX.length) };
    }
    // anything else the machine answered (its own error, an invalid result): not applied
    this.log.warn("a device policy change failed on the machine", { deviceId, error: errMsg(e) });
    const message = errMsg(e);
    return {
      applied: false,
      reason: "refused",
      message: message.startsWith(ON_MACHINE_PREFIX)
        ? message.slice(ON_MACHINE_PREFIX.length)
        : message,
    };
  }
}

/** The machine's pending ops without `opId` (an expired one left for the next note to drop). */
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
