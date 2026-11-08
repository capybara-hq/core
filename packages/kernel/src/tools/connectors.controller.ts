import { ConnectorAuthSchema } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { orgIconScope, PluginIcons } from "../extensions/plugin-icons.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { can } from "../orgs/roles.js";
import {
  ConnectorAccountPolicies,
  type MemberToolPolicyView,
} from "./connector-account-policies.js";
import { CredentialValue, MemberToolPoliciesBody } from "./connectors.schemas.js";
import {
  type ConnectorDetail,
  type ConnectorPreview,
  type ConnectorSummary,
  ConnectorsService,
  type ToolIssue,
} from "./connectors.service.js";
import { publicEndpoint } from "./endpoint.js";

/**
 * 没有 `connectors.manage` 的读者只看到端点的公开部分（URL 不带 query、只有头名，见 endpoint.ts），
 * 也看不到工具的连接器数据（可能含服务器地址）。
 */
function forViewer<T extends ConnectorSummary>(org: OrgContext, c: T): T {
  if (can(org.role, "connectors.manage")) return c;
  const view: T = { ...c, endpoint: publicEndpoint(c.endpoint) };
  if ("tools" in view) {
    (view as unknown as ConnectorDetail).tools = (view as unknown as ConnectorDetail).tools.map(
      (t) => ({
        ...t,
        connectorData: null,
        pending: t.pending && { ...t.pending, connectorData: null },
      }),
    );
  }
  return view;
}

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().max(24).optional(),
    connector: z.string().min(1).max(100),
    endpoint: z.record(z.string(), z.unknown()),
    auth: ConnectorAuthSchema,
    credential: CredentialValue.optional(),
  })
  .strict();

/** 预览（Ruling A20）：与创建相同的连接器 / 端点 / 认证 / 凭据，认证可缺省（只读端点描述，不列工具）。 */
const PreviewBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().max(24).optional(),
    connector: z.string().min(1).max(100),
    endpoint: z.record(z.string(), z.unknown()),
    auth: ConnectorAuthSchema.optional(),
    credential: CredentialValue.optional(),
  })
  .strict();

const ToolPatch = z
  .object({
    status: z.enum(["enabled", "disabled"]).optional(),
    defaultPolicy: z.enum(["allow", "ask", "deny"]).optional(),
  })
  .strict();

const ReviewBody = z.object({ action: z.enum(["approve", "reject"]) }).strict();

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    tools: z
      .record(z.string().max(200), ToolPatch)
      .refine((v) => Object.keys(v).length <= 1000, { message: "Too many tools" })
      .optional(),
    allowUnannotated: z.boolean().optional(),
  })
  .strict();

class ConnectorCreateBody extends createZodDto(CreateBody, "ConnectorCreateBody") {}
class ConnectorPreviewBody extends createZodDto(PreviewBody, "ConnectorPreviewBody") {}
class ConnectorUpdateBody extends createZodDto(UpdateBody, "ConnectorUpdateBody") {}
class ConnectorToolReviewBody extends createZodDto(ReviewBody, "ConnectorToolReviewBody") {}
class ConnectorCredentialBody extends createZodDto(CredentialValue, "ConnectorCredentialBody") {}
class MemberToolPoliciesDto extends createZodDto(
  MemberToolPoliciesBody,
  "MemberToolPoliciesBody",
) {}

/**
 * 连接器（`/api/v1/orgs/:orgId/connectors`）：读与个人凭据用 `connectors.use`（访客起），安装 / 修改 / 删除 / 刷新 /
 * 组织凭据用 `connectors.manage`（管理员起）；两者都仅限用户主体。
 */
@Controller("api/v1/orgs/:orgId/connectors")
export class ConnectorsController {
  constructor(
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
    @Inject(ConnectorAccountPolicies) private readonly memberPolicies: ConnectorAccountPolicies,
  ) {}

  /**
   * Each connector with `icon`: the icon of the plugin its template came from, on the org's catalog
   * route (null for a custom connector, a plugin without an icon, or one the reader's catalog does
   * not show: the share gate holds; maintainer decision 2026-11-09).
   */
  private async withIcons<T extends ConnectorSummary>(
    org: OrgContext,
    rows: T[],
  ): Promise<(T & { icon: string | null })[]> {
    const ids = rows.flatMap((r) => (r.catalogItemId === null ? [] : [r.catalogItemId]));
    const urls = await this.icons.ofItems(ids, orgIconScope(org));
    return rows.map((r) => ({
      ...r,
      icon: r.catalogItemId === null ? null : (urls.get(r.catalogItemId) ?? null),
    }));
  }

  @Get()
  @OrgAction("connectors.use")
  async list(
    @CurrentOrg() org: OrgContext,
  ): Promise<{ connectors: (ConnectorSummary & { icon: string | null })[] }> {
    const rows = (await this.connectors.list(org.orgId)).map((a) => forViewer(org, a));
    return { connectors: await this.withIcons(org, rows) };
  }

  /**
   * The connector kinds the org can create connectors of, each with the plugin providing it (the
   * install wizard offers only these; an empty list means no connector extension is enabled).
   */
  @Get("kinds")
  @OrgAction("connectors.manage")
  async kinds(
    @CurrentOrg() org: OrgContext,
  ): Promise<{ kinds: { kind: string; plugin: string }[] }> {
    return { kinds: await this.connectors.kinds(org.orgId) };
  }

