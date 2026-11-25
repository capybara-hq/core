import type { ToolCallContext } from "@capybara-hq/plugin-sdk";
import type { ReviewRecord } from "../conversations/events.js";
import type { ConversationKindForHooks } from "../runtime/hook-calls.js";

/**
 * The call scope (browser use spec §7.1): what a tool handler's kernel services report about one
 * call while it runs, read by the pipeline once the handler returns, and the run facts the
 * pipeline knows about the call that the SDK context does not carry. It lives on the call's own
 * context object under {@link CALL_SCOPE}, written and read within the same call on the same
 * replica, never in a module-level map.
 */
export const CALL_SCOPE = Symbol("capybara.callScope");

/** The run facts of a call (what the command review of a device service launch needs). */
export interface CallFacts {
  runId: string;
  step: number;
  /** The root conversation of the run's tree (a sub-agent works in its root's device). */
  rootConversationId: string;
  /** An unattended run (a scheduled task): nobody is there to answer an ask. */
  unattended: boolean;
  agentVersion: number;
  conversationKind?: ConversationKindForHooks;
  /** A sub-agent's call: its parent run (hooks and the review's usage). */
  parent?: { conversationId: string; runId: string; callId: string; budgetRunId?: string };
}

export interface CallScope {
  /** Absent for a scope attached outside the pipeline (nothing reads it then). */
  facts?: CallFacts;
  /**
   * The device a `ctx.deviceAccess` call of this call resolved (`ensureService` / `request`), or
   * null when none did yet.
   */
  device: string | null;
  /**
   * The command review's record of a device service launch during this call
   * (`ctx.deviceAccess.ensureService`), written with the call's result as a reviewed `Bash`
   * call's is; null when nothing was reviewed. The last review wins.
   */
  review: ReviewRecord | null;
  /**
   * Hosts a device service (`ctx.deviceAccess.reportBlockedHosts`) saw refused by the device's
   * network allowlist during this call; null when nothing was reported. `deviceId` is the device
   * this call's own `ctx.deviceAccess` calls resolved, or null when the call made none (the
   * pipeline then asks about the device the call's conversation works in); `url` is the page the
   * refusals came from, when the service said.
   */
  blocked: { deviceId: string | null; hosts: Set<string>; url: string | null } | null;
  /**
   * How many device starts of this call are in progress now (`ctx.deviceAccess.ensureService`:
   * the instance created or resumed, the service launched): a timeout that lands while one is
   * says the device was still starting, not that the target failed.
   */
  starting: number;
}

type Scoped = ToolCallContext & { [CALL_SCOPE]?: CallScope };

/** Attaches a fresh scope to the call's context (the pipeline, before the handler runs). */
export function attachCallScope(ctx: ToolCallContext, facts?: CallFacts): CallScope {
  const scope: CallScope = {
    device: null,
    review: null,
    blocked: null,
    starting: 0,
    ...(facts !== undefined && { facts }),
  };
  (ctx as Scoped)[CALL_SCOPE] = scope;
  return scope;
}

/** The call's scope, or null for a context the pipeline did not make (no scope attached). */
export function callScopeOf(ctx: ToolCallContext): CallScope | null {
  return (ctx as Scoped)[CALL_SCOPE] ?? null;
}

/**
 * Runs `fn` as a device start of the call ({@link CallScope.starting}); a context without a scope
 * runs it as it is.
 */
export async function whileDeviceStarting<T>(
  ctx: ToolCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = callScopeOf(ctx);
  if (scope === null) return fn();
  scope.starting++;
  try {
    return await fn();
  } finally {
    scope.starting--;
  }
}
