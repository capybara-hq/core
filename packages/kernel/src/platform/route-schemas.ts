import type { z } from "zod";
import { AGENT_ROUTES } from "../agents/agents.schemas.js";
import { AGENT_TEMPLATE_ROUTES } from "../agents/templates.schemas.js";
import { ADMIN_CATALOG_ROUTES } from "../catalog/admin-catalog.schemas.js";
import { COMPONENT_SCOPE_ROUTES } from "../catalog/component-scope.schemas.js";
import { MARKETPLACE_ROUTES } from "../catalog/marketplaces.schemas.js";
import { ORG_CATALOG_ROUTES } from "../catalog/org-catalog.schemas.js";
import { ORG_EXTENSION_ROUTES } from "../catalog/org-extension.schemas.js";
import { SKILL_ROUTES } from "../skills/skills.schemas.js";
import { CONNECTOR_ROUTES } from "../tools/connectors.schemas.js";

/**
 * The zod schemas one HTTP route validates (spec §14.5 item 3), as its controller uses them:
 * `route` is the `check:platform-ops` key (`POST /api/v1/orgs/:orgId/skills`), `params` its path
 * params but `:orgId` (the conversation's org, never an operation field).
 */
export interface RouteSchemas {
  route: string;
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Every route a Platform operation mirrors, from the exported `<domain>.schemas.ts` next to each
 * controller. An operation builds its input from these (`pick` / `omit` / `extend`); the parity
 * test in `tools/checks` compares the two. A route mirrored by a new operation adds its entry here.
 */
export const ROUTE_SCHEMAS: readonly RouteSchemas[] = [
  ...SKILL_ROUTES,
  ...AGENT_ROUTES,
  ...AGENT_TEMPLATE_ROUTES,
  ...ORG_CATALOG_ROUTES,
  ...ADMIN_CATALOG_ROUTES,
  ...MARKETPLACE_ROUTES,
  ...CONNECTOR_ROUTES,
  ...COMPONENT_SCOPE_ROUTES,
  ...ORG_EXTENSION_ROUTES,
];
