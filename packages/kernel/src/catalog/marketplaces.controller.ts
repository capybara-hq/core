import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { MARKETPLACE_MAX_MIRRORS } from "../config/schema.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import { CatalogService, type MarketplaceImportResult } from "./catalog.service.js";
import {
  type ActorOpts,
  type MarketplaceEntryView,
  MarketplacesService,
  type MarketplaceView,
} from "./marketplaces.service.js";

const Url = z.string().min(1).max(2000);

const Form = z.enum(["http", "git"]);
const Ref = z.string().min(1).max(256);

const AddBody = z.object({
  name: z.string().min(1).max(100),
  url: Url,
  form: Form.optional(),
  ref: Ref.optional(),
  mirrors: z.array(Url).max(MARKETPLACE_MAX_MIRRORS).optional(),
  token: z.string().min(1).max(4096).optional(),
});

const PatchBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: Url.optional(),
    form: Form.optional(),
    ref: Ref.nullable().optional(),
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

class MarketplaceAddBody extends createZodDto(AddBody, "MarketplaceAddBody") {}
class MarketplaceEntriesQuery extends createZodDto(EntriesQuery, "MarketplaceEntriesQuery") {}
class MarketplaceImportBody extends createZodDto(ImportBody, "MarketplaceImportBody") {}
class MarketplacePatchBody extends createZodDto(PatchBody, "MarketplacePatchBody") {}

/**
 * Marketplaces (`/api/v1/admin/marketplaces/*`, enterprise admins): create, update, delete and
 * refresh the official and enterprise marketplaces, browse entries, import from a marketplace.
 * Writes re-check the enterprise admin inside the service's lock and are audited.
 */
@Controller("api/v1/admin/marketplaces")
@EnterpriseAdmin()
export class MarketplacesController {
  constructor(
    @Inject(MarketplacesService) private readonly marketplaces: MarketplacesService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  /** 全部来源；`offline` 为 true 表示 `marketplaces.official.enabled` 为 false（界面显示「离线模式」）。 */
  @Get()
  async list(): Promise<{ items: MarketplaceView[]; offline: boolean }> {
    return {
      items: await this.marketplaces.list(),
      offline: !this.config.get().marketplaces.official.enabled,
    };
  }

  /**
   * Adds an enterprise marketplace (https URL and mirrors; the token is kept in secrets and sent only
   * to the URL's origin). A git URL (`…/*.git`, `owner/repo`, or any URL with `form: "git"`) is a
   * git marketplace with an optional `ref`; anything else is a marketplace.json URL.
   */
  @Post()
  @HttpCode(201)
  add(
    @CurrentPrincipal() principal: Principal,
    @ZBody(MarketplaceAddBody) body: z.infer<typeof AddBody>,
  ): Promise<MarketplaceView> {
    const actor = requireUser(principal);
    return this.marketplaces.add(
      actor.account.id,
      {
        name: body.name,
        url: body.url,
        ...(body.form !== undefined && { form: body.form }),
        ...(body.ref !== undefined && { ref: body.ref }),
        ...(body.mirrors !== undefined && { mirrors: body.mirrors }),
        ...(body.token !== undefined && { token: body.token }),
      },
      actorOpts(actor),
    );
  }

  /**
   * Browses entries (enabled marketplaces only, `sourceId` filters by marketplace; at most
   * `MARKETPLACE_ENTRIES_MAX`, `truncated` true means there are more). An entry that cannot be
   * imported has `importable: false` and a `reason`: `host_not_allowed` (its git / archive host is
   * outside `marketplaces.allowedHosts`) or `path_needs_git_marketplace` (a path entry of an http
   * marketplace).
   */
  @Get("entries")
  entries(
    @ZQuery(MarketplaceEntriesQuery) q: z.infer<typeof EntriesQuery>,
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
    @ZBody(MarketplacePatchBody) body: z.infer<typeof PatchBody>,
  ): Promise<MarketplaceView> {
    const actor = requireUser(principal);
    return this.marketplaces.update(
      actor.account.id,
      id,
      {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.url !== undefined && { url: body.url }),
        ...(body.form !== undefined && { form: body.form }),
        ...(body.ref !== undefined && { ref: body.ref }),
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
   * Manual refresh (a git marketplace with an unchanged commit is skipped). On failure the status
   * becomes `error`, the old entries are kept, and it returns `marketplace.invalid` (502) when some
   * URL returned an invalid manifest, the network rule's code (422) when every URL was refused by
   * it, a git reader code (`marketplace.git_failed` 502, `git_too_large` / `git_unsupported_entry`
   * 422) for a git marketplace, else `marketplace.fetch_failed` (502).
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
   * A `path` / `git` source is read from git (a path at the marketplace's last refreshed commit, a
   * git source at its pinned commit or its ref's head, recorded); its host outside
   * `marketplaces.allowedHosts` -> 403 `marketplace.host_not_allowed`; a path entry of an http
   * marketplace -> 422 `marketplace.path_unsupported`.
   */
  @Post(":id/entries/:name/import")
  @HttpCode(200)
  importEntry(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Param("name") name: string,
    @ZBody(MarketplaceImportBody) body: z.infer<typeof ImportBody>,
  ): Promise<MarketplaceImportResult> {
    const actor = requireUser(principal);
    return this.catalog.importFromMarketplace(
      actor.account.id,
      { marketplaceId: id, name, ...(body.version !== undefined && { version: body.version }) },
      actorOpts(actor),
    );
  }
}
