import {
  type AvailableHook,
  HOOKS_AVAILABLE,
  type HookHandler,
  type HookOptions,
  type HookPayloads,
  type Logger,
  POLICY_HOOKS,
  type PolicyHook,
} from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { LockService } from "../infra/lock/lock.service.js";
import { ExtensionUnloadedError, type InflightTracker } from "./inflight.js";

/** Default of `hooks.timeoutMs` (used when a host is built without kernel config, e.g. in tests). */
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/**
 * Longest plugin-authored deny reason kept, in UTF-16 code units (the `hook_denied` event's limit;
 * the model-visible denial quotes it).
 */
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
      /**
       * R10: the hooks could not run at all (organization lookup or payload copy failed); `plugin` is
       * only the first policy plugin on the mount, not the cause.
       */
      preflight?: true;
      /**
       * M-1: `plugin` declares a policy hook on this mount (`permissions.policyHooks`), is enabled and
       * approved, but is not loaded on this replica: the call fails closed without running any hook.
       */
      notLoaded?: true;
    };

/** A hook a plugin instance registered through `ctx.hooks.on` (kept on the instance, like tools). */
export interface RegisteredHook {
  mount: AvailableHook;
  handler: HookHandler<AvailableHook>;
  mode: HookOptions["mode"];
}

/** What the registry needs from a plugin instance (satisfied by `ExtensionInstance`). */
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
 * whitespace collapses, and the text is clipped to {@link HOOK_REASON_MAX_CHARS} UTF-16 code units
 * (never splitting a surrogate pair). An empty result becomes {@link EMPTY_DENY_REASON}.
 */
export function sanitizeDenyReason(raw: string): string {
  const s = raw.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (s === "") return EMPTY_DENY_REASON;
  return clipText(s, HOOK_REASON_MAX_CHARS);
}

/** Clips to at most `max` UTF-16 code units, ending in "…", without splitting a surrogate pair. */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const cp of s) {
    if (out.length + cp.length > max - 1) break;
    out += cp;
  }
  return `${out}…`;
}

const failedReason = (plugin: string) => `The ${plugin} policy check failed`;
const unavailableReason = (plugin: string) => `The ${plugin} policy check is unavailable`;
const timeoutReason = (plugin: string) => `The ${plugin} policy check did not respond in time`;

