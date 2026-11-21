import {
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
/**
 * Why a device cannot run permission-scoped work, for people and for the kernel-rendered admission
 * text (ruling R9): an outdated sandbox provider plugin, or a runtime that cannot enforce the
 * sandbox. The recorded `permission_context` keeps only `{ state, reason }`.
 */
export type PermissionAvailabilityCause =
  | { kind: "provider-outdated"; plugin: string; version: string }
  | { kind: "runtime" };

/**
 * Admission's refusal of device work on a device that cannot run permission-scoped operations:
 * nothing was sent. It extends {@link SandboxPermissionUnsupportedError} (and keeps its name), so
 * every check that treats that error as a definite refusal treats this one the same way; the
 * model's text is rendered from `cause` (`admissionUnavailableText`), never from the message,
 * which is the availability reason (a provider may write it). Exported to tools from
 * `tools/builtins/sandbox/common.ts`.
 */
export class PermissionAdmissionUnavailable extends SandboxPermissionUnsupportedError {
  override readonly cause: PermissionAvailabilityCause;

  constructor(cause: PermissionAvailabilityCause, reason: string) {
    super(reason);
    this.cause = cause;
  }
}

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
 * Task 6 records provenance-bound runtime reports before user execution can be admitted. A
 * provider without the permission-scoped methods is an outdated plugin, named with its version
 * (ruling R9).
 */
export function permissionAvailabilityFor(
  provider: { impl: SandboxProvider; plugin: string; version?: string } | undefined,
): PermissionAvailability {
  if (!provider)
    return {
      state: "unsupported",
      reason: "This device's sandbox provider is not available",
      cause: { kind: "runtime" },
    };
  const { impl, plugin } = provider;
  if (
    typeof impl.operation !== "function" ||
    typeof impl.permissionSupport !== "function" ||
    typeof impl.revokeOperation !== "function"
  ) {
    const version = provider.version ?? "unknown version";
    return {
      state: "unsupported",
      reason: `This device's sandbox plugin (${plugin} ${version}) does not implement permission-scoped operations; a super admin updates it`,
      cause: { kind: "provider-outdated", plugin, version },
    };
  }
  return unprobedPermissionAvailability();
}
