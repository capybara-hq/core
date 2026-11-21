import type { SandboxPermissionSupport, SandboxProvider } from "@capybara-hq/plugin-sdk";
/**
 * Why a device cannot run permission-scoped work, for people and for the kernel-rendered admission
 * text (ruling R9): an outdated sandbox provider plugin, or a runtime that cannot enforce the
 * sandbox. The recorded `permission_context` keeps only `{ state, reason }`.
 */
export type PermissionAvailabilityCause =
  | { kind: "provider-outdated"; plugin: string; version: string }
  | { kind: "runtime" };

/** Read models never provision or probe. Runtime activation will persist provenance-bound reports. */
export type PermissionAvailability =
  | { state: "supported"; report: SandboxPermissionSupport }
  | { state: "unsupported"; reason: string; cause?: PermissionAvailabilityCause }
  | { state: "unprobed"; reason: string };
export const unprobedPermissionAvailability = (): PermissionAvailability => ({
  state: "unprobed",
  reason: "Checked when this device starts",
});

/** Method presence is only an unknown runtime candidate, never evidence of enforcement support.
 * No capability probe or lifecycle operation runs here, even for an empty or suspended device.
 * Task 6 records provenance-bound runtime reports before user execution can be admitted.
 */
export function permissionAvailabilityFor(
  provider: SandboxProvider | undefined,
): PermissionAvailability {
  if (
    !provider ||
    typeof provider.operation !== "function" ||
    typeof provider.permissionSupport !== "function" ||
    typeof provider.revokeOperation !== "function"
  )
    return {
      state: "unsupported",
      reason:
        "This provider does not implement permission-scoped operations; update its plugin or device program",
    };
  return unprobedPermissionAvailability();
}
