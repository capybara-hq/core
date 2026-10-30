import { Controller, Get, Inject, Param } from "@nestjs/common";
import { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  RUN_STATUSES,
  type RunWindow,
  type TrajectoryDetail,
  type TrajectoryListItem,
  TrajectoryService,
} from "./trajectory.service.js";

const ListQuery = z.object({
  agentId: z.string().min(1).max(100).optional(),
  kind: z.enum(["chat", "eval"]).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  before: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** 详情的运行窗口：`runId` 与 `before` / `limit` 互斥；都不给时读全对话（形状不变）。 */
const DetailQuery = z
  .object({
    runId: z.string().min(1).max(100).optional(),
    before: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .refine((q) => q.runId === undefined || (q.before === undefined && q.limit === undefined), {
    message: "runId cannot be combined with before or limit",
    path: ["runId"],
  });

/** 只给 `before` 时的页大小。 */
const DEFAULT_RUN_PAGE = 20;

class TrajectoryListQueryDto extends createZodDto(ListQuery, "TrajectoryListQuery") {}
class TrajectoryDetailQueryDto extends createZodDto(DetailQuery, "TrajectoryDetailQuery") {}

/**
 * 轨迹查看器（`/api/v1/orgs/:orgId/trajectories`）：`trajectories.read`（member 起、只给人），
 * 服务里再判定「组织管理员或 agent 负责人」；无权一律 404 `trajectory.not_found`。
 */
@Controller("api/v1/orgs/:orgId/trajectories")
export class TrajectoryController {
  constructor(@Inject(TrajectoryService) private readonly trajectories: TrajectoryService) {}

  @Get()
  @OrgAction("trajectories.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(TrajectoryListQueryDto) q: z.infer<typeof ListQuery>,
  ): Promise<{ items: TrajectoryListItem[]; next: string | null }> {
    const user = requireUser(principal);
    return this.trajectories.list(org.orgId, user.account.id, {
      limit: q.limit,
      ...(q.agentId !== undefined && { agentId: q.agentId }),
      ...(q.kind !== undefined && { kind: q.kind }),
      ...(q.status !== undefined && { status: q.status }),
      ...(q.before !== undefined && { before: q.before }),
    });
  }

  @Get(":conversationId")
  @OrgAction("trajectories.read")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("conversationId") conversationId: string,
    @ZQuery(TrajectoryDetailQueryDto) q: z.infer<typeof DetailQuery>,
  ): Promise<TrajectoryDetail> {
    const user = requireUser(principal);
    const window: RunWindow | undefined =
      q.runId !== undefined
        ? { runId: q.runId }
        : q.limit !== undefined || q.before !== undefined
          ? {
              limit: q.limit ?? DEFAULT_RUN_PAGE,
              ...(q.before !== undefined && { before: q.before }),
            }
          : undefined;
    return this.trajectories.get(
      org.orgId,
      user.account.id,
      conversationId,
      patTokenId(user),
      window,
    );
  }
}
