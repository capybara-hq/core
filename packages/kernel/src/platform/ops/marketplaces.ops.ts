import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { CatalogService } from "../../catalog/catalog.service.js";
import {
  MarketplaceAddBody,
  MarketplaceEntriesQuery,
  MarketplaceEntryPathParams,
  MarketplaceIdPathParams,
  MarketplaceImportBody,
  MarketplacePatchBody,
} from "../../catalog/marketplaces.schemas.js";
import {
  type MarketplaceEntryView,
  MarketplacesService,
  type MarketplaceView,
} from "../../catalog/marketplaces.service.js";
import { itemsSeenBy } from "../../catalog/scope-state.js";
import { ApiError } from "../../errors.js";
import { readOrgMarketplaceBrowse } from "../../identity/settings.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { CONFIRM_ON_WEB, reviewBrief, reviewUrl } from "./catalog-admin.ops.js";
import { viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";

const PAGE = 50;

/** A marketplace source id (`:id` of the admin routes), named as the entries name it. */
const MarketplaceId = MarketplaceIdPathParams.shape.id.max(100);
/** 手动刷新的总时限（与路由一致）。 */
const REFRESH_DEADLINE_MS = 300_000;

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
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  /** The source `id`, or null when there is none. */
  private async sourceOf(id: string): Promise<MarketplaceView | null> {
    return (await this.marketplaces.list()).find((m) => m.id === id) ?? null;
  }

  /** The precheck refusal of an unknown source, or of anything but `enabled` on the official one. */
  private async editable(
    id: string,
    onlyEnabled: boolean,
  ): Promise<{ ok: true; source: MarketplaceView } | Exclude<PrecheckResult, { ok: true }>> {
    const m = await this.sourceOf(id);
    if (m === null) {
      return { ok: false, code: "marketplace.not_found", message: "Marketplace not found" };
    }
    if (m.builtin && !onlyEnabled) {
      return {
        ok: false,
        code: "marketplace.builtin",
        message: "The official marketplace can only be enabled or disabled",
      };
    }
    return { ok: true, source: m };
  }

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
        renames: { marketplaceId: "sourceId" },
        extras: ["cursor"],
        confirm: "read",
        errors: [
          {
            code: "not_found",
            next: {
              superAdmin:
                "Org marketplace browsing is off (deployment setting orgMarketplaceBrowse); browse and import the marketplaces in the admin console under Plugins instead.",
              orgAdmin:
                "The platform does not let orgs browse the marketplaces; ask the super admin.",
              member: "The platform does not let orgs browse the marketplaces; ask an org admin.",
            },
          },
        ],
        run: async (input, ctx) => {
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
        },
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
          {
            code: "marketplace.already_added",
            next: "Use the existing source (marketplaces.list) instead of adding it again.",
          },
        ],
        precheck: async (i) => {
          let same: { id: string; name: string } | null;
          try {
            same = await this.marketplaces.checkAdd({
              name: i.name,
              url: i.url,
              ...(i.ref !== undefined && { ref: i.ref }),
            });
          } catch (e) {
            if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
            throw e;
          }
          return same === null
            ? { ok: true }
            : {
                ok: false,
                code: "marketplace.already_added",
                message: `The marketplace source "${same.name}" (id ${same.id}) already has this URL`,
              };
        },
        summary: (i) => ({
          zh: `添加市场源「${i.name}」${i.url}`,
          en: `Add marketplace source "${i.name}" ${i.url}`,
        }),
        run: async (input, ctx) => ({
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
        }),
      }),
      defineOperation({
        id: "marketplaces.platform-entries",
        description:
          "Browse every plugin the enabled marketplaces offer (super admin): name, version, summary, whether it can be imported (and why not) and whether it is in the catalog already. Filter by marketplaceId or a search text q. Pages by 50: pass the returned next as params.cursor. To import one, use marketplaces.import.",
        input: z
          .object({
            marketplaceId: MarketplaceEntriesQuery.shape.sourceId,
            q: MarketplaceEntriesQuery.shape.q.unwrap().min(1).optional(),
            cursor: Cursor.optional(),
          })
          .strict(),
        example: { q: "github" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/marketplaces/entries"],
        renames: { marketplaceId: "sourceId" },
        extras: ["cursor"],
        confirm: "read",
        run: async (input) => {
          const r = await this.marketplaces.entries({
            ...(input.marketplaceId !== undefined && { marketplaceId: input.marketplaceId }),
            ...(input.q !== undefined && { q: input.q }),
          });
          return {
            ...pageOf(r.items.map(entry), startOf(input.cursor), PAGE),
            truncated: r.truncated,
          };
        },
      }),
      defineOperation({
        id: "marketplaces.update",
        description:
          "Edit a marketplace source (super admin): name, url, form, ref (null: follow the remote HEAD), mirrors, enabled. The official one takes only enabled. A token is set on the web.",
        input: z
          .object({
            marketplaceId: MarketplaceId,
            ...MarketplacePatchBody.omit({ token: true }).shape,
          })
          .strict(),
        example: { marketplaceId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", enabled: false },
        authz: { superAdmin: true },
        mirrors: ["PATCH /api/v1/admin/marketplaces/:id"],
        renames: { marketplaceId: "id" },
        // the token is a secret: set on the web only
        omits: ["token"],
        confirm: "platform",
        errors: [
          { code: "marketplace.not_found", next: "Check the source id with marketplaces.list." },
          {
            code: "marketplace.builtin",
            next: "The official marketplace can only be enabled or disabled; it cannot be edited or removed.",
          },
          {
            code: "validation_failed",
            next: "Fix the field the message names (https, no user info), then call again.",
          },
        ],
        precheck: async (i) => {
          const { marketplaceId: _id, enabled: _enabled, ...rest } = i;
          const r = await this.editable(i.marketplaceId, Object.keys(rest).length === 0);
          return r.ok ? { ok: true } : r;
        },
        summary: async (i) => {
          const { marketplaceId, ...patch } = i;
          const m = await this.sourceOf(marketplaceId);
          const name = m?.name ?? marketplaceId;
          const fields = Object.entries(patch)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : String(v)}`)
            .join(", ");
          return {
            zh: `修改市场源「${name}」：${fields}`,
            en: `Edit marketplace source "${name}": ${fields}`,
          };
        },
        run: async (input, ctx) => {
          const { marketplaceId, ...patch } = input;
          return {
            marketplace: source(
              await this.marketplaces.update(
                ctx.actorAccountId,
                marketplaceId,
                Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
                { auditDetail: viaAgent("marketplaces.update", ctx) },
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "marketplaces.remove",
        description:
          "Remove a custom marketplace source (super admin): its entries and token go; plugins imported from it stay in the catalog. The official one cannot be removed (disable it with marketplaces.update).",
        input: z.object({ marketplaceId: MarketplaceId }).strict(),
        example: { marketplaceId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/marketplaces/:id"],
        renames: { marketplaceId: "id" },
        confirm: "platform",
        errors: [
          { code: "marketplace.not_found", next: "Check the source id with marketplaces.list." },
          {
            code: "marketplace.builtin",
            next: "The official marketplace can only be enabled or disabled; it cannot be edited or removed.",
          },
        ],
        precheck: async (i) => {
          const r = await this.editable(i.marketplaceId, false);
          return r.ok ? { ok: true } : r;
        },
        summary: async (i) => {
          const m = await this.sourceOf(i.marketplaceId);
          const name = m?.name ?? i.marketplaceId;
          return {
            zh: `删除市场源「${name}」（${m?.entryCount ?? 0} 个条目；已导入的插件保留）`,
            en: `Remove marketplace source "${name}" (${m?.entryCount ?? 0} entries; imported plugins stay)`,
          };
        },
        run: async (input, ctx) => {
          await this.marketplaces.remove(ctx.actorAccountId, input.marketplaceId, {
            auditDetail: viaAgent("marketplaces.remove", ctx),
          });
          return { removed: input.marketplaceId };
        },
      }),
      defineOperation({
        id: "marketplaces.refresh",
        description:
          "Refresh a marketplace source now (super admin): fetch its index again (a git source with an unchanged commit is skipped). On failure the old entries are kept and the error says why.",
        input: z.object({ marketplaceId: MarketplaceId }).strict(),
        example: { marketplaceId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/marketplaces/:id/refresh"],
        renames: { marketplaceId: "id" },
        confirm: "platform",
        errors: [
          { code: "marketplace.not_found", next: "Check the source id with marketplaces.list." },
          {
            code: "marketplace.fetch_failed",
            next: "The source could not be fetched; check its URL with marketplaces.list, or try again later.",
          },
          {
            code: "marketplace.invalid",
            next: "The source returned an invalid marketplace index; tell the person who maintains it.",
          },
        ],
        precheck: async (i) => {
          const r = await this.editable(i.marketplaceId, true);
          return r.ok ? { ok: true } : r;
        },
        summary: async (i) => {
          const name = (await this.sourceOf(i.marketplaceId))?.name ?? i.marketplaceId;
          return { zh: `刷新市场源「${name}」`, en: `Refresh marketplace source "${name}"` };
        },
        run: async (input, ctx) => ({
          marketplace: source(
            await this.marketplaces.refresh(
              input.marketplaceId,
              AbortSignal.any([ctx.signal, AbortSignal.timeout(REFRESH_DEADLINE_MS)]),
              ctx.actorAccountId,
              { throwOnError: true, auditDetail: viaAgent("marketplaces.refresh", ctx) },
            ),
          ),
        }),
      }),
      defineOperation({
        id: "marketplaces.import",
        description:
          "Prepare importing one marketplace entry into the catalog (super admin; version defaults to the newest compatible one, verified against the marketplace's integrity). Stages it for 24 hours and returns what it brings and a reviewUrl; nothing is imported until the person confirms it there.",
        input: z
          .object({
            marketplaceId: MarketplaceId,
            name: MarketplaceEntryPathParams.shape.name.max(214),
            ...MarketplaceImportBody.shape,
          })
          .strict(),
        example: { marketplaceId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", name: "github" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/marketplaces/:id/entries/:name/import"],
        renames: { marketplaceId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "marketplace.entry_not_found",
            next: "Check the entry name and version with marketplaces.platform-entries.",
          },
          {
            code: "marketplace.host_not_allowed",
            next: "The entry downloads from a host outside the deployment's marketplaces.allowedHosts; that list is deployment config, changed by whoever runs the deployment.",
          },
          {
            code: "marketplace.incompatible",
            next: "The entry needs a newer kernel than this platform runs; pick an older version with marketplaces.platform-entries.",
          },
          {
            code: "catalog.version_exists",
            next: "This version is in the catalog already: update the plugin to it with plugins.update-preview.",
          },
        ],
        precheck: async (i) => {
          const r = await this.marketplaces.entries({ marketplaceId: i.marketplaceId });
          const found = r.items.filter(
            (e) => e.name === i.name && (i.version === undefined || e.version === i.version),
          );
          if (found.length === 0) {
            return r.truncated
              ? { ok: true }
              : {
                  ok: false,
                  code: "marketplace.entry_not_found",
                  message: `The marketplace has no entry ${i.name}${i.version !== undefined ? `@${i.version}` : ""}`,
                };
          }
          const blocked = found.every((e) => !e.importable);
          return blocked
            ? {
                ok: false,
                code:
                  found[0]?.reason === "host_not_allowed"
                    ? "marketplace.host_not_allowed"
                    : "marketplace.path_unsupported",
                message: `Entry ${i.name} cannot be imported (${found[0]?.reason ?? "not importable"})`,
              }
            : { ok: true };
        },
        summary: async (i) => {
          const name = (await this.sourceOf(i.marketplaceId))?.name ?? i.marketplaceId;
          const v = i.version !== undefined ? `@${i.version}` : "";
          return {
            zh: `从市场源「${name}」准备导入插件 ${i.name}${v}（确认在网页上进行）`,
            en: `Prepare importing plugin ${i.name}${v} from marketplace source "${name}" (confirmed on the web)`,
          };
        },
        run: async (input, ctx) => {
          const r = await this.catalog.importFromMarketplace(
            ctx.actorAccountId,
            {
              marketplaceId: input.marketplaceId,
              name: input.name,
              ...(input.version !== undefined && { version: input.version }),
            },
            { auditDetail: viaAgent("marketplaces.import", ctx) },
          );
          return {
            stagingId: r.stagingId,
            review: reviewBrief(r.review),
            permissionsMismatch: r.permissionsMismatch,
            reviewUrl: reviewUrl(r.stagingId),
            next: CONFIRM_ON_WEB,
          };
        },
      }),
    ]);
  }
}
