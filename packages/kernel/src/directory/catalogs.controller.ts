import { PACKAGE_KINDS, type PackageKind } from "@capybara-hq/plugin-sdk";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { CATALOG_MAX_MIRRORS, type KernelConfig } from "../config/schema.js";
import { CATALOGS, DIRECTORY, KERNEL_CONFIG } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type {
  ActorOpts,
  CatalogEntryView,
  CatalogSourceView,
  CatalogsService,
} from "./catalogs.service.js";
import type { CatalogImportResult, DirectoryService } from "./directory.service.js";

const Url = z.string().min(1).max(2000);
const Kind = z.enum(PACKAGE_KINDS as [PackageKind, ...PackageKind[]]);

const AddBody = z.object({
  name: z.string().min(1).max(100),
  url: Url,
  mirrors: z.array(Url).max(CATALOG_MAX_MIRRORS).optional(),
  token: z.string().min(1).max(4096).optional(),
});

const PatchBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: Url.optional(),
    mirrors: z.array(Url).max(CATALOG_MAX_MIRRORS).optional(),
    enabled: z.boolean().optional(),
    token: z.string().min(1).max(4096).nullable().optional(),
  })
  .strict();

const EntriesQuery = z.object({
  sourceId: z.string().min(1).max(100).optional(),
  kind: Kind.optional(),
  q: z.string().max(200).optional(),
});

const ImportBody = z.object({ version: z.string().min(1).max(256) });

/** 手动刷新的总时限（每个地址另有 30 秒超时）。 */
const REFRESH_DEADLINE_MS = 300_000;

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * 目录来源（`/api/v1/admin/catalogs/*`，企业管理员）：官方 / 企业清单的增删改与刷新、浏览条目、从清单引入。
 * 写操作在服务里锁内复核企业管理员并写审计。
 */
@Controller("api/v1/admin/catalogs")
@EnterpriseAdmin()
export class CatalogsController {
  constructor(
    @Inject(CATALOGS) private readonly catalogs: CatalogsService,
    @Inject(DIRECTORY) private readonly directory: DirectoryService,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
  ) {}

  /** 全部来源；`offline` 为 true 表示 `catalogs.official.enabled` 为 false（界面显示「离线模式」）。 */
  @Get()
  async list(): Promise<{ items: CatalogSourceView[]; offline: boolean }> {
    return {
      items: await this.catalogs.list(),
      offline: !this.config().catalogs.official.enabled,
    };
  }

  /** 加企业清单（地址与镜像只认 https；令牌存 secrets，只发往清单地址的源）。 */
  @Post()
  @HttpCode(201)
  add(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(AddBody)) body: z.infer<typeof AddBody>,
  ): Promise<CatalogSourceView> {
    const actor = requireUser(principal);
    return this.catalogs.add(
      actor.account.id,
      {
        name: body.name,
        url: body.url,
        ...(body.mirrors !== undefined && { mirrors: body.mirrors }),
        ...(body.token !== undefined && { token: body.token }),
      },
      actorOpts(actor),
    );
  }

  /** 浏览条目（只含生效的来源）。 */
  @Get("entries")
  async entries(
    @Query(new ZodPipe(EntriesQuery)) q: z.infer<typeof EntriesQuery>,
  ): Promise<{ items: CatalogEntryView[] }> {
    return {
      items: await this.catalogs.entries({
        ...(q.sourceId !== undefined && { sourceId: q.sourceId }),
        ...(q.kind !== undefined && { kind: q.kind }),
        ...(q.q !== undefined && { q: q.q }),
      }),
    };
  }

  /** 改来源（official 只能改 `enabled`，其余 → 409 `catalog.builtin`；`token: null` 清除令牌）。 */
  @Patch(":id")
  update(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>,
  ): Promise<CatalogSourceView> {
    const actor = requireUser(principal);
    return this.catalogs.update(
      actor.account.id,
      id,
      {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.url !== undefined && { url: body.url }),
        ...(body.mirrors !== undefined && { mirrors: body.mirrors }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.token !== undefined && { token: body.token }),
      },
      actorOpts(actor),
    );
  }

  /** 删除企业清单（已引入的目录条目保留）；official → 409 `catalog.builtin`。 */
  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param("id") id: string): Promise<void> {
    const actor = requireUser(principal);
    await this.catalogs.remove(actor.account.id, id, actorOpts(actor));
  }

  /**
   * 手动刷新。失败时状态记为 `error`、旧条目保留，并返回 502：有地址返回了不合法的清单为 `catalog.invalid`，
   * 否则 `catalog.fetch_failed`。
   */
  @Post(":id/refresh")
  @HttpCode(200)
  refresh(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
  ): Promise<CatalogSourceView> {
    const actor = requireUser(principal);
    return this.catalogs.refresh(id, AbortSignal.timeout(REFRESH_DEADLINE_MS), actor.account.id, {
      ...actorOpts(actor),
      throwOnError: true,
    });
  }

  /** 从清单引入某个版本（按清单 sha512 校验）。 */
  @Post(":id/entries/:kind/:name/import")
  @HttpCode(201)
  importEntry(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Param("kind", new ZodPipe(Kind)) kind: PackageKind,
    @Param("name") name: string,
    @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>,
  ): Promise<CatalogImportResult> {
    const actor = requireUser(principal);
    return this.directory.importFromCatalog(
      actor.account.id,
      { sourceId: id, kind, name, version: body.version },
      actorOpts(actor),
    );
  }
}
