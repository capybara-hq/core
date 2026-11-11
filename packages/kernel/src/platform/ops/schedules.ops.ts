import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  type ScheduleActor,
  type ScheduledTaskListItem,
  ScheduledTasksService,
} from "../../schedules/scheduled-tasks.service.js";
import {
  createInputOf,
  grantsOf,
  ScheduleChatTargetsQuery,
  ScheduleCreateBody,
  ScheduleGrantableQuery,
  ScheduleGrantParams,
  ScheduleGrantsBody,
  ScheduleListQuery,
  ScheduleParams,
  ScheduleRunBody,
  ScheduleRunsQuery,
  ScheduleUpdateBody,
  updateInputOf,
} from "../../schedules/schedules.schemas.js";
import type { ScheduledTask, TaskRun } from "../../schedules/types.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { named, orElse } from "./summary.js";

const ListQuery = ScheduleListQuery;
const CreateBody = ScheduleCreateBody;
const UpdateBody = ScheduleUpdateBody;
const RunBody = ScheduleRunBody;
const RunsQuery = ScheduleRunsQuery;
const GrantsBody = ScheduleGrantsBody;
const Id = ScheduleParams.shape.id;
const ToolKey = ScheduleGrantParams.shape.toolKey;

const TaskId = z.object({ scheduleId: Id }).strict();
const EXAMPLE_ID = "7b2d4f60-3a1e-4c85-9e07-5d8f1a2b3c4d";

/** A task as `schedules.list` shows it: the schedule, the state and the next run. */
function row(t: ScheduledTask & { lastRun?: ScheduledTaskListItem["lastRun"] }) {
  return {
    ...(t.lastRun !== undefined && { lastRun: t.lastRun }),
    id: t.id,
    name: t.name,
    agentId: t.agentId,
    status: t.status,
    pauseReason: t.pauseReason,
    trigger: t.trigger,
    mode: t.mode,
    nextRunAt: t.nextRunAt,
    creator: t.accountId,
  };
}

const runRow = (r: TaskRun) => ({
  id: r.id,
  scheduledFor: r.scheduledFor,
  firedAt: r.firedAt,
  trial: r.trial,
  status: r.status,
  skipReason: r.skipReason,
  error: r.error,
  conversationId: r.conversationId,
  missingGrants: r.missingGrants,
});

/**
 * Scheduled-task operations of the `Platform` tool (scheduled tasks spec §10): the same service
 * as the HTTP routes. Writes are `personal`. Creating or changing a task and its approved tools
 * are never remembered (`rememberable: false`): an approval, remembered or granted to a task,
 * must never let an unattended run create or widen a task. Delete, run and resume are never
 * remembered either. List, pause and delete are `org.read` like their routes: a creator demoted
 * to guest can still see and stop their own tasks (the service decides by ownership).
 */
