import {
  type DeviceExecArgs,
  type ExecResult,
  type SandboxLimits,
  type SandboxRoots,
  type SandboxTier,
  UNSANDBOXED_NOT_ALLOWED_MESSAGE,
} from "@capybara-hq/plugin-sdk";
import { deviceTier, type TierLimits } from "../policy.js";
import type { ProxyGuardResult } from "../proxy-guard.js";
import type { Policy } from "../state.js";
import { DeviceOpError, type ExecIsolation, type Executor } from "./types.js";

export type { ExecIsolation } from "./types.js";

/**
 * Whether the local policy itself asks for no sandbox: `isolation: "none"` with the owner's own
 * tier set to `open` on this machine. A tier the deployment supplies (the org's default) never
 * counts, so the kernel can never be the last step that makes commands run unsandboxed.
 */
export function policyUnsandboxed(policy: Pick<Policy, "tier" | "isolation">): boolean {
  return policy.isolation === "none" && policy.tier === "open";
}

/**
 * Decides how one command runs (spec §5.4). Without a sandbox only when the local policy says
 * `isolation: "none"` with its own tier `open` ({@link policyUnsandboxed}), the device runs in OS
 * mode, the kernel allows it for this command (`limits.allowUnsandboxed`: the platform and the
 * org allow it and an unattended run has its grant; absent counts as not allowed), and the
 * command's tier (that choice cut to the org's ceiling) is `open`. When the policy says `none`
 * but any of those does not hold, the command is refused, never run in the sandbox silently: the
 * owner asked for no sandbox. The device enforces the kernel's decision itself, because the
 * kernel knows the local policy only from the last hello or policy op (spec §4.3); its refusal is
 * {@link UNSANDBOXED_NOT_ALLOWED_MESSAGE}, which the kernel maps to its own error. Docker mode
 * ignores `isolation` (its container is the isolation).
 */
export function execIsolation(
  policy: Pick<Policy, "tier" | "isolation">,
  limits: ExecLimits,
  mode: Executor["mode"],
): ExecIsolation {
  const tier = deviceTier(policy, limits);
  if (mode !== "os" || policy.isolation !== "none") return { tier, isolation: "sandbox" };
  if (policy.tier !== "open") {
    return { tier, isolation: "none", refusal: unsandboxedRefusal(policy, tier) };
  }
  if (limits.allowUnsandboxed !== true) {
    return { tier, isolation: "none", refusal: UNSANDBOXED_NOT_ALLOWED_MESSAGE };
  }
  if (tier === "open") return { tier, isolation: "none" };
  return { tier, isolation: "none", refusal: unsandboxedRefusal(policy, tier) };
}

/** What {@link execIsolation} reads of an exec's limits. */
export type ExecLimits = TierLimits & Pick<SandboxLimits, "allowUnsandboxed">;

/** The refusal of a command the policy asks to run without a sandbox below tier `open`. */
export function unsandboxedRefusal(policy: Pick<Policy, "tier">, tier: SandboxTier): string {
  if (policy.tier !== "open") {
    const own =
      policy.tier === undefined
        ? "its tier is not set on this machine (it follows the organization's default)"
        : `its tier is ${policy.tier}`;
    return (
      `This device is set to run commands without a sandbox, but ${own}; running without a ` +
      "sandbox needs tier open set on this machine. Run capybara-device policy set tier open, " +
      "or turn the sandbox back on with capybara-device policy set isolation sandbox."
    );
  }
  return (
    "This device is set to run commands without a sandbox, but the organization allows at most " +
    `the ${tier} tier, and running without a sandbox needs tier open. The device's owner can ` +
    "turn the sandbox back on with capybara-device policy set isolation sandbox."
  );
}

/**
 * How long the latest command's limits decide file operations. The kernel judges the org's
 * settings at each exec, and file operations carry no limits, so an unsandboxed decision older
 * than this no longer counts: file operations fall back to the sandboxed helper, which reads and
 * writes the same roots (only slower), until the next command decides again. A minute covers a
 * turn's file operations around its commands while bounding how long an org's change (or a lower
 * ceiling) takes to reach a device that runs no more commands.
 */
export const FILE_OPS_DECISION_TTL_MS = 60_000;

/** How often the switching executor rereads the policy while it runs commands unsandboxed. */
const WATCH_INTERVAL_MS = 1000;

/** The refusal of an unsandboxed command whose sandbox was turned back on before it started. */
export const SANDBOX_BACK_ON =
  "The sandbox was turned back on on this machine while the command was starting, so it did " +
  "not run. Run it again: it runs in the sandbox now.";

/**
 * The OS-mode executor the program serves: each command runs in the OS sandbox or, when
 * {@link execIsolation} says so, without one; the policy is read per operation, so a change
 * applies at once. File operations use the host executor's direct IO (still confined to the
 * roots) when the same decision, on the policy now and the latest command's limits, says no
 * sandbox; otherwise (and before any command) the sandboxed helper. When the policy turns the
 * sandbox back on, every command still running without one (and what it left in the background)
 * is killed, and one still starting is refused right before its spawn; while unsandboxed, the
 * policy is also checked every second so that happens without waiting for the next operation.
 * Kills reach both executors' commands.
 */
