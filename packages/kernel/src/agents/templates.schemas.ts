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

export const AgentTemplateShareableBody = z.object({ shareable: z.boolean() }).strict();
export const AgentTemplateUpdateBody = z
  .object({
    /** The whole definition (the `AgentTemplate` shape), validated like a template file. */
    definition: z.record(z.string(), z.unknown()),
    /** The `version` the editor read; another one -> 409 `agent_template.version_conflict`. */
    expectedVersion: z.number().int().min(1),
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
  {
    route: "PUT /api/v1/orgs/:orgId/agent-templates/:id",
    params: AgentTemplateIdParams,
    body: AgentTemplateUpdateBody,
  },
  {
    route: "GET /api/v1/orgs/:orgId/agent-templates/:id/delete-preview",
    params: AgentTemplateIdParams,
  },
  { route: "DELETE /api/v1/orgs/:orgId/agent-templates/:id", params: AgentTemplateIdParams },
  {
    route: "PUT /api/v1/orgs/:orgId/agent-templates/:id/shareable",
    params: AgentTemplateIdParams,
    body: AgentTemplateShareableBody,
  },
];
