import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { PLUGIN_INSTALLS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { PackageReview, PluginInstalls } from "../plugins/installs.js";

const NpmBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

/**
 * 部署级插件管理（`/api/v1/admin/plugins/*`，企业管理员）。本任务只有包的导入（上传 / npm），
 * 返回审阅结果；安装、启用等改期望状态的接口在 T14。
 */
@Controller("api/v1/admin/plugins")
@EnterpriseAdmin()
export class AdminPluginsController {
  constructor(@Inject(PLUGIN_INSTALLS) private readonly installs: PluginInstalls) {}

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