  @Post()
  @OrgAction("connectors.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(ConnectorCreateBody) body: z.infer<typeof CreateBody>,
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[] }> {
    const p = requireUser(principal);
    return this.connectors.create(org.orgId, p.account.id, body, patTokenId(p));
  }

  /**
   * 预览（安装向导）：读端点描述（认证提示、操作清单）并在能认证时列出工具，什么都不写。
   * 创建与预览的请求体可带最大 2 MB 的 OpenAPI 文档，路由级 bodyLimit 见 http/app.ts。
   */
  @Post("preview")
  @HttpCode(200)
  @OrgAction("connectors.manage")
  async preview(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(ConnectorPreviewBody) body: z.infer<typeof PreviewBody>,
  ): Promise<ConnectorPreview> {
    requireUser(principal);
    return this.connectors.preview(org.orgId, body);
  }

  @Get(":connectorId")
  @OrgAction("connectors.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
  ): Promise<{ connector: ConnectorDetail & { icon: string | null } }> {
    const p = requireUser(principal);
    const c = forViewer(org, await this.connectors.get(org.orgId, connectorId, p.account.id));
    const [connector] = await this.withIcons(org, [c]);
    return { connector: connector as ConnectorDetail & { icon: string | null } };
  }

  @Patch(":connectorId")
  @OrgAction("connectors.manage")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
    @ZBody(ConnectorUpdateBody) body: z.infer<typeof UpdateBody>,
  ): Promise<{ connector: ConnectorDetail }> {
    const p = requireUser(principal);
    return {
      connector: await this.connectors.update(
        org.orgId,
        connectorId,
        p.account.id,
        body,
        patTokenId(p),
      ),
    };
  }

  @Delete(":connectorId")
  @HttpCode(204)
  @OrgAction("connectors.manage")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.connectors.remove(org.orgId, connectorId, p.account.id, patTokenId(p));
  }

  @Post(":connectorId/refresh")
  @HttpCode(200)
  @OrgAction("connectors.manage")
  async refresh(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
  ): Promise<{
    connector: ConnectorDetail;
    issues: ToolIssue[];
    changes: { added: string[]; removed: string[]; changed: string[] };
  }> {
    const p = requireUser(principal);
    return this.connectors.refresh(org.orgId, connectorId, p.account.id, patTokenId(p));
  }

  /** 复核待复核的工具（漂移检测，spec 7.3）：approve 采用新定义并启用，reject 停用并保留旧定义。 */
  @Post(":connectorId/tools/:name/review")
  @HttpCode(200)
  @OrgAction("connectors.manage")
  async review(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
    @Param("name") name: string,
    @ZBody(ConnectorToolReviewBody) body: z.infer<typeof ReviewBody>,
  ): Promise<{ connector: ConnectorDetail }> {
    const p = requireUser(principal);
    return {
      connector: await this.connectors.reviewTool(
        org.orgId,
        connectorId,
        name,
        body.action,
        p.account.id,
        patTokenId(p),
      ),
    };
  }

  @Put(":connectorId/credentials/org")
  @HttpCode(204)
  @OrgAction("connectors.manage")
  async setOrgCredential(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
    @ZBody(ConnectorCredentialBody) body: z.infer<typeof CredentialValue>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.connectors.setCredential(
      org.orgId,
      connectorId,
      p.account.id,
      "org",
      body,
      patTokenId(p),
    );
  }

  @Put(":connectorId/credentials/me")
  @HttpCode(204)
  @OrgAction("connectors.use")
  async setMyCredential(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
    @ZBody(ConnectorCredentialBody) body: z.infer<typeof CredentialValue>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.connectors.setCredential(
      org.orgId,
      connectorId,
      p.account.id,
      "personal",
      body,
      patTokenId(p),
    );
  }

  /**
   * The caller's own tool policies for their own connection of a personal-credential connector
   * (the card's 权限, decision 2026-11-09): each tool with the org default, the annotation default,
   * the caller's setting and whether the org locked it. Only ever the caller's rows. A connector
   * with one org credential -> 409 `connector.not_personal`.
   */
  @Get(":connectorId/tool-policies/me")
  @OrgAction("connectors.use")
  async myToolPolicies(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
  ): Promise<{ tools: MemberToolPolicyView[] }> {
    const p = requireUser(principal);
    return { tools: await this.memberPolicies.read(org.orgId, connectorId, p.account.id) };
  }

  /**
   * Sets (`allow` / `ask` / `deny`) or clears (null) the caller's own policies for some tools:
   * `{ tools: { <name>: policy | null } }` -> the sheet again. Unknown tool -> 404
   * `connector.tool_not_found`.
   */
  @Put(":connectorId/tool-policies/me")
  @OrgAction("connectors.use")
  async setMyToolPolicies(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
    @ZBody(MemberToolPoliciesDto) body: z.infer<typeof MemberToolPoliciesBody>,
  ): Promise<{ tools: MemberToolPolicyView[] }> {
    const p = requireUser(principal);
    await this.memberPolicies.set(org.orgId, connectorId, p.account.id, body.tools, patTokenId(p));
    return { tools: await this.memberPolicies.read(org.orgId, connectorId, p.account.id) };
  }

  @Delete(":connectorId/credentials/me")
  @HttpCode(204)
  @OrgAction("connectors.use")
  async clearMyCredential(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.connectors.clearMyCredential(org.orgId, connectorId, p.account.id, patTokenId(p));
  }
}
