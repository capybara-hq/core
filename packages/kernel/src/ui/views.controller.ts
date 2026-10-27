import { UI_LIMITS, type UiActionResult, type UiView } from "@capybara-hq/plugin-sdk";
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
import { API_TOKENS, EMBED_TOKENS, ORG_UI_STREAMS, SESSIONS, UI_VIEWS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { ApiTokenService } from "../identity/api-tokens.js";
import { credentialCheck } from "../identity/credential-check.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import type { SessionService } from "../identity/sessions.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { EMBED_TOKEN_TTL_SECONDS, type EmbedTokens } from "./embed-token.js";
import type { OrgUiStreams } from "./ui-stream.js";
import type { UiContributionItem, UiViews } from "./views.js";

const BEARER_RE = /^Bearer\s+(\S+)$/i;

const Locale = z.enum(["zh", "en"]).default("en");
const Id = z.string().min(1).max(100);

const ViewQuery = z
  .object({
    conversationId: z.string().min(1).max(100).optional(),
    locale: Locale,
    /** A panel opened from an open target: the item to scroll to. */
    item: z.string().min(1).max(200).optional(),
    /** An inline card: the tool call it hangs off, and its `ToolResult.card.key`. */
    callId: z.string().min(1).max(200).optional(),
    key: z.string().min(1).max(200).optional(),
  })
  .refine((q) => q.key === undefined || q.callId !== undefined, {
    message: "key needs callId",
  });

/**
 * 表单答案（plugin-sdk 的 `FormAnswer`）。SDK 的 InputForm 没有单独的字段数 / 选项数上限，
 * 这里沿用视图的上限：键数与多选数组长度 ≤ `UI_LIMITS.tableRows`，单个文本 ≤ `UI_LIMITS.textChars`。
 */
const AnswerText = z.string().max(UI_LIMITS.textChars);
const FormAnswerSchema = z
  .record(
    z.string().max(100),
    z.union([AnswerText, z.number(), z.boolean(), z.array(AnswerText).max(UI_LIMITS.tableRows)]),
  )
  .refine((a) => Object.keys(a).length <= UI_LIMITS.tableRows, {
    message: `answer must have at most ${UI_LIMITS.tableRows} fields`,
  });

/** 按钮 payload 的 JSON 序列化后 UTF-8 字节数（与 `validateUiView` 对按钮 payload 的上限一致）。 */
const payloadBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

const ActionBody = z.object({
  actionId: z.string().min(1).max(200),
  payload: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || payloadBytes(v) <= UI_LIMITS.payloadBytes, {
      message: `payload must be at most ${UI_LIMITS.payloadBytes} bytes as JSON`,
    }),
  answer: FormAnswerSchema.optional(),
  conversationId: z.string().min(1).max(100).optional(),
  locale: Locale,
});

const EmbedTokenBody = z
  .object({
    conversationId: z.string().min(1).max(100).optional(),
    /** Only a `file-preview` embed: the file version it previews. */
    fileId: z.uuid().optional(),
  })
  .default({});

/** 嵌入页的同源代理前缀（网页 `/plugin-ui/<plugin>/<rest>` → 内核 `/plugins/<plugin>/ui/<rest>`）。 */
const embedSrc = (plugin: string, path: string) =>
  `/plugin-ui/${plugin}/${path.replace(/^\/ui\//, "")}`;

/**
 * 插件界面（第一档：渲染 schema；第二档：嵌入应用），会话鉴权、`ui.use`（只给人用，服务令牌 403）：
 * - `GET  /api/v1/orgs/:orgId/ui/contributions` → `{ items: { plugin, id, title, place, legacyPlace?, kind, path?, icon }[] }`
 *   (place normalized: the old `conversation` is `panel` with `legacyPlace`; aliases and file-preview
 *   embeds are not listed)
 *   （`path` 仅 embed）；
 * - `GET  /api/v1/orgs/:orgId/ui/views/:plugin/:id?conversationId=&locale=&item=&callId=&key=` → `{ view }`
 *   （`item`: the panel item to scroll to; `callId` / `key`: an inline card's tool call）；
 * - `POST /api/v1/orgs/:orgId/ui/actions/:plugin/:id`（`{ actionId, payload?, answer?, conversationId?, locale? }`）
 *   → `{ toast }` | `{ view }`；
 * - `GET  /api/v1/orgs/:orgId/ui/stream`：组织级刷新 SSE（`event: ui`，`data: {"plugin","contribution"}`）；
 * - `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token`（`{ conversationId? }`）
 *   → `{ token, src: "/plugin-ui/<plugin>/<path 去掉 /ui/>", expiresAt, expiresIn }`：嵌入令牌
 *   （300 秒，`expiresIn` 为秒数，见 `embed-token.ts`）。
 *   插件须在组织启用、贡献须是 embed；对话嵌入要求能访问该对话（否则 404）。令牌只给插件路由用，
 *   内核鉴权守卫不认它（它不是 API 令牌）。
 * 对话视图的刷新走现有的会话流 `/conversations/:id/stream`。
 * 角色（A38）：组织页面（`place: "page"`，含组织级刷新流）只给 member 以上，guest 一律 404 `ui.not_found`、
 * 列表里也不出现；对话位置的贡献给能访问该对话的任何成员。插件收到的 `role` 来自 OrgGuard 查出的成员关系。
 */
@Controller("api/v1/orgs/:orgId/ui")
export class UiController implements OnModuleDestroy {
  constructor(
    @Inject(UI_VIEWS) private readonly views: UiViews,
    @Inject(ORG_UI_STREAMS) private readonly streams: OrgUiStreams,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(API_TOKENS) private readonly tokens: ApiTokenService,
    @Inject(EMBED_TOKENS) private readonly embeds: EmbedTokens,
  ) {}

  @Get("contributions")
  @OrgAction("ui.use")
  async contributions(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ items: UiContributionItem[] }> {
    requireUser(principal);
    return { items: await this.views.contributions(org.orgId, org.role) };
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
      role: org.role,
      plugin,
      id,
      ...(q.conversationId !== undefined && { conversationId: q.conversationId }),
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
    @Param("plugin", new ZodPipe(Id)) plugin: string,
    @Param("id", new ZodPipe(Id)) id: string,
    @Body(new ZodPipe(ActionBody)) body: z.infer<typeof ActionBody>,
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
    @Param("plugin", new ZodPipe(Id)) plugin: string,
    @Param("id", new ZodPipe(Id)) id: string,
    @Body(new ZodPipe(EmbedTokenBody)) body: z.infer<typeof EmbedTokenBody>,
  ): Promise<{ token: string; src: string; expiresAt: string; expiresIn: number }> {
    const p = requireUser(principal);
    const target = await this.views.embed({
      orgId: org.orgId,
      accountId: p.account.id,
      role: org.role,
      plugin,
      id,
      ...(body.conversationId !== undefined && { conversationId: body.conversationId }),
      ...(body.fileId !== undefined && { fileId: body.fileId }),
    });
    const { token, expiresAt } = this.embeds.issue({
      plugin: target.plugin,
      orgId: org.orgId,
      accountId: p.account.id,
      role: org.role,
      ...(target.conversationId !== undefined && { conversationId: target.conversationId }),
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

  /** 停机：关闭本进程的全部组织刷新流。 */
  onModuleDestroy(): void {
    this.streams.closeAll();
  }
}
