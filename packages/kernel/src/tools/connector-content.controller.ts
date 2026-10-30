import { Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  ConnectorContent,
  type ConnectorPromptView,
  type ConnectorResourceView,
  type ConnectorUnavailable,
} from "./connector-content.js";

const PromptBody = z
  .object({
    arguments: z
      .record(z.string().min(1).max(200), z.string().max(10_000))
      .refine((v) => Object.keys(v).length <= 50, { message: "Too many arguments" })
      .default({}),
  })
  .strict();

const ResourcesQuery = z.object({ query: z.string().max(200).optional() });

class ConnectorPromptBody extends createZodDto(PromptBody, "ConnectorPromptBody") {}
class ConnectorResourcesQuery extends createZodDto(ResourcesQuery, "ConnectorResourcesQuery") {}

/**
 * 连接器内容（`/api/v1/orgs/:orgId/connectors/...`）：网页输入框的 `/` 斜杠命令（prompts）与 `@` 资源引用。
 * 都是 `connectors.use`、仅限用户主体，以发起人自己的凭据访问连接器（个人连接器须已连接）。
 * 静态路径 `prompts` / `resources` 优先于 ConnectorsController 的 `:connectorId`。
 */
@Controller("api/v1/orgs/:orgId/connectors")
export class ConnectorContentController {
  constructor(@Inject(ConnectorContent) private readonly content: ConnectorContent) {}

  /** 发起人可用的提示模板；缺凭据 / 连不上的连接器列在 `unavailable`。 */
  @Get("prompts")
  @OrgAction("connectors.use")
  async prompts(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ prompts: ConnectorPromptView[]; unavailable: ConnectorUnavailable[] }> {
    const p = requireUser(principal);
    return this.content.listPrompts(org.orgId, p.account.id);
  }

  /** 发起人可用的资源，`query` 按名称 / URI / 描述子串过滤。 */
  @Get("resources")
  @OrgAction("connectors.use")
  async resources(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(ConnectorResourcesQuery) q: z.infer<typeof ResourcesQuery>,
  ): Promise<{ resources: ConnectorResourceView[]; unavailable: ConnectorUnavailable[] }> {
    const p = requireUser(principal);
    return this.content.listResources(org.orgId, p.account.id, q.query);
  }

  /** 按参数渲染一个提示模板为文本（放进输入框，由用户发送）。 */
  @Post(":connectorId/prompts/:name")
  @HttpCode(200)
  @OrgAction("connectors.use")
  async renderPrompt(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
    @Param("name") name: string,
    @ZBody(ConnectorPromptBody) body: z.infer<typeof PromptBody>,
  ): Promise<{ text: string }> {
    const p = requireUser(principal);
    return this.content.getPrompt(org.orgId, connectorId, name, body.arguments, p.account.id);
  }
}
