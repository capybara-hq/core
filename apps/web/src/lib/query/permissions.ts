import { getConversationPermissions, getPermissionPreview } from "../permissions";
import { defineQuery } from "./define";
import { keys } from "./keys";
import { keepNewerPermissions } from "./permission-state";

/** Owner-only direct view; callers enable this only after an authoritative ownership check. */
export const permissionsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).permissions(),
    fn: ({ signal }) => getConversationPermissions(orgId, id, signal),
    freshness: "live",
    // a slow read of an older revision never replaces a newer cached view of the same root
    keep: keepNewerPermissions,
  });

/** The selected device/project's metadata; callers without a selected device do not enable it. */
export const permissionPreviewQuery = (orgId: string, deviceId: string, project?: string) =>
  defineQuery({
    key: keys.org(orgId).permissionPreview(deviceId, project),
    fn: ({ signal }) => getPermissionPreview(orgId, deviceId, project, signal),
    freshness: "live",
  });
