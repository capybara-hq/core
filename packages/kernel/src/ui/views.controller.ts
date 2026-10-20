import type { UiActionResult, UiView } from "@capybara-hq/plugin-sdk";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  type OnModuleDestroy,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { API_TOKENS, ORG_UI_STREAMS, SESSIONS, UI_VIEWS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { ApiTokenService } from "../identity/api-tokens.js";
import { credentialCheck } from "../identity/credential-check.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import type { SessionService } from "../identity/sessions.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { OrgUiStreams } from "./ui-stream.js";
import type { UiContributionItem, UiViews } from "./views.js";

const BEARER_RE = /^Bearer\s+(\S+)$/i;

const Locale = z.enum(["zh", "en"]).default("en");
const Id = z.string().min(1).max(100);

const ViewQuery = z.object({
  conversationId: z.string().min(1).max(100).optional(),
  locale: Locale,
});

/** 表单答案（plugin-sdk 的 `FormAnswer`）。 */
const FormAnswerSchema = z.record(
  z.string().max(100),
  z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(10_000))]),
);

const ActionBody = z.object({
  actionId: z.string().min(1).max(200),
  payload: z.unknown().optional(),
  answer: FormAnswerSchema.optional(),
  conversationId: z.string().min(1).max(100).optional(),
  locale: Locale,
});

/**
 * 插件界面（第一档：渲染 schema），会话鉴权、`ui.use`（只给人用，服务令牌 403）：
 * - `GET  /api/v1/orgs/:orgId/ui/contributions` → `{ items: { plugin, id, title, place, kind }[] }`；
 * - `GET  /api/v1/orgs/:orgId/ui/views/:plugin/:id?conversationId=&locale=` → `{ view }`；
 * - `POST /api/v1/orgs/:orgId/ui/actions/:plugin/:id`（`{ actionId, payload?, answer?, conversationId?, locale? }`）
 *   → `{ toast }` | `{ view }`；
 * - `GET  /api/v1/orgs/:orgId/ui/stream`：组织级刷新 SSE（`event: ui`，`data: {"plugin","contribution"}`）。
 * 对话视图的刷新走现有的会话流 `/conversations/:id/stream`。
 */
@Controller("api/v1/orgs/:orgId/ui")
export class UiController implements OnModuleDestroy {
  constructor(
    @Inject(UI_VIEWS) private readonly views: UiViews,
    @Inject(ORG_UI_STREAMS) private readonly streams: OrgUiStreams,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(API_TOKENS) private readonly tokens: ApiTokenService,
  ) {}

  @Get("contributions")
  @OrgAction("ui.use")
  async contributions(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ items: UiContributionItem[] }> {
    requireUser(principal);
    return { items: await this.views.contributions(org.orgId) };
  }

  @Get("views/:plugin/:id")
  @OrgAction("ui.use")
  async view(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("plugin", new ZodPipe(Id)) plugin: string,
    @Param("id", new ZodPipe(Id)) id: string,
    @Query(new ZodPipe(ViewQuery)) q: z.infer<typeof ViewQuery>,
  ): Promise<{ view: UiView }> {
    const p = requireUser(principal);
    const view = await this.views.render({
      orgId: org.orgId,
      accountId: p.account.id,
      plugin,
      id,
      ...(q.conversationId !== undefined && { conversationId: q.conversationId }),
      locale: q.locale,
    });
    return { view };
  }

  @Post("actions/:plugin/:id")
  @HttpCode(200)
  @OrgAction("ui.use")
  async action(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("plugin", new ZodPipe(Id)) plugin: string,
    @Param("id", new ZodPipe(Id)) id: string,
    @Body(new ZodPipe(ActionBody)) body: z.infer<typeof ActionBody>,
  ): Promise<UiActionResult> {
    const p = requireUser(principal);
    return this.views.act(
      {
        orgId: org.orgId,
        accountId: p.account.id,
        plugin,
        id,
        ...(body.conversationId !== undefined && { conversationId: body.conversationId }),
        locale: body.locale,
      },
      {
        actionId: body.actionId,
        ...(body.payload !== undefined && { payload: body.payload }),
        ...(body.answer !== undefined && { answer: body.answer }),
      },
    );
  }

  /** 组织级刷新流：与会话流一样用 `reply.hijack()` 直接写原始响应；心跳与复核间隔同 `runtime.sse*`。 */
  @Get("stream")
  @OrgAction("ui.use")
  async stream(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const res = reply.raw;
    const handle = await this.streams.open(
      {
        orgId: org.orgId,
        viewerAccountId: p.account.id,
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

  /** 停机：关闭本进程的全部组织刷新流。 */
  onModuleDestroy(): void {
    this.streams.closeAll();
  }
}
