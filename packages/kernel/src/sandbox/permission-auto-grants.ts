import { Inject, Injectable, Optional } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFencePrelude,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { PermissionCallGrants } from "./permission-call-grants.js";
import type { PermissionCallBinding, PermissionCandidate } from "./permission-call-types.js";
import { permissionScopeHash } from "./permission-facts.js";
import { crossingOfCandidate } from "./review/permission-candidate.js";

/** Test seams of {@link PermissionAutoGrants} (optional provider {@link PERMISSION_AUTO_GRANT_HOOKS}). */
export interface PermissionAutoGrantHooks {
  /**
   * Called inside the issuing transaction once the precheck found no grant for the binding,
   * before anything is written: a barrier here makes two replicas pass the precheck together.
   */
  afterPrecheck?(binding: PermissionCallBinding): Promise<void>;
}
/** Optional provider: the {@link PermissionAutoGrantHooks} (tests). */
export const PERMISSION_AUTO_GRANT_HOOKS = Symbol("PERMISSION_AUTO_GRANT_HOOKS");

/** The reason a Full access auto-grant's `permission_reviewed` event records. */
const AUTO_GRANT_REASON = "Full access grants this crossing within the device's limits.";

/**
 * Full access auto-grants (approval-only profiles design, "Kernel: decision, admission and
 * records"): one crossing granted for one call within the device's ceilings, recorded exactly once
 * in one fenced transaction under the shared authority lock: the `permission_reviewed` event
 * (decision source `full-access`, its crossing and any sensitive consents it skipped), the audit
 * row `permission.crossing_auto_granted` and the grant itself (source `full-access`). The event is
 * announced after the commit. A replica that lost the race for the same binding rolls back on the
 * grant's immutable evidence (its event and audit row with it) and finds the winner's grant.
 */
@Injectable()
export class PermissionAutoGrants {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(PermissionCallGrants) private readonly grants: PermissionCallGrants,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Optional()
    @Inject(PERMISSION_AUTO_GRANT_HOOKS)
    private readonly hooks?: PermissionAutoGrantHooks,
  ) {}

  /**
   * Records the auto-grant of `candidate`. `sensitive` are the sensitive-command consents (rule
   * ids) Full access skipped for this call. Resolves once this call's grant exists, from this
   * replica or another; anything else (a changed permission state, other evidence) throws.
   */
  async record(candidate: PermissionCandidate, sensitive: readonly string[] = []): Promise<void> {
    const b = candidate.binding;
    const lock = () =>
      this.locks.acquire(
        { orgId: b.orgId, deviceId: b.deviceId, rootConversationId: b.rootConversationId },
        { kind: "admit" },
      );
    try {
      await withTransactionFencePrelude(lock, () => this.recordIn(candidate, sensitive));
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
      const grant = await withTransactionFencePrelude(lock, () => this.findIn(b));
      if (
        grant?.source !== "full-access" ||
        grant.scopeKind !== candidate.scopeKind ||
        permissionScopeHash(grant.expansion) !== permissionScopeHash(candidate.permissionScope)
      )
        throw error;
    }
  }

  @Transactional()
  private findIn(binding: PermissionCallBinding) {
    return this.grants.findForAdmission(binding);
  }

  @Transactional()
  private async recordIn(
    candidate: PermissionCandidate,
    sensitive: readonly string[],
  ): Promise<void> {
    const b = candidate.binding;
    await this.grants.assertCurrent(b);
    // an exact retry (or the other replica's committed grant) is already the record
    if (await this.grants.findForAdmission(b)) return;
    await this.hooks?.afterPrecheck?.(b);
    const crossing = crossingOfCandidate(candidate);
    const skipped = [...new Set(sensitive)].sort();
    const [event] = await this.eventLog.appendIn(b.conversationId, [
      {
        type: "permission_reviewed",
        runId: b.runId,
        payload: {
          ...candidate,
          outcome: "allow",
          reason: AUTO_GRANT_REASON,
          decisionSource: "full-access",
          crossing,
          ...(skipped.length > 0 ? { sensitive: skipped } : {}),
        },
      },
    ]);
    if (!event) throw new Error("The review event was not recorded");
    await audit(this.db.db, {
      actorAccountId: b.accountId,
      orgId: b.orgId,
      action: "permission.crossing_auto_granted",
      target: b.deviceId,
      detail: {
        kind: crossing,
        deviceId: b.deviceId,
        conversationId: b.conversationId,
        rootConversationId: b.rootConversationId,
        runId: b.runId,
        callId: b.callId,
        toolKey: b.toolKey,
        candidateHash: candidate.candidateHash,
        reviewEventSeq: event.seq,
        ...(crossing === "outside-sandbox"
          ? { justification: candidate.escalation?.justification }
          : { permissionScope: candidate.permissionScope }),
        ...(candidate.targetPath ? { targetPath: candidate.targetPath } : {}),
        ...(skipped.length > 0 ? { sensitive: skipped } : {}),
      },
    });
    await this.grants.issueLocked(candidate, {
      source: "full-access",
      reviewEventSeq: event.seq,
      decidedBy: null,
    });
    afterCommit(() => this.eventLog.notify(b.conversationId, event.seq));
  }
}
