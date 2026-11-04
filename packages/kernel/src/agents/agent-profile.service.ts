import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { AgentLookup } from "./agent-lookup.js";
import { AgentsService, assertProfileWritable } from "./agents.service.js";
import type { AgentProfile, ProfileInput } from "./profile.js";

/**
 * Writes an agent's profile (avatar, description, quick actions): display data stored beside the
 * agent, never model-visible, so a change creates no agent version. The permission is the one of
 * `AgentsService.update` (owner or org admin, checked under the org row lock).
 */
@Injectable()
export class AgentProfileService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AgentLookup) private readonly lookup: AgentLookup,
    @Inject(AgentsService) private readonly agents: Pick<AgentsService, "lockForWrite">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Applies `patch` (only the given fields) when `expectedUpdatedAt` is still the profile's
   * `updatedAt`, else 409 `agent.profile_conflict` (never a silent overwrite). Audit
   * `agent.profile_updated` `{ fields, channel }`: `api` for a personal access token, else `web`.
   */
  @Transactional()
  async update(
    orgId: string,
    agentId: string,
    actorAccountId: string,
    patch: ProfileInput,
    expectedUpdatedAt: string,
    actorTokenId?: string,
  ): Promise<AgentProfile> {
    assertProfileWritable(patch);
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
    const fields = (["avatar", "description", "quickActions"] as const).filter(
      (f) => patch[f] !== undefined,
    );
    await t
      .updateTable("agents")
      .set({
        ...(patch.avatar !== undefined && { profile_avatar: JSON.stringify(patch.avatar) }),
        ...(patch.description !== undefined && { profile_description: patch.description }),
        ...(patch.quickActions !== undefined && {
          profile_quick_actions: JSON.stringify(patch.quickActions),
        }),
        profile_updated_at: sql`greatest(date_trunc('milliseconds', now()), profile_updated_at + interval '1 millisecond')`,
      })
      .where("id", "=", agentId)
      .execute();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent.profile_updated",
      target: agentId,
      detail: { fields, channel: actorTokenId !== undefined ? "api" : "web" },
    });
    return (await this.lookup.view(agentId)).profile;
  }
}
