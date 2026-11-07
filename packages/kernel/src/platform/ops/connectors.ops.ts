import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ComponentScopeService } from "../../catalog/component-scope.service.js";
import {
  type ConnectorDetail,
  type ConnectorSummary,
  ConnectorsService,
} from "../../tools/connectors.service.js";
import { publicEndpoint } from "../../tools/endpoint.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { asToolError } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";

const PAGE = 50;

/**
 * A connector without anything secret: the auth method and who holds the credential (the org or
 * each person), never the auth preset's fields or a credential. The endpoint is always the public
 * one (origin only, header names only), as the route shows readers without `connectors.manage`,
 * whatever the actor's role: the result enters a log other people read.
 */
const summary = (c: ConnectorSummary) => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  connector: c.connector,
  endpoint: publicEndpoint(c.endpoint),
  auth: {
    type: c.auth.type,
    ownership: "ownership" in c.auth ? (c.auth.ownership ?? null) : null,
  },
  status: c.status,
  platformTemplateId: c.platformTemplateId,
  updatedAt: c.updatedAt,
});

/** A connector's detail: its tools (name, description, state, default policy) and your credential state. */
const detail = (c: ConnectorDetail) => ({
  ...summary(c),
  credential: c.credential,
  tools: c.tools.map((t) => ({
    name: t.name,
    description: t.description,
    status: t.status,
    defaultPolicy: t.defaultPolicy,
    missing: t.missing,
    pendingReview: t.pending !== null,
  })),
});

/**
 * Connector operations of the `Platform` tool (spec §7): read only. Creating a connector or
 * entering a credential stays on the web (a person types credentials, spec §6.4).
 */
@Injectable()
export class ConnectorsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(ComponentScopeService) private readonly components: ComponentScopeService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "connectors.list",
        description:
          "List the org's connectors: name, protocol, endpoint, auth method and status, never credentials. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "connectors.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/connectors"],
        confirm: "read",
        run: async (input, ctx) =>
          pageOf((await this.connectors.list(ctx.orgId)).map(summary), startOf(input.cursor), PAGE),
      }),
      defineOperation({
        id: "connectors.get",
        description:
          "Read one connector: its tools with their state and default policy, and whether your credential for it is connected. Credentials are never returned; a person enters them on the connector's web page.",
        input: z.object({ connectorId: z.string().min(1).max(100) }).strict(),
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { orgAction: "connectors.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/connectors/:connectorId"],
        confirm: "read",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
        ],
        run: async (input, ctx) =>
          asToolError(async () => ({
            connector: detail(
              await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId),
            ),
          })),
      }),
      defineOperation({
        id: "connectors.templates",
        description:
          "List the platform connector templates offered to this org, with whether each is on here: the templates the web's create-from-template flow offers. Creating a connector from one needs credentials, so it is done on the web. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/components"],
        confirm: "read",
        run: async (input, ctx) => {
          const all = await this.components.orgList(ctx.orgId, { kind: "connector_template" });
          const templates = all.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            plugin: t.plugin,
            itemId: t.itemId,
            version: t.version,
            on: t.on,
            switchable: t.switchable,
            owner: t.owner,
          }));
          return pageOf(templates, startOf(input.cursor), PAGE);
        },
      }),
    ]);
  }
}