export class SwitchingExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  /** The policy asked for no sandbox when last checked. */
  private unsandboxed = false;
  private watch: NodeJS.Timeout | undefined;
  /** The latest command's limits and when they came (file operations follow their decision). */
  private lastLimits: ExecLimits | undefined;
  private lastLimitsAt = 0;

  constructor(
    private readonly sandboxed: Executor,
    /** Runs commands without a sandbox (the `HostExecutor`). */
    private readonly host: Executor,
    private readonly policy: () => Policy,
    private readonly onSwitch?: (isolation: "sandbox" | "none") => void,
  ) {
    this.roots = sandboxed.roots;
  }

  /**
   * Rereads the policy; on a change fires `onSwitch` and, when the sandbox came back on, kills
   * the unsandboxed commands. Returns whether the policy asks for no sandbox now.
   */
  async sync(policy: Policy = this.policy()): Promise<boolean> {
    const none = policyUnsandboxed(policy);
    if (none === this.unsandboxed) return none;
    if (none) {
      this.unsandboxed = true;
      this.watch ??= setInterval(() => void this.sync().catch(() => {}), WATCH_INTERVAL_MS);
      this.watch.unref();
      this.onSwitch?.("none");
      return none;
    }
    // Back in the sandbox only once the unsandboxed commands are gone: a failed kill keeps the
    // state (and the watch), so the next sync tries again. Routing follows the policy meanwhile.
    try {
      await this.host.killAll();
    } catch {
      return none;
    }
    // The policy may have changed again while the kill ran: the next sync judges that.
    if (!this.unsandboxed || policyUnsandboxed(this.policy())) return none;
    this.unsandboxed = false;
    if (this.watch !== undefined) clearInterval(this.watch);
    this.watch = undefined;
    this.onSwitch?.("sandbox");
    return none;
  }

  /**
   * Records an exec's limits, refused ones included, so file operations follow the latest
   * decision (see {@link FILE_OPS_DECISION_TTL_MS}).
   */
  noteLimits(limits: ExecLimits): void {
    const { tier, defaultTier, allowUnsandboxed } = limits;
    this.lastLimits = {
      tier,
      ...(defaultTier !== undefined && { defaultTier }),
      ...(allowUnsandboxed !== undefined && { allowUnsandboxed }),
    };
    this.lastLimitsAt = Date.now();
  }

  /**
   * The executor for file operations now: the commands' decision on the policy now and the latest
   * exec's limits; the sandboxed helper before any exec or once those limits are stale.
   */
  private async files(): Promise<Executor> {
    const policy = this.policy();
    await this.sync(policy);
    if (this.lastLimits === undefined) return this.sandboxed;
    if (Date.now() - this.lastLimitsAt > FILE_OPS_DECISION_TTL_MS) return this.sandboxed;
    const how = execIsolation(policy, this.lastLimits, "os");
    return how.isolation === "none" && how.refusal === undefined ? this.host : this.sandboxed;
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const policy = this.policy();
    return this.execDecided(args, signal, execIsolation(policy, args.limits, "os"), policy);
  }

  /**
   * Runs one command as `how` decided (the caller logs the same decision). The policy it was
   * decided on is synced first, so a sandbox turned back on stops the unsandboxed commands. An
   * unsandboxed command is decided again on the policy then, right before its spawn: one whose
   * sandbox came back on while it was starting is refused ({@link SANDBOX_BACK_ON}).
   */
  async execDecided(
    args: DeviceExecArgs,
    signal: AbortSignal,
    how: ExecIsolation,
    policy: Policy = this.policy(),
  ): Promise<ExecResult> {
    signal.throwIfAborted();
    this.noteLimits(args.limits);
    await this.sync(policy);
    if (how.refusal !== undefined) throw new DeviceOpError("policy", how.refusal);
    if (how.isolation !== "none") return this.sandboxed.exec(args, signal);
    const beforeSpawn = (): void => {
      const now = execIsolation(this.policy(), args.limits, "os");
      if (now.isolation !== "none" || now.refusal !== undefined) {
        throw new DeviceOpError("policy", SANDBOX_BACK_ON);
      }
    };
    return this.host.exec(args, signal, { beforeSpawn });
  }

  async readFile(path: string, maxBytes: number) {
    return (await this.files()).readFile(path, maxBytes);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    return (await this.files()).writeFile(path, data);
  }

  async stat(path: string) {
    return (await this.files()).stat(path);
  }

  async killTagged(tags: string[]): Promise<void> {
    await Promise.all([this.sandboxed.killTagged(tags), this.host.killTagged(tags)]);
  }

  async killAll(): Promise<void> {
    await Promise.all([this.sandboxed.killAll(), this.host.killAll()]);
  }

  ensureRoot(): Promise<"ok" | "gone"> {
    return this.sandboxed.ensureRoot();
  }

  /** The sandboxed executor's latest localhost proxy guard result (see `Executor`). */
  proxyGuard(): ProxyGuardResult {
    return this.sandboxed.proxyGuard?.() ?? { detected: false, reasons: [] };
  }

  /** Stops watching the policy. */
  dispose(): void {
    if (this.watch !== undefined) clearInterval(this.watch);
    this.watch = undefined;
  }
}
