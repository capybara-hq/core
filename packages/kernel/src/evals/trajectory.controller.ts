import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { TRAJECTORIES } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type {
  TrajectoryDetail,
  TrajectoryListItem,
  TrajectoryService,
} from "./trajectory.service.js";

const ListQuery = z.object({
  agentId: z.string().min(1).max(100).optional(),
  kind: z.enum(["chat", "eval"]).optional(),
  before: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * 轨迹查看器（`/api/v1/orgs/:orgId/trajectories`）：`trajectories.read`（member 起、只给人），
 * 服务里再判定「组织管理员或 agent 负责人」；无权一律 404 `trajectory.not_found`。
 */
@Controller("api/v1/orgs/:orgId/trajectories")
export class TrajectoryController {
  constructor(@Inject(TRAJECTORIES) private readonly trajectories: TrajectoryService) {}

  @Get()
  @OrgAction("trajectories.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ items: TrajectoryListItem[]; next: string | null }> {
    const user = requireUser(principal);
    return this.trajectories.list(org.orgId, user.account.id, {
      limit: q.limit,
      ...(q.agentId !== undefined && { agentId: q.agentId }),
      ...(q.kind !== undefined && { kind: q.kind }),
      ...(q.before !== undefined && { before: q.before }),
    });
  }

  @Get(":conversationId")
  @OrgAction("trajectories.read")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("conversationId") conversationId: string,
  ): Promise<TrajectoryDetail> {
    const user = requireUser(principal);
    return this.trajectories.get(org.orgId, user.account.id, conversationId, patTokenId(user));
  }
}
