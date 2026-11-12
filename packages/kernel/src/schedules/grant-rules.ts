import {
  type DeviceLocalPolicySummary,
  type SandboxLimits,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { orgAllows } from "../local-devices/network-grants.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { isFixedAsk } from "../tools/fixed-ask.js";
import type { ResolvedTool } from "../tools/registry.js";
import { changesAgentSkills } from "./unattended.js";

/**
 * The one rule for what can be a scheduled task's grant (spec §7): the task form and
 * `addGrants`, a trial run's kept approvals and the unattended policy's `missing_grants` all ask
 * it. A plain module (no provider): the tool policy imports it.
 */

/** Who asks for a grant and where: the inputs of {@link grantRefusalOf}. */
export interface GrantContext {
  role: OrgRole;
  forbiddenTools: readonly string[];
}

/**
 * Why a tool can't be a task's grant, as a code the UI words: `forbidden` (the org's
 * `forbiddenTools`), `not_grantable` (by design: a Platform call that changes the agent's
 * skills, or any other per-call key such as `Platform:<operation>`), `not_available` (not one of the agent's tools now), `needs_role` (a
 * `requiredRole` above the creator's), `fixed_ask` (always asks a person). A network grant
 * (`network:<host>`, {@link networkGrantRefusal}) adds `needs_admin` (outside the org's network
 * allowlist: only an org admin can add the host) and `device_refuses` (the task's device takes no
 * network grants from the deployment: `remoteGrants` off); an invalid or wildcard host is
 * `not_grantable`.
 */
export type GrantRefusalCode =
  | "forbidden"
  | "not_grantable"
  | "not_available"
  | "needs_role"
  | "fixed_ask"
  | "needs_admin"
  | "device_refuses";

/**
 * Why `toolKey` cannot be one of a task's grants, or null when it can: the creator could approve
 * it with scope `always` themselves (no `requiredRole` above their role, not a fixed ask), it is
 * the tool's own key (a per-call key such as `Platform:<operation>` is decided per call and never
 * a task grant), it changes none of the agent's skills (an unattended run never does) and
 * the org forbids neither the key nor the tool. `tool`: the agent's tool `toolKey` belongs to,
 * undefined when the agent does not have it now.
 */
export function grantRefusalOf(
  toolKey: string,
  tool: ResolvedTool | undefined,
  ctx: GrantContext,
): { code: GrantRefusalCode; message: string } | null {
  if (
    ctx.forbiddenTools.includes(toolKey) ||
    (tool !== undefined && ctx.forbiddenTools.includes(tool.key))
  ) {
    return {
      code: "forbidden",
      message: `The organization does not allow ${toolKey} in scheduled runs`,
    };
  }
  if (changesAgentSkills(toolKey)) {
    return {
      code: "not_grantable",
      message: `${toolKey} cannot be approved for a scheduled task: an unattended run never changes the agent's skills`,
    };
  }
  if (!tool) {
    return { code: "not_available", message: `${toolKey} is not one of the agent's tools now` };
  }
  if (toolKey !== tool.key) {
    return {
      code: "not_grantable",
      message: `${toolKey} is decided per call and cannot be approved in advance for a scheduled task`,
    };
  }
  if (tool.requiredRole !== undefined && !roleAtLeast(ctx.role, tool.requiredRole)) {
    return {
      code: "needs_role",
      message: `${toolKey} needs the ${tool.requiredRole} role to approve; you cannot approve it for the task`,
    };
  }
  if (isFixedAsk(tool)) {
    return {
      code: "fixed_ask",
      message: `${toolKey} always asks a person and cannot be approved in advance`,
    };
  }
  return null;
}

/** {@link grantRefusalOf}'s message alone; null when the tool can be granted. */
export function grantRefusal(
  toolKey: string,
  tool: ResolvedTool | undefined,
  ctx: GrantContext,
): string | null {
  return grantRefusalOf(toolKey, tool, ctx)?.message ?? null;
}

/** The prefix of a network grant's key (network ask-to-allow spec §8.1). */
export const NETWORK_GRANT_PREFIX = "network:";

/** The `spec_hash` a network grant is stored with (no tool definition behind it; plan P-D7). */
export const NETWORK_GRANT_SPEC_HASH = "network";

/** Whether a grant key is a network grant (`network:<host>`). */
export const isNetworkGrantKey = (key: string): boolean => key.startsWith(NETWORK_GRANT_PREFIX);

/** The host of a network grant key (`network:<host>`). */
export const networkGrantHost = (key: string): string => key.slice(NETWORK_GRANT_PREFIX.length);

/** What {@link networkGrantRefusal} checks a host against. */
export interface NetworkGrantContext {
  /** The org's effective sandbox egress now (`SandboxService.orgLimits`). */
  limits: Pick<SandboxLimits, "egress" | "allowHosts">;
  /**
   * The local policy summary of the task's device (its active machine); null or undefined when
   * the task has no device that can be determined or its machine is not connected: the device
   * rule is then skipped (the device still refuses at the command, and the run notes it).
   */
  deviceSummary?: DeviceLocalPolicySummary | null;
}

/**
 * Why `host` cannot be one of a task's network grants (network ask-to-allow spec §8.1), or null
 * when it can: `not_grantable` (not an exact, valid host name: no wildcard, no address),
 * `needs_admin` (the org's effective egress does not admit it: only an org admin can add it),
 * `device_refuses` (the task's device reports `remoteGrants: "off"`). The host is compared as given
 * (callers lower-case it first).
 */
export function networkGrantRefusal(
  host: string,
  ctx: NetworkGrantContext,
): { code: GrantRefusalCode; message: string } | null {
  if (host.startsWith("*.") || validateAllowHost(host).length > 0) {
    return {
      code: "not_grantable",
      message: `${host} cannot be approved for a scheduled task: give one exact domain name (no wildcard, no IP address or local name)`,
    };
  }
  if (!orgAllows(host, ctx.limits)) {
    return {
      code: "needs_admin",
      message: `${host} is not in the organization's network allowlist; only an organization admin can add it`,
    };
  }
  if (ctx.deviceSummary?.remoteGrants === "off") {
    return {
      code: "device_refuses",
      message: `The task's device does not accept network grants from the deployment; its owner can allow ${host} locally: capybara-device policy add allowedDomains ${host}`,
    };
  }
  return null;
}
