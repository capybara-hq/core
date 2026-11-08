/**
 * Sandbox contract `sandbox@2`: a single-select, brokered extension point (extensions may not
 * `requires` it; the kernel's `SandboxService` consumes it). The provider implements only the
 * primitives below; the kernel builds `glob` / `grep` / `edit` from `exec` plus `readFile` /
 * `writeFile`.
 *
 * `@2` separates an environment's **file system** from its **instance**: the file system
 * (`createFileSystem`) lives until the environment is deleted (`destroyFileSystem`); instances
 * (`create`) attach to it and come and go (`destroy` drops the instance and keeps the files).
 */

/** Sandbox extension point ref. */
export const SANDBOX_EXTENSION_POINT = "sandbox@2";

/** The roots inside the sandbox the model may access. */
export const SANDBOX_ROOTS = ["/workspace", "/skills", "/tmp"] as const;

const MAX_PATH_LENGTH = 4096;

/** Sandbox resource and egress limits. */
export interface SandboxLimits {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  egress: "none" | "allowlist" | "open";
  /** Egress allowlist (used when `egress` is `allowlist`); each entry passes {@link validateAllowHost}. */
  allowHosts: string[];
}

/** The absolute roots inside one instance (a device may place them anywhere on its host). */
export interface SandboxRoots {
  workspace: string;
  skills: string;
  tmp: string;
}

/** The roots every container-like provider uses. */
export const DEFAULT_SANDBOX_ROOTS: SandboxRoots = {
  workspace: "/workspace",
  skills: "/skills",
  tmp: "/tmp",
};

/** The provider's instance handle. */
export interface SandboxHandle {
  /** The provider's instance id. */
  id: string;
  /** The instance's roots; absent means {@link DEFAULT_SANDBOX_ROOTS}. */
  roots?: SandboxRoots;
}

/** The roots of an instance, falling back to {@link DEFAULT_SANDBOX_ROOTS}. */
export function rootsOf(h: SandboxHandle): SandboxRoots {
  return h.roots ?? DEFAULT_SANDBOX_ROOTS;
}

/** The provider's file system handle (an environment's files, independent of any instance). */
export interface FileSystemHandle {
  /** The provider's file system id. */
  id: string;
}

/** Who runs an `exec` (informational in phase 1: audit and attribution). */
export interface SandboxActor {
  accountId: string;
  conversationId: string;
}

/** Result of a command. */
export interface ExecResult {
  /** null on timeout or when aborted while running (`timedOut` is then true / false). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * The instance is definitely gone on the provider's side (container removed, E2B sandbox expired).
 * `exec` / `readFile` / `writeFile` / `stat` must throw it (not a plain Error) when they find the
 * instance gone; the kernel then rebuilds the instance and retries once. A transient connection
 * failure throws a plain error.
 */
export class SandboxGoneError extends Error {
  readonly sandboxGone = true as const;

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "SandboxGoneError";
  }
}

/** Duck-typed check (not instanceof), so a plugin bundling another plugin-sdk copy still matches. */
export function isSandboxGoneError(e: unknown): e is SandboxGoneError {
  return (
    e instanceof Error &&
    e.name === "SandboxGoneError" &&
    (e as { sandboxGone?: unknown }).sandboxGone === true
  );
}

/**
 * The file system is definitely gone on the provider's side (volume removed, E2B sandbox killed).
 * `create` throws it instead of attaching the instance to a new, empty file system; the kernel then
 * reports the environment's files as lost rather than handing out a silently empty workspace.
 */
export class FileSystemGoneError extends Error {
  readonly fileSystemGone = true as const;

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "FileSystemGoneError";
  }
}

/** Duck-typed check (not instanceof), so a plugin bundling another plugin-sdk copy still matches. */
export function isFileSystemGoneError(e: unknown): e is FileSystemGoneError {
  return (
    e instanceof Error &&
    e.name === "FileSystemGoneError" &&
    (e as { fileSystemGone?: unknown }).fileSystemGone === true
  );
}

/**
 * A holder tag (`exec` argument `tag`, {@link SandboxProvider.killTagged}): the kernel passes its
 * lease tokens (UUIDs). Providers check tags against it before putting them in a command line or a
 * kill pattern.
 */
export const SANDBOX_TAG_RE = /^[a-z0-9-]{1,64}$/;

