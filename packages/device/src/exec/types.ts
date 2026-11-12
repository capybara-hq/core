import type {
  DeviceErrorKind,
  DeviceExecArgs,
  ExecResult,
  SandboxRoots,
  SandboxTier,
} from "@capybara-hq/plugin-sdk";
import type { ProxyGuardResult } from "../proxy-guard.js";
import type { Policy } from "../state.js";

/** How one command runs: its tier and whether it runs in the sandbox (see `exec/switch.ts`). */
export interface ExecIsolation {
  tier: SandboxTier;
  /** `none`: without a sandbox. */
  isolation: "sandbox" | "none";
  /** Set when the policy asks for no sandbox but the tiers do not allow it: the command is refused. */
  refusal?: string;
}

/** Hooks of one command. */
export interface ExecHooks {
  /**
   * Called synchronously right before the command is spawned, after everything the executor
   * awaits; throwing refuses the command (nothing is spawned) with that error.
   */
  beforeSpawn?: () => void;
}

/** What runs the operations on this machine: the OS sandbox (os) or a container (docker). */
export interface Executor {
  readonly mode: "os" | "docker";
  readonly roots: SandboxRoots;
  /**
   * Runs one command; `signal` aborting kills its whole process tree. An executor must not start
   * work on an already-aborted signal (the kernel cancelled the request). `hooks` are honoured by
   * the executor that runs commands without a sandbox; others may ignore them.
   */
  exec(args: DeviceExecArgs, signal: AbortSignal, hooks?: ExecHooks): Promise<ExecResult>;
  /** The file's bytes (at most `maxBytes`); null when it does not exist. */
  readFile(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** null when the path does not exist. */
  stat(path: string): Promise<{ size: number; isDir: boolean } | null>;
  killTagged(tags: string[]): Promise<void>;
  killAll(): Promise<void>;
  /**
   * Creates the device directory (and its marker file) on first use. "gone" when it existed
   * before and has vanished; it is never recreated silently.
   */
  ensureRoot(): Promise<"ok" | "gone">;
  /**
   * OS mode: the latest localhost proxy guard result (a local forwarding proxy turns localhost
   * off for `dev` / `open`, spec §5.2.3). Absent: none found.
   */
  proxyGuard?(): ProxyGuardResult;
  /**
   * OS mode, an executor that can run without a sandbox: runs one command as `how` (decided by
   * the caller on `policy`, and logged by it) says, instead of deciding again in {@link exec}.
   */
  execDecided?(
    args: DeviceExecArgs,
    signal: AbortSignal,
    how: ExecIsolation,
    policy: Policy,
  ): Promise<ExecResult>;
}

/** An executor failure with a protocol error kind (default `error`). */
export class DeviceOpError extends Error {
  constructor(
    readonly kind: DeviceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DeviceOpError";
  }
}
