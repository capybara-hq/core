import { listPluginInstalls } from "../catalog";
import { listExtensionPointDefaults } from "../extensions";
import { listInvitations } from "../members";
import { listOrgPurposes } from "../models";
import { getOrgSettings } from "../org-settings";
import { listServiceTokens } from "../orgs";
import { getOrgFilePreviewers } from "../previewers";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's settings (`/settings/organization` and `/settings/sandbox` share it). */
export const orgSettingsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).orgSettings(),
    fn: () => getOrgSettings(orgId),
    freshness: "orgConfig",
  });

/** The org's invitations (`{ invitations }`; admins only). */
export const invitationsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).invitations(),
    fn: () => listInvitations(orgId),
    freshness: "orgConfig",
  });

/** The org's model purposes (`{ purposes }`). */
export const orgPurposesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).orgPurposes(),
    fn: () => listOrgPurposes(orgId),
    freshness: "orgConfig",
  });

/** The org's file previewers (`{ items }`). */
export const orgFilePreviewersQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).orgFilePreviewers(),
    fn: () => getOrgFilePreviewers(orgId),
    freshness: "orgConfig",
  });

/** The org's `org-default` extension points and their default providers (`{ points }`; admins). */
export const extensionPointDefaultsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).extensionPointDefaults(),
    fn: () => listExtensionPointDefaults(orgId),
    freshness: "orgConfig",
  });

/** The plugins installed in the org (`{ installs }`). */
export const pluginInstallsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).pluginInstalls(),
    fn: () => listPluginInstalls(orgId),
    freshness: "orgConfig",
  });

/** The org's service tokens (`{ tokens }`). */
export const serviceTokensQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).serviceTokens(),
    fn: () => listServiceTokens(orgId),
    freshness: "mine",
  });