/**
 * The `sandbox@2` implementation (provided by a sandbox plugin such as Docker or E2B).
 *
 * **File systems and instances.** `createFileSystem` makes an environment's files; they live until
 * `destroyFileSystem` (the environment is deleted). `create` makes an instance attached to an
 * existing file system; `destroy` / `destroyByName` drop the instance only and keep the files, and
 * `suspend` keeps them too. When the file system is gone, `create` must throw
 * {@link FileSystemGoneError} and never create an empty one in its place (a Docker provider checks
 * its volumes exist before mounting them, because Docker would otherwise create empty volumes).
 *
 * **Gone instances.** When the instance is definitely gone: `resume` returns `gone`; `exec` /
 * `readFile` / `writeFile` / `stat` / `killAll` / `killTagged` throw {@link SandboxGoneError};
 * `suspend` / `destroy` succeed as usual.
 *
 * **Auto-start**: when the instance still exists but is stopped or paused (for a reason outside the
 * kernel: host or daemon restart, a process in the sandbox stopping its init, an idle sweep that
 * stopped the instance before recording `suspended`...), `exec` / `readFile` / `writeFile` /
 * `stat` / `killAll` / `killTagged` must start it transparently first (like `resume`, files kept)
 * and then run, never fail: the kernel trusts only the `running` it recorded itself. Auto-start
 * must be idempotent under concurrent calls: two calls that both find the instance stopped both
 * start it without failing.
 *
 * **Time limits apply inside the sandbox too**: besides stopping a command after `timeoutMs` on the
 * provider's side, `exec` must make the command in the sandbox kill itself shortly (a few seconds)
 * after `timeoutMs`. When a kernel replica crashes, the provider-side timer goes with it, and a
 * dropped connection does not end the command; the in-sandbox limit keeps it from running
 * indefinitely next to the next holder's commands.
 *
 * **Abort**: every method must respond to `signal` promptly (fail at once when already aborted, end
 * with the abort reason as soon as possible when aborted mid-way): the kernel relies on it to stop
 * on lock loss, run abort or timeout, and ignoring it may let two holders operate on one instance.
 * An aborted `exec` must kill its running command (and the processes it spawned), not just stop
 * waiting for its output; an `exec` aborted after its command started resolves normally with
 * `exitCode: null`, `timedOut: false` (and the output collected so far), it does not reject. An
 * `exec` called with an already aborted signal rejects at once.
 *
 * **Concurrent use** (required in `@2`): the sessions of one environment share its instance, so the
 * kernel calls `exec`, `readFile`, `writeFile` and `stat` concurrently on one instance. Those four
 * methods must be safe to call concurrently. Each `exec` labels its command with its `tag`, and an
 * aborted `exec` kills only its own command.
 */
