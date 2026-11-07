import type { PluginUnavailableReason } from "../../catalog/catalog-content.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { type ErrorRole, errorRoleOf, resolveNext } from "../errors.js";
import type { OperationErrorNext } from "../operation.js";

/**
 * What an unavailable plugin or extension tells the model (Platform tool spec §14.2 problems 1
 * and 3): what is missing, and the next step for the actor's role. Only the super admin gets the
 * admin console path; nothing names a config field or carries a value.
 */

/** What is missing, per reason (model-visible English, completes "…is not running on the platform: "). */
const MISSING: Record<PluginUnavailableReason, string> = {
  plugin_disabled: "the super admin stopped the plugin on the platform",
  not_deployed: "its extension is not installed on the platform",
  needs_deployment_config: "it is installed, but its deployment config is missing or invalid",
  pending_approval: "it is installed, but its permissions wait for the super admin's approval",
  pending_migration: "the platform is still preparing it (database migration)",
  loading: "the platform is still loading it",
  dependency: "it requires an extension point that no running extension provides",
  failed: "it failed to load on the platform",
  deployment_disabled: "the super admin disabled it on the platform",
};

/** No request operation reaches the super admin for these (requests.create: enable / access only). */
const TELL_SUPER_ADMIN =
  "There is no request operation for this (requests.create covers enabling and access only), so tell the super admin directly.";

/** The member's step: inside the org, never the admin console. */
const memberNext = (name: string) =>
  `Ask an org admin: the super admin must set up ${name} on the platform before anyone in the org can use it.`;

/** The next step for an unavailable plugin or extension, keyed by role. */
export function unavailableNext(reason: PluginUnavailableReason, name: string): OperationErrorNext {
  const adminPath = `Open the admin console → Extensions → ${name}`;
  switch (reason) {
    case "loading":
    case "pending_migration":
      return `The platform is still bringing ${name} up; wait a minute and check again with plugins.get or extensions.list.`;
    case "plugin_disabled":
      return {
        superAdmin:
          "The plugin is stopped on the platform: turn it back on in the admin console under Plugins, then call again.",
        orgAdmin: "The super admin stopped this plugin on the platform; ask them.",
        member:
          "The super admin stopped this plugin on the platform; nothing can switch it on here.",
      };
    case "needs_deployment_config":
      return {
        superAdmin: `${adminPath} → fill in the deployment config; once it loads, switch the plugin on again.`,
        orgAdmin: `Only the super admin can fill in the deployment config of ${name}. ${TELL_SUPER_ADMIN}`,
        member: memberNext(name),
      };
    case "pending_approval":
      return {
        superAdmin: `${adminPath} → review and approve its permissions; once it loads, switch the plugin on again.`,
        orgAdmin: `Only the super admin can approve the permissions of ${name}. ${TELL_SUPER_ADMIN}`,
        member: memberNext(name),
      };
    case "dependency":
      return {
        superAdmin: `${adminPath} to see the extension point it requires, then install or enable an extension that provides it.`,
        orgAdmin: `Only the super admin can provide what ${name} requires. ${TELL_SUPER_ADMIN}`,
        member: memberNext(name),
      };
    case "failed":
      return {
        superAdmin: `${adminPath} to see why it failed to load; fix its deployment config or reinstall it.`,
        orgAdmin: `Only the super admin can fix ${name}, which failed to load. ${TELL_SUPER_ADMIN}`,
        member: memberNext(name),
      };
    case "deployment_disabled":
      return {
        superAdmin: `${adminPath} → enable it; once it loads, switch the plugin on again.`,
        orgAdmin: `Only the super admin can enable ${name} on the platform. ${TELL_SUPER_ADMIN}`,
        member: memberNext(name),
      };
    case "not_deployed":
      return {
        superAdmin: `Install the extension of ${name}: admin console → Extensions (or update the plugin in the admin console under Plugins), then switch it on again.`,
        orgAdmin: `Only the super admin can install the extension of ${name}. ${TELL_SUPER_ADMIN}`,
        member: memberNext(name),
      };
  }
}

/** Why it cannot be used: "The extension of plugin "X" is not running on the platform: … (reason)." */
export function unavailableMessage(reason: PluginUnavailableReason, name: string): string {
  if (reason === "plugin_disabled") return `Plugin "${name}" is unavailable: ${MISSING[reason]}.`;
  return `The extension of "${name}" is not running on the platform: ${MISSING[reason]} (${reason}).`;
}

/** The fields an unavailable list row or detail adds: the reason and the role's next step. */
export function unavailableFields(
  reason: PluginUnavailableReason | undefined,
  name: string,
  role: ErrorRole,
): { reason?: PluginUnavailableReason; next?: string } {
  if (reason === undefined) return {};
  const next = resolveNext(unavailableNext(reason, name), role);
  return { reason, ...(next !== undefined && { next }) };
}

/** The actor's role for next steps, read now (the super admin first, then an org admin). */
export async function errorRoleFor(
  db: KernelSchemaDb,
  orgId: string,
  accountId: string,
): Promise<ErrorRole> {
  const row = await db
    .selectFrom("accounts")
    .leftJoin("memberships", (j) =>
      j.onRef("memberships.account_id", "=", "accounts.id").on("memberships.org_id", "=", orgId),
    )
    .select(["accounts.is_super_admin", "accounts.status", "memberships.role"])
    .where("accounts.id", "=", accountId)
    .executeTakeFirst();
  return errorRoleOf({
    role: row?.role ?? null,
    isSuperAdmin: row?.is_super_admin === true && row.status === "active",
  });
}
