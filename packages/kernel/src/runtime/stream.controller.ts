import {
  Controller,
  Get,
  Headers,
  Inject,
  type OnModuleDestroy,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { API_TOKENS, CONVERSATION_STREAMS, SESSIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { ApiTokenService } from "../identity/api-tokens.js";
import { credentialCheck } from "../identity/credential-check.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import type { SessionService } from "../identity/sessions.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { ConversationStreams } from "./stream.js";

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

/**
 * 会话事件流（SSE）：`GET /api/v1/orgs/:orgId/conversations/:id/stream?after=<seq>`，`agents.use`，只有会话所有者可用。
 * - 先订阅会话频道、再回放 `after`（或优先的 `Last-Event-ID`）之后的事件：`id: <seq>` / `event: event`；
 *   之后收到 `events` 通知就补读新事件（按 seq 去重），收到增量就发 `event: delta`；
 * - 每 `runtime.sseHeartbeatMs` 发 `: ping` 注释；每 `runtime.sseRecheckMs` 复核凭据（会话未吊销 / 令牌仍有效，
 *   access token 到期本身不算失效）与可见性，失败时发 `event: error`（`data: {"code"}`）后关闭流；
 * - 用 `@Res()` + `reply.hijack()` 直接写原始响应，绕开 Nest / Fastify 的响应处理与缓冲。
 *   代理（Web 层）需透传 `x-accel-buffering: no`、`cache-control: no-cache`。
 */
@Controller("api/v1/orgs/:orgId/conversations")
export class ConversationStreamController implements OnModuleDestroy {
  constructor(
    @Inject(CONVERSATION_STREAMS) private readonly streams: ConversationStreams,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(API_TOKENS) private readonly tokens: ApiTokenService,
  ) {}

  @Get(":id/stream")
  @OrgAction("agents.use")
  async stream(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Query(new ZodPipe(StreamQuery)) q: z.infer<typeof StreamQuery>,
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

  /** 停机：关闭本进程的全部流，否则 HTTP 关闭要等到这些长连接超时。 */
  onModuleDestroy(): void {
    this.streams.closeAll();
  }
}
