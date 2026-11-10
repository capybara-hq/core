import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/**
 * Schemas of the super admin's routes for every org's agents and connectors (admin agents and
 * connectors spec §4.1). Ids are `text` columns, so a malformed id cannot fail the query: it is
 * bounded here (400 `validation_failed` past 100 characters) and otherwise reads as not found.
 */
const Id = z.string().min(1).max(100);

const Paging = {
  /** The last id of the previous page (the `next` of the previous response). */
  after: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

/** `GET /api/v1/admin/agents`: org filter, name search, id paging. */
export const AdminAgentListQuery = z.object({
  orgId: Id.optional(),
  q: z.string().max(200).optional(),
  ...Paging,
});

/** `GET /api/v1/admin/connectors`: org and status filters, name search, id paging. */
export const AdminConnectorListQuery = z.object({
  orgId: Id.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  q: z.string().max(200).optional(),
  ...Paging,
});

export const AgentIdParams = z.object({ agentId: Id });

export const ConnectorIdParams = z.object({ connectorId: Id });

/** The new owner: a member of the agent's org, not its anonymous guest. */
export const OwnerBody = z.object({ accountId: Id }).strict();

/** Only the status: a connector's endpoint and auth stay the org's. */
export const ConnectorStatusBody = z.object({ status: z.enum(["active", "disabled"]) }).strict();

/**
 * The routes a Platform operation mirrors. The owner transfer is excluded (human-only, as the org's
 * own transfer route), so it is not listed.
 */
export const ADMIN_ITEM_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/agents", query: AdminAgentListQuery },
  { route: "GET /api/v1/admin/agents/:agentId", params: AgentIdParams },
  { route: "DELETE /api/v1/admin/agents/:agentId", params: AgentIdParams },
  { route: "GET /api/v1/admin/connectors", query: AdminConnectorListQuery },
  { route: "GET /api/v1/admin/connectors/:connectorId", params: ConnectorIdParams },
  {
    route: "PATCH /api/v1/admin/connectors/:connectorId",
    params: ConnectorIdParams,
    body: ConnectorStatusBody,
  },
  { route: "DELETE /api/v1/admin/connectors/:connectorId", params: ConnectorIdParams },
];
