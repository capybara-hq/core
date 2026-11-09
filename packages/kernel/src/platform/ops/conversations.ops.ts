import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  EventsQuery,
  FilesQuery,
  IdParams,
  ListQuery,
  PatchBody,
  SubagentsQuery,
} from "../../conversations/conversations.schemas.js";
import {
  ConversationsService,
  type ConversationView,
} from "../../conversations/conversations.service.js";
import { ConversationDeviceStatus } from "../../conversations/device-status.js";
import { ConversationFiles } from "../../conversations/files.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { rootConversationOf } from "../../runtime/subagents/child.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy } from "./errors.js";
import { named, orElse } from "./summary.js";

const PAGE = 50;
const ConversationId = IdParams.shape.id;
const Id = z.object({ conversationId: ConversationId }).strict();
const EVENTS_PAGE_MAX = 100;

/** A list row: the compact form (`state` is what the run is doing, else archived or idle). */
const row = (c: ConversationView) => ({
  id: c.id,
  name: c.title ?? "Untitled",
  state: c.activity ?? (c.archivedAt === null ? "idle" : "archived"),
  agentId: c.agentId,
  updatedAt: c.updatedAt,
});

/**
 * Conversation operations of the `Platform` tool (spec §14, conversations): the person's own
 * conversations only, as the web sidebar shows them. Starting a conversation or sending a message
 * stays with the person (runs are started by them), and so do the live stream and the other
 * display reads (see `exclusions.ts`).
 */
