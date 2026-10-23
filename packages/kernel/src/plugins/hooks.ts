import {
  type AvailableHook,
  HOOKS_AVAILABLE,
  type HookHandler,
  type HookOptions,
  type HookPayloads,
  type Logger,
  POLICY_HOOKS,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { KernelConfig } from "../config/schema.js";
import { type InflightTracker, PluginUnloadedError } from "./inflight.js";

/** Default of `hooks.timeoutMs` (used when a host is built without kernel config, e.g. in tests). */
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/** Longest plugin-authored deny reason kept, in code points (the model-visible denial quotes it). */
export const HOOK_REASON_MAX_CHARS = 500;

/** In-flight observe calls allowed per plugin on one replica; overflow is dropped with a warning. */
export const OBSERVE_INFLIGHT_MAX = 64;

/** Reason used when a plugin denies with an empty (or whitespace-only) reason. */
export const EMPTY_DENY_REASON = "(no reason given)";

/** Warnings about a plugin's hooks are logged at most once per plugin, mount and kind in this window. */
const WARN_WINDOW_MS = 60_000;

/**
 * Result of running the policy hooks of a mount point. `reason` is model-visible: the plugin's own
 * (sanitized) text for `deny`, a generic sentence for `hook_error` / `timeout`. `detail` is the raw
 * error for logs and audit only, never for the model.
 */
export type HookOutcome =
  | { allowed: true }
  | {
      allowed: false;
      plugin: string;
      reason: string;
      cause: "deny" | "hook_error" | "timeout";
      detail?: string;
    };

/** A hook a plugin instance registered through `ctx.hooks.on` (kept on the instance, like tools). */
export interface RegisteredHook {
  mount: AvailableHook;
  handler: HookHandler<AvailableHook>;
  mode: HookOptions["mode"];
}

/** What the registry needs from a plugin instance (satisfied by `PluginInstance`). */
export interface HookSource {
  readonly name: string;
  readonly hooks: readonly RegisteredHook[];
  readonly inflight: InflightTracker;
}

const AVAILABLE: ReadonlySet<string> = new Set(HOOKS_AVAILABLE);
const POLICY: ReadonlySet<string> = new Set(POLICY_HOOKS);

/** Error text that never throws itself (a hostile `message` getter or `toString`). */
export function errMsg(e: unknown): string {
  try {
    return e instanceof Error ? String(e.message) : String(e);
  } catch {
    return "unprintable error";
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Sanitizes a plugin-authored deny reason for the model: control characters become spaces,
 * whitespace collapses, and the text is clipped to {@link HOOK_REASON_MAX_CHARS} code points (never
 * splitting a surrogate pair). An empty result becomes {@link EMPTY_DENY_REASON}.
 */
export function sanitizeDenyReason(raw: string): string {
  const s = raw.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (s === "") return EMPTY_DENY_REASON;
  const cps = Array.from(s);
  return cps.length > HOOK_REASON_MAX_CHARS
    ? `${cps.slice(0, HOOK_REASON_MAX_CHARS - 1).join("")}…`
    : s;
}

const failedReason = (plugin: string) => `The ${plugin} policy check failed`;
const timeoutReason = (plugin: string) => `The ${plugin} policy check did not respond in time`;

/** Deep-freezes a structured clone in place (typed arrays cannot be frozen and are left as they are). */
function deepFreeze<T>(v: T): T {
  if (typeof v !== "object" || v === null || ArrayBuffer.isView(v) || Object.isFrozen(v)) return v;
  for (const k of Reflect.ownKeys(v)) deepFreeze((v as Record<string | symbol, unknown>)[k]);
  return Object.freeze(v);
}

/** Validates a registration; throws a plain Error (permission checks happen in the ctx). */
export function checkHookRegistration(
  plugin: string,
  mount: string,
  handler: unknown,
  opts: HookOptions | undefined,
): void {
  if (!AVAILABLE.has(mount)) {
    throw new Error(
      `plugin ${plugin}: hook "${mount}" is not available (available: ${HOOKS_AVAILABLE.join(", ")})`,
    );
  }
  if (typeof handler !== "function") {
    throw new Error(`plugin ${plugin}: hook "${mount}" handler must be a function`);
  }
  const mode = opts?.mode;
  if (mode !== "observe" && mode !== "policy") {
    throw new Error(`plugin ${plugin}: hook "${mount}" needs mode "observe" or "policy"`);
  }
  if (mode === "policy" && !POLICY.has(mount)) {
    throw new Error(
      `plugin ${plugin}: hook "${mount}" cannot use mode "policy" (policy hooks: ${POLICY_HOOKS.join(", ")})`,
    );
  }
}

type CallResult =
  | { kind: "ok"; deny?: string }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

/** Rejects with the signal's reason once it aborts (never resolves otherwise). */
const abortOf = (s: AbortSignal): Promise<never> => {
  const p = new Promise<never>((_, reject) => {
    if (s.aborted) reject(s.reason);
    else s.addEventListener("abort", () => reject(s.reason), { once: true });
  });
  p.catch(() => {});
  return p;
};

/**
 * Runs the hooks of this process's **active** plugin instances (one registry per replica, like
 * tools). Hooks live on each instance (`ctx.hooks.on` records them in the instance ledger), and the
 * registry resolves them from the host's active instances on every call: after an upgrade only the
 * new generation fires, and unloading or disabling an instance stops its hooks. Every hook call runs
 * through the instance's `inflight.run`, so revocation drains it (up to `pluginHost.drainSeconds`).
 *
 * {@link run} (Ruling R11):
 * 1. If the caller's signal is aborted, throw its reason (an abort is never a deny).
 * 2. Resolve the organization's enabled plugins (every run, not cached) and make one deep-frozen
 *    `structuredClone` of the payload. If either throws (Ruling R10): with any policy hook on the
 *    mount, deny with a generic reason (`hook_error`); with only observe hooks, allow and warn.
 * 3. Policy hooks run serially by plugin name (registration order within a plugin), each limited
 *    by `hooks.timeoutMs` (read on every run, hot). `{ deny }`, an error or a timeout stops the chain
 *    and denies (`deny` / `hook_error` / `timeout`). A policy hook cut off by its instance being
 *    revoked (`PluginUnloadedError`) reruns once on the plugin's current generation, if one is active
 *    and enabled; otherwise the call is denied.
 * 4. Observe hooks (resolved again from the active instances) are then dispatched concurrently, fire-and-forget, whether or not the call was
 *    denied (never awaited on the call path). At most {@link OBSERVE_INFLIGHT_MAX} run per plugin on
 *    this replica; overflow is dropped. Their verdicts are ignored; errors, timeouts and drops are
 *    logged at most once per plugin and mount per minute (Redis counter with a TTL, shared by
 *    replicas).
 *
 * The in-flight observe counter is per replica on purpose (it bounds this process's work); it is not
 * cross-request state anybody reads back. Callers fire hooks only for chat conversations, never in
 * eval replays, and skip building the payload when {@link has} is false.
 */
export class HookRegistry {
  /** In-flight observe calls per plugin on this replica (see {@link OBSERVE_INFLIGHT_MAX}). */
  private readonly observing = new Map<string, number>();

  constructor(
    private readonly d: {
      /** The host's active instances (read on every call). */
      instances(): readonly HookSource[];
      /** The active instance of a plugin (the current generation), if any. */
      current(plugin: string): HookSource | undefined;
      enabledPlugins(orgId: string): Promise<Set<string>>;
      redis: Redis;
      config: () => Pick<KernelConfig, "hooks">;
      log: Logger;
    },
  ) {}

  /** Whether any active instance has a hook on the mount point (regardless of organization). */
  has(mount: AvailableHook): boolean {
    return this.d.instances().some((i) => i.hooks.some((h) => h.mount === mount));
  }

  /**
   * `usage.report` handlers by plugin name (delivered by the usage queue, not by {@link run}); each
   * call runs through the instance's `inflight.run`.
   */
  handlers(mount: "usage.report"): { plugin: string; handler: HookHandler<"usage.report"> }[] {
    return this.entries(mount).map(({ src, hook }) => ({
      plugin: src.name,
      handler: (payload, signal) =>
        src.inflight.run(signal, async (s) => {
          await hook.handler(payload, s);
        }),
    }));
  }

  /** Runs the hooks of a mount point (see the class comment). */
  async run<K extends Exclude<AvailableHook, "usage.report">>(
    mount: K,
    payload: HookPayloads[K],
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    if (signal.aborted) throw signal.reason;
    const all = this.entries(mount);
    if (all.length === 0) return { allowed: true };
    let enabled: Set<string>;
    let frozen: HookPayloads[K];
    try {
      enabled = await Promise.race([this.d.enabledPlugins(payload.orgId), abortOf(signal)]);
      frozen = deepFreeze(structuredClone(payload));
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      const detail = errMsg(err);
      const policy = all.find((e) => e.hook.mode === "policy");
      if (policy) {
        this.d.log.warn("plugin hooks could not run; denying the call", {
          mount,
          plugin: policy.src.name,
          error: detail,
        });
        return {
          allowed: false,
          plugin: policy.src.name,
          reason: failedReason(policy.src.name),
          cause: "hook_error",
          detail,
        };
      }
      for (const name of new Set(all.map((e) => e.src.name))) {
        void this.warnOnce(name, mount, "prepare", "plugin observe hooks skipped", detail);
      }
      return { allowed: true };
    }
    const active = all.filter((e) => enabled.has(e.src.name));
    const timeoutMs = this.d.config().hooks.timeoutMs;
    let outcome: HookOutcome = { allowed: true };
    // policy hooks grouped per plugin (entries are sorted, so groups are contiguous)
    const groups: { src: HookSource; hooks: RegisteredHook[] }[] = [];
    for (const e of active) {
      if (e.hook.mode !== "policy") continue;
      const last = groups[groups.length - 1];
      if (last && last.src === e.src) last.hooks.push(e.hook);
      else groups.push({ src: e.src, hooks: [e.hook] });
    }
    for (const g of groups) {
      const denied = await this.runPolicies(mount, g.src, g.hooks, frozen, signal, timeoutMs);
      if (denied) {
        outcome = denied;
        break;
      }
    }
    // observe hooks are resolved again now: if the plugin was upgraded while the policy hooks ran,
    // the current generation observes (the retiring one no longer accepts calls)
    for (const e of this.entries(mount)) {
      if (e.hook.mode === "observe" && enabled.has(e.src.name)) {
        this.dispatchObserve(mount, e.src, e.hook, frozen, signal);
      }
    }
    return outcome;
  }

  /** Active entries of a mount point, sorted by plugin name (stable: registration order within). */
  private entries(mount: AvailableHook): { src: HookSource; hook: RegisteredHook }[] {
    return this.d
      .instances()
      .flatMap((src) => src.hooks.filter((h) => h.mount === mount).map((hook) => ({ src, hook })))
      .sort((a, b) => (a.src.name < b.src.name ? -1 : a.src.name > b.src.name ? 1 : 0));
  }

  /** One plugin's policy hooks in registration order; reruns once on a newer generation if revoked. */
  private async runPolicies(
    mount: AvailableHook,
    src: HookSource,
    hooks: RegisteredHook[],
    payload: unknown,
    signal: AbortSignal,
    timeoutMs: number,
    rerun = false,
  ): Promise<HookOutcome | undefined> {
    const plugin = src.name;
    for (const hook of hooks) {
      if (signal.aborted) throw signal.reason;
      let r: CallResult;
      try {
        r = await src.inflight.run(signal, (s) => this.call(hook, payload, s, timeoutMs));
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof PluginUnloadedError) {
          const cur = this.d.current(plugin);
          if (!rerun && cur && cur !== src) {
            const again = cur.hooks.filter((h) => h.mount === mount && h.mode === "policy");
            return this.runPolicies(mount, cur, again, payload, signal, timeoutMs, true);
          }
        }
        r = { kind: "error", message: errMsg(err) };
      }
      if (signal.aborted) throw signal.reason;
      if (r.kind === "error") {
        this.d.log.warn("plugin policy hook failed; denying the call", {
          plugin,
          mount,
          error: r.message,
        });
        return {
          allowed: false,
          plugin,
          reason: failedReason(plugin),
          cause: "hook_error",
          detail: r.message,
        };
      }
      if (r.kind === "timeout") {
        const detail = `did not finish within ${timeoutMs} ms`;
        this.d.log.warn("plugin policy hook timed out; denying the call", {
          plugin,
          mount,
          timeoutMs,
        });
        return { allowed: false, plugin, reason: timeoutReason(plugin), cause: "timeout", detail };
      }
      if (r.deny !== undefined) {
        return { allowed: false, plugin, reason: sanitizeDenyReason(r.deny), cause: "deny" };
      }
    }
    return undefined;
  }

  /** Fire-and-forget observe call through the instance's in-flight tracker, capped per plugin. */
  private dispatchObserve(
    mount: AvailableHook,
    src: HookSource,
    hook: RegisteredHook,
    payload: unknown,
    signal: AbortSignal,
  ): void {
    const plugin = src.name;
    const n = this.observing.get(plugin) ?? 0;
    if (n >= OBSERVE_INFLIGHT_MAX) {
      void this.warnOnce(
        plugin,
        mount,
        "overflow",
        "plugin observe hook dropped: too many calls in flight",
        `limit ${OBSERVE_INFLIGHT_MAX}`,
      );
      return;
    }
    this.observing.set(plugin, n + 1);
    const timeoutMs = this.d.config().hooks.timeoutMs;
    void (async () => {
      try {
        const r = await src.inflight.run(signal, (s) => this.call(hook, payload, s, timeoutMs));
        if (r.kind === "error" || r.kind === "timeout") {
          await this.warnOnce(
            plugin,
            mount,
            "failed",
            "plugin observe hook failed; the call continued",
            r.kind === "timeout" ? `timed out after ${timeoutMs} ms` : r.message,
          );
        }
      } catch (err) {
        // the caller aborted or the instance was revoked: nothing to report to anyone
        this.d.log.info("plugin observe hook cut off", { plugin, mount, reason: errMsg(err) });
      } finally {
        const left = (this.observing.get(plugin) ?? 1) - 1;
        if (left <= 0) this.observing.delete(plugin);
        else this.observing.set(plugin, left);
      }
    })();
  }

  /**
   * Calls one handler with its own signal (aborted on timeout or when `s` aborts). Rejects with
   * `s.reason` when `s` aborts first, so callers can tell an abort from a hook failure.
   */
  private async call(
    hook: RegisteredHook,
    payload: unknown,
    s: AbortSignal,
    timeoutMs: number,
  ): Promise<CallResult> {
    const ac = new AbortController();
    const onAbort = () => ac.abort(s.reason);
    if (s.aborted) onAbort();
    else s.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const handled = Promise.resolve()
        .then(() => hook.handler(payload as HookPayloads[AvailableHook], ac.signal))
        .then(
          (v) => ({ v }),
          (err: unknown) => ({ err }),
        );
      const result = await Promise.race([handled, timedOut, abortOf(s)]);
      if (result === "timeout") {
        ac.abort(new Error(`hook timed out after ${timeoutMs} ms`));
        return { kind: "timeout" };
      }
      if ("err" in result) return { kind: "error", message: errMsg(result.err) };
      const v = result.v as unknown;
      // only `{ deny: string }` is recognized; anything else counts as "no objection"
      if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as { deny?: unknown }).deny === "string"
      ) {
        return { kind: "ok", deny: (v as { deny: string }).deny };
      }
      return { kind: "ok" };
    } finally {
      clearTimeout(timer);
      s.removeEventListener("abort", onAbort);
    }
  }

  /** Logs a warning at most once per plugin, mount and kind per minute (counter in Redis, TTL). */
  private async warnOnce(
    plugin: string,
    mount: AvailableHook,
    kind: string,
    msg: string,
    error: string,
  ): Promise<void> {
    const key = `capk:hook-warn:${plugin}:${mount}:${kind}`;
    let first = true;
    try {
      first = (await this.d.redis.set(key, "1", "PX", WARN_WINDOW_MS, "NX")) === "OK";
    } catch {
      // Redis unavailable: log anyway rather than hiding the failure
    }
    if (first) this.d.log.warn(msg, { plugin, mount, error });
  }
}
