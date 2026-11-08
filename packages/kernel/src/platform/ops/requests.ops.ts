import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  CatalogItemPathParams,
  CatalogMarketplaceRequestBody,
  CatalogRequestBody,
  CatalogRequestsListQuery,
} from "../../catalog/org-catalog.schemas.js";
import { CatalogRequestsService, type CatalogRequestView } from "../../catalog/requests.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";

/** A request as the requester reads it (no org name: it is this org's). */
const view = (r: CatalogRequestView) => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  item: r.item,
  entry: r.entry,
  agent: r.agent,
  note: r.note,
  reason: r.reason,
  decidedAt: r.decidedAt,
  createdAt: r.createdAt,
});

/** A platform request as the super admin's list shows it: a compact row (the inbox's summary). */
const platformRow = (r: CatalogRequestView) => ({
  id: r.id,
  name: r.item?.name ?? r.entry?.name ?? r.kind,
  state: r.status,
  kind: r.kind,
  org: r.orgName,
  createdAt: r.createdAt,
});

/** A member's pending request as the org admins' list shows it: a compact row (the inbox's). */
const pendingRow = (r: CatalogRequestView) => ({
  id: r.id,
  name: r.item?.name ?? r.entry?.name ?? r.agent?.name ?? r.kind,
  state: r.status,
  kind: r.kind,
  requestedBy: r.requestedByName,
  note: r.note,
  next: "Decide it on the web, in the inbox; agents never decide requests.",
});

/**
 * Request operations of the `Platform` tool (spec §7): a member asks the org admins to switch a
 * plugin on, an org admin asks the super admin for access to a plugin or for an import from a
 * marketplace. Deciding a request is human-only (spec §6.4) and not offered.
 */
@Injectable()
export class RequestsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "requests.list-mine",
        description:
          "List the requests you made in this org, pending and decided, newest first: what was asked (a plugin, a marketplace entry, an agent's connectors), the status and a rejection's reason. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.request" },
        mirrors: [],
        confirm: "read",
        run: async (input, ctx) => {
          const mine = await this.requests.listForRequester(ctx.orgId, ctx.actorAccountId);
          return pageOf(mine.map(view), startOf(input.cursor), 50);
        },
      }),
      defineOperation({
        id: "requests.create",
        description:
          'Ask for a plugin: kind "enable" asks the org admins to switch on a plugin that is off in this org (members and up); kind "access" asks the super admin to offer this org a plugin it sees as not_offered (org admins). Take the plugin id and state from plugins.list. An optional note says why.',
        input: z
          .object({ itemId: CatalogItemPathParams.shape.itemId.max(100) })
          .extend(CatalogRequestBody.shape)
          .strict(),
        example: {
          itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c",
          kind: "enable",
          note: "Our team needs it for the weekly report.",
        },
        authz: { orgAction: "catalog.request" },
        mirrors: ["POST /api/v1/orgs/:orgId/catalog/:itemId/requests"],
        confirm: "personal",
        errors: [
          {
            code: "catalog.request_pending",
            next: "The org already has a pending request of this kind for the plugin; nothing to do but wait.",
          },
          {
            code: "catalog.request_invalid",
            next: 'The plugin\'s state does not fit the kind: "enable" needs state off, "access" needs not_offered. Check plugins.list.',
          },
          {
            code: "forbidden",
            next: 'Only org admins can ask for access; ask an org admin, or use kind "enable".',
          },
        ],
        summary: (i) =>
          i.kind === "enable"
            ? {
                zh: `申请在本组织启用插件 ${i.itemId}`,
                en: `Request that plugin ${i.itemId} be enabled in the org`,
              }
            : {
                zh: `向超级管理员申请插件 ${i.itemId} 的使用权`,
                en: `Request access to plugin ${i.itemId} from the super admin`,
              },
        run: async (input, ctx) => ({
          request: view(
            await this.requests.requestItem(
              ctx.orgId,
              ctx.actorAccountId,
              input.itemId,
              { kind: input.kind, ...(input.note !== undefined && { note: input.note }) },
              { auditDetail: viaAgent("requests.create", ctx) },
            ),
          ),
        }),
      }),
      defineOperation({
        id: "requests.create-import",
        description:
          "Ask the super admin to import a plugin from a marketplace into the platform catalog (org admins, when the platform lets orgs browse): the marketplaceId, name and version from marketplaces.entries, and an optional note.",
        input: CatalogMarketplaceRequestBody,
        example: { marketplaceId: "official", name: "github", version: "1.4.0" },
        authz: { orgAction: "catalog.decide" },
        mirrors: ["POST /api/v1/orgs/:orgId/marketplace-requests"],
        confirm: "org",
        errors: [
          {
            code: "catalog.marketplace_browse_disabled",
            next: "The platform does not let orgs request imports; ask the super admin directly.",
          },
          {
            code: "catalog.request_invalid",
            next: 'The plugin is in the catalog already: use requests.create with kind "access" or "enable".',
          },
          {
            code: "catalog.request_pending",
            next: "A request for this entry is pending already; wait for the super admin.",
          },
        ],
        summary: (i) => ({
          zh: `申请从市场导入插件 ${i.name} ${i.version}`,
          en: `Request the import of plugin ${i.name} ${i.version} from a marketplace`,
        }),
        run: async (input, ctx) => ({
          request: view(
            await this.requests.requestImport(
              ctx.orgId,
              ctx.actorAccountId,
              {
                marketplaceId: input.marketplaceId,
                name: input.name,
                version: input.version,
                ...(input.note !== undefined && { note: input.note }),
              },
              { auditDetail: viaAgent("requests.create-import", ctx) },
            ),
          ),
        }),
      }),
      defineOperation({
        id: "requests.pending",
        description:
          "List the requests members sent this org's admins that wait for a decision (org admins), as the inbox shows them, newest first: kind enable (switch a plugin on) or connector_setup (set up an agent's connectors), what it is about (the plugin or the agent), who asked and their note. Deciding them is done on the web. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.decide" },
        mirrors: [],
        confirm: "read",
        run: async (input, ctx) => {
          const all = await this.requests.listForOrgAdmin(ctx.orgId, ctx.actorAccountId);
          return pageOf(all.map(pendingRow), startOf(input.cursor), 50);
        },
      }),
      defineOperation({
        id: "requests.platform-list",
        description:
          "List the requests orgs sent the super admin (super admin): access to a plugin and imports from a marketplace, one compact row each (what, status, kind, the requesting org, when), newest first; pending by default, or filter by status. Deciding them is done on the web. Pages by 50: pass the returned next as params.cursor.",
        input: z
          .object({ status: CatalogRequestsListQuery.shape.status, cursor: Cursor.optional() })
          .strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/catalog/requests"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input) => {
          const all = await this.requests.listDeployment(
            input.status !== undefined ? { status: input.status } : {},
          );
          return pageOf(all.map(platformRow), startOf(input.cursor), 50);
        },
      }),
    ]);
  }
}