@Injectable()
export class ConversationsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(ConversationFiles) private readonly files: ConversationFiles,
    @Inject(ConversationDeviceStatus)
    private readonly device: ConversationDeviceStatus,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /**
   * Whether `id` is the conversation this run belongs to: its ROOT (the Platform tool also runs in
   * sub-agents, whose own id is not the person's conversation). Stopping or deleting it would end
   * the very run that asked.
   */
  private async isRunsRoot(id: string, ctx: OperationContext): Promise<boolean> {
    const root = await rootConversationOf(this.kdb.db, ctx.conversationId);
    return id === root || id === ctx.conversationId;
  }

  private titleOf(ctx: OperationContext, id: string): Promise<string> {
    return orElse(
      async () =>
        named((await this.conversations.get(ctx.orgId, id, ctx.actorAccountId)).title ?? id),
      id,
    );
  }

  private precheckWritable(id: string, ctx: OperationContext) {
    return precheckBy(() => this.conversations.writable(ctx.orgId, id, ctx.actorAccountId));
  }

  private async setArchived(id: string, archived: boolean, ctx: OperationContext) {
    return {
      conversation: await this.conversations.setArchived(
        ctx.orgId,
        id,
        ctx.actorAccountId,
        archived,
      ),
    };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "conversations.list",
        description:
          "List your own conversations, most recently updated first: id, name, state (running, waiting, idle or archived), agent id and update time. Pages by 50: pass the returned next as params.after. Filter by title text q, by agentId, by state (running or waiting), or pass archived 1 for the archived ones.",
        input: ListQuery.pick({
          q: true,
          state: true,
          archived: true,
          agentId: true,
          after: true,
        }).strict(),
        example: { q: "report" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations"],
        // the page size is fixed at 50
        omits: ["limit"],
        confirm: "read",
        run: async (input, ctx) => {
          const rows = await this.conversations.listMine(ctx.orgId, ctx.actorAccountId, {
            limit: PAGE + 1,
            ...(input.after !== undefined && { after: input.after }),
            ...(input.agentId !== undefined && { agentId: input.agentId }),
            ...(input.q !== undefined && { q: input.q }),
            ...(input.state !== undefined && { state: input.state }),
            ...(input.archived !== undefined && { archived: true }),
          });
          const items = rows.slice(0, PAGE);
          return {
            conversations: items.map(row),
            next: rows.length > PAGE ? (items.at(-1)?.id ?? null) : null,
          };
        },
      }),
      defineOperation({
        id: "conversations.get",
        description:
          "Read one of your conversations: title, agent, model selection, archived time, last event seq and what it is doing now. Takes the id from conversations.list.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) => ({
          conversation: await this.conversations.get(
            ctx.orgId,
            input.conversationId,
            ctx.actorAccountId,
          ),
        }),
      }),
      defineOperation({
        id: "conversations.events",
        description:
          'Read the event log of one of your conversations (messages, tool calls, results) in order, at most 100 events per call. Pass after (a seq; the last seq of the previous page) to read forward from the start, or before (a seq, or "end" for the log\'s last turns) to read the turns before it; the two cannot be combined. Takes the id from conversations.list.',
        input: z
          .object({
            conversationId: ConversationId,
            after: EventsQuery.shape.after,
            before: EventsQuery.shape.before,
            limit: z.number().int().min(1).max(EVENTS_PAGE_MAX).default(EVENTS_PAGE_MAX),
          })
          .strict()
          .refine((q) => q.after === undefined || q.before === undefined, {
            message: "after and before are exclusive",
            path: ["before"],
          }),
        example: {
          conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10",
          before: "end",
          limit: 100,
        },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id/events"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) => {
          if (input.before !== undefined) {
            return this.conversations.listEventsBefore(
              ctx.orgId,
              input.conversationId,
              ctx.actorAccountId,
              input.before === "end" ? null : input.before,
              input.limit,
            );
          }
          return {
            events: await this.conversations.listEvents(
              ctx.orgId,
              input.conversationId,
              ctx.actorAccountId,
              input.after ?? 0,
              input.limit,
            ),
          };
        },
      }),
      defineOperation({
        id: "conversations.rename",
        description:
          "Rename one of your conversations. The new title is kept and never replaced by a generated one. Takes the id from conversations.list. The person may remember this permission.",
        input: z
          .object({ conversationId: ConversationId, title: PatchBody.shape.title.unwrap() })
          .strict(),
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10", title: "Q3 report" },
        authz: { orgAction: "agents.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/conversations/:id"],
        // archiving is its own operation
        omits: ["archived"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
          {
            code: "conversation.read_only",
            next: "That is a sub-agent's conversation and cannot be changed; use the conversation it belongs to.",
          },
        ],
        confirm: "personal",
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.conversations.writable(ctx.orgId, i.conversationId, ctx.actorAccountId),
          ),
        summary: async (i, ctx) => {
          const old = await this.titleOf(ctx, i.conversationId);
          return {
            zh: `将对话「${old}」重命名为「${named(i.title)}」`,
            en: `Rename conversation "${old}" to "${named(i.title)}"`,
          };
        },
        run: async (input, ctx) => ({
          conversation: await this.conversations.rename(
            ctx.orgId,
            input.conversationId,
            ctx.actorAccountId,
            input.title,
          ),
        }),
      }),
      defineOperation({
        id: "conversations.archive",
        description:
          "Archive one of your conversations: it leaves the default list and stays readable; conversations.unarchive brings it back. The person may remember this permission.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/conversations/:id"],
        // the title is conversations.rename; `archived` is fixed by the operation
        omits: ["title", "archived"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
          {
            code: "conversation.read_only",
            next: "That is a sub-agent's conversation and cannot be changed; use the conversation it belongs to.",
          },
        ],
        confirm: "personal",
        precheck: (i, ctx) => this.precheckWritable(i.conversationId, ctx),
        summary: async (i, ctx) => {
          const t = await this.titleOf(ctx, i.conversationId);
          return { zh: `归档对话「${t}」`, en: `Archive conversation "${t}"` };
        },
        run: (input, ctx) => this.setArchived(input.conversationId, true, ctx),
      }),
      defineOperation({
        id: "conversations.unarchive",
        description:
          "Unarchive one of your conversations so it is in the default list again. The person may remember this permission.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/conversations/:id"],
        omits: ["title", "archived"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
          {
            code: "conversation.read_only",
            next: "That is a sub-agent's conversation and cannot be changed; use the conversation it belongs to.",
          },
        ],
        confirm: "personal",
        precheck: (i, ctx) => this.precheckWritable(i.conversationId, ctx),
        summary: async (i, ctx) => {
          const t = await this.titleOf(ctx, i.conversationId);
          return { zh: `取消归档对话「${t}」`, en: `Unarchive conversation "${t}"` };
        },
        run: (input, ctx) => this.setArchived(input.conversationId, false, ctx),
      }),
      defineOperation({
        id: "conversations.usage",
        description:
          "Read the token usage of one of your conversations, its sub-agents included: input, output, cache read and cache write tokens. Takes the id from conversations.list.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id/usage"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) => ({
          usage: await this.conversations.usage(
            ctx.orgId,
            input.conversationId,
            ctx.actorAccountId,
          ),
        }),
      }),
      defineOperation({
        id: "conversations.subagents",
        description:
          "List the sub-agents one of your conversations dispatched, newest first: id, type, description, status, tool calls, times, usage and any pending approval or question ids. Pages by 50: pass the returned next as params.after.",
        input: SubagentsQuery.pick({ after: true })
          .extend({ conversationId: ConversationId })
          .strict(),
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id/subagents"],
        // the page size is fixed at 50
        omits: ["limit"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) =>
          this.conversations.listSubagents(ctx.orgId, input.conversationId, ctx.actorAccountId, {
            limit: PAGE,
            ...(input.after !== undefined && { after: input.after }),
          }),
      }),
      defineOperation({
        id: "conversations.agent-tree",
        description:
          "Read the agent tree of one of your conversations: the conversation and every sub-agent below it with status, model, time, tokens and tool calls. Only a conversation you started, not a sub-agent's, has a tree.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id/agent-tree"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations, not their sub-agents, have a tree.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) =>
          this.conversations.agentTree(ctx.orgId, input.conversationId, ctx.actorAccountId),
      }),
      defineOperation({
        id: "conversations.files",
        description:
          "List the files one of your conversations produced, newest first: id, name, state (available or removed), type, size and version. File contents are downloaded on the web. Pages by 50: pass the returned next as params.after.",
        input: FilesQuery.pick({ after: true }).extend({ conversationId: ConversationId }).strict(),
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id/files"],
        // the page size is fixed at 50
        omits: ["limit"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) => {
          const out = await this.files.list(ctx.orgId, input.conversationId, ctx.actorAccountId, {
            limit: PAGE,
            ...(input.after !== undefined && { after: input.after }),
          });
          return {
            files: out.files.map((f) => ({
              id: f.id,
              name: f.name,
              state: f.status,
              contentType: f.contentType,
              size: f.size,
              version: f.version,
            })),
            next: out.next,
          };
        },
      }),
      defineOperation({
        id: "conversations.device",
        description:
          "Read the device one of your conversations works in and whether its instance is running or suspended; device is null while the conversation has none. Takes the id from conversations.list.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/conversations/:id/device"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) => ({
          device: await this.device.get(ctx.orgId, input.conversationId, ctx.actorAccountId),
        }),
      }),
      defineOperation({
        id: "conversations.abort",
        description:
          "Stop the run that is active in one of your other conversations (its sub-agents keep working; stopping a sub-agent's conversation stops it and those below it). Nothing happens if no run is active. The person confirms every stop; it is never remembered. The conversation you are working in cannot be stopped.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/conversations/:id/abort"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
          {
            code: "run.not_active",
            next: "No run is active in that conversation: nothing to stop; check conversations.list for its state.",
          },
          {
            code: "conversation.abort_current",
            next: "This is the conversation you are running in: ask the person to stop it on the web, or stop a different one.",
          },
        ],
        confirm: "personal",
        rememberable: false,
        precheck: async (i, ctx) => {
          if (await this.isRunsRoot(i.conversationId, ctx)) {
            return {
              ok: false,
              code: "conversation.abort_current",
              message: "The conversation you are running in cannot be stopped from here.",
            };
          }
          return precheckBy(() =>
            this.conversations.get(ctx.orgId, i.conversationId, ctx.actorAccountId),
          );
        },
        summary: async (i, ctx) => {
          const t = await this.titleOf(ctx, i.conversationId);
          return {
            zh: `停止对话「${t}」中正在进行的运行`,
            en: `Stop the active run in conversation "${t}"`,
          };
        },
        run: async (input, ctx) => ({
          stopped: true,
          runId: await this.conversations.abort(
            ctx.orgId,
            input.conversationId,
            ctx.actorAccountId,
          ),
        }),
      }),
      defineOperation({
        id: "conversations.delete",
        description:
          "Delete one of your conversations: a running run in it is stopped and the conversation disappears from every list. This cannot be undone from the tool. The person confirms every delete; it is never remembered. The conversation you are working in cannot be deleted.",
        input: Id,
        example: { conversationId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/conversations/:id"],
        renames: { conversationId: "id" },
        errors: [
          {
            code: "conversation.not_found",
            next: "Check the id with conversations.list: only your own conversations can be read or changed.",
          },
          {
            code: "conversation.read_only",
            next: "That is a sub-agent's conversation and cannot be changed; use the conversation it belongs to.",
          },
          {
            code: "conversation.delete_current",
            next: "This is the conversation you are running in: ask the person to delete it from the web sidebar, or delete a different one.",
          },
        ],
        confirm: "personal",
        // destructive: `personal` in rights, but each delete is asked and never remembered
        rememberable: false,
        precheck: async (i, ctx) => {
          if (await this.isRunsRoot(i.conversationId, ctx)) {
            return {
              ok: false,
              code: "conversation.delete_current",
              message: "The conversation you are running in cannot be deleted from here.",
            };
          }
          return precheckBy(() =>
            this.conversations.writable(ctx.orgId, i.conversationId, ctx.actorAccountId),
          );
        },
        summary: async (i, ctx) => {
          const t = await this.titleOf(ctx, i.conversationId);
          return { zh: `删除对话「${t}」`, en: `Delete conversation "${t}"` };
        },
        run: async (input, ctx) => {
          await this.conversations.remove(ctx.orgId, input.conversationId, ctx.actorAccountId);
          return { deleted: true, conversationId: input.conversationId };
        },
      }),
    ]);
  }
}
