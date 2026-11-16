import { myRole, roleAtLeast } from "./members";

/** What the model-config rule reads of the viewer. */
export interface ModelConfigViewer {
  superAdmin: boolean;
  /** An admin or owner of the current org. */
  orgAdmin: boolean;
}

/** {@link ModelConfigViewer} of `GET /me`. */
export function modelConfigViewer(me: {
  account: { isSuperAdmin: boolean };
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}): ModelConfigViewer {
  return { superAdmin: me.account.isSuperAdmin, orgAdmin: roleAtLeast(myRole(me), "admin") };
}

/**
 * Why the models need configuring: `not_enabled`, the org has not turned a deployed model service
 * on (or a model is not on in it); `platform`, the platform's side (no model service, its
 * credentials, a purpose without a model).
 */
export type ModelConfigCause = "not_enabled" | "platform";

/**
 * Where a viewer fixes the models, the one rule of the setup checklist's model step and the run
 * row's "Configure model services": `not_enabled` on `/settings/models` for the org's admins,
 * `platform` on `/admin/models` for a super admin; null for anyone else (they wait).
 */
export function modelConfigHref(
  cause: ModelConfigCause,
  v: ModelConfigViewer,
): "/settings/models" | "/admin/models" | null {
  if (cause === "not_enabled") return v.orgAdmin ? "/settings/models" : null;
  return v.superAdmin ? "/admin/models" : null;
}
