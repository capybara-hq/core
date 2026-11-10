/**
 * The platform-level audit actions the console labels (spec 2026-11-11-admin-overview-design.md
 * §8.4): every action the kernel's `audit()` call sites write with no org, mapped to its key under
 * `admin.audit.actions` (message keys cannot hold the action's dots). An action without an entry
 * is shown as written, in mono. Legacy names are mapped by the kernel before they get here.
 */
const AUDIT_ACTION_KEYS: Readonly<Record<string, string>> = {
  "account.created": "accountCreated",
  "account.updated": "accountUpdated",
  "identity.linked": "identityLinked",
  "identity.verified": "identityVerified",
  "identity.unlinked": "identityUnlinked",
  "deployment.settings.updated": "deploymentSettingsUpdated",
  "bootstrap.completed": "bootstrapCompleted",
  "marketplace.added": "marketplaceAdded",
  "marketplace.updated": "marketplaceUpdated",
  "marketplace.removed": "marketplaceRemoved",
  "marketplace.refreshed": "marketplaceRefreshed",
  "catalog.imported": "catalogImported",
  "catalog.plugin_staged": "catalogPluginStaged",
  "catalog.removed": "catalogRemoved",
  "catalog.scope_changed": "catalogScopeChanged",
  "catalog.shown_changed": "catalogShownChanged",
  "catalog.upload_confirmed": "catalogUploadConfirmed",
  "catalog.upload_rejected": "catalogUploadRejected",
  "catalog.upload_withdrawn": "catalogUploadWithdrawn",
  "catalog.ownership_transferred": "catalogOwnershipTransferred",
  "plugin.platform_updated": "pluginPlatformUpdated",
  "plugin.platform_update_failed": "pluginPlatformUpdateFailed",
  "component.scope_changed": "componentScopeChanged",
  "component.shown_changed": "componentShownChanged",
  "component.version_uploaded": "componentVersionUploaded",
  "component.removed": "componentRemoved",
  "extension.installed": "extensionInstalled",
  "extension.uninstalled": "extensionUninstalled",
  "extension.enabled": "extensionEnabled",
  "extension.disabled": "extensionDisabled",
  "extension.install_source_changed": "extensionInstallSourceChanged",
  "extension.package_uploaded": "extensionPackageUploaded",
  "extension.permissions_approved": "extensionPermissionsApproved",
  "extension.permissions_restored": "extensionPermissionsRestored",
  "extension.permission_denied": "extensionPermissionDenied",
  "extension.deployment_config_updated": "extensionDeploymentConfigUpdated",
  "extension.config_cleared": "extensionConfigCleared",
  "model_price.updated": "modelPriceUpdated",
  "model_price.deleted": "modelPriceDeleted",
  "model.purpose_mapped": "modelPurposeMapped",
  "model.disabled_set": "modelDisabledSet",
};

/** The `admin.audit.actions` key of `action`, or null when it has no label. */
export const auditActionKey = (action: string): string | null =>
  Object.hasOwn(AUDIT_ACTION_KEYS, action) ? (AUDIT_ACTION_KEYS[action] as string) : null;
