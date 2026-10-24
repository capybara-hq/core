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
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionAdminOps } from "../extensions/admin-ops.js";
import type { ExtensionAdmin } from "../extensions/admin-view.js";
import type {
  DeploymentConfigView,
  ExtensionDeploymentConfigService,
} from "../extensions/deployment-config.js";
import type { ExtensionInstalls, PackageReview } from "../extensions/installs.js";
import type { AdminExtensionView } from "../extensions/permission-view.js";
import {
  EXTENSION_ADMIN,
  EXTENSION_ADMIN_OPS,
  EXTENSION_DEPLOYMENT_CONFIGS,
  EXTENSION_INSTALLS,
  KERNEL_CONFIG,
} from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";

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
 * Deployment-level extension management (`/api/v1/admin/extensions/*`, enterprise admins): package
 * import (upload / npm, returns the review), the extension list and detail, web permission approval
 * (D8), install / enable / disable / uninstall (only writes the desired state and publishes
 * `kernel.plugins.changed`; every replica reconciles, no restart; replicas may still be converging
 * when the call returns).
 */
@Controller("api/v1/admin/extensions")
@EnterpriseAdmin()
export class AdminExtensionsController {
  constructor(
    @Inject(EXTENSION_INSTALLS) private readonly installs: ExtensionInstalls,
    @Inject(EXTENSION_ADMIN) private readonly admin: ExtensionAdmin,
    @Inject(EXTENSION_ADMIN_OPS) private readonly ops: ExtensionAdminOps,
    @Inject(EXTENSION_DEPLOYMENT_CONFIGS)
    private readonly deploymentConfigs: ExtensionDeploymentConfigService,
    // 字段名不能与路由方法同名（如 `config`）：实例字段会遮住原型上的处理函数
    @Inject(KERNEL_CONFIG) private readonly kernelConfig: () => KernelConfig,
  ) {}

  /**
   * 部署上的全部插件（内置、配置声明、安装记录）及其状态、权限与快照；`drainSeconds` 为停用 / 升级时
   * 在途工具调用最多等待的秒数（`pluginHost.drainSeconds`，界面提示用）。
   */
  @Get()
  async list(): Promise<{ extensions: AdminExtensionView[]; drainSeconds: number }> {
    return {
      extensions: await this.admin.list(),
      drainSeconds: this.kernelConfig().pluginHost.drainSeconds,
    };
  }

  /** A single extension; unknown -> 404 `extension.not_found`. */
  @Get(":name")
  get(@Param("name") name: string): Promise<AdminExtensionView> {
    return this.admin.get(name);
  }

  /**
   * Deployment config (D8 / C10): each field's source (read-only from file / Nacos / env), the
   * effective value (secrets only say whether they are set), the JSON Schema and the validation
   * result. Unknown -> 404 `extension.not_found`.
   */
  @Get(":name/config")
  config(@Param("name") name: string): Promise<DeploymentConfigView> {
    return this.deploymentConfigs.view(name);
  }

  /**
   * Saves the deployment config (`values` keyed by field dot path; `null` clears, omitted keeps).
   * A field present in the startup config -> 409 `extension.config_readonly`; unknown or invalid
   * -> 400 `extension.config_invalid` (values not echoed). A problem in a read-only field itself
   * (a value from the startup config) does not block the PUT: it saves anyway, the extension stays
   * pending configuration and the startup config has to change. Every replica re-reads after saving:
   * hot fields are replaced in place, other fields reload the extension, and a pending extension
   * loads (no restart).
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
   * Web approval: writes the snapshot (source web), audits `extension.permissions_approved` and
   * publishes `kernel.plugins.changed`. Builtin extension -> 409 `extension.builtin`; package or
   * permissions changed after the review -> 409 `extension.approval_stale`; nothing to approve ->
   * 409 `extension.not_pending`.
   */
  @Post(":name/approve")
  @HttpCode(200)
  async approve(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Body(new ZodPipe(ApproveBody)) body: z.infer<typeof ApproveBody>,
  ): Promise<AdminExtensionView> {
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
   * New install or version change (upgrade / downgrade): the install record points at `sha256` in the
   * package store; the desired state is unchanged (a new install is disabled).
   * Builtin -> 409 `extension.builtin`; config-declared -> 409 `extension.config_declared`; package
   * missing -> 404 `extension.package_not_found`; extension name in the package differs -> 409
   * `extension.name_mismatch`; an extension of the same name comes from another npm package -> 409
   * `extension.name_conflict`; downgrade to a version with unrun migrations -> 409
   * `extension.downgrade_unsupported`.
   */
  @Post(":name/install")
  @HttpCode(200)
  install(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Body(new ZodPipe(InstallBody)) body: z.infer<typeof InstallBody>,
  ): Promise<AdminExtensionView> {
    const actor = requireUser(principal);
    return this.ops.install(name, body.sha256, actor.account.id, patTokenId(actor));
  }

  /** Enable on the deployment; not installed -> 404 `extension.not_found`; builtin / config-declared -> 409. */
  @Post(":name/enable")
  @HttpCode(200)
  enable(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
  ): Promise<AdminExtensionView> {
    const actor = requireUser(principal);
    return this.ops.enable(name, actor.account.id, patTokenId(actor));
  }

  /** 部署上停用（各副本排空在途调用后卸下）；未安装 → 404；内置 / 配置声明 → 409。 */
  @Post(":name/disable")
  @HttpCode(200)
  disable(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
  ): Promise<AdminExtensionView> {
    const actor = requireUser(principal);
    return this.ops.disable(name, actor.account.id, patTokenId(actor));
  }

  /** Uninstall (must be disabled first, otherwise 409 `extension.not_disabled`); data is kept. */
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
   * Uploads an extension package (the body is the raw tgz bytes, `application/octet-stream`, limit
   * `packages.maxBytes`). Invalid package -> 400 `extension.package_invalid` (details list each
   * problem); over the limit -> 413; same name as a builtin / config-declared extension -> 409.
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
        "Send the extension package (.tgz) as the request body with content-type application/octet-stream",
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