@Injectable()
export class SchedulesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ScheduledTasksService) private readonly tasks: ScheduledTasksService,
  ) {}

  /** The caller as the service expects (it reads the live role itself). */
  private actor(ctx: OperationContext): ScheduleActor {
    return { accountId: ctx.actorAccountId };
  }

  /** The task's name for a card; its id when it cannot be read. */
  private label(ctx: OperationContext, id: string): Promise<string> {
    return orElse(
      async () => named((await this.tasks.get(ctx.orgId, this.actor(ctx), id)).name),
      id,
    );
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "schedules.list",
        description:
          "List your scheduled tasks: one compact row each (name, agent, status and why it is paused, schedule with its time zone, where runs post, next run, last settled run). all=true lists every task of the org and needs the org admin role; conversationId keeps the tasks that post into that conversation.",
        input: ListQuery,
        example: {},
        // a creator demoted to guest still lists their own tasks (to pause or delete them)
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/schedules"],
        confirm: "read",
        errors: [
          {
            code: "forbidden",
            next: "Listing every task needs the org admin role: call without all, or ask an org admin.",
          },
        ],
        run: async (input, ctx) => {
          const items = await this.tasks.list(ctx.orgId, this.actor(ctx), {
            all: input.all === "true",
            ...(input.conversationId !== undefined && { conversationId: input.conversationId }),
          });
          return { items: items.map(row) };
        },
      }),
      defineOperation({
        id: "schedules.chat-targets",
        description:
          "The IM chats you can point a chat-mode scheduled task at: your direct chats with each active channel connection's bot (one you have messaged before), and the groups you have talked in when the channel has threads. Each gives { connectionId, chatId, chatType } for schedules.create, and the connection's agentId, which the task must use.",
        input: ScheduleChatTargetsQuery,
        example: {},
        authz: { orgAction: "schedules.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/schedules/chat-targets"],
        confirm: "read",
        errors: [],
        run: async (_input, ctx) => ({
          items: await this.tasks.chatTargets(ctx.orgId, ctx.actorAccountId),
        }),
      }),
      defineOperation({
        id: "schedules.grantable-tools",
        description:
          "An agent's tools as a scheduled task can approve them in advance: each { key, title, source, connectorId, grantable, reason }; reason says why not (forbidden by the org, not_grantable by design, needs_role, fixed_ask, not_available). Takes the agent id from the agents list.",
        input: ScheduleGrantableQuery,
        example: { agentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "schedules.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/schedules/grantable-tools"],
        confirm: "read",
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id: it must be an agent you can use in this org.",
          },
        ],
        run: async (input, ctx) => ({
          items: await this.tasks.grantableTools(ctx.orgId, ctx.actorAccountId, input.agentId),
        }),
      }),
      defineOperation({
        id: "schedules.get",
        description:
          "Read one scheduled task in full: prompt, schedule, target, model, effort, device, status, next run, expiry. Takes the id from schedules.list.",
        input: TaskId,
        example: { scheduleId: EXAMPLE_ID },
        authz: { orgAction: "schedules.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/schedules/:id"],
        renames: { scheduleId: "id" },
        confirm: "read",
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        run: async (input, ctx) => ({
          task: await this.tasks.get(ctx.orgId, this.actor(ctx), input.scheduleId),
        }),
      }),
      defineOperation({
        id: "schedules.create",
        description:
          "Create a scheduled task: an agent runs the prompt on a 5-field cron (or once at a local date-time) as you, unattended. The task's time zone is yours; timeZone is only the fallback when you have none set. mode: new (a conversation per run), conversation (post into one conversation) or chat (an IM chat). model ({ provider, model } like an agent definition's), effort and deviceId are for mode new only; a conversation or chat task runs with that conversation's model. Without expiresAt a cron task ends after the org's default expiry, when the org sets one. grants pre-approve tools the unattended run may use. The person confirms every creation; it is never remembered.",
        input: CreateBody,
        example: {
          agentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20",
          name: "Daily digest",
          prompt: "Summarize yesterday's activity.",
          trigger: { kind: "cron", expr: "0 9 * * *" },
          mode: "new",
        },
        authz: { orgAction: "schedules.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/schedules"],
        confirm: "personal",
        // an unattended run must never create or widen a task through a remembered approval
        rememberable: false,
        errors: [
          {
            code: "schedule.disabled",
            next: {
              orgAdmin: "Turn scheduled tasks on in the org settings.",
              member: "Scheduled tasks are off here; ask an org admin.",
            },
          },
          {
            code: "schedule.limit_reached",
            next: "Delete a task you no longer need with schedules.delete, or pause and edit an existing one.",
          },
          {
            code: "schedule.target_invalid",
            next: "Fix the target named in the message (conversation, chat or device) and call again.",
          },
          {
            code: "schedule.grant_not_allowed",
            next: "Drop that grant: the task will ask for it as a person when it runs attended, or ask an org admin.",
          },
        ],
        summary: (i) => ({
          zh: `创建定时任务「${named(i.name)}」（${i.trigger.kind === "cron" ? `cron ${named(i.trigger.expr)}` : `一次性 ${named(i.trigger.at)}`}），之后无人值守地以你的身份运行`,
          en: `Create scheduled task "${named(i.name)}" (${i.trigger.kind === "cron" ? `cron ${named(i.trigger.expr)}` : `once at ${named(i.trigger.at)}`}), then run unattended as you`,
        }),
        run: async (input, ctx) => {
          const { input: create, browserTimeZone } = createInputOf(input);
          return {
            task: await this.tasks.create(ctx.orgId, ctx.actorAccountId, create, browserTimeZone),
          };
        },
      }),
      defineOperation({
        id: "schedules.update",
        description:
          "Change one of your own scheduled tasks (name, prompt, schedule, time zone, target, model, effort, device, expiry; null clears an optional field, and a null expiry on a cron task takes the org's default expiry when set). model, effort and deviceId are for mode new only; switching to another mode clears them. Only the creator can; an org admin can pause it instead. The person confirms every change; it is never remembered. Takes the id from schedules.list.",
        input: UpdateBody.extend({ scheduleId: Id }).strict(),
        example: { scheduleId: EXAMPLE_ID, prompt: "Summarize the last two days." },
        authz: { orgAction: "schedules.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/schedules/:id"],
        renames: { scheduleId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "schedule.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
          {
            code: "schedule.target_invalid",
            next: "Fix the target named in the message and call again.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.scheduleId);
          return {
            zh: `修改定时任务「${n}」`,
            en: `Change scheduled task "${n}"`,
          };
        },
        run: async (input, ctx) => {
          const { scheduleId, ...patch } = input;
          return {
            task: await this.tasks.update(
              ctx.orgId,
              ctx.actorAccountId,
              scheduleId,
              updateInputOf(patch),
            ),
          };
        },
      }),
      defineOperation({
        id: "schedules.delete",
        description:
          "Delete a scheduled task (yours; an org admin can delete any). The person confirms every delete; it is never remembered. Takes the id from schedules.list.",
        input: TaskId,
        example: { scheduleId: EXAMPLE_ID },
        authz: { orgAction: "org.read" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/schedules/:id"],
        renames: { scheduleId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.scheduleId);
          return { zh: `删除定时任务「${n}」`, en: `Delete scheduled task "${n}"` };
        },
        run: async (input, ctx) => {
          await this.tasks.remove(ctx.orgId, this.actor(ctx), input.scheduleId);
          return { id: input.scheduleId, deleted: true };
        },
      }),
      defineOperation({
        id: "schedules.pause",
        description:
          "Pause a scheduled task so it stops firing (yours; an org admin can pause any, and the creator is told). Resume it with schedules.resume. Takes the id from schedules.list.",
        input: TaskId,
        example: { scheduleId: EXAMPLE_ID },
        authz: { orgAction: "org.read" },
        mirrors: ["POST /api/v1/orgs/:orgId/schedules/:id/pause"],
        renames: { scheduleId: "id" },
        confirm: "personal",
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.scheduleId);
          return { zh: `暂停定时任务「${n}」`, en: `Pause scheduled task "${n}"` };
        },
        run: async (input, ctx) => ({
          task: row(await this.tasks.pause(ctx.orgId, this.actor(ctx), input.scheduleId)),
        }),
      }),
      defineOperation({
        id: "schedules.resume",
        description:
          "Resume a paused scheduled task: the next run is computed from now (missed ticks are not caught up). An ended task cannot be resumed. The person confirms every resume; it is never remembered. Takes the id from schedules.list.",
        input: TaskId,
        example: { scheduleId: EXAMPLE_ID },
        authz: { orgAction: "schedules.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/schedules/:id/resume"],
        renames: { scheduleId: "id" },
        confirm: "personal",
        // a remembered resume would let an unattended run restart a task a person stopped
        rememberable: false,
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "schedule.once_in_past",
            next: "Its time has passed: set a new time with schedules.update, then resume.",
          },
          {
            code: "schedule.disabled",
            next: {
              orgAdmin: "Turn scheduled tasks on in the org settings.",
              member: "Scheduled tasks are off here; ask an org admin.",
            },
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.scheduleId);
          return { zh: `恢复定时任务「${n}」`, en: `Resume scheduled task "${n}"` };
        },
        run: async (input, ctx) => ({
          task: row(await this.tasks.resume(ctx.orgId, this.actor(ctx), input.scheduleId)),
        }),
      }),
      defineOperation({
        id: "schedules.run",
        description:
          "Run one of your own scheduled tasks now, outside its schedule (the schedule does not move). trial=true is an attended trial: you approve its tool calls and they become the task's approved tools. Counts toward the hourly run limit. The person confirms every run; it is never remembered. Takes the id from schedules.list.",
        input: RunBody.extend({ scheduleId: Id }).strict(),
        example: { scheduleId: EXAMPLE_ID, trial: true },
        authz: { orgAction: "schedules.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/schedules/:id/run"],
        renames: { scheduleId: "id" },
        confirm: "personal",
        // a remembered run would let an unattended run trigger other tasks
        rememberable: false,
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "schedule.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
          { code: "conflict", next: "The task has ended or is being run: wait, or edit it first." },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.scheduleId);
          return {
            zh: `立即运行定时任务「${n}」${i.trial === true ? "（试运行）" : ""}`,
            en: `Run scheduled task "${n}" now${i.trial === true ? " as a trial" : ""}`,
          };
        },
        run: async (input, ctx) => ({
          run: runRow(
            await this.tasks.runNow(ctx.orgId, ctx.actorAccountId, input.scheduleId, {
              trial: input.trial === true,
            }),
          ),
        }),
      }),
      defineOperation({
        id: "schedules.runs",
        description:
          "A task's run history, latest first (default 50, at most 200): each tick with its status, skip reason, error, conversation and the tools refused for lack of an approval. Takes the id from schedules.list.",
        input: RunsQuery.extend({ scheduleId: Id }).strict(),
        example: { scheduleId: EXAMPLE_ID },
        authz: { orgAction: "schedules.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/schedules/:id/runs"],
        renames: { scheduleId: "id" },
        confirm: "read",
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        run: async (input, ctx) => ({
          items: (
            await this.tasks.runs(ctx.orgId, this.actor(ctx), input.scheduleId, input.limit)
          ).map(runRow),
        }),
      }),
      defineOperation({
        id: "schedules.grants-list",
        description:
          "The tools approved in advance for a scheduled task (what an unattended run may call without asking), each as { toolKey, connectorId, stale }; a stale approval no longer applies because the tool changed. Takes the id from schedules.list.",
        input: TaskId,
        example: { scheduleId: EXAMPLE_ID },
        authz: { orgAction: "schedules.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/schedules/:id/grants"],
        renames: { scheduleId: "id" },
        confirm: "read",
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        run: async (input, ctx) => ({
          items: (await this.tasks.grants(ctx.orgId, this.actor(ctx), input.scheduleId)).map(
            (g) => ({ toolKey: g.toolKey, connectorId: g.connectorId, stale: g.stale }),
          ),
        }),
      }),
      defineOperation({
        id: "schedules.grants-add",
        description:
          "Approve tools in advance for one of your own scheduled tasks: an unattended run may then call them without asking. Only tools you could approve with always-allow yourself; never SkillWrite and nothing the org forbids. Returns the task's approved tools as { toolKey, connectorId }. The person confirms every change; it is never remembered. Takes the id from schedules.list.",
        input: GrantsBody.extend({ scheduleId: Id }).strict(),
        example: { scheduleId: EXAMPLE_ID, grants: [{ toolKey: "WebFetch" }] },
        authz: { orgAction: "schedules.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/schedules/:id/grants"],
        renames: { scheduleId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "schedule.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
          {
            code: "schedule.grant_not_allowed",
            next: "Drop that tool: it cannot be approved in advance for a task.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.scheduleId);
          const keys = i.grants.map((g) => named(g.toolKey)).join(", ");
          return {
            zh: `为定时任务「${n}」预先批准工具：${keys}`,
            en: `Approve tools in advance for scheduled task "${n}": ${keys}`,
          };
        },
        run: async (input, ctx) => ({
          items: (
            await this.tasks.addGrants(
              ctx.orgId,
              ctx.actorAccountId,
              input.scheduleId,
              grantsOf(input.grants),
            )
          ).map((g) => ({ toolKey: g.toolKey, connectorId: g.connectorId })),
        }),
      }),
      defineOperation({
        id: "schedules.grants-remove",
        description:
          "Remove a tool's advance approval from one of your own scheduled tasks (nothing happens if it had none): the unattended run is then refused that tool. Takes the id from schedules.list.",
        input: z.object({ scheduleId: Id, toolKey: ToolKey }).strict(),
        example: { scheduleId: EXAMPLE_ID, toolKey: "WebFetch" },
        authz: { orgAction: "schedules.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/schedules/:id/grants/:toolKey"],
        renames: { scheduleId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "schedule.not_found",
            next: "Check the id with schedules.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "schedule.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.scheduleId);
          return {
            zh: `撤销定时任务「${n}」对工具 ${named(i.toolKey)} 的预先批准`,
            en: `Remove the advance approval of ${named(i.toolKey)} from scheduled task "${n}"`,
          };
        },
        run: async (input, ctx) => {
          await this.tasks.removeGrant(
            ctx.orgId,
            ctx.actorAccountId,
            input.scheduleId,
            input.toolKey,
          );
          return { id: input.scheduleId, toolKey: input.toolKey, removed: true };
        },
      }),
    ]);
  }
}
