import { randomUUID } from "node:crypto";
import {
  type DeviceExecGrants,
  SandboxOperationOutcomeUnknownError,
  type SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import { PermissionProfileStore } from "../conversations/permission-profile-store.js";
import type { PermissionCallGrantsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { coversHost } from "./modes.js";
import { isExecutionMethod, parseStartingExecutionGrants } from "./operation-authority-types.js";
import { describeOperationPayload } from "./operation-payloads.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import type {
  PermissionCallBinding,
  PermissionCandidate,
  PermissionGrantDecision,
} from "./permission-call-types.js";
import { PermissionFacts, permissionScopeHash } from "./permission-facts.js";
import {
  normalizePermissionExpansion,
  permissionCandidateHash,
} from "./review/permission-candidate.js";

type GrantRow = Selectable<PermissionCallGrantsTable>;
export function bindingOfGrant(r: GrantRow): PermissionCallBinding {
  return {
    orgId: r.org_id,
    rootConversationId: r.root_conversation_id,
    conversationId: r.conversation_id,
    deviceId: r.device_id,
    accountId: r.account_id,
    runId: r.run_id,
    callId: r.call_id,
    toolKey: r.tool_key,
    specHash: r.spec_hash,
    callInputHash: r.call_input_hash,
    resolvedInputHash: r.resolved_input_hash,
    profile: r.profile,
    profileRevision: r.profile_revision,
    scopeRevision: r.scope_revision,
    authorityRevision: r.authority_revision,
  };
}
@Injectable()
export class PermissionCallGrants {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(PermissionAuthorityEpochStore) private readonly epochs: PermissionAuthorityEpochStore,
    @Inject(PermissionProfileStore) private readonly profiles: PermissionProfileStore,
    @Inject(PermissionFacts) private readonly facts: PermissionFacts,
  ) {}
  /** The caller takes authority before conversation/approval/run locks. No I/O occurs here. */
  @Transactional({ propagation: "mandatory" })
  async assertCurrent(binding: PermissionCallBinding): Promise<void> {
    this.locks.assertHeld("root", binding.rootConversationId);
    const root = await this.profiles.readOwnedRoot(
      binding.orgId,
      binding.conversationId,
      binding.accountId,
    );
    const view = await this.facts.view(binding.orgId, binding.accountId, root);
    const run = await this.db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", binding.runId)
      .executeTakeFirst();
    const device = await this.db
      .selectFrom("devices")
      .select("owner_account_id")
      .where("id", "=", binding.deviceId)
      .where("org_id", "=", binding.orgId)
      .executeTakeFirst();
    const vector = await this.epochs.readLocked({
      orgId: binding.orgId,
      deviceId: binding.deviceId,
      rootConversationId: binding.rootConversationId,
    });
    if (
      root.id !== binding.rootConversationId ||
      root.device_id !== binding.deviceId ||
      root.scheduled_task_id ||
      !run ||
      run.conversation_id !== binding.conversationId ||
      run.trigger_account_id !== binding.accountId ||
      run.scheduled_task_run_id ||
      !["running", "waiting", "queued"].includes(run.status) ||
      device?.owner_account_id !== binding.accountId ||
      view.availability.state !== "supported" ||
      view.profile !== binding.profile ||
      view.revision !== binding.profileRevision ||
      view.scopeRevision !== binding.scopeRevision ||
      permissionScopeHash({ scopeRevision: view.scopeRevision, vector }) !==
        binding.authorityRevision
    )
      throw new ApiError(
        "conflict",
        "Permissions changed or the call is unattended; review the current call again",
      );
    const messages = await this.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", binding.conversationId)
      .where("run_id", "=", binding.runId)
      .where("type", "=", "assistant_message")
      .execute();
    const calls = messages.flatMap((row) =>
      Array.isArray((row.payload as { content?: unknown }).content)
        ? (row.payload as { content: unknown[] }).content
        : [],
    ) as { type?: string; id?: string; name?: string; input?: unknown }[];
    if (
      !calls.some(
        (call) =>
          call.type === "tool_call" &&
          call.id === binding.callId &&
          call.name === binding.toolKey &&
          permissionScopeHash(call.input) === binding.callInputHash,
      )
    )
      throw new ApiError("forbidden", "Permission proposal does not match the recorded tool input");
  }
  @Transactional({ propagation: "mandatory" })
  async issueLocked(
    candidate: PermissionCandidate,
    decision: PermissionGrantDecision,
  ): Promise<{ id: string }> {
    const b = candidate.binding;
    await this.assertCurrent(b);
    const { candidateHash, ...presentation } = candidate;
    const escalation = candidate.scopeKind === "sandbox-escalation";
    if (
      !["directories-and-hosts", "sandbox-escalation"].includes(candidate.scopeKind) ||
      permissionCandidateHash(presentation) !== candidateHash ||
      // an escalation names its justification and no expansion; an expansion names no escalation
      (escalation
        ? typeof candidate.escalation?.justification !== "string" ||
          candidate.escalation.justification.trim() === "" ||
          candidate.permissionScope.readDirectories.length > 0 ||
          candidate.permissionScope.writeDirectories.length > 0 ||
          candidate.permissionScope.hosts.length > 0 ||
          candidate.targetPath !== undefined
        : candidate.escalation !== undefined)
    )
      throw new ApiError(
        "forbidden",
        "Permission proposal evidence does not match its exact directory scope",
      );
    if (
      b.profile === "full-access" ||
      (decision.source === "review-model" && b.profile !== "approve-for-me")
    )
      throw new ApiError("forbidden", "This profile cannot issue an automated expansion grant");
    const root = await this.profiles.readOwnedRoot(b.orgId, b.conversationId, b.accountId);
    const view = await this.facts.view(b.orgId, b.accountId, root);
    if (escalation) {
      // the same ceiling as Full access: owner, org and platform, and a runtime that runs Full
      if (
        b.toolKey !== "Bash" ||
        !view.fullAccessCeiling ||
        view.availability.state !== "supported" ||
        !view.availability.report.fullAccess
      )
        throw new ApiError(
          "forbidden",
          "Running this call outside the sandbox is outside the current Full access ceiling",
        );
      await this.verifyEvidence(candidate, decision);
      return this.insertGrant(candidate, decision);
    }
    const working = await this.facts.readWorkingFacts({
      orgId: b.orgId,
      rootConversationId: b.rootConversationId,
      holderConversationId: b.conversationId,
      deviceId: b.deviceId,
    });
    const { policy, owner } = await this.facts.readDevice(b.orgId, b.deviceId);
    const device = await this.db
      .selectFrom("devices")
      .select("source")
      .where("id", "=", b.deviceId)
      .executeTakeFirstOrThrow();
    const network =
      device.source === "local"
        ? { kind: "allowlist", hosts: policy.localAllowedDomains }
        : policy.network;
    if (
      (!view.broadProjectReach &&
        (candidate.permissionScope.readDirectories.length ||
          candidate.permissionScope.writeDirectories.length)) ||
      candidate.permissionScope.hosts.some(
        (host) =>
          network.kind !== "open-public" &&
          !network.hosts.some((pattern) => coversHost(pattern, host)),
      )
    )
      throw new ApiError(
        "forbidden",
        "Permission proposal exceeds the current owner or organization ceiling",
      );
    const baseRoot = root.project_path ?? working.workspace;
    const normalized = normalizePermissionExpansion(candidate.permissionScope, {
      baseReadDirectories: [baseRoot],
      baseWriteDirectories: [baseRoot],
      baseHosts: (owner?.allowedDomains ?? policy.localAllowedDomains).filter(
        (host) =>
          network.kind === "open-public" ||
          network.hosts.some((pattern) => coversHost(pattern, host)),
      ),
    });
    if (permissionScopeHash(normalized) !== permissionScopeHash(candidate.permissionScope))
      throw new ApiError("forbidden", "Permission scope is not normalized");
    await this.verifyEvidence(candidate, decision);
    return this.insertGrant(candidate, decision);
  }
  /** One immutable row per binding; an exact retry returns it, anything else conflicts. */
  private async insertGrant(
    candidate: PermissionCandidate,
    decision: PermissionGrantDecision,
  ): Promise<{ id: string }> {
    const b = candidate.binding;
    const { candidateHash } = candidate;
    const bindingHash = permissionScopeHash(b),
      expansionHash = permissionScopeHash(candidate.permissionScope);
    await this.db
      .insertInto("permission_call_grants")
      .values({
        id: randomUUID(),
        org_id: b.orgId,
        root_conversation_id: b.rootConversationId,
        conversation_id: b.conversationId,
        device_id: b.deviceId,
        account_id: b.accountId,
        run_id: b.runId,
        call_id: b.callId,
        tool_key: b.toolKey,
        spec_hash: b.specHash,
        call_input_hash: b.callInputHash,
        resolved_input_hash: b.resolvedInputHash,
        profile: b.profile,
        profile_revision: b.profileRevision,
        scope_revision: b.scopeRevision,
        authority_revision: b.authorityRevision,
        binding_hash: bindingHash,
        expansion: JSON.stringify(candidate.permissionScope),
        expansion_hash: expansionHash,
        candidate_hash: candidateHash,
        target_path: candidate.targetPath ?? null,
        scope_kind: candidate.scopeKind,
        escalation: candidate.escalation ? JSON.stringify(candidate.escalation) : null,
        source: decision.source,
        approval_id: decision.source === "human" ? decision.approvalId : null,
        review_event_seq: decision.source === "review-model" ? decision.reviewEventSeq : null,
        decided_by: decision.decidedBy,
      })
      .onConflict((oc) => oc.column("binding_hash").doNothing())
      .execute();
    const row = await this.db
      .selectFrom("permission_call_grants")
      .selectAll()
      .where("binding_hash", "=", bindingHash)
      .executeTakeFirstOrThrow();
    if (
      permissionScopeHash(bindingOfGrant(row)) !== bindingHash ||
      row.expansion_hash !== expansionHash ||
      row.candidate_hash !== candidateHash ||
      row.target_path !== (candidate.targetPath ?? null) ||
      row.scope_kind !== candidate.scopeKind ||
      permissionScopeHash(row.escalation) !== permissionScopeHash(candidate.escalation ?? null) ||
      row.source !== decision.source ||
      row.approval_id !== (decision.source === "human" ? decision.approvalId : null) ||
      row.review_event_seq !==
        (decision.source === "review-model" ? decision.reviewEventSeq : null) ||
      row.decided_by !== decision.decidedBy
    )
      throw new ApiError(
        "conflict",
        "This call already has different immutable permission evidence",
      );
    return { id: row.id };
  }
  private async verifyEvidence(
    candidate: PermissionCandidate,
    decision: PermissionGrantDecision,
  ): Promise<void> {
    const b = candidate.binding;
    let evidence: unknown;
    if (decision.source === "human") {
      const approval = await this.db
        .selectFrom("approvals")
        .selectAll()
        .where("id", "=", decision.approvalId)
        .executeTakeFirst();
      if (
        approval?.status !== "approved" ||
        approval.kind !== "command" ||
        approval.org_id !== b.orgId ||
        approval.conversation_id !== b.conversationId ||
        approval.run_id !== b.runId ||
        approval.call_id !== b.callId ||
        approval.requested_for !== b.accountId ||
        approval.decided_by !== decision.decidedBy ||
        decision.decidedBy !== b.accountId ||
        approval.scope !== "once"
      )
        throw new ApiError(
          "forbidden",
          "Permission grant requires this owner's exact approved call",
        );
      evidence = (approval.detail as { permissionCandidate?: unknown } | null)?.permissionCandidate;
    } else {
      const event = await this.db
        .selectFrom("conversation_events")
        .selectAll()
        .where("conversation_id", "=", b.conversationId)
        .where("seq", "=", String(decision.reviewEventSeq))
        .where("run_id", "=", b.runId)
        .where("type", "=", "permission_reviewed")
        .executeTakeFirst();
      if (
        !event ||
        (event.payload as Record<string, unknown>).outcome !== "allow" ||
        (event.payload as Record<string, unknown>).decisionSource !== "review-model"
      )
        throw new ApiError("forbidden", "Permission grant requires its recorded allow verdict");
      const {
        outcome: _outcome,
        reason: _reason,
        decisionSource: _source,
        ...proposal
      } = event.payload as Record<string, unknown>;
      evidence = proposal;
    }
    if (permissionScopeHash(evidence) !== permissionScopeHash(candidate))
      throw new ApiError("forbidden", "The approved directory and host proposal does not match");
  }
  @Transactional({ propagation: "mandatory" })
  async findForAdmission(binding: PermissionCallBinding): Promise<{
    id: string;
    expansion: PermissionCandidate["permissionScope"];
    scopeKind: PermissionCandidate["scopeKind"];
    source: "human" | "review-model";
  } | null> {
    const hash = permissionScopeHash(binding);
    const row = await this.db
      .selectFrom("permission_call_grants")
      .selectAll()
      .where("binding_hash", "=", hash)
      .executeTakeFirst();
    if (!row || permissionScopeHash(bindingOfGrant(row)) !== hash) return null;
    await this.assertCurrent(binding);
    if (row.source === "human" && (!row.approval_id || !row.decided_by))
      throw new ApiError("forbidden", "The human permission evidence is incomplete");
    if (row.source === "review-model" && row.review_event_seq === null)
      throw new ApiError("forbidden", "The review permission evidence is incomplete");
    await this.verifyEvidence(
      {
        binding,
        permissionScope: row.expansion,
        ...(row.target_path ? { targetPath: row.target_path } : {}),
        scopeKind: row.scope_kind,
        ...(row.escalation ? { escalation: row.escalation } : {}),
        candidateHash: row.candidate_hash,
      },
      row.source === "human"
        ? { source: "human", approvalId: row.approval_id ?? "", decidedBy: row.decided_by ?? "" }
        : { source: "review-model", reviewEventSeq: row.review_event_seq ?? -1, decidedBy: null },
    );
    return { id: row.id, expansion: row.expansion, scopeKind: row.scope_kind, source: row.source };
  }
  /** Starting authority belongs to this admitted exec, never to another call or native method. */
  async forExecution(
    operationId: string,
    deviceId: string,
    method: "exec" | "backgroundStart",
    scope: SandboxOperationScope,
    input: unknown,
  ): Promise<DeviceExecGrants | undefined> {
    const intent = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirst();
    if (
      !intent ||
      intent.device_id !== deviceId ||
      !(
        ["admitted", "dispatching", "started-or-unknown"].includes(intent.state) ||
        // an acknowledged start keeps its starting authority while it runs: a retried start of
        // the same operation (the provider returns the same ref) reuses it, never a new envelope
        (intent.state === "background-running" && intent.method === "backgroundStart")
      )
    )
      throw new ApiError("forbidden", "The operation has no current admitted execution identity");
    if (
      !isExecutionMethod(intent.method) ||
      intent.method !== method ||
      permissionScopeHash(scope) !== permissionScopeHash(intent.scope)
    )
      throw new ApiError(
        "forbidden",
        "The execution does not match its exact admitted method and scope",
      );
    if (intent.execution_grants === null || intent.execution_grants === undefined) {
      const message =
        "Starting grant provenance is unavailable; check the original operation before retrying";
      if (intent.state === "admitted") throw new ApiError("forbidden", message);
      throw new SandboxOperationOutcomeUnknownError(message);
    }
    const metadata = parseStartingExecutionGrants(intent.execution_grants);
    const inputDigest = describeOperationPayload(input).digest;
    if (
      intent.input_hash !== permissionScopeHash({ method, inputDigest }) ||
      intent.admission_hash !==
        permissionScopeHash({ method, inputDigest, scope, executionGrants: metadata }) ||
      permissionScopeHash(metadata.grants?.hosts ?? []) !==
        permissionScopeHash(intent.granted_hosts)
    )
      throw new ApiError(
        "forbidden",
        "Starting grants or input do not match the exact admitted execution",
      );
    if (!intent.permission_grant_id) return metadata.grants ?? undefined;
    const grant = await this.db
      .selectFrom("permission_call_grants")
      .selectAll()
      .where("id", "=", intent.permission_grant_id)
      .executeTakeFirstOrThrow();
    const admittedScope = intent.scope;
    if (
      !("profileRevision" in admittedScope) ||
      grant.device_id !== deviceId ||
      grant.org_id !== intent.org_id ||
      grant.account_id !== intent.account_id ||
      grant.run_id !== intent.run_id ||
      grant.call_id !== intent.call_id ||
      grant.conversation_id !== intent.conversation_id ||
      grant.root_conversation_id !== intent.root_conversation_id ||
      grant.profile_revision !== admittedScope.profileRevision ||
      grant.authority_revision !== admittedScope.ceilingRevision ||
      grant.expansion.hosts.some((host) => !intent.granted_hosts.includes(host))
    )
      throw new ApiError(
        "forbidden",
        "The operation's explicit host evidence does not match its admitted call",
      );
    if (
      grant.expansion.hosts.length &&
      permissionScopeHash(metadata.grants?.source) !==
        permissionScopeHash({ kind: "run", id: grant.run_id, accountId: grant.account_id })
    )
      throw new ApiError(
        "forbidden",
        "Starting grant source does not match the admitted call evidence",
      );
    return metadata.grants ?? undefined;
  }
}
