import { Controller, Get, Headers, Inject, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ConversationAccess } from "../conversations/access.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { ApiError } from "../errors.js";
import { ApiTokenService } from "../identity/api-tokens.js";
import { credentialCheck } from "../identity/credential-check.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { SessionService } from "../identity/sessions.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { type RunDraft, RunDrafts } from "./run-drafts.js";
import { ConversationStreams } from "./stream.js";

const BEARER_RE = /^Bearer\s+(\S+)$/i;

const StreamQuery = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

/** `Last-Event-ID`：非负整数（客户端回传的最后一条事件 seq）。 */
function parseLastEventId(v: string): number {
  const t = v.trim();
  const n = Number(t);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(n)) {
    throw new ApiError("validation_failed", "Last-Event-ID must be a non-negative integer");
  }
  return n;
}

const DraftParams = z.object({
  id: z.string().min(1).max(100),
  runId: z.string().min(1).max(100),
});

class ConversationStreamQueryDto extends createZodDto(StreamQuery, "ConversationStreamQuery") {}
class RunDraftParamsDto extends createZodDto(DraftParams, "RunDraftParams") {}

/**
 * 会话事件流（SSE）：`GET /api/v1/orgs/:orgId/conversations/:id/stream?after=<seq>`，`agents.use`，只有会话所有者可用。
 * - 打开时不阻塞地调用一次 ensureRun（`ConversationsService.kickRun`），停在「运行中」的孤儿运行由此被清理；
 * - 先订阅会话频道、再回放 `after`（或优先的 `Last-Event-ID`）之后的事件：`id: <seq>` / `event: event`；
 * - after that catch-up, one `event: draft` (`data: {"runId","step","text","thinking"}`) per step of
 *   the running run whose `assistant_message` is not logged (live drafts, spec 2026-11-07 §3.2);
 *   之后收到 `events` 通知就补读新事件（按 seq 去重），收到增量就发 `event: delta`，收到界面刷新
 *   （插件 `ctx.ui.invalidate`）就发 `event: ui`（`data: {"plugin","contribution"}`）；
 * - 每 `runtime.sseHeartbeatMs` 发 `: ping` 注释；每 `runtime.sseRecheckMs` 复核凭据（会话未吊销 / 令牌仍有效，
 *   access token 到期本身不算失效）与可见性，失败时发 `event: error`（`data: {"code"}`）后关闭流；
 * - 用 `@Res()` + `reply.hijack()` 直接写原始响应，绕开 Nest / Fastify 的响应处理与缓冲。
 *   代理（Web 层）需透传 `x-accel-buffering: no`、`cache-control: no-cache`。
 */
@Controller("api/v1/orgs/:orgId/conversations")
export class ConversationStreamController {
  constructor(
    @Inject(ConversationStreams) private readonly streams: ConversationStreams,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ApiTokenService) private readonly tokens: ApiTokenService,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(ConversationAccess) private readonly access: ConversationAccess,
    @Inject(RunDrafts) private readonly drafts: RunDrafts,
  ) {}

  /**
   * The live drafts of one run (spec 2026-11-07 §3.2): `{ drafts: { step, text, thinking }[] }`,
   * the steps still streaming whose `assistant_message` is not logged (none once the run is no
   * longer running). What a stream client asks for when a delta's `offset` is past its draft.
   * The stream's access rule (the conversation is visible to the viewer, else 404
   * `conversation.not_found`); a run not of this conversation → 404 `run.not_found`.
   */
  @Get(":id/runs/:runId/draft")
  @OrgAction("agents.use")
  async draft(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(RunDraftParamsDto) params: z.infer<typeof DraftParams>,
  ): Promise<{ drafts: RunDraft[] }> {
    const p = requireUser(principal);
    if (!(await this.access.isAccessible(org.orgId, params.id, p.account.id))) {
      throw new ApiError("conversation.not_found", "Conversation not found");
    }
    if (!(await this.drafts.runOf(params.id, params.runId))) {
      throw new ApiError("run.not_found", "Run not found");
    }
    const live = await this.drafts.live(params.id, params.runId);
    return { drafts: live.map(({ step, text, thinking }) => ({ step, text, thinking })) };
  }

  @Get(":id/stream")
  @OrgAction("agents.use")
  async stream(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZQuery(ConversationStreamQueryDto) q: z.infer<typeof StreamQuery>,
    @Headers("last-event-id") lastEventId: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const afterSeq = lastEventId !== undefined ? parseLastEventId(lastEventId) : q.after;
    const res = reply.raw;
    // 到这里为止的错误（不可见、订阅失败）尚未写响应，由错误过滤器按普通错误返回。
    const handle = await this.streams.open(
      {
        orgId: org.orgId,
        conversationId: id,
        viewerAccountId: p.account.id,
        afterSeq,
        // 个人令牌要保留明文以便复核时重新 authenticate（只在本连接的闭包里，不落日志）
        credential: credentialCheck(p, BEARER_RE.exec(req.headers.authorization ?? "")?.[1], {
          sessions: this.sessions,
          tokens: this.tokens,
        }),
      },
      {
        write: (chunk) => {
          res.write(chunk);
        },
        backlog: () => res.writableLength,
        end: () => {
          res.end();
        },
        abort: () => {
          res.destroy();
        },
      },
    );
    reply.hijack();
    // 可见性已通过：不阻塞地 ensureRun（清理孤儿运行、投递等待中的消息），见 ConversationsService.kickRun。
    this.conversations.kickRun(id);
    res.on("close", () => handle.close());
    // 订阅期间客户端已断开：close 事件可能已经错过
    if (res.destroyed || !res.socket || res.socket.destroyed) {
      handle.close();
      res.destroy();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.flushHeaders();
    handle.begin();
  }
}
