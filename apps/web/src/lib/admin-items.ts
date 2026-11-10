import type { AvatarValue } from "@capybara-hq/design";
import type {
  AgentAvatar,
  AgentDefinitionInput,
  AgentVisibility,
  PendingConnector,
} from "./agents";
import { apiFetch } from "./api";
import type { ToolPolicy } from "./connectors";
import type { ModelRef } from "./conversations";
import type { Member } from "./members";

/**
 * Every org's agents and connectors for the super admin (`/api/v1/admin/agents`,
 * `/api/v1/admin/connectors`; kernel `admin/admin-agents.controller.ts`,
 * `admin/admin-connectors.controller.ts`; spec 2026-11-10-admin-agents-connectors §3, §4.1). The
 * kernel decides who may call them; hiding them in the UI is only a convenience.
 */

/** One row of the cross-org agent list (kernel `AdminAgentRow`). */
export interface AdminAgentRow {
  id: string;
  orgId: string;
  orgName: string;
  /** The current version's name. */
  name: string;
  /** The stored avatar: an upload is served only from the org's own route. */
  avatar: AgentAvatar;
  ownerAccountId: string;
  ownerName: string;
  needsReassignment: boolean;
  visibility: AgentVisibility;
  createdFrom: { templateId: string; name: string } | null;
  updatedAt: string;
}

/** The read-only agent detail (kernel `AdminAgentDetail`): quick actions by label only. */
export interface AdminAgentDetail extends AdminAgentRow {
  profile: { description: string | null; quickActions: { label: string }[] };
  memberIds: string[] | null;
  /** The current version's definition, instructions included. */
  definition: AgentDefinitionInput & {
    fallback: ModelRef | null;
    pendingConnectors?: PendingConnector[];
  } & Record<string, unknown>;
  /** How many versions the agent has. */
  versions: number;
  createdAt: string;
  /** The skills it uses by name: selected org skills that resolve, and its own (`agent`). */
  skills: { id: string; name: string; scope: "org" | "agent" }[];
  /** The org's live connectors it uses (all but those it turns off entirely), by name. */
  connectors: { id: string; name: string; slug: string; status: "active" | "disabled" }[];
}

export interface AdminAgentsPage {
  agents: AdminAgentRow[];
  /** The `after` of the next page; null at the end. */
  next: string | null;
}

/** One row of the cross-org connector list (kernel `AdminConnectorRow`). */
export interface AdminConnectorRow {
  id: string;
  orgId: string;
  orgName: string;
  name: string;
  slug: string;
  /** The connector extension (`mcp`, `openapi`, …). */
  connector: string;
  status: "active" | "disabled";
  platformTemplateId: string | null;
  catalogItemId: string | null;
  toolCount: number;
  toolsSyncedAt: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The read-only connector detail (kernel `AdminConnectorDetail`): never a credential, nor whether a
 * member has one.
 */
export interface AdminConnectorDetail extends AdminConnectorRow {
  /** Large text fields as their size and sha256 only. */
  endpoint: unknown;
  auth: { type: string; ownership: "org" | "personal" | null };
  tools: {
    name: string;
    title: string | null;
    status: "enabled" | "disabled" | "pending_review";
    defaultPolicy: ToolPolicy;
  }[];
}

export interface AdminConnectorsPage {
  connectors: AdminConnectorRow[];
  next: string | null;
}

/** The agent list's filters (`""`: none). */
export interface AdminAgentFilter {
  orgId?: string;
  q?: string;
}

/** The connector list's filters (`""`: none). */
export interface AdminConnectorFilter {
  orgId?: string;
  status?: "active" | "disabled" | "";
  q?: string;
}

/** `?a=b&…` of the set (non-empty) values, or `""`. */
function queryOf(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

const agentPath = (id: string) => `/api/v1/admin/agents/${encodeURIComponent(id)}`;
const connectorPath = (id: string) => `/api/v1/admin/connectors/${encodeURIComponent(id)}`;

export const listAdminAgents = (filter: AdminAgentFilter, after?: string) =>
  apiFetch<AdminAgentsPage>(
    `/api/v1/admin/agents${queryOf({ orgId: filter.orgId, q: filter.q?.trim(), after })}`,
  );

export const getAdminAgent = (id: string) => apiFetch<{ agent: AdminAgentDetail }>(agentPath(id));

export const transferAdminAgent = (id: string, accountId: string) =>
  apiFetch<{ agent: AdminAgentDetail }>(`${agentPath(id)}/owner`, {
    method: "POST",
    body: JSON.stringify({ accountId }),
  });

export const deleteAdminAgent = (id: string) => apiFetch<void>(agentPath(id), { method: "DELETE" });

/** The members of any org (the owner transfer's picker). */
export const listAdminOrgMembers = (orgId: string) =>
  apiFetch<{ members: Member[] }>(`/api/v1/admin/orgs/${encodeURIComponent(orgId)}/members`);

export const listAdminConnectors = (filter: AdminConnectorFilter, after?: string) =>
  apiFetch<AdminConnectorsPage>(
    `/api/v1/admin/connectors${queryOf({
      orgId: filter.orgId,
      status: filter.status,
      q: filter.q?.trim(),
      after,
    })}`,
  );

export const getAdminConnector = (id: string) =>
  apiFetch<{ connector: AdminConnectorDetail }>(connectorPath(id));

export const setAdminConnectorStatus = (id: string, status: "active" | "disabled") =>
  apiFetch<{ connector: AdminConnectorDetail }>(connectorPath(id), {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });

export const deleteAdminConnector = (id: string) =>
  apiFetch<void>(connectorPath(id), { method: "DELETE" });

/**
 * The avatar the admin console draws for an agent of any org: a preset as itself, a migrated
 * external URL as the image; an upload is served only from the org's own route (members only),
 * so it falls back to the name's initial.
 */
export function adminAvatarValue(avatar: AgentAvatar): AvatarValue {
  if (avatar === null || avatar.kind === "upload") return null;
  if (avatar.kind === "preset") return { kind: "preset", id: avatar.id };
  return { kind: "image", src: avatar.url };
}
