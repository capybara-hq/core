import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  BackgroundConversationParams,
  BackgroundTaskParams,
} from "../../background/background.schemas.js";
import { BackgroundTasks, type BackgroundTaskView } from "../../background/tasks.service.js";
import { ApiError } from "../../errors.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { named } from "./summary.js";

const PAGE = 50;
const ConversationId = BackgroundConversationParams.shape.id;
const TaskId = BackgroundTaskParams.shape.taskId;
/** The longest command a row or a card quotes. */
const COMMAND_MAX = 200;

const row = (t: BackgroundTaskView) => ({
  id: t.id,
  name: t.description,
  state: t.status,
  ...(t.lostReason !== null && { reason: t.lostReason }),
  command: t.command.length > COMMAND_MAX ? `${t.command.slice(0, COMMAND_MAX)}…` : t.command,
  subagentId: t.subagentId,
  stopping: t.stopping,
});

/**
 * Background task operations of the `Platform` tool (the conversation domain): list the
 * background commands of one of your conversations and stop one. The output is the web's
 * (`transport`): bytes of a command's output are read there.
 */
@Injectable()
export class BackgroundOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(BackgroundTasks) private readonly tasks: BackgroundTasks,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "conversations.background-tasks",
        description:
          "List the background commands of one of your conversations and of its sub-agents, newest first: description, state (running, finished, failed, stopped, lost), the command and whether a stop is under way. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ conversationId: ConversationId, cursor: Cursor.optional() }).strict(),
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id/background-tasks"],
        renames: { conversationId: "id" },
        extras: ["cursor"],
        confirm: "read",
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only conversations you can see are readable.",
          },
        ],
        run: async (input, ctx) =>
          pageOf(
            (await this.tasks.list(ctx.orgId, input.conversationId, ctx.actorAccountId)).map(row),
            startOf(input.cursor),
            PAGE,
          ),
      }),
      defineOperation({
        id: "conversations.stop-background-task",
        description:
          "Stop one background command of one of your conversations, as the stop button does: the command is killed. Takes the task id from conversations.background-tasks. A task already stopping or finished is returned as it is.",
        input: z.object({ conversationId: ConversationId, taskId: TaskId }).strict(),
        example: {
          conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10",
          taskId: "bg-1a2b3c4d",
        },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/conversations/:id/background-tasks/:taskId/stop"],
        renames: { conversationId: "id" },
        confirm: "personal",
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only conversations you can see are readable.",
          },
          {
            code: "background_task.not_found",
            next: "Check the task id with conversations.background-tasks; the task may be gone.",
          },
        ],
        precheck: async (i, ctx) => {
          try {
            const tasks = await this.tasks.list(ctx.orgId, i.conversationId, ctx.actorAccountId);
            return tasks.some((t) => t.id === i.taskId)
              ? { ok: true }
              : {
                  ok: false,
                  code: "background_task.not_found",
                  message: "Background task not found",
                };
          } catch (e) {
            if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
            throw e;
          }
        },
        summary: async (i, ctx) => {
          let label = i.taskId;
          try {
            const t = (await this.tasks.list(ctx.orgId, i.conversationId, ctx.actorAccountId)).find(
              (x) => x.id === i.taskId,
            );
            if (t !== undefined) label = `${t.description} (${named(t.command)})`;
          } catch {
            // the card names the id when the task cannot be read
          }
          return {
            zh: `停止后台任务「${named(label)}」`,
            en: `Stop background task "${named(label)}"`,
          };
        },
        run: async (input, ctx) => ({
          task: row(
            await this.tasks.stop(
              ctx.orgId,
              input.conversationId,
              ctx.actorAccountId,
              input.taskId,
              undefined,
              viaAgent("conversations.stop-background-task", ctx),
            ),
          ),
        }),
      }),
    ]);
  }
}
