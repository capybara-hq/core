import { apiFetch } from "./api";

/**
 * One internal endpoint a super admin lets an org's extension requests reach although it resolves
 * to a private address (plugin safe fetch spec): a hostname, a `*.domain` wildcard, an IP address
 * or CIDR, or an origin such as `http://mcp.internal:8080`. Who added it stays in the audit log.
 */
export interface NetworkAllowance {
  id: string;
  entry: string;
  createdAt: string;
}

const adminPath = (orgId: string) =>
  `/api/v1/admin/orgs/${encodeURIComponent(orgId)}/network-allowances`;

/** The super admin's read of an org's entries (oldest first). */
export const listAdminOrgNetworkAllowances = (orgId: string) =>
  apiFetch<{ allowances: NetworkAllowance[] }>(adminPath(orgId));

/**
 * Adds an entry (super admin, a session: the kernel refuses an API token). An invalid entry is
 * `org.network_allowance_invalid` with the reason in its details.
 */
export const addOrgNetworkAllowance = (v: { orgId: string; entry: string }) =>
  apiFetch<{ allowance: NetworkAllowance }>(adminPath(v.orgId), {
    method: "POST",
    body: JSON.stringify({ entry: v.entry }),
  });

/** Removes an entry (`org.network_allowance_not_found` when it is already gone). */
export const removeOrgNetworkAllowance = (v: { orgId: string; id: string }) =>
  apiFetch<void>(`${adminPath(v.orgId)}/${encodeURIComponent(v.id)}`, { method: "DELETE" });

/** The org admin's read-only view of the same list. */
export const listOrgNetworkAllowances = (orgId: string) =>
  apiFetch<{ allowances: NetworkAllowance[] }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/network-allowances`,
  );
