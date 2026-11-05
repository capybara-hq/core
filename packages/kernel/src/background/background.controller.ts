import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type BackgroundTaskOutput,
  BackgroundTasks,
  type BackgroundTaskView,
  OUTPUT_TAIL_MAX_BYTES,
} from "./tasks.service.js";

const ConversationParams = z.object({ id: z.string().min(1).max(100) });
const TaskParams = z.object({ id: z.string().min(1).max(100), taskId: z.string().min(1).max(100) });
const OutputQuery = z.object({
  tail: z.coerce.number().int().min(1).max(OUTPUT_TAIL_MAX_BYTES).default(OUTPUT_TAIL_MAX_BYTES),
});

class BackgroundConversationParamsDto extends createZodDto(
  ConversationParams,
  "BackgroundConversationParams",
) {}
class BackgroundTaskParamsDto extends createZodDto(TaskParams, "BackgroundTaskParams") {}
class BackgroundOutputQueryDto extends createZodDto(OutputQuery, "BackgroundOutputQuery") {}

/**
 * Background Bash tasks of a conversation (spec 2026-11-05-background-bash-design §5). Visible to
 * whoever sees the conversation, stoppable by whoever may abort its run (the owner): the same
 * checks as `GET :id` and `POST :id/abort`.
 */
@Controller("api/v1/orgs")
export class BackgroundController {
  constructor(@Inject(BackgroundTasks) private readonly tasks: BackgroundTasks) {}

  /** The conversation's tasks and its sub-agents' (`subagentId`), newest first. */
  @Get(":orgId/conversations/:id/background-tasks")
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(BackgroundConversationParamsDto) params: z.infer<typeof ConversationParams>,
  ): Promise<{ tasks: BackgroundTaskView[] }> {
    const p = requireUser(principal);
    return { tasks: await this.tasks.list(org.orgId, params.id, p.account.id) };
  }

  /**
   * Stops a task like a person's stop: 200 `{ task }` with the row after the stop. A task that is
   * still `running` with `stopping: true` is being stopped by another request (or is still
   * launching); a stop that fails is an error and the task keeps running.
   */
  @Post(":orgId/conversations/:id/background-tasks/:taskId/stop")
  @HttpCode(200)
  @OrgAction("agents.use")
  async stop(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(BackgroundTaskParamsDto) params: z.infer<typeof TaskParams>,
  ): Promise<{ task: BackgroundTaskView }> {
    const p = requireUser(principal);
    return {
      task: await this.tasks.stop(org.orgId, params.id, p.account.id, params.taskId, patTokenId(p)),
    };
  }

  /** The end of the task's output (`tail` bytes, at most 65536); 409 when it cannot be read now. */
  @Get(":orgId/conversations/:id/background-tasks/:taskId/output")
  @OrgAction("agents.use")
  async output(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(BackgroundTaskParamsDto) params: z.infer<typeof TaskParams>,
    @ZQuery(BackgroundOutputQueryDto) q: z.infer<typeof OutputQuery>,
  ): Promise<BackgroundTaskOutput> {
    const p = requireUser(principal);
    return this.tasks.output(org.orgId, params.id, p.account.id, params.taskId, q.tail);
  }
}
