import {
  type AdminAgentFilter,
  type AdminConnectorFilter,
  getAdminAgent,
  getAdminConnector,
  listAdminAgents,
  listAdminConnectors,
  listAdminOrgMembers,
} from "../admin-items";
import { defineQuery } from "./define";
import { keys } from "./keys";

// Every org's agents and connectors for the super admin (spec 2026-11-10-admin-agents-connectors
// §3, §5): deployment data, fresh for `deployment`. Hook-free (server layouts prefetch through
// these); the writes are in `admin-items-mutations.ts`.

const d = () => keys.deployment();

/**
 * A page of every org's agents under `filter` (each org / search its own entry): the first
 * (`after` omitted) or the one after a cursor ("Load more").
 */
export const adminAgentsQuery = (filter: AdminAgentFilter, after?: string) =>
  defineQuery({
    key: d().adminAgents(filter.orgId ?? "", (filter.q ?? "").trim(), after),
    fn: () => listAdminAgents(filter, after),
    freshness: "deployment",
  });

/** One agent of any org (`agent.not_found` is the page's not-found). */
export const adminAgentQuery = (id: string) =>
  defineQuery({
    key: d().adminAgent(id),
    fn: () => getAdminAgent(id).then((r) => r.agent),
    freshness: "deployment",
  });

/** The members of one org (`{ members }`, anonymous guests included: the picker leaves them out). */
export const adminOrgMembersQuery = (orgId: string) =>
  defineQuery({
    key: d().adminOrgMembers(orgId),
    fn: () => listAdminOrgMembers(orgId),
    freshness: "deployment",
  });

/** A page of every org's connectors under `filter`: the first or the one after a cursor. */
export const adminConnectorsQuery = (filter: AdminConnectorFilter, after?: string) =>
  defineQuery({
    key: d().adminConnectors(
      filter.orgId ?? "",
      filter.status ?? "",
      (filter.q ?? "").trim(),
      after,
    ),
    fn: () => listAdminConnectors(filter, after),
    freshness: "deployment",
  });

/** One connector of any org, without its credentials (`connector.not_found`: not-found). */
export const adminConnectorQuery = (id: string) =>
  defineQuery({
    key: d().adminConnector(id),
    fn: () => getAdminConnector(id).then((r) => r.connector),
    freshness: "deployment",
  });
