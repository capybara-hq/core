import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import type { ConnectorAuth } from "./credentials.js";
import { endpointView } from "./endpoint.js";
import type { ToolPolicy } from "./registry.js";

/** One connector in the super admin's cross-org list (no endpoint, auth or credential). */
export interface AdminConnectorRow {
  id: string;
  orgId: string;
  orgName: string;
  name: string;
  slug: string;
  /** The connector extension (e.g. `mcp`, `openapi`). */
  connector: string;
  status: "active" | "disabled";
  platformTemplateId: string | null;
  /** The platform connector template's name (its template id in the plugin), when it exists. */
  templateName: string | null;
  catalogItemId: string | null;
  /** Counts every tool row of the connector, pending and missing ones included. */
  toolCount: number;
  toolsSyncedAt: Date | null;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The super admin's read-only connector detail. Never a credential, token or secret value, and
 * not whether any member has a credential: `auth` is the type and ownership only.
 */
export interface AdminConnectorDetail extends AdminConnectorRow {
  /** Through {@link endpointView}: large text fields as their size and sha256 only. */
  endpoint: unknown;
  auth: { type: string; ownership: "org" | "personal" | null };
  tools: {
    name: string;
    title: string | null;
    status: "enabled" | "disabled" | "pending_review";
    defaultPolicy: ToolPolicy;
  }[];
}

export interface AdminConnectorQuery {
  orgId?: string | undefined;
  status?: "active" | "disabled" | undefined;
  /** A case-insensitive substring of the connector name. */
  q?: string | undefined;
  /** The last id of the previous page. */
  after?: string | undefined;
  limit: number;
}

const notFound = () => new ApiError("connector.not_found", "Connector not found");

/**
 * Cross-org reads of connectors for the super admin (spec
 * 2026-11-10-admin-agents-connectors-design.md §3.4, §3.5). Only live connectors of live orgs;
 * the caller checks the super admin.
 */
@Injectable()
export class AdminConnectors {
  constructor(@Inject(KernelDb) private readonly kdb: KernelDb) {}

  private get db() {
    return this.kdb.db;
  }

  private base() {
    return this.db
      .selectFrom("connectors as c")
      .innerJoin("orgs as o", "o.id", "c.org_id")
      .innerJoin("accounts as a", "a.id", "c.created_by")
      .leftJoin("platform_connector_templates as pt", "pt.id", "c.platform_template_id")
      .select([
        "c.id",
        "c.org_id",
        "o.name as org_name",
        "c.name",
        "c.slug",
        "c.connector",
        "c.status",
        "c.platform_template_id",
        "pt.template_id as template_name",
        "c.catalog_item_id",
        "c.tools_synced_at",
        "c.created_by",
        "a.display_name as created_by_name",
        "c.created_at",
        "c.updated_at",
        sql<number>`(SELECT count(*)::int FROM capybara.connector_tools t
          WHERE t.connector_id = c.id)`.as("tool_count"),
      ])
      .where("c.deleted_at", "is", null)
      .where("o.deleted_at", "is", null);
  }

  /** Live connectors of every live org by id, filtered; `next` is the last id when more follow. */
  async list(q: AdminConnectorQuery): Promise<{
    connectors: AdminConnectorRow[];
    next: string | null;
  }> {
    let query = this.base();
    if (q.orgId !== undefined) query = query.where("c.org_id", "=", q.orgId);
    if (q.status !== undefined) query = query.where("c.status", "=", q.status);
    if (q.q !== undefined && q.q !== "") {
      const like = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      query = query.where(sql<boolean>`c.name ILIKE ${like} ESCAPE '\\'`);
    }
    if (q.after !== undefined) query = query.where("c.id", ">", q.after);
    const rows = await query
      .orderBy("c.id")
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit).map(toRow);
    return {
      connectors: page,
      next: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** One live connector of a live org; else `connector.not_found`. */
  async get(connectorId: string): Promise<AdminConnectorDetail> {
    const r = await this.base()
      .select(["c.endpoint", "c.auth"])
      .where("c.id", "=", connectorId)
      .executeTakeFirst();
    if (!r) throw notFound();
    const tools = await this.db
      .selectFrom("connector_tools")
      .select(["name", "spec", "status", "default_policy"])
      .where("connector_id", "=", connectorId)
      .orderBy("name")
      .execute();
    const auth = r.auth as unknown as ConnectorAuth;
    return {
      ...toRow(r),
      endpoint: endpointView(r.endpoint),
      auth: { type: auth.type, ownership: auth.type === "none" ? null : auth.ownership },
      tools: tools.map((t) => {
        const title = (t.spec as { title?: unknown }).title;
        return {
          name: t.name,
          title: typeof title === "string" ? title : null,
          status: t.status,
          defaultPolicy: t.default_policy,
        };
      }),
    };
  }
}

function toRow(r: {
  id: string;
  org_id: string;
  org_name: string;
  name: string;
  slug: string;
  connector: string;
  status: "active" | "disabled";
  platform_template_id: string | null;
  template_name: string | null;
  catalog_item_id: string | null;
  tools_synced_at: Date | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  updated_at: Date;
  tool_count: number;
}): AdminConnectorRow {
  return {
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    name: r.name,
    slug: r.slug,
    connector: r.connector,
    status: r.status,
    platformTemplateId: r.platform_template_id ?? null,
    templateName: r.template_name ?? null,
    catalogItemId: r.catalog_item_id ?? null,
    toolCount: r.tool_count,
    toolsSyncedAt: r.tools_synced_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
