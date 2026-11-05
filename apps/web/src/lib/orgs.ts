import { apiFetch } from "./api";

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;

/**
 * Leave the organization (`POST …/leave`, any member; the last owner gets 409 `org.last_owner`).
 * The kernel offboards the member, which ends every session of the account: sign in again after.
 */
export const leaveOrg = (orgId: string) =>
  apiFetch<void>(`${org(orgId)}/leave`, { method: "POST" });

/** Delete the organization (`org.delete`, owners only; a soft delete). */
export const deleteOrg = (orgId: string) => apiFetch<void>(org(orgId), { method: "DELETE" });

export type ServiceTokenRole = "guest" | "member" | "admin";
export const SERVICE_TOKEN_ROLES = ["guest", "member", "admin"] as const;

/** `GET …/service-tokens` item (`org.tokens.manage`, admins, web sessions only). */
export interface ServiceToken {
  id: string;
  name: string;
  role: ServiceTokenRole | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export const listServiceTokens = (orgId: string) =>
  apiFetch<{ tokens: ServiceToken[] }>(`${org(orgId)}/service-tokens`);

/** Create a service token (role at most the actor's; the kernel re-checks). The token is returned once. */
export const createServiceToken = (
  orgId: string,
  input: { name: string; role: ServiceTokenRole; expiresAt?: string },
) =>
  apiFetch<{ token: string; record: ServiceToken }>(`${org(orgId)}/service-tokens`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const revokeServiceToken = (orgId: string, tokenId: string) =>
  apiFetch<void>(`${org(orgId)}/service-tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
