import type { z } from "zod";
import { ADMIN_ROUTES } from "../admin/admin.schemas.js";
import { ADMIN_EXTENSION_ROUTES } from "../admin/extensions.schemas.js";
import { AGENT_ROUTES } from "../agents/agents.schemas.js";
import { AGENT_TEMPLATE_ROUTES } from "../agents/templates.schemas.js";
import { ADMIN_CATALOG_ROUTES } from "../catalog/admin-catalog.schemas.js";
import { COMPONENT_SCOPE_ROUTES } from "../catalog/component-scope.schemas.js";
import { MARKETPLACE_ROUTES } from "../catalog/marketplaces.schemas.js";
import { ORG_CATALOG_ROUTES } from "../catalog/org-catalog.schemas.js";
import { ORG_EXTENSION_ROUTES } from "../catalog/org-extension.schemas.js";
import { ORG_PLUGIN_UPLOAD_ROUTES } from "../catalog/org-plugin-uploads.schemas.js";
import { CONVERSATION_ROUTES } from "../conversations/conversations.schemas.js";
import { EXTENSION_POINT_ROUTES } from "../extensions/point-defaults.schemas.js";
import { INBOX_ROUTES } from "../inbox/inbox.schemas.js";
import { ORG_MODEL_ROUTES } from "../models/org-models.schemas.js";
import { ORG_ROUTES } from "../orgs/orgs.schemas.js";
import { SKILL_ROUTES } from "../skills/skills.schemas.js";
import { APPROVAL_ROUTES } from "../tools/approvals.schemas.js";
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
  ...CONVERSATION_ROUTES,
  // Task 7: admin accounts, orgs, deployment settings, platform models
  ...ADMIN_ROUTES,
  ...ORG_ROUTES,
  // Task 8: admin catalog, extensions, marketplaces, models, org uploads
  ...ADMIN_EXTENSION_ROUTES,
  ...ORG_PLUGIN_UPLOAD_ROUTES,
  ...EXTENSION_POINT_ROUTES,
  ...ORG_MODEL_ROUTES,
  // Task 9: inbox and pending reads
  ...INBOX_ROUTES,
  ...APPROVAL_ROUTES,
];