/** Deep-freezes a structured clone in place (typed arrays cannot be frozen and are left as they are). */
export function deepFreeze<T>(v: T): T {
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

/**
 * A promise that rejects with the signal's reason once it aborts (never resolves otherwise), and a
 * cleanup that removes its listener (call it in a `finally`: callers reuse one signal for many runs).
 */
const abortOf = (s: AbortSignal): { aborted: Promise<never>; cleanup: () => void } => {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(s.reason);
    if (s.aborted) onAbort();
    else s.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  return { aborted, cleanup: () => s.removeEventListener("abort", onAbort) };
};

/** Longest raw error kept in `HookOutcome.detail` (characters). */
export const HOOK_DETAIL_MAX_CHARS = 2048;

const clipDetail = (s: string): string => clipText(s, HOOK_DETAIL_MAX_CHARS);

/**
 * Runs the hooks of this process's **active** plugin instances (one registry per replica, like
 * tools). Hooks live on each instance (`ctx.hooks.on` records them in the instance ledger), and the
 * registry resolves them from the host's active instances on every call: after an upgrade only the
 * new generation fires, and unloading or disabling an instance stops its hooks. Every hook call runs
 * through the instance's `inflight.run`, so revocation drains it (up to `extensionHost.drainSeconds`).
 *
 * {@link run} (Ruling R11):
 * 1. If the caller's signal is aborted, throw its reason (an abort is never a deny).
 * 2. Resolve the organization's enabled plugins (every run, not cached) and make one deep-frozen
 *    `structuredClone` of the payload. If either throws (Ruling R10): with any policy hook on the
 *    mount, deny with a generic reason (`hook_error`); with only observe hooks, allow and warn.
 *    If a plugin the organization enabled is expected to run policy hooks on the mount (deployment
 *    state, `expectedPolicy`) but is not loaded on this replica, deny with a generic reason
 *    (`hook_error`, `notLoaded`) without running any policy hook (M-1: fail closed). Observe hooks
 *    of plugins that are not loaded are simply missing.
 * 3. Policy hooks run serially by plugin name (registration order within a plugin), each limited
 *    by `hooks.timeoutMs` (read on every run, hot). `{ deny }`, an error or a timeout stops the chain
 *    and denies (`deny` / `hook_error` / `timeout`). A policy hook cut off by its instance being
 *    revoked (`ExtensionUnloadedError`) reruns once on the plugin's current generation, if one is active
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
      /**
       * Plugins that deployment state expects to run policy hooks on a mount point (M-1): enabled and
       * approved, with `permissions.policyHooks` listing it in the approved snapshot. In-process (refreshed by the host on every reconcile), so asking costs no
       * I/O. Absent: none.
       */
      expectedPolicy?(mount: PolicyHook): readonly string[];
      enabledPlugins(orgId: string): Promise<Set<string>>;
      /** The warn-once markers (`lease`: set unless present, with a TTL). */
      locks: Pick<LockService, "lease">;
      config: () => { hooks: Pick<KernelConfig["hooks"], "timeoutMs"> };
      log: Logger;
    },
  ) {}

  /**
   * Whether calls on the mount point need {@link run}: an active instance has a hook on it, or a plugin
   * expected to run policy hooks on it is not loaded here (M-1). In-process only (regardless of
   * organization), so callers skip building payloads and log lookups when it is false.
   */
  has(mount: AvailableHook): boolean {
    return (
      this.d.instances().some((i) => i.hooks.some((h) => h.mount === mount)) ||
      this.unloadedPolicy(mount).length > 0
    );
  }

  /**
   * Plugins expected to run policy hooks on the mount (deployment state) that have no active instance
   * on this replica, sorted by name. A loaded plugin that registered no policy hook is not listed.
   */
  private unloadedPolicy(mount: AvailableHook): string[] {
    if (!POLICY.has(mount) || !this.d.expectedPolicy) return [];
    return this.d
      .expectedPolicy(mount as PolicyHook)
      .filter((p) => this.d.current(p) === undefined)
      .sort();
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
    const unloaded = this.unloadedPolicy(mount);
    if (all.length === 0 && unloaded.length === 0) return { allowed: true };
    let enabled: Set<string>;
    let frozen: HookPayloads[K];
    let missing: string[];
    try {
      const abort = abortOf(signal);
      try {
        enabled = await Promise.race([this.d.enabledPlugins(payload.orgId), abort.aborted]);
      } finally {
        abort.cleanup();
      }
      missing = unloaded.filter((p) => enabled.has(p));
      // M-1: an enabled policy plugin is not loaded on this replica: fail closed (R10 stance);
      // observe hooks, if any, still see the denied call (below)
      if (
        missing.length > 0 &&
        !all.some((e) => e.hook.mode === "observe" && enabled.has(e.src.name))
      ) {
        return this.notLoadedDenial(mount, missing);
      }
      if (!all.some((e) => enabled.has(e.src.name))) return { allowed: true };
      // Cost: one clone + deep-freeze per call. The model.request payload carries no media bytes
      // (hookRequestOf, I-3), so it stays small. Freezing in place would freeze the logged object.
      // The clone is skipped when has() is false or no enabled plugin has a hook on this mount.
      frozen = deepFreeze(structuredClone(payload));
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      const raw = errMsg(err);
      const firstPolicy = all.find((e) => e.hook.mode === "policy")?.src.name ?? unloaded[0];
      if (firstPolicy !== undefined) {
        // R10: no plugin ran; the named plugin is only the first policy plugin on this mount, so
        // the detail says so instead of blaming it
        const detail = clipDetail(
          `Hooks could not run (organization lookup or payload copy failed) before any plugin was called; ${firstPolicy} is named only as the first policy plugin on ${mount}: ${raw}`,
        );
        this.d.log.warn("plugin hooks could not run; denying the call", {
          mount,
          firstPolicyPlugin: firstPolicy,
          error: raw,
        });
        return {
          allowed: false,
          plugin: firstPolicy,
          reason: failedReason(firstPolicy),
          cause: "hook_error",
          detail,
          preflight: true,
        };
      }
      for (const name of new Set(all.map((e) => e.src.name))) {
        void this.warnOnce(name, mount, "prepare", "plugin observe hooks skipped", raw);
      }
      return { allowed: true };
    }
    const active = all.filter((e) => enabled.has(e.src.name));
    const timeoutMs = this.d.config().hooks.timeoutMs;
    let outcome: HookOutcome =
      missing.length > 0 ? this.notLoadedDenial(mount, missing) : { allowed: true };
    // policy hooks grouped per plugin (entries are sorted, so groups are contiguous)
    const groups: { src: HookSource; hooks: RegisteredHook[] }[] = [];
    for (const e of active) {
      if (e.hook.mode !== "policy") continue;
      const last = groups[groups.length - 1];
      if (last && last.src === e.src) last.hooks.push(e.hook);
      else groups.push({ src: e.src, hooks: [e.hook] });
    }
    for (const g of outcome.allowed ? groups : []) {
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

  /**
   * The M-1 denial: `missing` (sorted) are enabled policy plugins that are not loaded on this replica.
   * The model-visible reason is generic; the detail and a throttled warning name the plugin for the
   * admin.
   */
  private notLoadedDenial(mount: AvailableHook, missing: string[]): HookOutcome {
    const plugin = missing[0] as string;
    const detail = `extension ${missing.join(", ")} declares a policy hook on ${mount} (permissions.policyHooks) and is enabled, but is not loaded on this replica; the call was denied without running any hook`;
    for (const p of missing) {
      void this.warnOnce(
        p,
        mount,
        "not-loaded",
        "policy extension not loaded on this replica; denying calls (check the extension's status in the admin console)",
        "not loaded",
      );
    }
    return {
      allowed: false,
      plugin,
      reason: unavailableReason(plugin),
      cause: "hook_error",
      detail,
      notLoaded: true,
    };
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
        if (err instanceof ExtensionUnloadedError) {
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
          detail: clipDetail(r.message),
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
    const timeoutMs = this.d.config().hooks.timeoutMs;
    this.observing.set(plugin, n + 1);
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
    const abort = abortOf(s);
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
      const result = await Promise.race([handled, timedOut, abort.aborted]);
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
      abort.cleanup();
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
      first = await this.d.locks.lease(key, "1", WARN_WINDOW_MS);
    } catch {
      // Redis unavailable: log anyway rather than hiding the failure
    }
    if (first) this.d.log.warn(msg, { plugin, mount, error });
  }
}
