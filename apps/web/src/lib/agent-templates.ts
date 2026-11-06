// Types and pure helpers: imported by the route table (server) and the template page (client).
import type { AgentTemplateDetail, AgentTier, TightenedPolicy } from "./agents";
import { apiFetch } from "./api";
import type { InstructionFile } from "./instruction-files";

/**
 * The org's own agent templates as the web edits them (rulings P4-9 to P4-13): the definition
 * (SDK `AgentTemplate`, mirrored: the web does not import the SDK), the owner's new versions
 * (`PUT …/agent-templates/:id`) and 另存为模板 (`POST …/agents/:id/save-as-template`).
 */

/** The effort levels a template may carry (SDK `AgentTemplate.effort`). */
export const TEMPLATE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type TemplateEffort = (typeof TEMPLATE_EFFORTS)[number];

/** A connector the template names (SDK `AgentTemplateConnector`, ruling P4-1 / P4-11). */
export type TemplateConnector =
  | { template: string; tools?: string[]; policies?: Record<string, TightenedPolicy> }
  | {
      needs: { protocol: "mcp" | "openapi"; endpoint: string; tools: string[]; label: string };
      policies?: Record<string, TightenedPolicy>;
    };

/** A sub-agent described inline (SDK `AgentTemplateInlineSubagent`; `tools` absent = all). */
export interface TemplateInlineSubagent {
  name: string;
  description: string;
  instructions: string;
  model: AgentTier;
  skills: string[];
  tools?: string[];
}

/** The definition of a template (SDK `AgentTemplate`); keys the web does not know are kept. */
export interface TemplateDefinition {
  name: string;
  description: string;
  instructions: string;
  instructionFiles?: InstructionFile[];
  quickActions?: { title: string; body: string }[];
  model?: AgentTier;
  modelRef?: string;
  effort?: TemplateEffort;
  maxSteps?: number;
  tools?: string[];
  toolPolicies?: Record<string, TightenedPolicy>;
  disallowedTools?: string[];
  /** Preloaded (pinned) skill names, at most 3. */
  skills?: string[];
  /** Further skill names the agent uses (not preloaded). */
  selectedSkills?: string[];
  connectors?: TemplateConnector[];
  subagents?: { general?: boolean; types?: string[]; inline?: TemplateInlineSubagent[] };
  [key: string]: unknown;
}

/** The SDK limits the editor hints at (the kernel judges on save). */
export const TEMPLATE_LIMITS = {
  descriptionChars: 4096,
  skills: 3,
  selectedSkills: 32,
  connectors: 16,
  connectorTools: 200,
  subagentTypes: 16,
  inlineInstructionsChars: 100_000,
  labelChars: 80,
  endpointChars: 2048,
} as const;

/** The template's definition as the web reads it. */
export const definitionOf = (t: AgentTemplateDetail): TemplateDefinition =>
  t.definition as unknown as TemplateDefinition;

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;

/**
 * A new version of the org's own template (`agents.manage`, owner-org admins): `expectedVersion`
 * is the version the edit was made on (409 `agent_template.version_conflict` otherwise); a needs
 * endpoint with userinfo, a query or a fragment is 400 `validation_failed` naming
 * `definition.connectors.<i>.needs.endpoint`.
 */
export const updateAgentTemplate = (
  orgId: string,
  id: string,
  input: { definition: TemplateDefinition; expectedVersion: number },
) =>
  apiFetch<{ template: AgentTemplateDetail }>(
    `${base(orgId)}/agent-templates/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );

/**
 * Something 另存为模板 left out (kernel `SaveAsOmission`): the kind of thing, its name, and why.
 * `field` names an inline sub-agent's setting the template has no place for.
 */
export interface SaveAsOmission {
  kind:
    | "subagent_agent"
    | "subagent_template"
    | "subagent_inline"
    | "skill"
    | "connector"
    | "tool"
    | "tool_policy"
    | (string & {});
  name: string;
  id?: string;
  field?: string;
  reason:
    | "org_agent"
    | "unavailable"
    | "agent_skill"
    | "no_endpoint"
    | "unsupported_protocol"
    | "limit"
    | "connector_tool"
    | "unsupported_field"
    | (string & {});
}

/** 另存为模板 (`agents.manage`, org admins): 201 with the new template and what was left out. */
export const saveAgentAsTemplate = (
  orgId: string,
  agentId: string,
  input: { name: string; description: string },
) =>
  apiFetch<{ template: AgentTemplateDetail; omitted: SaveAsOmission[] }>(
    `${base(orgId)}/agents/${encodeURIComponent(agentId)}/save-as-template`,
    { method: "POST", body: JSON.stringify(input) },
  );

/** The bare-name rule of a template (SDK `AGENT_TEMPLATE_NAME_RE`). */
export const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A template name from an agent's name: lower case, every run of other characters one `-`, no
 * leading or trailing `-`, at most 64 characters. A name with nothing usable (all CJK) gives "".
 */
export function templateNameFrom(agentName: string): string {
  return agentName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** Why a 409 `agent_template.name_taken` refused a name (its first detail). */
export type NameTaken =
  | { reserved: true }
  | { owner: { kind: "platform" } | { kind: "org"; orgId: string; name: string } }
  | null;

export function nameTakenOf(rawDetails: readonly unknown[]): NameTaken {
  const d = rawDetails[0];
  if (d === null || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  if (r.reserved === true) return { reserved: true };
  const o = r.owner as Record<string, unknown> | undefined;
  if (o?.kind === "platform") return { owner: { kind: "platform" } };
  if (o?.kind === "org" && typeof o.orgId === "string" && typeof o.name === "string") {
    return { owner: { kind: "org", orgId: o.orgId, name: o.name } };
  }
  return null;
}

/**
 * What the kernel would say about a needs endpoint (ruling P4-11, the PUT's check mirrored):
 * `invalid` (no http(s) URL of at most 2048 characters), `carries` (userinfo, a query or a
 * fragment, with the clean form to use), or null when it is accepted (a form that differs only by
 * normalization is stored canonical by the kernel).
 */
export type EndpointProblem =
  | { kind: "invalid" }
  | { kind: "carries"; parts: ("userinfo" | "query" | "fragment")[]; clean: string };

export function endpointProblem(raw: string): EndpointProblem | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { kind: "invalid" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { kind: "invalid" };
  const parts: ("userinfo" | "query" | "fragment")[] = [
    ...(u.username !== "" || u.password !== "" ? (["userinfo"] as const) : []),
    ...(u.search !== "" ? (["query"] as const) : []),
    ...(u.hash !== "" ? (["fragment"] as const) : []),
  ];
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  const clean = u.toString();
  if (clean.length > TEMPLATE_LIMITS.endpointChars) return { kind: "invalid" };
  return parts.length === 0 ? null : { kind: "carries", parts, clean };
}

/** The connector index of a `definition.connectors.<i>.needs.endpoint` problem path, else null. */
export function endpointIndexOf(path: string): number | null {
  const m = /^definition\.connectors\.(\d+)\.needs\.endpoint$/.exec(path);
  return m === null ? null : Number(m[1]);
}
