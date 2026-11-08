import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ApprovalPathParams, ApprovalsListQuerySchema } from "../../tools/approvals.schemas.js";
import { ApprovalsService, type ApprovalView } from "../../tools/approvals.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { Cursor, pageOf, startOf } from "./paging.js";

/** Where a person decides an approval: never through an agent (spec §6.4, §14.1 item 2). */
export const DECIDE_ON_WEB =
  "Decide it on the web, in the inbox or in its conversation; agents never decide approvals.";

/**
 * An approval as the waiting list shows it: a compact row with the summary the inbox shows (the
 * kernel-rendered summary of a per-call policy, else null). Never the tool input: it may carry
 * another person's data or credentials (Review Focus 5); the web shows it to the person deciding.
 */
export const approvalRow = (a: ApprovalView) => ({
  id: a.id,
  name: a.toolKey,
  state: a.status,
  summary: a.summary?.en ?? null,
  agent: a.agent.name,
  expiresAt: a.expiresAt,
  ...(a.status === "pending" && { next: DECIDE_ON_WEB }),
});

/**
 * One approval as `approvals.get` shows it: what was called, by which agent and conversation, its
 * state and the scopes a decider may choose. Left out: the tool input, the spec hash and the call
 * and run ids (the decision route's material, not a summary).
 */
const detail = (a: ApprovalView) => ({
  id: a.id,
  toolKey: a.toolKey,
  toolName: a.toolName,
  connector: a.connector === null ? null : { id: a.connector.id, name: a.connector.name },
  extension: a.extension,
  agent: a.agent,
  conversationId: a.conversationId,
  conversationPath: a.conversationPath,
  ...(a.parentConversationId !== undefined && { parentConversationId: a.parentConversationId }),
  initiatorAccountId: a.initiatorAccountId,
  summary: a.summary,
  status: a.status,
  approverRole: a.approverRole,
  scopes: a.scopes,
  attempt: a.attempt,
  denyReason: a.denyReason,
  decidedAt: a.decidedAt,
  expiresAt: a.expiresAt,
  createdAt: a.createdAt,
  ...(a.status === "pending" && { next: DECIDE_ON_WEB }),
});

/**
 * The approval reads of the `Platform` tool (spec §14.1 item 2): what waits for my decision, as
 * the inbox shows it. Deciding stays with the person on the web; `POST /approvals/:id/decision`
 * and the standing grants (`/me/tool-grants`) are excluded as human-only.
 */
@Injectable()
export class ApprovalsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "approvals.waiting",
        description:
          "List the tool call approvals you can decide in this org, newest first: your own runs' calls and, for org admins, other people's calls that need an admin. One compact row each (tool, state, the summary the inbox shows, agent, expiry); pending by default, or pass one status (pending, approved, denied, expired, cancelled; there is no \"all\": call once per status to see more). Never the call's input. Deciding is done by you on the web, never by an agent. Pages by 50: pass the returned next as params.cursor.",
        input: z
          .object({ status: ApprovalsListQuerySchema.shape.status, cursor: Cursor.optional() })
          .strict(),
        example: {},
        authz: { orgAction: "approvals.decide" },
        mirrors: ["GET /api/v1/orgs/:orgId/approvals"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const all = await this.approvals.list(
            ctx.orgId,
            ctx.actorAccountId,
            input.status ?? "pending",
          );
          return pageOf(all.map(approvalRow), startOf(input.cursor), 50);
        },
      }),
      defineOperation({
        id: "approvals.get",
        description:
          "Read one approval you can decide (the id from approvals.waiting or inbox.list): the tool, its connector or extension, the agent and conversation, the summary, state, expiry and the scopes a decision may take. Never the call's input; the web shows it to you when you decide there.",
        input: z.object({ id: ApprovalPathParams.shape.id.uuid() }).strict(),
        example: { id: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { orgAction: "approvals.decide" },
        mirrors: ["GET /api/v1/orgs/:orgId/approvals/:id"],
        confirm: "read",
        errors: [
          {
            code: "approval.not_found",
            next: "No approval with this id waits for you (it may be another person's); list yours with approvals.waiting.",
          },
        ],
        run: async (input, ctx) => ({
          approval: detail(await this.approvals.get(ctx.orgId, input.id, ctx.actorAccountId)),
        }),
      }),
    ]);
  }
}
