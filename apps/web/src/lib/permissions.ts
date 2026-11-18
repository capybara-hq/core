import { apiFetch } from "./api";

/** The existing conversation permission HTTP contract, mirrored without kernel or SDK imports. */
export type PermissionProfile = "request-approval" | "approve-for-me" | "full-access";
export interface PermissionSelection {
  profile: PermissionProfile;
  consentScopeRevision?: string;
}
export type PermissionPatch = PermissionSelection & { expectedRevision: number };

/** Persisted runtime support is independent of consent and the device's Full access ceiling. */
export type PermissionAvailability =
  | {
      state: "supported";
      report: {
        version: 1;
        restricted: {
          filesystem: true;
          network: true;
          native: true;
          concurrentScopes: true;
        } | null;
        fullAccess: boolean;
        background: boolean;
        unavailableReason?: string;
      };
    }
  | { state: "unsupported" | "unprobed"; reason: string };

export interface PermissionPreview {
  deviceId: string;
  project: string | null;
  scopeRevision: string;
  availability: PermissionAvailability;
  fullAccessCeiling: boolean;
}

/** An owner read; a child's view names the root whose profile it inherits. */
export interface ConversationPermissions {
  profile: PermissionProfile;
  revision: number;
  rootConversationId: string;
  deviceId: string | null;
  consentScope: { deviceId: string; scopeRevision: string } | null;
  scopeRevision: string | null;
  availability: PermissionAvailability;
  fullAccessCeiling: boolean;
  startingWorkNotice: string;
}

const pathOf = (orgId: string, id: string) =>
  `/api/v1/orgs/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(id)}/permissions`;

/** Read the authoritative direct view, only after conversation ownership is known. */
export const getConversationPermissions = (orgId: string, id: string, signal?: AbortSignal) =>
  apiFetch<ConversationPermissions>(pathOf(orgId, id), { ...(signal ? { signal } : {}) });

/** A successful write returns only a revision; callers must read the authoritative view again. */
export const setConversationPermissions = (
  orgId: string,
  id: string,
  body: PermissionPatch,
  signal?: AbortSignal,
) =>
  apiFetch<{ revision: number }>(pathOf(orgId, id), {
    method: "PATCH",
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

/** Metadata only: this endpoint never provisions or probes the selected device. */
export const getPermissionPreview = (
  orgId: string,
  deviceId: string,
  project?: string,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({ deviceId });
  if (project !== undefined) query.set("project", project);
  return apiFetch<PermissionPreview>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/conversation-permission-preview?${query}`,
    { ...(signal ? { signal } : {}) },
  );
};
