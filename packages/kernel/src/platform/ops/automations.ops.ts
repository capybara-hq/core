import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  AutomationCalendarQuery,
  AutomationChatTargetsQuery,
  AutomationCreateBody,
  AutomationEventSourcesQuery,
  AutomationGrantableQuery,
  AutomationGrantParams,
  AutomationGrantsBody,
  AutomationListQuery,
  AutomationParams,
  AutomationRunBody,
  AutomationRunsQuery,
  AutomationUpdateBody,
  calendarInputOf,
  createInputOf,
  grantsOf,
  updateInputOf,
} from "../../automations/automations.schemas.js";
import {
  type AutomationActor,
  type AutomationListItem,
  AutomationsService,
} from "../../automations/automations.service.js";
import type { Automation, TaskRun } from "../../automations/types.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { named, orElse } from "./summary.js";

const ListQuery = AutomationListQuery;
type CreateTrigger = z.infer<typeof AutomationCreateBody>["trigger"];

/** A trigger in words for the approval card (the person's strings are neutralized). */
function triggerWords(t: CreateTrigger): { zh: string; en: string } {
  if (t.kind === "cron") return { zh: `cron ${named(t.expr)}`, en: `cron ${named(t.expr)}` };
  if (t.kind === "once") return { zh: `一次性 ${named(t.at)}`, en: `once at ${named(t.at)}` };
  const types = t.types.map(named).join(", ");
  return {
    zh: `${named(t.source)} 的事件 ${types}`,
    en: `events ${types} from ${named(t.source)}`,
  };
}
const CreateBody = AutomationCreateBody;
const UpdateBody = AutomationUpdateBody;
const RunBody = AutomationRunBody;
const RunsQuery = AutomationRunsQuery;
const GrantsBody = AutomationGrantsBody;
const Id = AutomationParams.shape.id;
const ToolKey = AutomationGrantParams.shape.toolKey;

const TaskId = z.object({ automationId: Id }).strict();
const EXAMPLE_ID = "7b2d4f60-3a1e-4c85-9e07-5d8f1a2b3c4d";

