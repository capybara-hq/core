import type { Agent, PendingConnector } from "./agents";
import { ApiClientError, apiFetch } from "./api";
import type { CatalogRequest, ConnectorInstallInput, LocalizedName } from "./catalog";
import type { ConnectorDetail, ConnectorSummary, ToolIssue } from "./connectors";

/**
 * Pending connectors (rulings P4-6, P4-7): connectors a template needed that the org lacked. An org
 * admin binds one (an existing connector of that template or protocol, or one made for it); the
 * owner who may not configure connectors has a `connector_setup` request in the org admins' inbox.
 */

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;
const agentPath = (orgId: string, agentId: string) =>
  `${org(orgId)}/agents/${encodeURIComponent(agentId)}/pending-connectors`;

/** Binds a connector to a pending entry: a new agent version, `dropped` what it lacked. */
export const bindPendingConnector = (
  orgId: string,
  agentId: string,
  key: string,
  connectorId: string,
) =>
  apiFetch<{ agent: Agent; dropped: string[] }>(
    `${agentPath(orgId, agentId)}/${encodeURIComponent(key)}/bind`,
    { method: "POST", body: JSON.stringify({ connectorId }) },
  );

/** The agent's latest setup request, any status (owner or org admin). */
export const getPendingConnectorsRequest = (orgId: string, agentId: string) =>
  apiFetch<{ request: CatalogRequest | null }>(`${agentPath(orgId, agentId)}/request`);

/** Opens a setup request (idempotent: the pending one when there is one). */
export const requestPendingConnectors = (orgId: string, agentId: string) =>
  apiFetch<{ request: CatalogRequest }>(`${agentPath(orgId, agentId)}/request`, {
    method: "POST",
  });

/**
 * One more connector from a platform connector template on in the org (`connectors.manage`):
 * without `config.slug` the kernel picks the first free name and slug.
 */
export const addTemplateConnector = (
  orgId: string,
  templateId: string,
  input: { name?: string; config: Omit<ConnectorInstallInput, "name"> },
) =>
  apiFetch<{ connector: ConnectorDetail; issues: ToolIssue[] }>(
    `${org(orgId)}/connector-templates/${encodeURIComponent(templateId)}/connectors`,
    { method: "POST", body: JSON.stringify(input) },
  );

/** A pending entry as the agent page and the inbox dialog both show it. */
export interface PendingEntry {
  key: string;
  label: string;
  source:
    | { kind: "template"; templateId: string; displayName: LocalizedName | null }
    | { kind: "needs"; protocol: "mcp" | "openapi"; endpoint: string; tools: string[] };
  /** The tools the agent takes once bound; null = all. */
  tools: string[] | null;
}

export const entryOfPending = (p: PendingConnector): PendingEntry => ({
  key: p.key,
  label: p.label,
  source:
    "template" in p.source
      ? { kind: "template", templateId: p.source.template, displayName: null }
      : {
          kind: "needs",
          protocol: p.source.needs.protocol,
          endpoint: p.source.needs.endpoint,
          tools: p.source.needs.tools,
        },
  tools: p.tools === undefined || p.tools.length === 0 ? null : p.tools,
});

export const entryOfRequest = (
  c: NonNullable<CatalogRequest["connectors"]>[number],
): PendingEntry => ({
  key: c.key,
  label: c.label,
  source:
    "template" in c.source
      ? {
          kind: "template",
          templateId: c.source.template.id,
          displayName: c.source.template.displayName,
        }
      : {
          kind: "needs",
          protocol: c.source.needs.protocol,
          endpoint: c.source.needs.endpoint,
          tools: c.source.needs.tools,
        },
  tools: c.tools,
});

/**
 * The org's connectors a pending entry may be bound to: active ones made from that template, or,
 * for a `needs` entry, active ones of that protocol (the kernel checks the tools at bind).
 */
export function candidatesFor(
  entry: PendingEntry,
  connectors: readonly ConnectorSummary[],
): ConnectorSummary[] {
  const active = connectors.filter((c) => c.status === "active");
  return entry.source.kind === "template"
    ? active.filter(
        (c) => c.platformTemplateId === (entry.source as { templateId: string }).templateId,
      )
    : active.filter((c) => c.connector === (entry.source as { protocol: string }).protocol);
}

/** Why a bind was refused as a mismatch (`agent.pending_connector_mismatch` details). */
export type MismatchReason = "template" | "protocol" | "tools" | "not_synced";

export function mismatchReason(e: unknown): MismatchReason | null {
  if (!(e instanceof ApiClientError) || e.code !== "agent.pending_connector_mismatch") return null;
  const r = (e.rawDetails[0] as { reason?: unknown } | undefined)?.reason;
  return r === "template" || r === "protocol" || r === "tools" || r === "not_synced" ? r : null;
}

/**
 * Where the custom connector wizard opens prefilled for a `needs` entry (ruling P4-7): the
 * protocol, the endpoint and the label as the name; the wizard still answers
 * `catalog.custom_disabled` under `customConnectors = deny`.
 */
export function customConnectorHref(entry: PendingEntry): string | null {
  if (entry.source.kind !== "needs") return null;
  const q = new URLSearchParams({
    kind: entry.source.protocol,
    endpoint: entry.source.endpoint,
    name: entry.label,
    pending: "1",
  });
  return `/connectors/install?${q.toString()}`;
}
