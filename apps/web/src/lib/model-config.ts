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
 * Why the models need configuring: `org_fixable`, the org's admins can fix it here (a model service
 * the platform offers is off in the org or waits for the org's config, readiness `org_fixable`; or
 * a model is not on in the org); `credentials`, a model service's credentials failed (an org may
 * hold its own copy of them, overridable fields, else the platform's are used); `platform`, the
 * platform's side (no model service, a purpose without a model).
 */
export type ModelConfigCause = "org_fixable" | "credentials" | "platform";

/**
 * Where a viewer fixes the models, the one rule of the setup checklist's model step and the run
 * row's "Configure model services": `org_fixable` on `/settings/models` for the org's admins,
 * `credentials` there too for the org's admins (their own key, or the place to set one), else on
 * `/admin/models` for a super admin; `platform` on `/admin/models` for a super admin; null for
 * anyone else (they wait).
 */
export function modelConfigHref(
  cause: ModelConfigCause,
  v: ModelConfigViewer,
): "/settings/models" | "/admin/models" | null {
  if (cause === "org_fixable") return v.orgAdmin ? "/settings/models" : null;
  if (cause === "credentials" && v.orgAdmin) return "/settings/models";
  return v.superAdmin ? "/admin/models" : null;
}
