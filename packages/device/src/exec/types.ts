import type {
  DeviceErrorKind,
  DeviceExecArgs,
  ExecResult,
  SandboxRoots,
} from "@capybara-hq/plugin-sdk";

/** What runs the operations on this machine: the OS sandbox (os) or a container (docker). */
export interface Executor {
  readonly mode: "os" | "docker";
  readonly roots: SandboxRoots;
  /** Runs one command; `signal` aborting kills its whole process tree. */
  exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult>;
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
   * Creates the environment directory (and its marker file) on first use. "gone" when it existed
   * before and has vanished; it is never recreated silently.
   */
  ensureRoot(): Promise<"ok" | "gone">;
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
