import type {
  NetworkBlockLayer,
  ServiceBlockedHost,
  ToolCallContext,
} from "@capybara-hq/plugin-sdk";
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
  /** An unattended run (an automation): nobody is there to answer an ask. */
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
   * A watched wait's watcher call (browser long waits spec §5.3), not a handler's: its
   * `ctx.deviceAccess.request` runs `ifRunning`, `ensureService` is refused, and refused hosts are
   * dropped (no call result carries them). Nothing reads this scope after the watcher returns.
   */
  watch?: true;
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
   * network during this call, each with the most restrictive layer reported for it
   * ({@link strongerLayer}); null when nothing was reported. `deviceId` is the device this call's
   * own `ctx.deviceAccess` calls resolved, or null when the call made none (the pipeline then asks
   * about the device the call's conversation works in); `url` is the page the refusals came from,
   * when the service said. `loopback` is the call's first loopback refusal of an extension that
   * declares `permissions.deviceAccess.loopbackPorts` (its host is in `hosts` too, as an address
   * host): the service it came from (`<extension>.<name>`), the host as reported and the port;
   * null when there was none.
   */
  blocked: {
    deviceId: string | null;
    hosts: Map<string, NetworkBlockLayer>;
    url: string | null;
    loopback: { serviceId: string; host: string; port: number } | null;
  } | null;
  /**
   * How many device starts of this call are in progress now (`ctx.deviceAccess.ensureService`:
   * the instance created or resumed, the service launched): a timeout that lands while one is
   * says the device was still starting, not that the target failed.
   */
  starting: number;
  /**
   * Whether this call sent a request to a device service (`ctx.deviceAccess.request`): its target
   * may have acted, so a timeout never claims otherwise.
   */
  reached: boolean;
}

type Scoped = ToolCallContext & { [CALL_SCOPE]?: CallScope };

/**
 * Attaches a fresh scope to the call's context (the pipeline, before the handler runs; the
 * watched-wait job before a watcher runs, with `opts.watch`).
 */
export function attachCallScope(
  ctx: ToolCallContext,
  facts?: CallFacts,
  opts: { watch?: boolean } = {},
): CallScope {
  const scope: CallScope = {
    device: null,
    review: null,
    blocked: null,
    starting: 0,
    reached: false,
    ...(facts !== undefined && { facts }),
    ...(opts.watch === true && { watch: true as const }),
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

/**
 * Whether a timeout of this call happened while its device was still starting and before it sent
 * anything to a device service (the only case the pipeline's "still starting" text may describe).
 */
export function stillStartingUnsent(scope: CallScope | undefined | null): boolean {
  return scope != null && scope.starting > 0 && !scope.reached;
}

/**
 * How restrictive a refusal layer is: `address` (no host grant lifts it) over `org` (only an
 * admin) over `device` (the device owner may be asked) over `unknown` (nothing said).
 */
const LAYER_RANK: Record<NetworkBlockLayer, number> = { unknown: 0, device: 1, org: 2, address: 3 };

/**
 * The more restrictive of two layers reported for one host: a report never makes a host more
 * grantable than another report of the same call said it was.
 */
export function strongerLayer(a: NetworkBlockLayer, b: NetworkBlockLayer): NetworkBlockLayer {
  return LAYER_RANK[b] > LAYER_RANK[a] ? b : a;
}

/** A refused host as the call scope keeps it: lower-cased, without a trailing dot. */
export function serviceHostKey(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * Two lists of a service's refused hosts as one, in first-seen order: a host in both keeps the
 * more restrictive layer ({@link strongerLayer}).
 */
export function mergeServiceHosts(
  a: readonly ServiceBlockedHost[],
  b: readonly ServiceBlockedHost[],
): ServiceBlockedHost[] {
  const out = new Map<string, NetworkBlockLayer>();
  for (const h of [...a, ...b]) {
    const key = serviceHostKey(h.host);
    const had = out.get(key);
    out.set(key, had === undefined ? h.layer : strongerLayer(had, h.layer));
  }
  return [...out].map(([host, layer]) => ({ host, layer }));
}
