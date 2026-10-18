import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { APP_CONTENT } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { AppContent, AppPromptView, AppResourceView, AppUnavailable } from "./app-content.js";

const PromptBody = z
  .object({
    arguments: z
      .record(z.string().min(1).max(200), z.string().max(10_000))
      .refine((v) => Object.keys(v).length <= 50, { message: "Too many arguments" })
      .default({}),
  })
  .strict();

const ResourcesQuery = z.object({ query: z.string().max(200).optional() });

/**
 * 应用内容（`/api/v1/orgs/:orgId/apps/...`）：网页输入框的 `/` 斜杠命令（prompts）与 `@` 资源引用。
 * 都是 `apps.use`、仅限用户主体，以发起人自己的凭据访问应用（个人应用须已连接）。
 * 静态路径 `prompts` / `resources` 优先于 AppsController 的 `:appId`。
 */
@Controller("api/v1/orgs/:orgId/apps")
export class AppContentController {
  constructor(@Inject(APP_CONTENT) private readonly content: AppContent) {}

  /** 发起人可用的提示模板；缺凭据 / 连不上的应用列在 `unavailable`。 */
  @Get("prompts")
  @OrgAction("apps.use")
  async prompts(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ prompts: AppPromptView[]; unavailable: AppUnavailable[] }> {
    const p = requireUser(principal);
    return this.content.listPrompts(org.orgId, p.account.id);
  }

  /** 发起人可用的资源，`query` 按名称 / URI / 描述子串过滤。 */
  @Get("resources")
  @OrgAction("apps.use")
  async resources(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Query(new ZodPipe(ResourcesQuery)) q: z.infer<typeof ResourcesQuery>,
  ): Promise<{ resources: AppResourceView[]; unavailable: AppUnavailable[] }> {
    const p = requireUser(principal);
    return this.content.listResources(org.orgId, p.account.id, q.query);
  }

  /** 按参数渲染一个提示模板为文本（放进输入框，由用户发送）。 */
  @Post(":appId/prompts/:name")
  @HttpCode(200)
  @OrgAction("apps.use")
  async renderPrompt(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
    @Param("name") name: string,
    @Body(new ZodPipe(PromptBody)) body: z.infer<typeof PromptBody>,
  ): Promise<{ text: string }> {
    const p = requireUser(principal);
    return this.content.getPrompt(org.orgId, appId, name, body.arguments, p.account.id);
  }
}
