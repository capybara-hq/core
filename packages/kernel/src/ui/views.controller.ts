import type { JsonValue, UiActionResult, UiView } from "@capybara-hq/plugin-sdk";
import { Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { ApiError } from "../errors.js";
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
  QueryBody,
  ViewQuery,
} from "./ui.schemas.js";
import { OrgUiStreams } from "./ui-stream.js";
import { type UiArrangementSlot, type UiContributionItem, UiViews } from "./views.js";

export const BEARER_RE = /^Bearer\s+(\S+)$/i;

/** 嵌入页的同源代理前缀（网页 `/plugin-ui/<plugin>/<rest>` → 内核 `/plugins/<plugin>/ui/<rest>`）。 */
export const embedSrc = (plugin: string, path: string) =>
  `/plugin-ui/${plugin}/${path.replace(/^\/ui\//, "")}`;

class UiContributionsQueryDto extends createZodDto(ContributionsQuery, "UiContributionsQuery") {}
class UiContributionParamsDto extends createZodDto(ContributionParams, "UiContributionParams") {}
class UiViewQueryDto extends createZodDto(ViewQuery, "UiViewQuery") {}
class UiActionBodyDto extends createZodDto(ActionBody, "UiActionBody") {}
class UiQueryBodyDto extends createZodDto(QueryBody, "UiQueryBody") {}
class UiEmbedTokenBodyDto extends createZodDto(EmbedTokenBody, "UiEmbedTokenBody") {}

/**
 * 插件界面（第一档：渲染 schema；第二档：嵌入应用），会话鉴权、`ui.use`（只给人用，服务令牌 403）：
 * - `GET  /api/v1/orgs/:orgId/ui/contributions?slot=` →
 *   `{ items: { plugin, id, title, slot, after?, kind, path?, icon }[] }`: every org-reachable slot
 *   (all but `platform.page`) or one slot; `after` is the resolved anchor of a slot with anchors,
 *   `path` only for an embed; aliases and `file.preview` contributions are not listed; ordered by
 *   extension name, then manifest order;
 * - `GET  /api/v1/orgs/:orgId/ui/arrangement` → `{ slots: { slot, source, items }[] }`: every
 *   org-arrangeable slot with the contributions the caller's role may use, in effective order, each
 *   marked `hidden` (the listing for the 界面位置 page; the lists above omit hidden ones, the
 *   view / action / embed routes below ignore the arrangement);
 * - `GET  /api/v1/orgs/:orgId/ui/views/:plugin/:id?conversationId=&agentId=&locale=&item=&callId=&key=`
 *   → `{ view }`（`item`: the panel item to scroll to; `callId` / `key`: an inline card's tool call）；
 * - `POST /api/v1/orgs/:orgId/ui/actions/:plugin/:id`
 *   （`{ actionId, payload?, answer?, conversationId?, agentId?, locale? }`）→ `{ toast }` | `{ view }`；
 *   `payload` ≤ `UI_LIMITS.componentActionPayloadBytes` for a component, `payloadBytes` for a view;
 * - `POST /api/v1/orgs/:orgId/ui/query/:plugin/:id` (`{ query, params?, conversationId?, agentId?,
 *   locale? }`) → `{ data }`: a component's named query (`ctx.ui.query`, plugin full pages spec
 *   §4.1), gated like the component's view; 404 `ui.query_not_found`, 413
 *   `ui.query_params_too_large`, 502 `ui.query_failed` / `ui.query_result_too_large`, 504
 *   `ui.query_timeout` (10 s);
 * - `GET  /api/v1/orgs/:orgId/ui/stream`：组织级刷新 SSE（`event: ui`，`data: {"plugin","contribution"}`），
 *   member and above；
 * - `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token` (`{ conversationId?, agentId?, fileId? }`,
 *   `{ fileId }` alone for a library file's previewer, or for a skill file's previewer
 *   `{ skillId, version?, path }`)
 *   → `{ token, src: "/plugin-ui/<plugin>/<path without /ui/>", expiresAt, expiresIn }`: an embed
 *   token (300 seconds, `expiresIn` in seconds, see `embed-token.ts`; `agentId` goes into the
 *   claims, a skill file as `skillFile` with its resolved version). The token is only for the
 *   extension's routes; the kernel's auth guard does not accept it (it is not an API token).
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

  @Get("arrangement")
  @OrgAction("ui.use")
  async arrangement(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ slots: UiArrangementSlot[] }> {
    requireUser(principal);
    return { slots: await this.views.arrangementView(org.orgId, org.role) };
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

  @Post("query/:plugin/:id")
  @HttpCode(200)
  @OrgAction("ui.use")
  async query(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(UiContributionParamsDto) { plugin, id }: z.infer<typeof ContributionParams>,
    @ZBody(UiQueryBodyDto) body: z.infer<typeof QueryBody>,
  ): Promise<{ data: JsonValue }> {
    const p = requireUser(principal);
    return this.views.query(
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
      { query: body.query, ...(body.params !== undefined && { params: body.params }) },
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
    if ((body.skillId === undefined) !== (body.path === undefined)) {
      throw new ApiError("validation_failed", "skillId and path go together");
    }
    if (body.version !== undefined && body.skillId === undefined) {
      throw new ApiError("validation_failed", "version is only allowed with skillId and path");
    }
    const skillFile =
      body.skillId !== undefined && body.path !== undefined
        ? {
            skillId: body.skillId,
            path: body.path,
            ...(body.version !== undefined && { version: body.version }),
          }
        : undefined;
    const target = await this.views.embed({
      orgId: org.orgId,
      accountId: p.account.id,
      role: org.role,
      plugin,
      id,
      ...(body.conversationId !== undefined && { conversationId: body.conversationId }),
      ...(body.agentId !== undefined && { agentId: body.agentId }),
      ...(body.fileId !== undefined && { fileId: body.fileId }),
      ...(skillFile !== undefined && { skillFile }),
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
      ...(target.skillFile !== undefined && { skillFile: target.skillFile }),
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
