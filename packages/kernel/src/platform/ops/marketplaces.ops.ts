import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { MarketplaceAddBody, MarketplaceEntriesQuery } from "../../catalog/marketplaces.schemas.js";
import {
  type MarketplaceEntryView,
  MarketplacesService,
  type MarketplaceView,
} from "../../catalog/marketplaces.service.js";
import { itemsSeenBy } from "../../catalog/scope-state.js";
import { ApiError } from "../../errors.js";
import { readOrgMarketplaceBrowse } from "../../identity/settings.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { asToolError, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";

const PAGE = 50;

/** A marketplace source as the list shows it: no token, etag or skip list. */
const source = (m: MarketplaceView) => ({
  id: m.id,
  name: m.name,
  url: m.url,
  form: m.form,
  ref: m.ref,
  builtin: m.builtin,
  enabled: m.enabled,
  disabledByConfig: m.disabledByConfig,
  lastStatus: m.lastStatus,
  lastError: m.lastError,
  lastRefreshedAt: m.lastRefreshedAt,
  entryCount: m.entryCount,
});

/** One marketplace entry (one version of a plugin) as the browse list shows it. */
const entry = (e: MarketplaceEntryView) => ({
  marketplaceId: e.sourceId,
  marketplace: e.sourceName,
  name: e.name,
  version: e.version,
  displayName: e.displayName,
  summary: e.summary,
  format: e.format,
  compatible: e.compatible,
  importable: e.importable,
  ...(e.reason !== undefined && { reason: e.reason }),
  deprecated: e.deprecated,
  permissions: e.permissions,
  importedAs: e.adopted,
  newerAvailable: e.newerAvailable,
});

/**
 * Marketplace operations of the `Platform` tool (spec §7): the super admin's sources (list, add)
 * and the org admins' read-only browse of the entries (deployment setting `orgMarketplaceBrowse`),
 * from which they request an import (`requests.create-import`).
 */
@Injectable()
export class MarketplacesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(MarketplacesService) private readonly marketplaces: MarketplacesService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "marketplaces.list",
        description:
          "List the marketplace sources of the platform (super admin): the official one and the custom ones, with whether each is enabled, its last refresh and how many entries it has. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/marketplaces"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input) =>
          pageOf((await this.marketplaces.list()).map(source), startOf(input.cursor), PAGE),
      }),
      defineOperation({
        id: "marketplaces.entries",
        description:
          "Browse the plugins the enabled marketplaces offer (org admins, when the platform lets orgs browse): name, version, summary, whether it can be imported and whether it is in the catalog already. Filter by marketplaceId or a search text q. Pages by 50: pass the returned next as params.cursor. To get one imported, use requests.create-import.",
        input: z
          .object({
            marketplaceId: MarketplaceEntriesQuery.shape.sourceId,
            q: MarketplaceEntriesQuery.shape.q.unwrap().min(1).optional(),
            cursor: Cursor.optional(),
          })
          .strict(),
        example: { q: "github" },
        authz: { orgAction: "catalog.decide" },
        mirrors: ["GET /api/v1/orgs/:orgId/marketplaces/entries"],
        // `marketplaceId` is the route's `sourceId`, named as the entries and requests name it
        omits: ["sourceId"],
        extras: ["marketplaceId", "cursor"],
        confirm: "read",
        errors: [
          {
            code: "not_found",
            next: "The platform does not let orgs browse the marketplaces; ask the super admin.",
          },
        ],
        run: async (input, ctx) =>
          asToolError(async () => {
            if (!(await readOrgMarketplaceBrowse(this.kdb.db))) {
              throw new ApiError("not_found", "Marketplace browsing is off for organizations");
            }
            const r = await this.marketplaces.entries({
              ...(input.marketplaceId !== undefined && { marketplaceId: input.marketplaceId }),
              ...(input.q !== undefined && { q: input.q }),
            });
            // as the route: an item the org can neither see nor request reads as not imported
            const seen = await itemsSeenBy(
              this.kdb.db,
              ctx.orgId,
              r.items.flatMap((e) => (e.adopted ? [e.adopted.itemId] : [])),
            );
            const items = r.items.map((e) =>
              e.adopted === null || seen.has(e.adopted.itemId)
                ? e
                : { ...e, adopted: null, newerAvailable: false, contentChanged: false },
            );
            return pageOf(items.map(entry), startOf(input.cursor), PAGE);
          }),
      }),
      defineOperation({
        id: "marketplaces.add",
        description:
          "Add a custom marketplace source to the platform (super admin): a name and an https URL of a marketplace.json, or a git repository (…/*.git or owner/repo) with an optional ref. Sources that need a token or mirrors are added on the web.",
        input: MarketplaceAddBody.pick({ name: true, url: true, ref: true }).strict(),
        example: { name: "Team plugins", url: "https://plugins.example.com/marketplace.json" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/marketplaces"],
        // the form is inferred from the URL; mirrors and a token are added on the web
        omits: ["form", "mirrors", "token"],
        confirm: "platform",
        errors: [
          {
            code: "validation_failed",
            next: "Fix the name or URL as the message says (https, no user info), then call again.",
          },
        ],
        summary: (i) => ({
          zh: `添加市场源「${i.name}」${i.url}`,
          en: `Add marketplace source "${i.name}" ${i.url}`,
        }),
        run: async (input, ctx) =>
          asToolError(async () => ({
            marketplace: source(
              await this.marketplaces.add(
                ctx.actorAccountId,
                {
                  name: input.name,
                  url: input.url,
                  ...(input.ref !== undefined && { ref: input.ref }),
                },
                { auditDetail: viaAgent("marketplaces.add", ctx) },
              ),
            ),
          })),
      }),
    ]);
  }
}
