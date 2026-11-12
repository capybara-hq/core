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
import { type PendingPolicyOp, pendingPolicyOpsOf } from "../local-devices/policy-summary.js";

/**
 * The `device-op-resolve` job (transactional outbox spec §7): records what became of a device
 * policy op whose outcome its caller did not record (a crash between the call and the resolve
 * transaction, an answer that never came). Owed by the op's intent for when the op can no longer
 * reach the machine, and by a hello that reported the op (`device-op-reported-<opId>`).
 *
 * An op without an entry any more is resolved already: a no-op. Otherwise the outcome is the one
 * the hello reported, else the machine's answer to a read-only `policyStatus`: `applied` →
 * recorded applied; `refused`, never received (`unknown` to the machine, or `absent` from its
 * hello, once the op can no longer reach it) → failed; `started` (interrupted on the machine) or
 * no answer (`offline`) → `unknown`, left for the machine's next hello. It never sends the change
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
        ? reportedResult(op.reported.outcome)
        : statusResult(op, await this.policies.outcomeOf(row.device_id, op.id));
    await this.settle(data, result);
  }

  /** The resolve transaction (the network ask's decision joins it in Task 19b). */
  @Transactional()
  private async settle(data: DeviceOpResolveData, result: PolicyOpResult): Promise<void> {
    await this.policies.settleIn(data, result);
  }
}

function reportedResult(outcome: NonNullable<PendingPolicyOp["reported"]>["outcome"]) {
  if (outcome === "applied") return { outcome: "applied" } as const;
  if (outcome === "refused") return { outcome: "refused", message: REFUSED_MESSAGE } as const;
  return { outcome: "not_received" } as const;
}

const REFUSED_MESSAGE = "The device's machine refused the policy change.";

function statusResult(op: PendingPolicyOp, s: PolicyOpStatus): PolicyOpResult {
  switch (s.outcome) {
    case "applied":
      return { outcome: "applied", ...(s.policy !== undefined && { policy: s.policy }) };
    case "refused":
      return { outcome: "refused", message: s.message ?? REFUSED_MESSAGE };
    case "unknown":
      // unknown to the machine: never received, once the op can no longer reach it (a job run
      // early, on a clock running ahead, cannot tell yet)
      return Date.now() >= op.resolveAt ? { outcome: "not_received" } : { outcome: "unknown" };
    default:
      // started (interrupted on the machine) or offline: its next hello tells
      return { outcome: "unknown" };
  }
}
