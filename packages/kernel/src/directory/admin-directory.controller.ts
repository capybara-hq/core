import { PACKAGE_KINDS, type PackageKind } from "@capybara-hq/plugin-sdk";
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
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { DIRECTORY } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { AdminPluginView } from "../plugins/permission-view.js";
import type {
  ActorOpts,
  DirectoryItemDetail,
  DirectoryItemView,
  DirectoryService,
} from "./directory.service.js";

const NpmBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

const PolicyBody = z.object({ policy: z.enum(["allow", "needs_approval", "disabled"]) });

const InstallBody = z.object({ version: z.string().min(1).max(256) });

const ListQuery = z.object({
  kind: z.enum(PACKAGE_KINDS as [PackageKind, ...PackageKind[]]).optional(),
  includeDeleted: z.enum(["true", "false"]).optional(),
});

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * 企业目录（`/api/v1/admin/directory/*`，企业管理员）：导入（上传 / npm）、条目列表与详情、策略、删除、
 * 插件条目装到部署。写操作在服务里锁内复核企业管理员并写审计。
 */
@Controller("api/v1/admin/directory")
@EnterpriseAdmin()
export class AdminDirectoryController {
  constructor(@Inject(DIRECTORY) private readonly directory: DirectoryService) {}

  /**
   * 上传目录包（请求体为原始字节，`application/octet-stream`，上限 `packages.maxBytes`）：插件 / 应用为 npm-pack
   * tgz，连接器模板与技能也可以是 zip。包不合法 → 400 `directory.invalid_package`（details 逐条列出）；
   * 同一版本已导入 → 409 `directory.version_exists`；同名条目来自别的 npm 包 → 409 `directory.name_conflict`；
   * 应用包（T25 之前）→ 409 `directory.wrong_kind`；插件与内置 / 配置声明的插件重名 → 409。
   */
  @Post("import/file")
  @HttpCode(201)
  async importFile(
    @CurrentPrincipal() principal: Principal,
    @Req() req: { body?: unknown },
  ): Promise<DirectoryItemView> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the package (.tgz or .zip) as the request body with content-type application/octet-stream",
      );
    }
    return this.directory.importFile(
      actor.account.id,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      actorOpts(actor),
    );
  }

  /** 从配置的 npm registry 拉取（`version` 可以是版本、dist-tag 或范围，缺省 latest）。下载失败 → 502。 */
  @Post("import/npm")
  @HttpCode(201)
  importNpm(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(NpmBody)) body: z.infer<typeof NpmBody>,
  ): Promise<DirectoryItemView> {
    const actor = requireUser(principal);
    return this.directory.importNpm(
      actor.account.id,
      { package: body.package, ...(body.version !== undefined && { version: body.version }) },
      actorOpts(actor),
    );
  }

  /** 条目列表（`kind` 过滤；`includeDeleted=true` 含已删除）。 */
  @Get("items")
  async list(
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ items: DirectoryItemView[] }> {
    return {
      items: await this.directory.list({
        ...(q.kind !== undefined && { kind: q.kind }),
        includeDeleted: q.includeDeleted === "true",
      }),
    };
  }

  /** 条目详情与各版本；不存在 → 404 `directory.item_not_found`。 */
  @Get("items/:id")
  get(@Param("id") id: string): Promise<DirectoryItemDetail> {
    return this.directory.get(id);
  }

  /** 改策略（allow / needs_approval / disabled）。 */
  @Put("items/:id/policy")
  setPolicy(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>,
  ): Promise<DirectoryItemView> {
    const actor = requireUser(principal);
    return this.directory.setPolicy(actor.account.id, id, body.policy, actorOpts(actor));
  }

  /** 删除条目（软删除，已安装的组件不受影响）。 */
  @Delete("items/:id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param("id") id: string): Promise<void> {
    const actor = requireUser(principal);
    await this.directory.remove(actor.account.id, id, actorOpts(actor));
  }

  /** 插件条目的某个版本装到部署（新装为停用；权限仍需批准）。非插件条目 → 409 `directory.wrong_kind`。 */
  @Post("items/:id/install-deployment")
  @HttpCode(200)
  installToDeployment(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Body(new ZodPipe(InstallBody)) body: z.infer<typeof InstallBody>,
  ): Promise<AdminPluginView> {
    const actor = requireUser(principal);
    return this.directory.installToDeployment(actor.account.id, id, body.version, actorOpts(actor));
  }
}