/** A task as `automations.list` shows it: the schedule, the state and the next run. */
function row(t: Automation & { lastRun?: AutomationListItem["lastRun"] }) {
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
 * Automation operations of the `Platform` tool (scheduled tasks spec §10): the same service
 * as the HTTP routes. Writes are `personal`. Creating or changing a task and its approved tools
 * are never remembered (`rememberable: false`): an approval, remembered or granted to a task,
 * must never let an unattended run create or widen a task. Delete, run and resume are never
 * remembered either. List, pause and delete are `org.read` like their routes: a creator demoted
 * to guest can still see and stop their own tasks (the service decides by ownership).
 */
@Injectable()
export class AutomationsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AutomationsService) private readonly tasks: AutomationsService,
  ) {}

  /** The caller as the service expects (it reads the live role itself). */
  private actor(ctx: OperationContext): AutomationActor {
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
        id: "automations.list",
        description:
          "List your automations: one compact row each (name, agent, status and why it is paused, schedule with its time zone, where runs post, next run, last settled run). all=true lists every task of the org and needs the org admin role; conversationId keeps the tasks that post into that conversation.",
        input: ListQuery,
        example: {},
        // a creator demoted to guest still lists their own tasks (to pause or delete them)
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations"],
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
        id: "automations.calendar",
        description:
          "Your automation runs and planned occurrences between two instants (at most 43 days): recorded runs with their status, planned runs computed from each active task's schedule up to 42 days ahead, and dense tasks summarized per day. Org admins see every task with all=true. from and to are ISO instants with an offset; timeZone (IANA) sets the local days used to summarize dense tasks; taskId lists one task's items, never summarized (then at most 2 days). truncated means a limit cut the range at horizon.",
        input: AutomationCalendarQuery,
        example: {
          from: "2026-11-09T00:00:00+08:00",
          to: "2026-11-16T00:00:00+08:00",
          timeZone: "Asia/Shanghai",
        },
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations/calendar"],
        confirm: "read",
        errors: [
          {
            code: "validation_failed",
            next: "Narrow the range to 43 days or less (2 days with taskId), with from before to.",
          },
          {
            code: "forbidden",
            next: "Reading every task needs the org admin role: call without all, or ask an org admin.",
          },
          {
            code: "automation.not_found",
            next: "Check taskId with automations.list: members see only their own tasks; an org admin finds another member's task id with automations.list all=true, then reads it here by taskId (all is not needed).",
          },
        ],
        run: async (input, ctx) => {
          const answer = await this.tasks.calendar(
            ctx.orgId,
            this.actor(ctx),
            calendarInputOf(input),
          );
          return {
            ...answer,
            tasks: answer.tasks.map((t) => ({
              id: t.id,
              name: t.name,
              agentId: t.agentId,
              status: t.status,
            })),
          };
        },
      }),
      defineOperation({
        id: "automations.event-sources",
        description:
          'The event sources an automation can trigger on: each { source, name, events } for an extension that emits trigger events and is on in this org (and not switched off in the automation settings). Each event is { type, name, directed, facts }: facts maps a name to { type (string, number, boolean or string[]), name, filterable }. Use source, type names and filterable facts in automations.create\'s trigger { kind: "event", source, types, filter }; directed types cannot trigger an automation.',
        input: AutomationEventSourcesQuery,
        example: {},
        authz: { orgAction: "automations.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations/event-sources"],
        confirm: "read",
        errors: [],
        run: async (_input, ctx) => ({ items: await this.tasks.eventSources(ctx.orgId) }),
      }),
      defineOperation({
        id: "automations.chat-targets",
        description:
          "The IM chats you can point a chat-mode automation at: your direct chats with each active channel connection's bot (one you have messaged before), and the groups you have talked in when the channel has threads. Each gives { connectionId, chatId, chatType } for automations.create, and the connection's agentId, which the task must use.",
        input: AutomationChatTargetsQuery,
        example: {},
        authz: { orgAction: "automations.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations/chat-targets"],
        confirm: "read",
        errors: [],
        run: async (_input, ctx) => ({
          items: await this.tasks.chatTargets(ctx.orgId, ctx.actorAccountId),
        }),
      }),
      defineOperation({
        id: "automations.grantable-tools",
        description:
          "An agent's tools as an automation can approve them in advance: each { key, title, source, connectorId, grantable, reason }; reason says why not (forbidden by the org, not_grantable by design, needs_role, fixed_ask, not_available). Takes the agent id from the agents list.",
        input: AutomationGrantableQuery,
        example: { agentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "automations.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations/grantable-tools"],
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
        id: "automations.get",
        description:
          "Read one automation in full: prompt, schedule, target, model, effort, device, status, next run, expiry. Takes the id from automations.list.",
        input: TaskId,
        example: { automationId: EXAMPLE_ID },
        authz: { orgAction: "automations.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations/:id"],
        renames: { automationId: "id" },
        confirm: "read",
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        run: async (input, ctx) => ({
          task: await this.tasks.get(ctx.orgId, this.actor(ctx), input.automationId),
        }),
      }),
      defineOperation({
        id: "automations.create",
        description:
          "Create an automation: an agent runs the prompt as you, unattended, on a 5-field cron, once at a local date-time, or when events happen: trigger { kind: \"event\", source, types, filter? } with a source, types and filterable facts from automations.event-sources (filter is a list of { fact, op: eq | in | contains, value }; eq takes a scalar of the fact's type, in a list of strings for a string fact, contains a string for a string[] fact). A time trigger uses your time zone; timeZone is only the fallback when you have none set; an event trigger has none. mode: new (a conversation per run), conversation (post into one conversation), chat (an IM chat; time triggers only) or subject (one conversation per event subject; event triggers only). unattendedAsk (fail | wait) sets what a question in an unattended run does; null follows the org's default. model ({ provider, model } like an agent definition's) and effort are for modes new and subject, deviceId for mode new only; a conversation or chat task runs with that conversation's model. Without expiresAt a cron or event automation ends after the org's default expiry, when the org sets one. grants pre-approve tools the unattended run may use.",
        input: CreateBody,
        example: {
          agentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20",
          name: "Daily digest",
          prompt: "Summarize yesterday's activity.",
          trigger: { kind: "cron", expr: "0 9 * * *" },
          mode: "new",
        },
        authz: { orgAction: "automations.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/automations"],
        confirm: "personal",
        // an unattended run must never create or widen a task through a remembered approval
        rememberable: false,
        errors: [
          {
            code: "automation.disabled",
            next: {
              orgAdmin: "Turn automations on in the org settings.",
              member: "Automations are off here; ask an org admin.",
            },
          },
          {
            code: "automation.limit_reached",
            next: "Delete a task you no longer need with automations.delete, or pause and edit an existing one.",
          },
          {
            code: "automation.target_invalid",
            next: "Fix the target named in the message (conversation, chat or device) and call again. Mode subject needs an event trigger; mode chat needs a time trigger.",
          },
          {
            code: "automation.event_source_unavailable",
            next: "Pick a source from automations.event-sources: it must be enabled in this org and not switched off in the automation settings.",
          },
          {
            code: "automation.event_type_unknown",
            next: "Use event type names the source declares in automations.event-sources; directed types cannot trigger an automation.",
          },
          {
            code: "automation.filter_invalid",
            next: "Filter only on filterable facts the selected event types all declare, with a value of the fact's type (eq: scalar, in: strings on a string fact, contains: a string on a string[] fact).",
          },
          {
            code: "automation.grant_not_allowed",
            next: "Drop that grant: the task will ask for it as a person when it runs attended, or ask an org admin.",
          },
        ],
        summary: (i) => ({
          zh: `创建自动化「${named(i.name)}」（${triggerWords(i.trigger).zh}），之后无人值守地以你的身份运行`,
          en: `Create automation "${named(i.name)}" (${triggerWords(i.trigger).en}), then run unattended as you`,
        }),
        run: async (input, ctx) => {
          const { input: create, browserTimeZone } = createInputOf(input);
          return {
            task: await this.tasks.create(ctx.orgId, ctx.actorAccountId, create, browserTimeZone),
          };
        },
      }),
      defineOperation({
        id: "automations.update",
        description:
          "Change one of your own automations (name, prompt, trigger (a schedule or an event trigger, as automations.create takes it), time zone, target, mode, unattendedAsk, model, effort, device, expiry; null clears an optional field, and a null expiry on a cron or event automation takes the org's default expiry when set). model and effort are for modes new and subject, deviceId for mode new only; switching to another mode clears them. Only the creator can; an org admin can pause it instead. Takes the id from automations.list.",
        input: UpdateBody.extend({ automationId: Id }).strict(),
        example: { automationId: EXAMPLE_ID, prompt: "Summarize the last two days." },
        authz: { orgAction: "automations.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/automations/:id"],
        renames: { automationId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "automation.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
          {
            code: "automation.target_invalid",
            next: "Fix the target named in the message and call again. Mode subject needs an event trigger; mode chat needs a time trigger; switching trigger kind may need a new mode.",
          },
          {
            code: "automation.event_source_unavailable",
            next: "Pick a source from automations.event-sources.",
          },
          {
            code: "automation.event_type_unknown",
            next: "Use event type names the source declares in automations.event-sources.",
          },
          {
            code: "automation.filter_invalid",
            next: "Filter only on filterable facts of the selected types, with a value of the fact's type.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.automationId);
          return {
            zh: `修改自动化「${n}」`,
            en: `Change automation "${n}"`,
          };
        },
        run: async (input, ctx) => {
          const { automationId, ...patch } = input;
          return {
            task: await this.tasks.update(
              ctx.orgId,
              ctx.actorAccountId,
              automationId,
              updateInputOf(patch),
            ),
          };
        },
      }),
      defineOperation({
        id: "automations.delete",
        description:
          "Delete an automation (yours; an org admin can delete any). Takes the id from automations.list.",
        input: TaskId,
        example: { automationId: EXAMPLE_ID },
        authz: { orgAction: "org.read" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/automations/:id"],
        renames: { automationId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.automationId);
          return { zh: `删除自动化「${n}」`, en: `Delete automation "${n}"` };
        },
        run: async (input, ctx) => {
          await this.tasks.remove(ctx.orgId, this.actor(ctx), input.automationId);
          return { id: input.automationId, deleted: true };
        },
      }),
      defineOperation({
        id: "automations.pause",
        description:
          "Pause an automation so it stops firing (yours; an org admin can pause any, and the creator is told). Resume it with automations.resume. Takes the id from automations.list.",
        input: TaskId,
        example: { automationId: EXAMPLE_ID },
        authz: { orgAction: "org.read" },
        mirrors: ["POST /api/v1/orgs/:orgId/automations/:id/pause"],
        renames: { automationId: "id" },
        confirm: "personal",
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.automationId);
          return { zh: `暂停自动化「${n}」`, en: `Pause automation "${n}"` };
        },
        run: async (input, ctx) => ({
          task: row(await this.tasks.pause(ctx.orgId, this.actor(ctx), input.automationId)),
        }),
      }),
      defineOperation({
        id: "automations.resume",
        description:
          "Resume a paused automation: the next run is computed from now (missed ticks are not caught up). An ended task cannot be resumed. Takes the id from automations.list.",
        input: TaskId,
        example: { automationId: EXAMPLE_ID },
        authz: { orgAction: "automations.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/automations/:id/resume"],
        renames: { automationId: "id" },
        confirm: "personal",
        // a remembered resume would let an unattended run restart a task a person stopped
        rememberable: false,
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "automation.once_in_past",
            next: "Its time has passed: set a new time with automations.update, then resume.",
          },
          {
            code: "automation.disabled",
            next: {
              orgAdmin: "Turn automations on in the org settings.",
              member: "Automations are off here; ask an org admin.",
            },
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.automationId);
          return { zh: `恢复自动化「${n}」`, en: `Resume automation "${n}"` };
        },
        run: async (input, ctx) => ({
          task: row(await this.tasks.resume(ctx.orgId, this.actor(ctx), input.automationId)),
        }),
      }),
      defineOperation({
        id: "automations.run",
        description:
          "Run one of your own scheduled automations now, outside its schedule (the schedule does not move). trial=true is an attended trial: you approve its tool calls and they become the task's approved tools. Counts toward the hourly run limit. An event automation runs only on its events and cannot be run now. Takes the id from automations.list.",
        input: RunBody.extend({ automationId: Id }).strict(),
        example: { automationId: EXAMPLE_ID, trial: true },
        authz: { orgAction: "automations.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/automations/:id/run"],
        renames: { automationId: "id" },
        confirm: "personal",
        // a remembered run would let an unattended run trigger other tasks
        rememberable: false,
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "automation.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
          { code: "conflict", next: "The task has ended or is being run: wait, or edit it first." },
          {
            code: "automation.run_now_unsupported",
            next: "An event automation runs only when its events arrive: tell the person to make an event of its source happen to test it, or change its trigger to a schedule with automations.update.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.automationId);
          return {
            zh: `立即运行自动化「${n}」${i.trial === true ? "（试运行）" : ""}`,
            en: `Run automation "${n}" now${i.trial === true ? " as a trial" : ""}`,
          };
        },
        run: async (input, ctx) => ({
          run: runRow(
            await this.tasks.runNow(ctx.orgId, ctx.actorAccountId, input.automationId, {
              trial: input.trial === true,
            }),
          ),
        }),
      }),
      defineOperation({
        id: "automations.runs",
        description:
          "A task's run history, latest first (default 50, at most 200): each tick with its status, skip reason, error, conversation and the tools refused for lack of an approval. Takes the id from automations.list.",
        input: RunsQuery.extend({ automationId: Id }).strict(),
        example: { automationId: EXAMPLE_ID },
        authz: { orgAction: "automations.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations/:id/runs"],
        renames: { automationId: "id" },
        confirm: "read",
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        run: async (input, ctx) => ({
          items: (
            await this.tasks.runs(ctx.orgId, this.actor(ctx), input.automationId, input.limit)
          ).map(runRow),
        }),
      }),
      defineOperation({
        id: "automations.grants-list",
        description:
          "The tools approved in advance for an automation (what an unattended run may call without asking), each as { toolKey, connectorId, stale }; a stale approval no longer applies because the tool changed. Takes the id from automations.list.",
        input: TaskId,
        example: { automationId: EXAMPLE_ID },
        authz: { orgAction: "automations.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/automations/:id/grants"],
        renames: { automationId: "id" },
        confirm: "read",
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
        ],
        run: async (input, ctx) => ({
          items: (await this.tasks.grants(ctx.orgId, this.actor(ctx), input.automationId)).map(
            (g) => ({ toolKey: g.toolKey, connectorId: g.connectorId, stale: g.stale }),
          ),
        }),
      }),
      defineOperation({
        id: "automations.grants-add",
        description:
          "Approve tools in advance for one of your own automations: an unattended run may then call them without asking. Only tools you could approve with always-allow yourself; never a Platform operation (each is decided per call) and nothing the org forbids. Returns the task's approved tools as { toolKey, connectorId }. Takes the id from automations.list.",
        input: GrantsBody.extend({ automationId: Id }).strict(),
        example: { automationId: EXAMPLE_ID, grants: [{ toolKey: "WebFetch" }] },
        authz: { orgAction: "automations.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/automations/:id/grants"],
        renames: { automationId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "automation.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
          {
            code: "automation.grant_not_allowed",
            next: "Drop that tool: it cannot be approved in advance for a task.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.automationId);
          const keys = i.grants.map((g) => named(g.toolKey)).join(", ");
          return {
            zh: `为自动化「${n}」预先批准工具：${keys}`,
            en: `Approve tools in advance for automation "${n}": ${keys}`,
          };
        },
        run: async (input, ctx) => ({
          items: (
            await this.tasks.addGrants(
              ctx.orgId,
              ctx.actorAccountId,
              input.automationId,
              grantsOf(input.grants),
            )
          ).map((g) => ({ toolKey: g.toolKey, connectorId: g.connectorId })),
        }),
      }),
      defineOperation({
        id: "automations.grants-remove",
        description:
          "Remove a tool's advance approval from one of your own automations (nothing happens if it had none): the unattended run is then refused that tool. Takes the id from automations.list.",
        input: z.object({ automationId: Id, toolKey: ToolKey }).strict(),
        example: { automationId: EXAMPLE_ID, toolKey: "WebFetch" },
        authz: { orgAction: "automations.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/automations/:id/grants/:toolKey"],
        renames: { automationId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "automation.not_found",
            next: "Check the id with automations.list: you only see your own tasks (org admins see all with all=true).",
          },
          {
            code: "automation.forbidden",
            next: "Only the creator can change a task: ask them, or an org admin can pause it.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.automationId);
          return {
            zh: `撤销自动化「${n}」对工具 ${named(i.toolKey)} 的预先批准`,
            en: `Remove the advance approval of ${named(i.toolKey)} from automation "${n}"`,
          };
        },
        run: async (input, ctx) => {
          await this.tasks.removeGrant(
            ctx.orgId,
            ctx.actorAccountId,
            input.automationId,
            input.toolKey,
          );
          return { id: input.automationId, toolKey: input.toolKey, removed: true };
        },
      }),
    ]);
  }
}
