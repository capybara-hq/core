import type { AgentView } from "../agents/agent-lookup.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { BUILTIN } from "../tools/builtin-names.js";
import { isFixedAsk } from "../tools/fixed-ask.js";
import type { ResolvedTool } from "../tools/registry.js";

/**
 * The one rule for what can be a scheduled task's grant (spec §7): the task form and
 * `addGrants`, a trial run's kept approvals and the unattended policy's `missing_grants` all ask
 * it. A plain module (no provider): the tool policy imports it.
 */

/** Who asks for a grant and where: the inputs of {@link grantRefusalOf}. */
export interface GrantContext {
  role: OrgRole;
  visibility: AgentView["visibility"];
  skillWritePolicy?: "allow" | "ask" | undefined;
  forbiddenTools: readonly string[];
}

/**
 * Why a tool can't be a task's grant, as a code the UI words: `forbidden` (the org's
 * `forbiddenTools`), `not_grantable` (by design: `SkillWrite`, or a per-call key such as
 * `Platform:<operation>`), `not_available` (not one of the agent's tools now), `needs_role` (a
 * `requiredRole` above the creator's), `fixed_ask` (always asks a person).
 */
export type GrantRefusalCode =
  | "forbidden"
  | "not_grantable"
  | "not_available"
  | "needs_role"
  | "fixed_ask";

/**
 * Why `toolKey` cannot be one of a task's grants, or null when it can: the creator could approve
 * it with scope `always` themselves (no `requiredRole` above their role, not a fixed ask), it is
 * the tool's own key (a per-call key such as `Platform:<operation>` is decided per call and never
 * a task grant), it is not `SkillWrite` (an unattended run never changes the agent's skills) and
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
  if (toolKey === BUILTIN.SkillWrite || tool?.key === BUILTIN.SkillWrite) {
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
  if (isFixedAsk(tool, ctx.visibility, ctx.skillWritePolicy)) {
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
