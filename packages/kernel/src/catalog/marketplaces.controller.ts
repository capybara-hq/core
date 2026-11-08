import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { ApiError } from "../errors.js";
import { orgIconScope, PluginIcons } from "../extensions/plugin-icons.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { readOrgMarketplaceBrowse } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { CatalogService, type MarketplaceImportResult } from "./catalog.service.js";
import { orgMarketplaceIconUrl } from "./marketplace-icons.js";
import {
  MarketplaceImportBody as ImportBody,
  MarketplaceAddBody,
  MarketplaceEntriesQuery,
  MarketplacePatchBody as PatchBody,
} from "./marketplaces.schemas.js";
import {
  type ActorOpts,
  type MarketplaceEntryView,
  MarketplacesService,
  type MarketplaceView,
} from "./marketplaces.service.js";
import { sendCatalogIcon } from "./org-catalog.controller.js";
import { itemsSeenBy } from "./scope-state.js";

/** 手动刷新的总时限（每个地址另有 30 秒超时）。 */
const REFRESH_DEADLINE_MS = 300_000;

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

class MarketplaceAddBodyDto extends createZodDto(MarketplaceAddBody, "MarketplaceAddBody") {}
class MarketplaceEntriesQueryDto extends createZodDto(
  MarketplaceEntriesQuery,
  "MarketplaceEntriesQuery",
) {}
class MarketplaceImportBody extends createZodDto(ImportBody, "MarketplaceImportBody") {}
class MarketplacePatchBody extends createZodDto(PatchBody, "MarketplacePatchBody") {}

/**
 * Marketplaces (`/api/v1/admin/marketplaces/*`, super admins): create, update, delete and
 * refresh the official and custom marketplaces, browse entries, import from a marketplace.
 * Writes re-check the super admin inside the service's lock and are audited.
 */
@Controller("api/v1/admin/marketplaces")
@SuperAdmin()
export class MarketplacesController {
  constructor(
    @Inject(MarketplacesService) private readonly marketplaces: MarketplacesService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
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
   * Adds a custom marketplace (https URL and mirrors; the token is kept in secrets and sent only
   * to the URL's origin). A git URL (`…/*.git`, `owner/repo`, or any URL with `form: "git"`) is a
   * git marketplace with an optional `ref`; anything else is a marketplace.json URL.
   */
  @Post()
  @HttpCode(201)
  add(
    @CurrentPrincipal() principal: Principal,
    @ZBody(MarketplaceAddBodyDto) body: z.infer<typeof MarketplaceAddBody>,
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
   * marketplace). `icon`: an imported plugin's catalog icon (its current version's, the one the
   * 已安装 list shows, also on an entry of a newer version), else the marketplace icon the last
   * refresh stored, else null.
   */
  @Get("entries")
  async entries(
    @ZQuery(MarketplaceEntriesQueryDto) q: z.infer<typeof MarketplaceEntriesQuery>,
  ): Promise<{ items: MarketplaceEntryView[]; truncated: boolean }> {
    const r = await this.marketplaces.entries({
      ...(q.sourceId !== undefined && { marketplaceId: q.sourceId }),
      ...(q.q !== undefined && { q: q.q }),
    });
    const installed = await this.icons.ofItems(
      r.items.flatMap((e) => (e.adopted ? [e.adopted.itemId] : [])),
      { kind: "admin" },
    );
    return {
      ...r,
      items: r.items.map((e) => {
        const own = e.adopted ? installed.get(e.adopted.itemId) : undefined;
        return own === undefined ? e : { ...e, icon: own };
      }),
    };
  }

  /**
   * A marketplace entry icon the last refresh stored (`icon` of the entries), from PG with the
   * plugin icon response headers (`sendCatalogIcon`: nosniff, CSP sandbox). Not stored -> 404
   * `catalog.icon_not_found`.
   */
  @Get(":id/icons/:sha256")
  async icon(
    @Param("id") id: string,
    @Param("sha256") sha256: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendCatalogIcon(reply, await this.marketplaces.icon(id, sha256));
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
   * Deletes a custom marketplace (imported catalog items are kept); official -> 409
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

/**
 * Org admins browse the marketplaces read-only (`GET /api/v1/orgs/:orgId/marketplaces/entries`,
 * `catalog.decide`; plugin scope spec §5.1 rule 3) to request an import. The deployment setting
 * `orgMarketplaceBrowse` off -> 404 `not_found`. An entry imported as an item the org can neither
 * see nor request (a hidden `named` item) reads as not imported (`adopted: null`). `icon`: the
 * catalog item's org icon route when the org's catalog shows the item (the share gate,
 * `PluginIcons`), else the marketplace icon on this controller's icon route, else null.
 */
@Controller("api/v1/orgs/:orgId/marketplaces")
export class OrgMarketplacesController {
  constructor(
    @Inject(MarketplacesService) private readonly marketplaces: MarketplacesService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
  ) {}

  /** The org browse is off (`orgMarketplaceBrowse`) -> 404, like the entries. */
  private async assertBrowse(): Promise<void> {
    if (!(await readOrgMarketplaceBrowse(this.kdb.db))) {
      throw new ApiError("not_found", "Marketplace browsing is off for organizations");
    }
  }

  /**
   * A marketplace entry icon for the org browse (`catalog.decide`, the org admins), gated like the
   * entries: browsing on, the marketplace enabled; served like plugin icons (`sendCatalogIcon`).
   * Not stored -> 404 `catalog.icon_not_found`.
   */
  @Get(":id/icons/:sha256")
  @OrgAction("catalog.decide")
  async icon(
    @Param("id") id: string,
    @Param("sha256") sha256: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.assertBrowse();
    await sendCatalogIcon(reply, await this.marketplaces.icon(id, sha256, { browsable: true }));
  }

  @Get("entries")
  @OrgAction("catalog.decide")
  async entries(
    @CurrentOrg() org: OrgContext,
    @ZQuery(MarketplaceEntriesQueryDto) q: z.infer<typeof MarketplaceEntriesQuery>,
  ): Promise<{ items: MarketplaceEntryView[]; truncated: boolean }> {
    await this.assertBrowse();
    const r = await this.marketplaces.entries(
      {
        ...(q.sourceId !== undefined && { marketplaceId: q.sourceId }),
        ...(q.q !== undefined && { q: q.q }),
      },
      orgMarketplaceIconUrl(org.orgId),
    );
    // A hidden `named` item the org is not listed on stays unknown to it: the entry reads as not
    // imported (and shows the marketplace icon, never the item's)
    const adoptedIds = r.items.flatMap((e) => (e.adopted ? [e.adopted.itemId] : []));
    const seen = await itemsSeenBy(this.kdb.db, org.orgId, adoptedIds);
    const own = await this.icons.ofItems(
      adoptedIds.filter((id) => seen.has(id)),
      orgIconScope(org),
    );
    return {
      ...r,
      items: r.items.map((e) => {
        if (e.adopted === null) return e;
        if (!seen.has(e.adopted.itemId)) {
          return { ...e, adopted: null, newerAvailable: false, contentChanged: false };
        }
        const icon = own.get(e.adopted.itemId);
        return icon === undefined ? e : { ...e, icon };
      }),
    };
  }
}
