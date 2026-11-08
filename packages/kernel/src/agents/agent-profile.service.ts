import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { AttachmentsService } from "../conversations/attachments.service.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { AgentLookup } from "./agent-lookup.js";
import { AgentsService } from "./agents.service.js";
import type { AgentProfile, ProfilePatch } from "./profile.js";

/**
 * Writes an agent's profile (avatar, quick actions): display data stored beside the agent, never
 * model-visible, so a change creates no agent version. The description is part of the definition
 * (run context spec §3.5). The permission is the one of
 * `AgentsService.update` (owner or org admin, checked under the org row lock).
 */
@Injectable()
export class AgentProfileService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AgentLookup) private readonly lookup: AgentLookup,
    @Inject(AgentsService) private readonly agents: Pick<AgentsService, "lockForWrite">,
    @Inject(AttachmentsService)
    private readonly attachments: Pick<
      AttachmentsService,
      "prepareAgentAvatar" | "consumeAgentAvatar"
    >,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Applies `patch` (only the given fields) when `expectedUpdatedAt` is still the profile's
   * `updatedAt`, else 409 `agent.profile_conflict` (never a silent overwrite). Audit
   * `agent.profile_updated` `{ fields, channel, ...auditDetail }`: `api` for a personal access
   * token, `agent` for a write through the `Platform` tool (`auditDetail` given), else `web`.
   * An `upload` avatar must be the actor's own upload that no other agent uses (else 404
   * `attachment.not_found`): it is finalized first (outside the transaction, it reads the object
   * store; 503 `storage.unavailable` without one) and bound to the agent inside it.
   */
  async update(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    patch: ProfilePatch,
    expectedUpdatedAt: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<AgentProfile> {
    if (patch.avatar?.kind === "upload") {
      await this.attachments.prepareAgentAvatar(
        orgId,
        actorAccountId,
        patch.avatar.uploadId,
        agentId,
      );
    }
    return this.updateIn(
      orgId,
      agentId,
      actorAccountId,
      patch,
      expectedUpdatedAt,
      actorTokenId,
      auditDetail,
    );
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    patch: ProfilePatch,
    expectedUpdatedAt: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<AgentProfile> {
    const t = this.db.db;
    await this.agents.lockForWrite(orgId, agentId, actorAccountId);
    const current = await t
      .selectFrom("agents")
      .select(
        sql<string>`to_char(profile_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
          "at",
        ),
      )
      .where("id", "=", agentId)
      .executeTakeFirstOrThrow();
    if (current.at !== expectedUpdatedAt) {
      throw new ApiError(
        "agent.profile_conflict",
        "The profile was changed by someone else; reload it and apply your changes again",
      );
    }
    if (patch.avatar?.kind === "upload") {
      await this.attachments.consumeAgentAvatar(
        orgId,
        actorAccountId,
        patch.avatar.uploadId,
        agentId,
      );
    }
    const fields = (["avatar", "quickActions"] as const).filter((f) => patch[f] !== undefined);
    // nothing to write: no timestamp bump, no audit row
    if (fields.length === 0) return (await this.lookup.view(agentId)).profile;
    await t
      .updateTable("agents")
      .set({
        ...(patch.avatar !== undefined && {
          profile_avatar: patch.avatar === null ? sql<null>`null` : JSON.stringify(patch.avatar),
        }),
        ...(patch.quickActions !== undefined && {
          profile_quick_actions: JSON.stringify(patch.quickActions),
        }),
        profile_updated_at: sql`greatest(date_trunc('milliseconds', now()), profile_updated_at + interval '1 millisecond')`,
      })
      .where("id", "=", agentId)
      .execute();
    if (patch.avatar !== undefined) {
      // the avatar changed: every other upload bound to this agent is garbage; the cleanup job
      // deletes it (and its object) once expired. Re-saving the same upload keeps it.
      await t
        .updateTable("attachments")
        .set({ expires_at: sql<Date>`now()` })
        .where("agent_id", "=", agentId)
        .where("purpose", "=", "agent-avatar")
        .$if(patch.avatar?.kind === "upload", (q) =>
          q.where("id", "<>", (patch.avatar as { uploadId: string }).uploadId),
        )
        .execute();
    }
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.profile_updated",
      target: agentId,
      detail: {
        fields,
        channel: actorTokenId !== undefined ? "api" : auditDetail !== undefined ? "agent" : "web",
        ...auditDetail,
      },
    });
    return (await this.lookup.view(agentId)).profile;
  }
}
