import type {
  DeviceExecArgs,
  ExecResult,
  SandboxRoots,
  SandboxTier,
} from "@capybara-hq/plugin-sdk";
import { deviceTier, type TierLimits } from "../policy.js";
import type { ProxyGuardResult } from "../proxy-guard.js";
import type { Policy } from "../state.js";
import type { HostExecutor } from "./host.js";
import { DeviceOpError, type Executor } from "./types.js";

/** How one command runs: its tier and whether it runs in the sandbox. */
export interface ExecIsolation {
  tier: SandboxTier;
  /** `none`: without a sandbox ({@link HostExecutor}). */
  isolation: "sandbox" | "none";
  /** Set when the policy asks for no sandbox but the tier does not allow it: the command is refused. */
  refusal?: string;
}

/**
 * Decides how one command runs (spec §5.4). Without a sandbox only when the local policy says
 * `isolation: "none"`, the device runs in OS mode, and the command's tier (the owner's choice cut
 * to the org's ceiling) is `open`. When the policy says `none` but the tier is lower, the command
 * is refused, never run in the sandbox silently: the owner asked for no sandbox, and the kernel
 * refuses such a device in the same case (spec §4.3), so both sides say why. Docker mode ignores
 * `isolation` (its container is the isolation).
 */
export function execIsolation(
  policy: Pick<Policy, "tier" | "isolation">,
  limits: TierLimits,
  mode: Executor["mode"],
): ExecIsolation {
  const tier = deviceTier(policy, limits);
  if (mode !== "os" || policy.isolation !== "none") return { tier, isolation: "sandbox" };
  if (tier === "open") return { tier, isolation: "none" };
  return { tier, isolation: "none", refusal: unsandboxedRefusal(policy, limits, tier) };
}

/** The refusal of a command the policy asks to run without a sandbox below tier `open`. */
export function unsandboxedRefusal(
  policy: Pick<Policy, "tier">,
  limits: TierLimits,
  tier: SandboxTier,
): string {
  const chosen = policy.tier ?? limits.defaultTier ?? "strict";
  if (chosen !== "open") {
    return (
      `This device is set to run commands without a sandbox, but its tier is ${chosen}; ` +
      "running without a sandbox needs tier open. On this machine, run " +
      "capybara-device policy set tier open, or turn the sandbox back on with " +
      "capybara-device policy set isolation sandbox."
    );
  }
  return (
    "This device is set to run commands without a sandbox, but the organization allows at most " +
    `the ${tier} tier, and running without a sandbox needs tier open. The device's owner can ` +
    "turn the sandbox back on with capybara-device policy set isolation sandbox."
  );
}

/**
 * The OS-mode executor the program serves: each command runs in the OS sandbox or, when
 * {@link execIsolation} says so, without one; the policy is read per command, so a change applies
 * at the next command. File operations use the host executor's direct IO (still confined to the
 * roots) while the last command ran unsandboxed and the policy still says `none`; otherwise the
 * sandboxed helper. Kills reach both executors' commands.
 */
export class SwitchingExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  /** The last command ran without a sandbox. */
  private unsandboxed = false;

  constructor(
    private readonly sandboxed: Executor,
    /** Runs commands without a sandbox ({@link HostExecutor}). */
    private readonly host: Executor,
    private readonly policy: () => Policy,
    private readonly onSwitch?: (isolation: "sandbox" | "none") => void,
  ) {
    this.roots = sandboxed.roots;
  }

  /** The executor for file operations now. */
  private files(): Executor {
    return this.unsandboxed && this.policy().isolation === "none" ? this.host : this.sandboxed;
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const how = execIsolation(this.policy(), args.limits, "os");
    if (how.refusal !== undefined) throw new DeviceOpError("policy", how.refusal);
    const none = how.isolation === "none";
    if (none !== this.unsandboxed) {
      this.unsandboxed = none;
      this.onSwitch?.(how.isolation);
    }
    return (none ? this.host : this.sandboxed).exec(args, signal);
  }

  readFile(path: string, maxBytes: number) {
    return this.files().readFile(path, maxBytes);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.files().writeFile(path, data);
  }

  stat(path: string) {
    return this.files().stat(path);
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
}
