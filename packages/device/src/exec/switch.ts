import type {
  DeviceExecArgs,
  ExecResult,
  SandboxLimits,
  SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import { effectiveMode } from "../policy.js";
import type { Policy } from "../state.js";
import { DeviceOpError, type ExecMode, type Executor } from "./types.js";

export type { ExecMode } from "./types.js";

/**
 * How long the latest command's limits decide file operations. The kernel judges the mode at each
 * exec, and file operations carry no limits, so a decision older than this no longer counts: file
 * operations fall back to the sandboxed helper (the safe default for an organization whose ceiling
 * is sandbox), until the next command decides again. A minute covers a turn's file operations
 * around its commands while bounding how long an organization's change takes to reach a device
 * that runs no more commands.
 */
export const FILE_OPS_DECISION_TTL_MS = 60_000;

/** How often the switching executor rereads the policy while auto mode is on. */
const WATCH_INTERVAL_MS = 1000;

/** The refusal of an auto-mode command whose sandbox was turned back on before it started. */
export const SANDBOX_BACK_ON =
  "The sandbox was turned back on on this machine while the command was starting, so it did " +
  "not run. Run it again: it runs in the sandbox now.";

/**
 * The OS-mode executor the program serves: each command runs in the sandbox or, in auto mode,
 * directly on the machine ({@link effectiveMode}). The policy is read per operation, so a change
 * applies at the next command. File operations use the host executor's direct IO (any absolute
 * path in auto mode, the roots in the sandbox) only while the latest command's decision is fresh;
 * before any command, or once its limits are stale, the sandboxed helper runs (file operations
 * never pass command review, so the org's ceiling may not be exceeded). When the policy turns the
 * sandbox back on, every auto-mode command still running (and what it left in the background) is
 * killed, and one still starting is refused right before its spawn; while auto mode is on, the
 * policy is also checked every second so that happens without waiting for the next operation.
 * Kills reach both executors' commands.
 */
export class SwitchingExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  /** The policy said auto mode when last checked. */
  private auto = false;
  private watch: NodeJS.Timeout | undefined;
  /** The latest command's limits and when they came (file operations follow their decision). */
  private lastLimits: Pick<SandboxLimits, "mode"> | undefined;
  private lastLimitsAt = 0;

  constructor(
    private readonly sandboxed: Executor,
    /** Runs commands without a sandbox (the `HostExecutor`). */
    private readonly host: Executor,
    private readonly policy: () => Policy,
    private readonly onSwitch?: (mode: "auto" | "sandbox") => void,
  ) {
    this.roots = sandboxed.roots;
  }

  /**
   * Rereads the policy; on a change fires `onSwitch` and, when the sandbox came back on, kills the
   * auto-mode commands. Returns whether the policy says auto mode now.
   */
  async sync(policy: Policy = this.policy()): Promise<boolean> {
    const auto = policy.mode === "auto";
    if (auto === this.auto) return auto;
    if (auto) {
      this.auto = true;
      this.watch ??= setInterval(() => void this.sync().catch(() => {}), WATCH_INTERVAL_MS);
      this.watch.unref();
      this.onSwitch?.("auto");
      return auto;
    }
    // The sandbox is back on only once the auto-mode commands are gone: a failed kill keeps the
    // state (and the watch), so the next sync tries again. Routing follows the policy meanwhile.
    try {
      await this.host.killAll();
    } catch {
      return auto;
    }
    // The policy may have changed again while the kill ran: the next sync judges that.
    if (!this.auto || this.policy().mode === "auto") return auto;
    this.auto = false;
    if (this.watch !== undefined) clearInterval(this.watch);
    this.watch = undefined;
    this.onSwitch?.("sandbox");
    return auto;
  }

  /**
   * Records an exec's limits, refused ones included, so file operations follow the latest
   * decision (see {@link FILE_OPS_DECISION_TTL_MS}).
   */
  noteLimits(limits: Pick<SandboxLimits, "mode">): void {
    this.lastLimits = { mode: limits.mode };
    this.lastLimitsAt = Date.now();
  }

  /**
   * The executor for file operations now. File operations carry no limits and never pass command
   * review, so they only follow an exec's decision when it is fresh: the sandboxed helper before
   * any exec and once those limits are stale (the safe default for an organization whose ceiling
   * is sandbox), else `effectiveMode(policy, limits)`.
   */
  private async files(): Promise<Executor> {
    const policy = this.policy();
    await this.sync(policy);
    if (policy.mode === "sandbox" || this.lastLimits === undefined) return this.sandboxed;
    if (Date.now() - this.lastLimitsAt > FILE_OPS_DECISION_TTL_MS) return this.sandboxed;
    return effectiveMode(policy, this.lastLimits) === "auto" ? this.host : this.sandboxed;
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const policy = this.policy();
    return this.execDecided(args, signal, { mode: effectiveMode(policy, args.limits) }, policy);
  }

  /**
   * Runs one command as `how` decided (the caller logs the same decision). The policy it was
   * decided on is synced first, so a sandbox turned back on stops the auto-mode commands. An
   * auto-mode command is decided again on the policy then, right before its spawn: one whose
   * sandbox came back on while it was starting is refused ({@link SANDBOX_BACK_ON}).
   */
  async execDecided(
    args: DeviceExecArgs,
    signal: AbortSignal,
    how: ExecMode,
    policy: Policy = this.policy(),
  ): Promise<ExecResult> {
    signal.throwIfAborted();
    this.noteLimits(args.limits);
    await this.sync(policy);
    if (how.mode !== "auto") return this.sandboxed.exec(args, signal);
    const beforeSpawn = (): void => {
      if (this.policy().mode === "sandbox") throw new DeviceOpError("policy", SANDBOX_BACK_ON);
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

  /** Stops watching the policy. */
  dispose(): void {
    if (this.watch !== undefined) clearInterval(this.watch);
    this.watch = undefined;
  }
}
