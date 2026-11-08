import type { UiActionResult, UiView } from "@capybara-hq/plugin-sdk";
import { Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { ApiTokenService } from "../identity/api-tokens.js";
import { credentialCheck } from "../identity/credential-check.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { SessionService } from "../identity/sessions.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { EMBED_TOKEN_TTL_SECONDS, EmbedTokens } from "./embed-token.js";
import {
  ActionBody,
  ContributionParams,
  ContributionsQuery,
  EmbedTokenBody,
  ViewQuery,
} from "./ui.schemas.js";
import { OrgUiStreams } from "./ui-stream.js";
import { type UiContributionItem, UiViews } from "./views.js";

export const BEARER_RE = /^Bearer\s+(\S+)$/i;

/** 嵌入页的同源代理前缀（网页 `/plugin-ui/<plugin>/<rest>` → 内核 `/plugins/<plugin>/ui/<rest>`）。 */
export const embedSrc = (plugin: string, path: string) =>
  `/plugin-ui/${plugin}/${path.replace(/^\/ui\//, "")}`;

class UiContributionsQueryDto extends createZodDto(ContributionsQuery, "UiContributionsQuery") {}
class UiContributionParamsDto extends createZodDto(ContributionParams, "UiContributionParams") {}
class UiViewQueryDto extends createZodDto(ViewQuery, "UiViewQuery") {}
class UiActionBodyDto extends createZodDto(ActionBody, "UiActionBody") {}
class UiEmbedTokenBodyDto extends createZodDto(EmbedTokenBody, "UiEmbedTokenBody") {}

/**
 * 插件界面（第一档：渲染 schema；第二档：嵌入应用），会话鉴权、`ui.use`（只给人用，服务令牌 403）：
 * - `GET  /api/v1/orgs/:orgId/ui/contributions?slot=` →
 *   `{ items: { plugin, id, title, slot, after?, kind, path?, icon }[] }`: every org-reachable slot
 *   (all but `platform.page`) or one slot; `after` is the resolved anchor of a slot with anchors,
 *   `path` only for an embed; aliases and `file.preview` contributions are not listed; ordered by
 *   extension name, then manifest order;
 * - `GET  /api/v1/orgs/:orgId/ui/views/:plugin/:id?conversationId=&agentId=&locale=&item=&callId=&key=`
 *   → `{ view }`（`item`: the panel item to scroll to; `callId` / `key`: an inline card's tool call）；
 * - `POST /api/v1/orgs/:orgId/ui/actions/:plugin/:id`
 *   （`{ actionId, payload?, answer?, conversationId?, agentId?, locale? }`）→ `{ toast }` | `{ view }`；
 * - `GET  /api/v1/orgs/:orgId/ui/stream`：组织级刷新 SSE（`event: ui`，`data: {"plugin","contribution"}`），
 *   member and above；
 * - `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token`（`{ conversationId?, agentId?, fileId? }`）
 *   → `{ token, src: "/plugin-ui/<plugin>/<path 去掉 /ui/>", expiresAt, expiresIn }`：嵌入令牌
 *   （300 秒，`expiresIn` 为秒数，见 `embed-token.ts`；`agentId` goes into the claims）。
 *   令牌只给插件路由用，内核鉴权守卫不认它（它不是 API 令牌）。
 * 对话视图的刷新走现有的会话流 `/conversations/:id/stream`。
 * Access (UI slots spec §7): every route checks the slot of the contribution it names, its
 * `minRole` (guest for conversation and agent slots, member for `org.page`, admin for
 * `org.settings.section`; `platform.page` never through these routes), then its scope rule
 * (conversation: whoever can read it; agent: whoever can read the agent, in this org; org: the
 * role alone; file: the previewer's read grant). Anything refused is 404 `ui.not_found`, the same
 * as a contribution that does not exist. 插件收到的 `role` 来自 OrgGuard 查出的成员关系。
 */
@Controller("api/v1/orgs/:orgId/ui")
export class UiController {
  constructor(
    @Inject(UiViews) private readonly views: UiViews,
    @Inject(OrgUiStreams) private readonly streams: OrgUiStreams,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ApiTokenService) private readonly tokens: ApiTokenService,
    @Inject(EmbedTokens) private readonly embeds: EmbedTokens,
  ) {}

  @Get("contributions")
  @OrgAction("ui.use")
  async contributions(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(UiContributionsQueryDto) q: z.infer<typeof ContributionsQuery>,
  ): Promise<{ items: UiContributionItem[] }> {
    requireUser(principal);
    return { items: await this.views.contributions(org.orgId, org.role, q.slot) };
  }

  @Get("views/:plugin/:id")
  @OrgAction("ui.use")
  async view(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(UiContributionParamsDto) { plugin, id }: z.infer<typeof ContributionParams>,
    @ZQuery(UiViewQueryDto) q: z.infer<typeof ViewQuery>,
  ): Promise<{ view: UiView }> {
    const p = requireUser(principal);
    const view = await this.views.render({
      orgId: org.orgId,
      accountId: p.account.id,
      role: org.role,
      plugin,
      id,
      ...(q.conversationId !== undefined && { conversationId: q.conversationId }),
      ...(q.agentId !== undefined && { agentId: q.agentId }),
      locale: q.locale,
      ...(q.item !== undefined && { item: q.item }),
      ...(q.callId !== undefined && {
        card: { callId: q.callId, ...(q.key !== undefined && { key: q.key }) },
      }),
    });
    return { view };
  }

  @Post("actions/:plugin/:id")
  @HttpCode(200)
  @OrgAction("ui.use")
  async action(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(UiContributionParamsDto) { plugin, id }: z.infer<typeof ContributionParams>,
    @ZBody(UiActionBodyDto) body: z.infer<typeof ActionBody>,
  ): Promise<UiActionResult> {
    const p = requireUser(principal);
    return this.views.act(
      {
        orgId: org.orgId,
        accountId: p.account.id,
        role: org.role,
        plugin,
        id,
        ...(body.conversationId !== undefined && { conversationId: body.conversationId }),
        ...(body.agentId !== undefined && { agentId: body.agentId }),
        locale: body.locale,
      },
      {
        actionId: body.actionId,
        ...(body.payload !== undefined && { payload: body.payload }),
        ...(body.answer !== undefined && { answer: body.answer }),
      },
    );
  }

  @Post("embeds/:plugin/:id/token")
  @HttpCode(200)
  @OrgAction("ui.use")
  async embedToken(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(UiContributionParamsDto) { plugin, id }: z.infer<typeof ContributionParams>,
    @ZBody(UiEmbedTokenBodyDto) body: z.infer<typeof EmbedTokenBody>,
  ): Promise<{ token: string; src: string; expiresAt: string; expiresIn: number }> {
    const p = requireUser(principal);
    const target = await this.views.embed({
      orgId: org.orgId,
      accountId: p.account.id,
      role: org.role,
      plugin,
      id,
      ...(body.conversationId !== undefined && { conversationId: body.conversationId }),
      ...(body.agentId !== undefined && { agentId: body.agentId }),
      ...(body.fileId !== undefined && { fileId: body.fileId }),
    });
    const { token, expiresAt } = this.embeds.issue({
      plugin: target.plugin,
      scope: "org",
      orgId: org.orgId,
      accountId: p.account.id,
      role: org.role,
      ...(target.conversationId !== undefined && { conversationId: target.conversationId }),
      ...(target.agentId !== undefined && { agentId: target.agentId }),
      ...(target.fileId !== undefined && { fileId: target.fileId }),
      contribution: target.contribution,
    });
    return {
      token,
      src: embedSrc(target.plugin, target.path),
      expiresAt: expiresAt.toISOString(),
      // 网页按收到的时刻加上它安排续期，不比较浏览器时钟与 expiresAt
      expiresIn: EMBED_TOKEN_TTL_SECONDS,
    };
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
}