export interface SandboxProvider {
  /** `exec` / `readFile` / `writeFile` / `stat` may run concurrently on one instance (required). */
  readonly concurrentExec: true;
  /**
   * Whether the provider isolates the sessions of one environment from each other inside the
   * instance (a declared capability; absent means false).
   */
  readonly sessionIsolation?: boolean;
  /**
   * Creates an environment's file system. `name` looks like `cap-env-<environmentId>`. If a file
   * system with this name already exists, return it.
   */
  createFileSystem(args: {
    name: string;
    limits: SandboxLimits;
    signal: AbortSignal;
  }): Promise<FileSystemHandle>;
  /** Deletes the file system and its files. Succeeds when it does not exist. */
  destroyFileSystem(fs: FileSystemHandle, signal: AbortSignal): Promise<void>;
  /**
   * Deletes the file system made under `name` by `createFileSystem`; succeeds when there is none.
   * The kernel uses it when it has no handle (`createFileSystem` finished on the provider's side
   * but the kernel stopped before recording the handle), and in its one-off cleanup of
   * per-conversation sandboxes with `cap-<conversationId>` names that a `sandbox@1` provider's
   * `create` made together with their files (Docker: the `cap-<conversationId>-workspace` and
   * `-skills` volumes); a provider removes those under the same call.
   */
  destroyFileSystemByName(name: string, signal: AbortSignal): Promise<void>;
  /**
   * Creates an instance attached to `fileSystem`. Without `image` the provider uses its own
   * published image. Throws {@link FileSystemGoneError} when the file system is gone.
   */
  create(args: {
    name: string;
    image?: string;
    limits: SandboxLimits;
    fileSystem: FileSystemHandle;
    signal: AbortSignal;
  }): Promise<SandboxHandle>;
  /** `gone` means the provider no longer has this instance. */
  resume(h: SandboxHandle, signal: AbortSignal): Promise<"resumed" | "gone">;
  /** Files must be kept. Succeeds when the instance does not exist. */
  suspend(h: SandboxHandle, signal: AbortSignal): Promise<void>;
  /** Drops the instance only; the file system and its files are kept. Succeeds when it does not exist. */
  destroy(h: SandboxHandle, signal: AbortSignal): Promise<void>;
  /**
   * Drops the instance made under `name` by `create` (instance only, files kept); succeeds when
   * there is none. The kernel uses it when it has no handle (`create` finished on the provider's
   * side but the kernel stopped before recording the handle), and in its one-off cleanup of
   * per-conversation sandboxes with `cap-<conversationId>` names made by a `sandbox@1` provider's
   * `create`.
   */
  destroyByName(name: string, signal: AbortSignal): Promise<void>;
  /**
   * Kills every running command started through `exec` in this instance (and the processes they
   * spawned that did not start their own session). The kernel calls it only when no other holder
   * can be running commands (an instance just resumed from `suspended`, or under the exclusive
   * lease), never while another session may be; to clean up after one crashed holder it uses
   * {@link SandboxProvider.killTagged}. Processes a command put in the background in their own
   * session are not guaranteed to be killed.
   */
  killAll(h: SandboxHandle, signal: AbortSignal): Promise<void>;
  /**
   * Kills every running `exec` command labelled with one of `tags` (and its process tree), leaving
   * other commands running. The kernel calls it for the tags of holders that crashed while live
   * holders keep running commands. Tags match {@link SANDBOX_TAG_RE}. Match whole tags: one tag
   * may be a prefix of another (`ab` of `ab-cd`), and killing `ab` must not touch `ab-cd`'s
   * commands.
   */
  killTagged(h: SandboxHandle, tags: string[], signal: AbortSignal): Promise<void>;
  /**
   * Runs a command. `maxOutputBytes` caps stdout and stderr **combined**; the rest is dropped and
   * `truncated` is true.
   */
  exec(
    h: SandboxHandle,
    args: {
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
      signal: AbortSignal;
      /**
       * The holder's tag ({@link SANDBOX_TAG_RE}); label the command with it so
       * {@link SandboxProvider.killTagged} can find it.
       */
      tag: string;
      /** Who runs the command; informational in phase 1 (record it, do not act on it). */
      actor: SandboxActor;
    },
  ): Promise<ExecResult>;
  /**
   * Reads a file (at most `maxBytes`; longer files are truncated and `truncated` is true). Returns
   * null when it does not exist or is a directory.
   */
  readFile(
    h: SandboxHandle,
    path: string,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; truncated: boolean } | null>;
  /** Parent directories are created. */
  writeFile(h: SandboxHandle, path: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  stat(
    h: SandboxHandle,
    path: string,
    signal: AbortSignal,
  ): Promise<{ size: number; isDir: boolean } | null>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦控制字符
const CONTROL = /[\u0000-\u001f\u007f]/;

/** 校验沙箱内路径：返回错误列表，空数组表示合法。 */
export function validateSandboxPath(p: string): string[] {
  if (typeof p !== "string" || p.length === 0) return ["path must be a non-empty string"];
  if (p.length > MAX_PATH_LENGTH) return [`path must be at most ${MAX_PATH_LENGTH} characters`];
  if (CONTROL.test(p)) return ["path must not contain control characters"];
  if (p.includes("\\")) return ["path must not contain backslashes"];
  if (!p.startsWith("/")) return ["path must be absolute"];
  if (p.includes("//")) return ["path must not contain empty segments"];
  const errors: string[] = [];
  for (const seg of p.split("/")) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // 非法百分号编码按字面处理
    }
    if (seg === ".." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      errors.push("path must not contain '..' segments");
      break;
    }
  }
  if (!SANDBOX_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) {
    errors.push(`path must be under ${SANDBOX_ROOTS.join(", ")}`);
  }
  return errors;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** 校验出站白名单主机名：小写、无协议与端口、可选前导 `*.`、IDN 只认 punycode。 */
export function validateAllowHost(h: string): string[] {
  if (typeof h !== "string" || h.length === 0) return ["host must be a non-empty string"];
  if (h.length > 253) return ["host must be at most 253 characters"];
  const name = h.startsWith("*.") ? h.slice(2) : h;
  if (name.length === 0) return ["wildcard must be followed by a domain"];
  const labels = name.split(".");
  if (labels.every((l) => LABEL.test(l))) {
    const tld = labels[labels.length - 1] as string;
    if (labels.length < 2) return ["host must have at least two labels (no single-label names)"];
    // 末段必须以字母开头：挡住 IPv4 的十进制 / 八进制 / 十六进制写法
    if (!/^[a-z]/.test(tld)) return ["host must not be an IP address literal"];
    if (["local", "internal", "localhost"].includes(tld)) {
      return ["host must not be in an internal-only domain (.local, .internal, .localhost)"];
    }
    return [];
  }
  return [
    "host must be a lowercase hostname without scheme, port or path (optional leading '*.'; IDN as punycode)",
  ];
}
