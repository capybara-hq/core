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
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
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
const Kind = z.enum(PACKAGE_KINDS as [PackageKind, ...PackageKind[]]);

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
   * Browses entries (enabled marketplaces only; at most `MARKETPLACE_ENTRIES_MAX`, `truncated`
   * true means there are more).
   */
  @Get("entries")
  entries(
    @Query(new ZodPipe(EntriesQuery)) q: z.infer<typeof EntriesQuery>,
  ): Promise<{ items: MarketplaceEntryView[]; truncated: boolean }> {
    return this.marketplaces.entries({
      ...(q.sourceId !== undefined && { sourceId: q.sourceId }),
      ...(q.kind !== undefined && { kind: q.kind }),
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
   * 502: `marketplace.invalid` when some URL returned an invalid index, else
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
   * Imports one version from a marketplace (verified against the marketplace's sha512). Extensions,
   * connector templates and skills create the item directly: 201 `{ item, permissionsMismatch }`;
   * a plugin (F-AB) is staged for review first: 200 `{ stagingId, review, permissionsMismatch }`,
   * then confirmed with `POST /api/v1/admin/catalog/plugins/:stagingId/confirm`.
   */
  @Post(":id/entries/:kind/:name/import")
  @HttpCode(201)
  async importEntry(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Param("kind", new ZodPipe(Kind)) kind: PackageKind,
    @Param("name") name: string,
    @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MarketplaceImportResult> {
    const actor = requireUser(principal);
    const r = await this.catalog.importFromMarketplace(
      actor.account.id,
      { sourceId: id, kind, name, version: body.version },
      actorOpts(actor),
    );
    if ("stagingId" in r) reply.code(200);
    return r;
  }
}
