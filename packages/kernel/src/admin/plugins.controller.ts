import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { PLUGIN_ADMIN, PLUGIN_INSTALLS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { PluginAdmin } from "../plugins/admin-view.js";
import type { PackageReview, PluginInstalls } from "../plugins/installs.js";
import type { AdminPluginView } from "../plugins/permission-view.js";

const ApproveBody = z.object({
  /** 安装记录的包（审阅时的 sha256）；配置声明的插件为 null。 */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  reviewHash: z.string().regex(/^[0-9a-f]{16}$/),
});

const NpmBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

/**
 * 部署级插件管理（`/api/v1/admin/plugins/*`，企业管理员）：包的导入（上传 / npm，返回审阅结果）、
 * 插件列表与详情、网页批准权限（D8）。安装、启用等改期望状态的接口在 T14。
 */
@Controller("api/v1/admin/plugins")
@EnterpriseAdmin()
export class AdminPluginsController {
  constructor(
    @Inject(PLUGIN_INSTALLS) private readonly installs: PluginInstalls,
    @Inject(PLUGIN_ADMIN) private readonly admin: PluginAdmin,
  ) {}

  /** 部署上的全部插件（内置、配置声明、安装记录）及其状态、权限与快照。 */
  @Get()
  async list(): Promise<{ plugins: AdminPluginView[] }> {
    return { plugins: await this.admin.list() };
  }

  /** 单个插件；不存在 → 404 `plugin.not_found`。 */
  @Get(":name")
  get(@Param("name") name: string): Promise<AdminPluginView> {
    return this.admin.get(name);
  }

  /**
   * 网页批准权限：写快照（source web）、审计 `plugin.permissions_approved`、发布 `kernel.plugins.changed`。
   * 内置插件 → 409 `plugin.builtin`；审阅后包或权限变了 → 409 `plugin.approval_stale`；
   * 无需批准 → 409 `plugin.not_pending`。
   */
  @Post(":name/approve")
  @HttpCode(200)
  async approve(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Body(new ZodPipe(ApproveBody)) body: z.infer<typeof ApproveBody>,
  ): Promise<AdminPluginView> {
    const actor = requireUser(principal);
    const tokenId = patTokenId(actor);
    return this.admin.approve(
      actor.account.id,
      name,
      body,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }

  /**
   * 上传插件包（请求体为 tgz 原始字节，`application/octet-stream`，上限 `packages.maxBytes`）。
   * 包不合法 → 400 `plugin.package_invalid`（details 逐条列出）；超过上限 → 413；与内置 / 配置声明的插件重名 → 409。
   */
  @Post("packages/file")
  @HttpCode(200)
  async uploadFile(
    @CurrentPrincipal() principal: Principal,
    @Req() req: { body?: unknown },
  ): Promise<PackageReview> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the plugin package (.tgz) as the request body with content-type application/octet-stream",
      );
    }
    const tokenId = patTokenId(actor);
    return this.installs.ingestFile(
      actor.account.id,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }

  /** 从配置的 npm registry 拉取（`version` 可以是版本、dist-tag 或范围，缺省 latest）。下载失败 → 502。 */
  @Post("packages/npm")
  @HttpCode(200)
  async fromNpm(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(NpmBody)) body: z.infer<typeof NpmBody>,
  ): Promise<PackageReview> {
    const actor = requireUser(principal);
    const tokenId = patTokenId(actor);
    return this.installs.ingestNpm(
      actor.account.id,
      { package: body.package, ...(body.version !== undefined && { version: body.version }) },
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }
}
