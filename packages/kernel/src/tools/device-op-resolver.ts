import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import {
  DevicePolicyService,
  type PolicyOpResult,
  type PolicyOpStatus,
} from "../local-devices/device-policy.service.js";
import type { DeviceOpResolveData } from "../local-devices/policy-op-jobs.js";
import {
  opVisibleIn,
  type PendingPolicyOp,
  pendingPolicyOpsOf,
} from "../local-devices/policy-summary.js";

/**
 * The `device-op-resolve` job (transactional outbox spec §7): records what became of a device
 * policy op whose outcome its caller did not record (a crash between the call and the resolve
 * transaction, an answer that never came). Owed by the op's intent for when the op can no longer
 * reach the machine, and by a hello that reported the op (`device-op-reported-<opId>`).
 *
 * An op without an entry any more is resolved already: a no-op. Otherwise the outcome is the one
 * the hello reported, else the machine's answer to a read-only `policyStatus`: `applied` →
 * recorded applied; `refused`, never received (`unknown` to the machine, or `absent` from its
 * hello, once the op can no longer reach it) → failed; `started` (the machine stopped between
 * its log and its answer), once the op can no longer reach it → applied when the policy it
 * reports holds the change, else failed (`interrupted`); no answer (`offline`) → `unknown`, left
 * for the machine's next hello. It never sends the change
 * again (a widening after its ask closed is not allowed). In ToolsModule: resolving an op may
 * decide the network ask it answers (Task 19b).
 */
@Injectable()
export class DeviceOpResolver {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(DevicePolicyService)
    private readonly policies: Pick<DevicePolicyService, "outcomeOf" | "settleIn">,
  ) {}

  async resolve(data: DeviceOpResolveData): Promise<void> {
    const row = await this.db
      .selectFrom("device_machines")
      .select(["device_id", "pending_policy_ops"])
      .where("id", "=", data.machineId)
      .executeTakeFirst();
    const op = pendingPolicyOpsOf(row?.pending_policy_ops).find((o) => o.id === data.opId);
    if (row === undefined || op === undefined) return;
    const result =
      op.reported !== undefined
        ? await this.reportedResult(row.device_id, op, op.reported.outcome)
        : statusResult(op, await this.policies.outcomeOf(row.device_id, op.id));
    await this.settle(data, result);
  }

  /**
   * The outcome a hello reported; a refusal's message (a hello carries none) is the machine's
   * answer to `policyStatus` when it is connected.
   */
  private async reportedResult(
    deviceId: string,
    op: PendingPolicyOp,
    outcome: NonNullable<PendingPolicyOp["reported"]>["outcome"],
  ): Promise<PolicyOpResult> {
    if (outcome === "applied") return { outcome: "applied" };
    if (outcome === "absent") return { outcome: "not_received" };
    if (outcome === "interrupted") return { outcome: "interrupted" };
    const s = await this.policies.outcomeOf(deviceId, op.id);
    const message = s.outcome === "refused" ? s.message : undefined;
    return { outcome: "refused", message: (message ?? REFUSED_MESSAGE).slice(0, MAX_MESSAGE) };
  }

  /** The resolve transaction (the network ask's decision joins it in Task 19b). */
  @Transactional()
  private async settle(data: DeviceOpResolveData, result: PolicyOpResult): Promise<void> {
    await this.policies.settleIn(data, result);
  }
}

const REFUSED_MESSAGE = "The device's machine refused the policy change.";
/** The longest refusal message kept from the machine (as its own op log keeps it). */
const MAX_MESSAGE = 500;

function statusResult(op: PendingPolicyOp, s: PolicyOpStatus): PolicyOpResult {
  switch (s.outcome) {
    case "applied":
      return { outcome: "applied", ...(s.policy !== undefined && { policy: s.policy }) };
    case "refused":
      return { outcome: "refused", message: (s.message ?? REFUSED_MESSAGE).slice(0, MAX_MESSAGE) };
    case "started":
      // logged `started` only: once the op can no longer reach the machine, the policy it reports
      // tells whether the change was written before it stopped
      if (Date.now() < op.resolveAt || s.policy === undefined) return { outcome: "unknown" };
      return opVisibleIn(op, s.policy)
        ? { outcome: "applied", policy: s.policy }
        : { outcome: "interrupted" };
    case "unknown":
      // unknown to the machine: never received, once the op can no longer reach it (a job run
      // early, on a clock running ahead, cannot tell yet)
      return Date.now() >= op.resolveAt ? { outcome: "not_received" } : { outcome: "unknown" };
    default:
      // offline: its next hello tells
      return { outcome: "unknown" };
  }
}
