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
import { type KernelConfig, MARKETPLACE_MAX_MIRRORS } from "../config/schema.js";
import { CATALOG, KERNEL_CONFIG, MARKETPLACES } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { CatalogService, MarketplaceImportResult } from "./catalog.service.js";
import type {
  ActorOpts,
  MarketplaceEntryView,
  MarketplacesService,
  MarketplaceView,
} from "./marketplaces.service.js";

const Url = z.string().min(1).max(2000);

const AddBody = z.object({
  name: z.string().min(1).max(100),
  url: Url,
  mirrors: z.array(Url).max(MARKETPLACE_MAX_MIRRORS).optional(),
  token: z.string().min(1).max(4096).optional(),
});

const PatchBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: Url.optional(),
    mirrors: z.array(Url).max(MARKETPLACE_MAX_MIRRORS).optional(),
    enabled: z.boolean().optional(),
    token: z.string().min(1).max(4096).nullable().optional(),
  })
  .strict();

const EntriesQuery = z.object({
  sourceId: z.string().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
});

const ImportBody = z.object({ version: z.string().min(1).max(256).optional() });

/** 手动刷新的总时限（每个地址另有 30 秒超时）。 */
const REFRESH_DEADLINE_MS = 300_000;

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * Marketplaces (`/api/v1/admin/marketplaces/*`, enterprise admins): create, update, delete and
 * refresh the official and enterprise marketplaces, browse entries, import from a marketplace.
 * Writes re-check the enterprise admin inside the service's lock and are audited.
 */
@Controller("api/v1/admin/marketplaces")
@EnterpriseAdmin()
export class MarketplacesController {
  constructor(
    @Inject(MARKETPLACES) private readonly marketplaces: MarketplacesService,
    @Inject(CATALOG) private readonly catalog: CatalogService,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
  ) {}

  /** 全部来源；`offline` 为 true 表示 `marketplaces.official.enabled` 为 false（界面显示「离线模式」）。 */
  @Get()
  async list(): Promise<{ items: MarketplaceView[]; offline: boolean }> {
    return {
      items: await this.marketplaces.list(),
      offline: !this.config().marketplaces.official.enabled,
    };
  }

  /** 加企业清单（地址与镜像只认 https；令牌存 secrets，只发往清单地址的源）。 */
  @Post()
  @HttpCode(201)
  add(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(AddBody)) body: z.infer<typeof AddBody>,
  ): Promise<MarketplaceView> {
    const actor = requireUser(principal);
    return this.marketplaces.add(
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

  /**
   * Browses entries (enabled marketplaces only, `sourceId` filters by marketplace; at most
   * `MARKETPLACE_ENTRIES_MAX`, `truncated` true means there are more). `path` / `git` entries are
   * listed with `importable: false, reason: "needs_git_marketplaces"`.
   */
  @Get("entries")
  entries(
    @Query(new ZodPipe(EntriesQuery)) q: z.infer<typeof EntriesQuery>,
  ): Promise<{ items: MarketplaceEntryView[]; truncated: boolean }> {
    return this.marketplaces.entries({
      ...(q.sourceId !== undefined && { marketplaceId: q.sourceId }),
      ...(q.q !== undefined && { q: q.q }),
    });
  }

  /**
   * Updates a marketplace (official only takes `enabled`, anything else -> 409
   * `marketplace.builtin`; `token: null` clears the token).
   */
  @Patch(":id")
  update(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>,
  ): Promise<MarketplaceView> {
    const actor = requireUser(principal);
    return this.marketplaces.update(
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

  /**
   * Deletes an enterprise marketplace (imported catalog items are kept); official -> 409
   * `marketplace.builtin`.
   */
  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param("id") id: string): Promise<void> {
    const actor = requireUser(principal);
    await this.marketplaces.remove(actor.account.id, id, actorOpts(actor));
  }

  /**
   * Manual refresh. On failure the status becomes `error`, the old entries are kept, and it returns
   * 502: `marketplace.invalid` when some URL returned an invalid manifest, else
   * `marketplace.fetch_failed`.
   */
  @Post(":id/refresh")
  @HttpCode(200)
  refresh(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
  ): Promise<MarketplaceView> {
    const actor = requireUser(principal);
    return this.marketplaces.refresh(
      id,
      AbortSignal.timeout(REFRESH_DEADLINE_MS),
      actor.account.id,
      {
        ...actorOpts(actor),
        throwOnError: true,
      },
    );
  }

  /**
   * Prepares the import of one version of a marketplace entry (`version` defaults to the newest
   * compatible one; verified against the marketplace's integrity): 200 `{ stagingId, review,
   * permissionsMismatch }`, confirmed with `POST /api/v1/admin/catalog/imports/:stagingId/confirm`.
   * A `path` / `git` source -> 422 `marketplace.source_unsupported`.
   */
  @Post(":id/entries/:name/import")
  @HttpCode(200)
  importEntry(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Param("name") name: string,
    @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>,
  ): Promise<MarketplaceImportResult> {
    const actor = requireUser(principal);
    return this.catalog.importFromMarketplace(
      actor.account.id,
      { marketplaceId: id, name, ...(body.version !== undefined && { version: body.version }) },
      actorOpts(actor),
    );
  }
}
