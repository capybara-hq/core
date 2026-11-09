import type { UiActionResult, UiView } from "@capybara-hq/plugin-sdk";
import { Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { ApiTokenService } from "../identity/api-tokens.js";
import { credentialCheck } from "../identity/credential-check.js";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { SessionService } from "../identity/sessions.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { EMBED_TOKEN_TTL_SECONDS, EmbedTokens } from "./embed-token.js";
import { ContributionParams, PlatformActionBody, PlatformViewQuery } from "./ui.schemas.js";
import { OrgUiStreams } from "./ui-stream.js";
import { BEARER_RE, embedSrc } from "./views.controller.js";
import { type UiArrangementSlot, type UiContributionItem, UiViews } from "./views.js";

class AdminUiContributionParamsDto extends createZodDto(
  ContributionParams,
  "AdminUiContributionParams",
) {}
class AdminUiViewQueryDto extends createZodDto(PlatformViewQuery, "AdminUiViewQuery") {}
class AdminUiActionBodyDto extends createZodDto(PlatformActionBody, "AdminUiActionBody") {}

/**
 * Extension UI in the admin console (UI slots spec §7, platform scope): the `platform.page`
 * contributions, for super admins only (`@SuperAdmin`, a person: service tokens are refused), with
 * no org. A platform contribution needs its extension running (no org enablement applies) and is
 * given the platform's deployment config; its render args carry `scope: "platform"`, `role:
 * "superAdmin"` and no `orgId`.
 * - `GET  /api/v1/admin/ui/contributions` → `{ items }` (`platform.page` only, base order);
 * - `GET  /api/v1/admin/ui/arrangement` → `{ slots }` over every arrangeable slot, the platform's
 *   entries only, with every running extension's contributions (hidden ones marked);
 * - `GET  /api/v1/admin/ui/views/:plugin/:id?locale=` → `{ view }`;
 * - `POST /api/v1/admin/ui/actions/:plugin/:id` (`{ actionId, payload?, answer?, locale? }`) →
 *   `{ toast }` | `{ view }`;
 * - `POST /api/v1/admin/ui/embeds/:plugin/:id/token` → `{ token, src, expiresAt, expiresIn }`: a
 *   platform embed token (`scope: "platform"`, `role: "superAdmin"`, no `orgId`), which
 *   `ctx.ui.verifyEmbedToken` accepts only for a `platform.page` contribution while the account is
 *   still an active super admin;
 * - `GET  /api/v1/admin/ui/stream`: the platform refresh SSE (`event: ui`, topic `platform-ui`),
 *   super admin re-checked on the `runtime.sseRecheckMs` interval.
 * A contribution in any other slot is 404 `ui.not_found`, the same as one that does not exist.
 */
@Controller("api/v1/admin/ui")
@SuperAdmin()
export class AdminUiController {
  constructor(
    @Inject(UiViews) private readonly views: UiViews,
    @Inject(OrgUiStreams) private readonly streams: OrgUiStreams,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ApiTokenService) private readonly tokens: ApiTokenService,
    @Inject(EmbedTokens) private readonly embeds: EmbedTokens,
  ) {}

  @Get("contributions")
  async contributions(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ items: UiContributionItem[] }> {
    requireUser(principal);
    return { items: await this.views.platformContributions() };
  }

  @Get("arrangement")
  async arrangement(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ slots: UiArrangementSlot[] }> {
    requireUser(principal);
    return { slots: await this.views.platformArrangementView() };
  }

  @Get("views/:plugin/:id")
  async view(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminUiContributionParamsDto) { plugin, id }: z.infer<typeof ContributionParams>,
    @ZQuery(AdminUiViewQueryDto) q: z.infer<typeof PlatformViewQuery>,
  ): Promise<{ view: UiView }> {
    const p = requireUser(principal);
    const view = await this.views.render({
      scope: "platform",
      accountId: p.account.id,
      plugin,
      id,
      locale: q.locale,
    });
    return { view };
  }

  @Post("actions/:plugin/:id")
  @HttpCode(200)
  async action(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminUiContributionParamsDto) { plugin, id }: z.infer<typeof ContributionParams>,
    @ZBody(AdminUiActionBodyDto) body: z.infer<typeof PlatformActionBody>,
  ): Promise<UiActionResult> {
    const p = requireUser(principal);
    return this.views.act(
      { scope: "platform", accountId: p.account.id, plugin, id, locale: body.locale },
      {
        actionId: body.actionId,
        ...(body.payload !== undefined && { payload: body.payload }),
        ...(body.answer !== undefined && { answer: body.answer }),
      },
    );
  }

  @Post("embeds/:plugin/:id/token")
  @HttpCode(200)
  async embedToken(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminUiContributionParamsDto) { plugin, id }: z.infer<typeof ContributionParams>,
  ): Promise<{ token: string; src: string; expiresAt: string; expiresIn: number }> {
    const p = requireUser(principal);
    const target = await this.views.embed({
      scope: "platform",
      accountId: p.account.id,
      plugin,
      id,
    });
    const { token, expiresAt } = this.embeds.issue({
      plugin: target.plugin,
      scope: "platform",
      accountId: p.account.id,
      role: "superAdmin",
      contribution: target.contribution,
    });
    return {
      token,
      src: embedSrc(target.plugin, target.path),
      expiresAt: expiresAt.toISOString(),
      expiresIn: EMBED_TOKEN_TTL_SECONDS,
    };
  }

  /** The platform refresh stream: written on the raw response (`reply.hijack()`) like the org one. */
  @Get("stream")
  async stream(
    @CurrentPrincipal() principal: Principal,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const res = reply.raw;
    const handle = await this.streams.open(
      {
        scope: "platform",
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
