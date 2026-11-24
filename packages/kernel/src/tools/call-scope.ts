import type { ToolCallContext } from "@capybara-hq/plugin-sdk";

/**
 * The call scope (browser use spec §7.1): what a tool handler's kernel services report about one
 * call while it runs, read by the pipeline once the handler returns. It lives on the call's own
 * context object under {@link CALL_SCOPE}, written and read within the same call on the same
 * replica, never in a module-level map.
 */
export const CALL_SCOPE = Symbol("capybara.callScope");

export interface CallScope {
  /**
   * Hosts a device service (`ctx.deviceAccess.reportBlockedHosts`) saw refused by the device's
   * network allowlist during this call, on the call's device; null when nothing was reported.
   */
  blocked: { deviceId: string; hosts: Set<string> } | null;
}

type Scoped = ToolCallContext & { [CALL_SCOPE]?: CallScope };

/** Attaches a fresh scope to the call's context (the pipeline, before the handler runs). */
export function attachCallScope(ctx: ToolCallContext): CallScope {
  const scope: CallScope = { blocked: null };
  (ctx as Scoped)[CALL_SCOPE] = scope;
  return scope;
}

/** The call's scope, or null for a context the pipeline did not make (no scope attached). */
export function callScopeOf(ctx: ToolCallContext): CallScope | null {
  return (ctx as Scoped)[CALL_SCOPE] ?? null;
}
