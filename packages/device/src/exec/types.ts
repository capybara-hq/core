import type {
  DeviceErrorKind,
  DeviceExecArgs,
  ExecResult,
  SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import type { Policy, SandboxMode } from "../state.js";

/** How one command runs: in auto mode (no OS sandbox) or in the sandbox. */
export interface ExecMode {
  mode: SandboxMode;
}

/** Hooks of one command. */
export interface ExecHooks {
  /**
   * Called synchronously right before the command is spawned, after everything the executor
   * awaits; throwing refuses the command (nothing is spawned) with that error.
   */
  beforeSpawn?: () => void;
}

/** What runs the operations on this machine: the OS sandbox / host (os) or a container (docker). */
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
   * OS mode, an executor that can run without a sandbox: records an exec's limits, also of one
   * the policy sent to the sandbox, so file operations follow the latest decision.
   */
  noteLimits?(limits: DeviceExecArgs["limits"]): void;
  /**
   * OS mode, an executor that can run without a sandbox: runs one command as `how` (decided by
   * the caller on `policy`, and logged by it) says, instead of deciding again in {@link exec}.
   */
  execDecided?(
    args: DeviceExecArgs,
    signal: AbortSignal,
    how: ExecMode,
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
