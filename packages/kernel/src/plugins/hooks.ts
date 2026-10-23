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

/** Default of `hooks.timeoutMs` (used when a host is built without kernel config, e.g. in tests). */
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/** Longest deny reason kept (the model-visible denial text quotes it). */
export const HOOK_REASON_MAX_CHARS = 500;

/** Observe-hook failures are logged at most once per plugin and mount point in this window. */
const WARN_WINDOW_MS = 60_000;

/** Result of running the hooks of a mount point. */
export type HookOutcome =
  | { allowed: true }
  | { allowed: false; plugin: string; reason: string; cause: "deny" | "hook_error" | "timeout" };

interface Entry {
  plugin: string;
  mount: AvailableHook;
  handler: HookHandler<AvailableHook>;
  mode: HookOptions["mode"];
}

const AVAILABLE: ReadonlySet<string> = new Set(HOOKS_AVAILABLE);
const POLICY: ReadonlySet<string> = new Set(POLICY_HOOKS);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string) =>
  s.length > HOOK_REASON_MAX_CHARS ? `${s.slice(0, HOOK_REASON_MAX_CHARS - 1)}…` : s;

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

/**
 * Hooks registered by the plugin instances loaded in this process (one registry per replica, like
 * tools: every replica registers its own instances' hooks). Registrations go through each instance's
 * ledger, so unloading, upgrading or disabling an instance revokes them.
 *
 * {@link run}: the hooks of a mount point run serially by plugin name (registration order within a
 * plugin), only for plugins the organization has enabled (queried on every run, not cached). Each
 * handler gets the same deep-frozen copy of the payload and its own signal, aborted when the handler
 * passes `hooks.timeoutMs` (read on every run, hot) or the caller's signal aborts. Hooks observe or
 * deny, never rewrite:
 * - `policy` (only on `model.request` / `tool.preExecute`): `{ deny }`, an error or a timeout stops
 *   the chain and denies (`deny` / `hook_error` / `timeout`);
 * - `observe`: the verdict is ignored; an error or a timeout is logged as a warning at most once per
 *   plugin and mount point per minute (the counter lives in Redis with a TTL, shared by replicas).
 *
 * Callers fire hooks only for chat conversations, never in eval replays, and skip building the
 * payload when {@link has} is false.
 */
export class HookRegistry {
  private entries: Entry[] = [];

  constructor(
    private readonly d: {
      enabledPlugins(orgId: string): Promise<Set<string>>;
      redis: Redis;
      config: () => Pick<KernelConfig, "hooks">;
      log: Logger;
    },
  ) {}

  /** Registers a hook; returns the revoke function (recorded in the instance ledger). */
  add(
    plugin: string,
    mount: AvailableHook,
    handler: HookHandler<AvailableHook>,
    opts: HookOptions,
  ): () => void {
    checkHookRegistration(plugin, mount, handler, opts);
    const entry: Entry = { plugin, mount, handler, mode: opts.mode };
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((e) => e !== entry);
    };
  }

  /** Whether any hook is registered on the mount point (regardless of organization). */
  has(mount: AvailableHook): boolean {
    return this.entries.some((e) => e.mount === mount);
  }

  /** `usage.report` handlers by plugin name (delivered by the usage queue, not by {@link run}). */
  handlers(mount: "usage.report"): { plugin: string; handler: HookHandler<"usage.report"> }[] {
    return this.sorted(mount).map((e) => ({ plugin: e.plugin, handler: e.handler }));
  }

  /** Runs the hooks of a mount point (see the class comment). */
  async run<K extends Exclude<AvailableHook, "usage.report">>(
    mount: K,
    payload: HookPayloads[K],
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    const all = this.sorted(mount);
    if (all.length === 0) return { allowed: true };
    const enabled = await this.d.enabledPlugins(payload.orgId);
    const entries = all.filter((e) => enabled.has(e.plugin));
    if (entries.length === 0) return { allowed: true };
    const frozen = deepFreeze(structuredClone(payload));
    const timeoutMs = this.d.config().hooks.timeoutMs;
    for (const e of entries) {
      const r = await this.call(e, frozen, signal, timeoutMs);
      if (e.mode === "policy") {
        if (r.kind === "error") return deny(e, `hook failed: ${r.message}`, "hook_error");
        if (r.kind === "timeout") {
          return deny(e, `hook did not finish within ${timeoutMs} ms`, "timeout");
        }
        if (r.deny !== undefined) return deny(e, r.deny, "deny");
      } else if (r.kind !== "ok") {
        await this.warnObserve(
          e,
          r.kind === "timeout" ? `timed out after ${timeoutMs} ms` : r.message,
        );
      }
    }
    return { allowed: true };
  }

  private sorted(mount: AvailableHook): Entry[] {
    // Array.prototype.sort is stable: one plugin's hooks keep their registration order
    return this.entries
      .filter((e) => e.mount === mount)
      .sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  }

  private async call(
    e: Entry,
    payload: unknown,
    outer: AbortSignal,
    timeoutMs: number,
  ): Promise<
    { kind: "ok"; deny?: string } | { kind: "error"; message: string } | { kind: "timeout" }
  > {
    const ac = new AbortController();
    const onAbort = () => ac.abort(outer.reason);
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const result = await Promise.race([
        Promise.resolve()
          .then(() => e.handler(payload as HookPayloads[AvailableHook], ac.signal))
          .then((v) => ({ v })),
        timedOut,
      ]);
      if (result === "timeout") {
        ac.abort(new Error(`hook timed out after ${timeoutMs} ms`));
        return { kind: "timeout" };
      }
      const v = result.v as unknown;
      // only `{ deny: string }` is recognized; anything else counts as "no objection"
      if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as { deny?: unknown }).deny === "string"
      ) {
        return { kind: "ok", deny: clip((v as { deny: string }).deny) };
      }
      return { kind: "ok" };
    } catch (err) {
      return { kind: "error", message: clip(errMsg(err)) };
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", onAbort);
    }
  }

  private async warnObserve(e: Entry, message: string): Promise<void> {
    const key = `capk:hook-warn:${e.plugin}:${e.mount}`;
    let first = true;
    try {
      first = (await this.d.redis.set(key, "1", "PX", WARN_WINDOW_MS, "NX")) === "OK";
    } catch {
      // Redis unavailable: log anyway rather than hiding the failure
    }
    if (first) {
      this.d.log.warn("plugin observe hook failed; the call continues", {
        plugin: e.plugin,
        mount: e.mount,
        error: message,
      });
    }
  }
}

const deny = (e: Entry, reason: string, cause: "deny" | "hook_error" | "timeout"): HookOutcome => ({
  allowed: false,
  plugin: e.plugin,
  reason: clip(reason),
  cause,
});
