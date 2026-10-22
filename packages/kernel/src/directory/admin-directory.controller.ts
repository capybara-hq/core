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
import { APP_IMPORT, DIRECTORY } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { AdminPluginView } from "../plugins/permission-view.js";
import type { AppConfirmResult, AppImport, AppReview } from "./app-import.js";
import {
  type ActorOpts,
  DIRECTORY_LIST_MAX_LIMIT,
  type DirectoryItemDetail,
  type DirectoryItemView,
  type DirectoryService,
} from "./directory.service.js";

const NpmBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

const PolicyBody = z.object({ policy: z.enum(["allow", "needs_approval", "disabled"]) });

const InstallBody = z.object({ version: z.string().min(1).max(256) });

const ConfirmBody = z.object({
  reviewHash: z.string().min(1).max(128),
  deployPlugins: z.boolean(),
});

const ListQuery = z.object({
  kind: z.enum(PACKAGE_KINDS as [PackageKind, ...PackageKind[]]).optional(),
  includeDeleted: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(DIRECTORY_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
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
  constructor(
    @Inject(DIRECTORY) private readonly directory: DirectoryService,
    @Inject(APP_IMPORT) private readonly apps: AppImport,
  ) {}

  /**
   * 上传目录包（请求体为原始字节，`application/octet-stream`，上限 `packages.maxBytes`）：插件 / 应用为 npm-pack
   * tgz，连接器模板与技能也可以是 zip。包不合法 → 400 `directory.invalid_package`（details 逐条列出）；
   * 同一版本已导入 → 409 `directory.version_exists`；同名条目来自别的 npm 包 → 409 `directory.name_conflict`；
   * 应用包 → 409 `directory.wrong_kind`（应用走 `apps/prepare/*`）；插件与内置 / 配置声明的插件重名 → 409。
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

  /**
   * 应用包（npm-pack tgz，请求体为原始字节，`application/octet-stream`，上限 `packages.maxBytes`）：解析 app.yaml，
   * 按 lock 从 npm 拉取每个插件并按 sha512 校验，校验模板与技能，全部通过后暂存 24 小时，返回一次审阅。
   * 清单不合法 → 400 `app.invalid_manifest`；lock 的 sha512 不符 → 502 `app.lock_mismatch`；内置 / 配置声明的插件
   * 不满足范围 → 409 `app.plugin_conflict`；不是应用包 → 409 `directory.wrong_kind`。
   */
  @Post("apps/prepare/file")
  @HttpCode(200)
  async prepareAppFile(
    @CurrentPrincipal() principal: Principal,
    @Req() req: { body?: unknown },
  ): Promise<{ stagingId: string; review: AppReview }> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the app package (.tgz) as the request body with content-type application/octet-stream",
      );
    }
    const r = await this.apps.prepare(
      actor.account.id,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      { kind: "file", ref: "upload" },
      actorOpts(actor),
    );
    return { stagingId: r.stagingId, review: r.review };
  }

  /** 从配置的 npm registry 拉取应用包再暂存（同 `apps/prepare/file`）。下载失败 → 502。 */
  @Post("apps/prepare/npm")
  @HttpCode(200)
  prepareAppNpm(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(NpmBody)) body: z.infer<typeof NpmBody>,
  ): Promise<{ stagingId: string; review: AppReview }> {
    const actor = requireUser(principal);
    return this.apps.prepareNpm(
      actor.account.id,
      { package: body.package, ...(body.version !== undefined && { version: body.version }) },
      actorOpts(actor),
    );
  }

  /**
   * 确认应用导入：一次批准全部要装 / 升级的插件（写快照），建 kind app 的目录条目；`deployPlugins` 时提交后装到部署并
   * 启用，返回 `{ item, deploy }`，`deploy` 逐个列出 enabled / failed（+ code）；部署失败不让已提交的导入报错，
   * 失败的插件经插件后台按 sha256 重新安装。可预见的失败（降级到有未执行迁移的版本）在写之前 409
   * `plugin.downgrade_unsupported`。
   * 暂存不存在或已过期 → 404 `app.staging_not_found`；`reviewHash` 不符或部署上的插件已变 → 409 `app.review_stale`。
   */
  @Post("apps/:stagingId/confirm")
  @HttpCode(201)
  confirmApp(
    @CurrentPrincipal() principal: Principal,
    @Param("stagingId") stagingId: string,
    @Body(new ZodPipe(ConfirmBody)) body: z.infer<typeof ConfirmBody>,
  ): Promise<AppConfirmResult> {
    const actor = requireUser(principal);
    return this.apps.confirm(actor.account.id, stagingId, body, actorOpts(actor));
  }

  /**
   * 条目列表（`kind` 过滤；`includeDeleted=true` 含已删除）。分页：`limit`（缺省 200，最大 1000）与 `offset`，
   * `nextOffset` 为下一页的 offset，没有下一页为 null。
   */
  @Get("items")
  list(
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ items: DirectoryItemView[]; nextOffset: number | null }> {
    return this.directory.page({
      ...(q.kind !== undefined && { kind: q.kind }),
      includeDeleted: q.includeDeleted === "true",
      ...(q.limit !== undefined && { limit: q.limit }),
      ...(q.offset !== undefined && { offset: q.offset }),
    });
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
