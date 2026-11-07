import { AGENT_TEMPLATE_NAME_RE } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

export const AgentTemplateIdParams = z.object({ id: z.string().min(1).max(100) });
export const SaveAsAgentIdParams = z.object({ agentId: z.string().min(1).max(100) });
export const SaveAsTemplateBody = z
  .object({
    /** The bare template name (the template name rule); unique in the org's usable set. */
    name: z.string().regex(AGENT_TEMPLATE_NAME_RE),
    /** When to use it (trimmed, as a template file's). */
    description: z.string().trim().min(1).max(4096),
  })
  .strict();

export const AGENT_TEMPLATE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/agent-templates" },
  { route: "GET /api/v1/orgs/:orgId/agent-templates/:id", params: AgentTemplateIdParams },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/save-as-template",
    params: SaveAsAgentIdParams,
    body: SaveAsTemplateBody,
  },
];
