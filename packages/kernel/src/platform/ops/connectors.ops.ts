import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ComponentScopeService } from "../../catalog/component-scope.service.js";
import { ConnectorPathParams } from "../../tools/connectors.schemas.js";
import {
  type ConnectorDetail,
  type ConnectorSummary,
  ConnectorsService,
} from "../../tools/connectors.service.js";
import { publicEndpoint } from "../../tools/endpoint.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { named, orElse } from "./summary.js";

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
 * Connector operations of the `Platform` tool (spec §7): reads, deleting a connector and
 * refreshing its tool list (org admins). Creating a connector, editing its endpoint or entering a
 * credential stays on the web (a person types credentials, spec §6.4).
 */
@Injectable()
export class ConnectorsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(ComponentScopeService) private readonly components: ComponentScopeService,
  ) {}

  private connectorName(ctx: OperationContext, connectorId: string): Promise<string> {
    return orElse(
      async () =>
        named((await this.connectors.get(ctx.orgId, connectorId, ctx.actorAccountId)).name),
      connectorId,
    );
  }

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
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) =>
          pageOf((await this.connectors.list(ctx.orgId)).map(summary), startOf(input.cursor), PAGE),
      }),
      defineOperation({
        id: "connectors.get",
        description:
          "Read one connector: its tools with their state and default policy, and whether your credential for it is connected. Credentials are never returned; a person enters them on the connector's web page.",
        input: z.object({ connectorId: ConnectorPathParams.shape.connectorId.max(100) }).strict(),
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { orgAction: "connectors.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/connectors/:connectorId"],
        confirm: "read",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
        ],
        run: async (input, ctx) => ({
          connector: detail(
            await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId),
          ),
        }),
      }),
      defineOperation({
        id: "connectors.templates",
        description:
          "List the platform connector templates offered to this org, with whether each is on here: the templates the web's create-from-template flow offers. Creating a connector from one needs credentials, so it is done on the web. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/components"],
        // connector templates only, every plugin's
        omits: ["kind", "itemId"],
        extras: ["cursor"],
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
      defineOperation({
        id: "connectors.delete",
        description:
          "Delete a connector of the org (org admins): its credentials are deleted too and agents that use it lose its tools. Creating a connector again needs its credentials entered on the web.",
        input: z.object({ connectorId: ConnectorPathParams.shape.connectorId.max(100) }).strict(),
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/connectors/:connectorId"],
        confirm: "org",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId)),
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          return {
            zh: `删除连接器「${n}」及其全部凭据；使用它的智能体将失去其工具`,
            en: `Delete connector "${n}" and all its credentials; agents that use it lose its tools`,
          };
        },
        run: async (input, ctx) => {
          await this.connectors.remove(
            ctx.orgId,
            input.connectorId,
            ctx.actorAccountId,
            undefined,
            viaAgent("connectors.delete", ctx),
          );
          return { id: input.connectorId, deleted: true };
        },
      }),
      defineOperation({
        id: "connectors.refresh",
        description:
          "Fetch the connector's tool list again (org admins) and compare it with the stored one: new or changed tools wait for review on the connector's web page, vanished tools are switched off. Returns the connector and which tools were added, changed or removed. It calls the connector's server with the org's credential, or yours for a personal one.",
        input: z.object({ connectorId: ConnectorPathParams.shape.connectorId.max(100) }).strict(),
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/connectors/:connectorId/refresh"],
        confirm: "org",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "credential.missing",
            next: "Your credential for this connector is missing: open the connector's page on the web and connect it, then refresh again.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId)),
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          return {
            zh: `刷新连接器「${n}」的工具列表（会访问该连接器的服务）`,
            en: `Refresh the tool list of connector "${n}" (calls the connector's server)`,
          };
        },
        run: async (input, ctx) => {
          const r = await this.connectors.refresh(
            ctx.orgId,
            input.connectorId,
            ctx.actorAccountId,
            undefined,
            { auditDetail: viaAgent("connectors.refresh", ctx) },
          );
          return { connector: detail(r.connector), issues: r.issues, changes: r.changes };
        },
      }),
    ]);
  }
}
