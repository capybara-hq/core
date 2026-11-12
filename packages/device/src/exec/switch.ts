import type {
  DeviceExecArgs,
  ExecResult,
  SandboxRoots,
  SandboxTier,
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
 * mode, and the command's tier (that choice cut to the org's ceiling) is `open`. When the policy
 * says `none` but either tier is lower (or the local tier is not set), the command is refused,
 * never run in the sandbox silently: the owner asked for no sandbox, and the kernel refuses such
 * a device in the same case (spec §4.3), so both sides say why. Docker mode ignores `isolation`
 * (its container is the isolation).
 */
export function execIsolation(
  policy: Pick<Policy, "tier" | "isolation">,
  limits: TierLimits,
  mode: Executor["mode"],
): ExecIsolation {
  const tier = deviceTier(policy, limits);
  if (mode !== "os" || policy.isolation !== "none") return { tier, isolation: "sandbox" };
  if (policy.tier === "open" && tier === "open") return { tier, isolation: "none" };
  return { tier, isolation: "none", refusal: unsandboxedRefusal(policy, tier) };
}

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

/** How often the switching executor rereads the policy while it runs commands unsandboxed. */
const WATCH_INTERVAL_MS = 1000;

/**
 * The OS-mode executor the program serves: each command runs in the OS sandbox or, when
 * {@link execIsolation} says so, without one; the policy is read per operation, so a change
 * applies at once. File operations use the host executor's direct IO (still confined to the
 * roots) while the policy asks for no sandbox ({@link policyUnsandboxed}); otherwise the
 * sandboxed helper. When the policy turns the sandbox back on, every command still running
 * without one (and what it left in the background) is killed; while unsandboxed, the policy is
 * also checked every second so that happens without waiting for the next operation. Kills reach
 * both executors' commands.
 */
export class SwitchingExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  /** The policy asked for no sandbox when last checked. */
  private unsandboxed = false;
  private watch: NodeJS.Timeout | undefined;

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

  /** The executor for file operations now. */
  private async files(): Promise<Executor> {
    return (await this.sync()) ? this.host : this.sandboxed;
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const policy = this.policy();
    return this.execDecided(args, signal, execIsolation(policy, args.limits, "os"), policy);
  }

  /**
   * Runs one command as `how` decided (the caller logs the same decision). The policy it was
   * decided on is synced first, so a sandbox turned back on stops the unsandboxed commands.
   */
  async execDecided(
    args: DeviceExecArgs,
    signal: AbortSignal,
    how: ExecIsolation,
    policy: Policy = this.policy(),
  ): Promise<ExecResult> {
    signal.throwIfAborted();
    await this.sync(policy);
    if (how.refusal !== undefined) throw new DeviceOpError("policy", how.refusal);
    return (how.isolation === "none" ? this.host : this.sandboxed).exec(args, signal);
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
