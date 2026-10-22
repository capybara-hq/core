import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  PLUGIN_ADMIN,
  PLUGIN_ADMIN_OPS,
  PLUGIN_DEPLOYMENT_CONFIGS,
  PLUGIN_INSTALLS,
} from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { PluginAdminOps } from "../plugins/admin-ops.js";
import type { PluginAdmin } from "../plugins/admin-view.js";
import type {
  DeploymentConfigView,
  DeploymentPluginConfigService,
} from "../plugins/deployment-config.js";
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

const InstallBody = z.object({
  /** 包存储里的包（上传 / npm 导入返回的 sha256）。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const ConfigBody = z.object({
  /** 字段点路径 → 新值（`null` 清除）。 */
  values: z.record(z.string().min(1).max(256), z.unknown()),
});

const NpmBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

/**
 * 部署级插件管理（`/api/v1/admin/plugins/*`，企业管理员）：包的导入（上传 / npm，返回审阅结果）、
 * 插件列表与详情、网页批准权限（D8）、安装 / 启用 / 停用 / 卸载（只写期望状态并发布 `kernel.plugins.changed`，
 * 各副本 reconcile 收敛，不重启；返回时副本可能还在收敛）。
 */
@Controller("api/v1/admin/plugins")
@EnterpriseAdmin()
export class AdminPluginsController {
  constructor(
    @Inject(PLUGIN_INSTALLS) private readonly installs: PluginInstalls,
    @Inject(PLUGIN_ADMIN) private readonly admin: PluginAdmin,
    @Inject(PLUGIN_ADMIN_OPS) private readonly ops: PluginAdminOps,
    @Inject(PLUGIN_DEPLOYMENT_CONFIGS)
    private readonly deploymentConfigs: DeploymentPluginConfigService,
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
   * 部署级配置（D8 / C10）：各字段的来源（文件 / Nacos / 环境变量的只读）、生效值（密钥只给是否已设置）、
   * JSON Schema 与校验结果。不存在 → 404 `plugin.not_found`。
   */
  @Get(":name/config")
  config(@Param("name") name: string): Promise<DeploymentConfigView> {
    return this.deploymentConfigs.view(name);
  }

  /**
   * 保存部署级配置（`values` 以字段点路径为键；`null` 清除、缺省不变）。启动配置里有的字段 → 409
   * `plugin.config_readonly`；未知字段或不合法 → 400 `plugin.config_invalid`（不回显值）。保存后各副本重读：
   * hot 字段就地替换，非 hot 字段重新加载插件，待配置的插件随之加载（不重启）。
   */
  @Put(":name/config")
  putConfig(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Body(new ZodPipe(ConfigBody)) body: z.infer<typeof ConfigBody>,
  ): Promise<DeploymentConfigView> {
    const actor = requireUser(principal);
    return this.deploymentConfigs.put(name, body.values, actor.account.id, patTokenId(actor));
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
   * 新装或换版本（升级 / 降级）：安装记录指向包存储里的 `sha256`；期望状态不变（新装为停用）。
   * 内置 → 409 `plugin.builtin`；配置声明 → 409 `plugin.config_declared`；包不存在 → 404 `plugin.package_not_found`；
   * 包里的插件名不符 → 409 `plugin.name_mismatch`；同名插件来自别的 npm 包 → 409 `plugin.name_conflict`；
   * 降级到有未执行迁移的版本 → 409 `plugin.downgrade_unsupported`。
   */
  @Post(":name/install")
  @HttpCode(200)
  install(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Body(new ZodPipe(InstallBody)) body: z.infer<typeof InstallBody>,
  ): Promise<AdminPluginView> {
    const actor = requireUser(principal);
    return this.ops.install(name, body.sha256, actor.account.id, patTokenId(actor));
  }

  /** 部署上启用；未安装 → 404 `plugin.not_found`；内置 / 配置声明 → 409。 */
  @Post(":name/enable")
  @HttpCode(200)
  enable(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
  ): Promise<AdminPluginView> {
    const actor = requireUser(principal);
    return this.ops.enable(name, actor.account.id, patTokenId(actor));
  }

  /** 部署上停用（各副本排空在途调用后卸下）；未安装 → 404；内置 / 配置声明 → 409。 */
  @Post(":name/disable")
  @HttpCode(200)
  disable(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
  ): Promise<AdminPluginView> {
    const actor = requireUser(principal);
    return this.ops.disable(name, actor.account.id, patTokenId(actor));
  }

  /** 卸载（须先停用，否则 409 `plugin.not_disabled`）；数据保留。 */
  @Delete(":name")
  @HttpCode(204)
  async uninstall(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
  ): Promise<void> {
    const actor = requireUser(principal);
    await this.ops.uninstall(name, actor.account.id, patTokenId(actor));
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
