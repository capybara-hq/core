/**
 * Sandbox contract `sandbox@2`: a single-select, brokered extension point (extensions may not
 * `requires` it; the kernel's `SandboxService` consumes it). The provider implements only the
 * primitives below; the kernel builds `glob` / `grep` / `edit` from `exec` plus `readFile` /
 * `writeFile`.
 *
 * `@2` separates a device's **file system** from its **instance**: the file system
 * (`createFileSystem`) lives until the device is deleted (`destroyFileSystem`); instances
 * (`create`) attach to it and come and go (`destroy` drops the instance and keeps the files).
 */

import type {
  SandboxBackground,
  SandboxBrowse,
  SandboxBrowseScope,
  SandboxOperation,
  SandboxOperationRef,
  SandboxOperationScope,
  SandboxPermissionSupport,
  SandboxPreparation,
  SandboxPreparationScope,
} from "./sandbox-operation.js";

/** Sandbox extension point ref. */
export const SANDBOX_EXTENSION_POINT = "sandbox@2";

/** The roots inside the sandbox the model may access. */
export const SANDBOX_ROOTS = ["/workspace", "/skills", "/tmp"] as const;

const MAX_PATH_LENGTH = 4096;

/**
 * Sandbox resource and network limits. A provider that ignores `mode` and `network` still runs:
 * it then behaves as an allowlisted sandbox (the safe direction).
 */
export interface SandboxLimits {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  /**
   * `auto`: no OS sandbox (local: the owner; cloud: the container is the boundary);
   * `sandbox`: the OS sandbox with the network limited by {@link SandboxLimits.network}.
   * For operation-capable providers this encodes the independent device ceiling: auto allows
   * Full access when separately authorized, sandbox permits restricted operations only.
   * It never selects a conversation profile or changes per operation. Legacy consumers retain
   * the current mode behavior until coordinated protocol activation.
   */
  mode: "auto" | "sandbox";
  /**
   * The network the instance (cloud) must enforce, or the allowlist a local device's sandbox mode
   * intersects with its own list (`open-public` is for cloud instances only). Each entry of
   * `hosts` passes {@link validateAllowHost}.
   */
  network: { kind: "open-public" | "allowlist"; hosts: string[] };
}

/** The absolute roots inside one instance (a device may place them anywhere on its host). */
export interface SandboxRoots {
  workspace: string;
  skills: string;
  tmp: string;
}

/** The roots every container-like provider uses; the same paths as {@link SANDBOX_ROOTS}. */
export const DEFAULT_SANDBOX_ROOTS: Readonly<SandboxRoots> = Object.freeze({
  workspace: "/workspace",
  skills: "/skills",
  tmp: "/tmp",
});

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

/** The provider's file system handle (a device's files, independent of any instance). */
export interface FileSystemHandle {
  /** The provider's file system id. */
  id: string;
}

/** Who runs an `exec` (informational in phase 1: audit and attribution). */
export interface SandboxActor {
  accountId: string;
  conversationId: string;
  /**
   * The run the command serves. The kernel uses it to route run grants (network hosts allowed
   * for the rest of a run) to a connected device; informational for other providers.
   */
  runId?: string;
}

/**
 * The layer that refused a network host: `device` (the org allows it, the device's local policy
 * does not), `org` (not in the org's effective egress), `address` (an IP literal or a name that
 * points to a private or local address; never grantable), `unknown`.
 */
export type NetworkBlockLayer = "device" | "org" | "address" | "unknown";

/** A host a command was refused, as the provider reports it. */
export interface NetworkBlockedHost {
  /** The host as the proxy saw it (IPv6 literals bracketed). */
  host: string;
  port: number;
  layer: NetworkBlockLayer;
}

/** Result of a command. */
export interface ExecResult {
  /** null on timeout or when aborted while running (`timedOut` is then true / false). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /**
   * Network refusals during the command (optional for every provider): at most
   * `MAX_NETWORK_BLOCKED_HOSTS` hosts, deduped by host. The kernel recomputes the `org` layer
   * itself and never trusts a provider's word that the org allows a host.
   */
  network?: { blocked: NetworkBlockedHost[] };
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
 * reports the device's files as lost rather than handing out a silently empty workspace.
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
 * **File systems and instances.** `createFileSystem` makes a device's files; they live until
 * `destroyFileSystem` (the device is deleted). `create` makes an instance attached to an
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
 * **Concurrent use** (required in `@2`): the sessions of one device share its instance, so the
 * kernel calls `exec`, `readFile`, `writeFile` and `stat` concurrently on one instance. Those four
 * methods must be safe to call concurrently. Each `exec` labels its command with its `tag`, and an
 * aborted `exec` kills only its own command.
 */
export interface SandboxProvider {
  /** Runtime permission support for this instance; does not grant consent or provision an instance. */
  permissionSupport?(h: SandboxHandle, signal: AbortSignal): Promise<SandboxPermissionSupport>;
  /**
   * Fresh immutable grant for one actual method invocation. Lightweight until a method is called;
   * never cache grants on the handle or fall back to raw methods when unsupported.
   */
  operation?(
    h: SandboxHandle,
    scope: SandboxOperationScope,
    signal: AbortSignal,
  ): Promise<SandboxOperation>;
  /** Trusted skill/attachment staging only; never exposed to user operations. */
  prepare?(
    h: SandboxHandle,
    scope: SandboxPreparationScope,
    signal: AbortSignal,
  ): Promise<SandboxPreparation>;
  /** Owner-authenticated metadata browsing without conversation/profile consent. */
  browse?(h: SandboxHandle, scope: SandboxBrowseScope, signal: AbortSignal): Promise<SandboxBrowse>;
  /**
   * Required for permission support: idempotently persist an operation-ID tombstone before
   * cancelling exact owned work. A delayed launch checks it before effects; retain it through
   * admitBeforeMs and any owned execution's lifetime, including across kernel restarts.
   */
  revokeOperation?(h: SandboxHandle, ref: SandboxOperationRef, signal: AbortSignal): Promise<void>;
  /** Exact registered background ownership; missing support must not fall back to shell launch. */
  background?: SandboxBackground;
  /** `exec` / `readFile` / `writeFile` / `stat` may run concurrently on one instance (required). */
  readonly concurrentExec: true;
  /**
   * Whether the provider isolates the sessions of one device from each other inside the
   * instance (a declared capability; absent means false).
   */
  readonly sessionIsolation?: boolean;
  /**
   * Where `create`-time limits are fixed: `instance` (absent; Docker: a new instance applies new
   * limits) or `fileSystem` (E2B: the instance is the file system, so only a file reset applies
   * them without {@link SandboxProvider.update}).
   */
  readonly limitsApplyAt?: "instance" | "fileSystem";
  /**
   * Applies new limits to a running instance without recreating it (optional). `recreate` asks
   * the kernel to destroy the instance and create one on the same files instead.
   */
  update?(
    h: SandboxHandle,
    limits: SandboxLimits,
    signal: AbortSignal,
  ): Promise<"updated" | "recreate">;
  /**
   * Creates a device's file system. `name` looks like `cap-device-<deviceId>`. If a file
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
  /**
   * Lists one directory's entries — each entry's `name` and whether it `isDir` — sorted by code
   * unit (locale-independent), at most `limit` of them; `truncated` is true when the directory has
   * more. Entries only: never file contents, never a recursive walk. A `name` is never `.` or `..`;
   * `isDir` follows symbolic links (stat semantics: a link to a directory is `true`, a dangling link
   * `false`, and so is a link whose target the request's mode cannot reach). `limits` is the kernel's current ceiling: read in the mode it gives, never in one an
   * earlier command saw. Returns null only when the path does not exist and that mode could reach
   * it; a path the mode cannot reach throws (a policy refusal), as does a path that is a file or a
   * directory that cannot be read.
   *
   * Optional: a provider without it (or without {@link SandboxProvider.scan}) offers no projects,
   * and its conversations stay in free mode.
   */
  list?(
    h: SandboxHandle,
    path: string,
    opts: { limit: number; limits: Pick<SandboxLimits, "mode">; signal: AbortSignal },
  ): Promise<{ entries: { name: string; isDir: boolean }[]; truncated: boolean } | null>;
  /**
   * Looks for project-like directories, read in the mode `limits` gives (as for
   * {@link SandboxProvider.list}). Every provider traverses the same way:
   *
   * - Candidates are `base` itself and the directories at most {@link MAX_DEVICE_SCAN_DEPTH}
   *   levels below it that hold a `.git` entry (directory or file) or an `AGENTS.md` file.
   * - The walk does not follow symbolic links and does not enter hidden directories (names
   *   starting with `.`); a candidate does not stop the descent (a monorepo's sub-projects are
   *   candidates too). It never enters a directory named in {@link DEVICE_SCAN_SKIPPED_DIRS}, at
   *   any depth, nor one named in {@link DEVICE_SCAN_SKIPPED_BASE_DIRS} directly under `base`;
   *   every provider skips exactly these. Paths under `base` the mode cannot reach are skipped,
   *   never an error.
   * - A directory whose basename does not satisfy {@link isDeviceProjectName} is not returned as
   *   a candidate (never with a changed name), but it is still traversed.
   * - Directories are visited breadth-first, each level in code-unit order of `path`, `base`
   *   counting as the first visit (visiting a directory reads its entries; one that cannot be read
   *   still counts as a visit); the walk stops after {@link MAX_DEVICE_SCAN_DIRS} visits, so a
   *   huge tree answers what was found by then.
   * - Each candidate is its absolute `path` and its basename as `suggestedName`; the candidates
   *   found are sorted by `path` in code-unit order and cut to the first
   *   {@link MAX_DEVICE_SCAN_RESULTS}.
   *
   * Directory entries only, never file contents. A `base` that does not exist answers `[]`; a
   * `base` that is a file, cannot be read, or lies outside the mode throws. Optional, like `list`.
   */
  scan?(
    h: SandboxHandle,
    base: string,
    opts: { limits: Pick<SandboxLimits, "mode">; signal: AbortSignal },
  ): Promise<{ path: string; suggestedName: string }[]>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦控制字符
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The longest project name, in UTF-16 code units. */
export const MAX_DEVICE_PROJECT_NAME_LENGTH = 64;

/** The most candidates a `scan` answers ({@link SandboxProvider.scan}). */
export const MAX_DEVICE_SCAN_RESULTS = 50;

/**
 * Directory names a `scan` never enters, at any depth ({@link SandboxProvider.scan}): dependency
 * trees, not projects. Every provider skips exactly these.
 */
export const DEVICE_SCAN_SKIPPED_DIRS: readonly string[] = Object.freeze(["node_modules"]);

/**
 * Directory names a `scan` does not enter directly under its `base` ({@link SandboxProvider.scan}):
 * the owner's macOS `Library` (app data, huge, partly privacy-protected) is not where projects
 * live. Every provider skips exactly these.
 */
export const DEVICE_SCAN_SKIPPED_BASE_DIRS: readonly string[] = Object.freeze(["Library"]);

/** How far below its base a `scan` looks: the base's children and their children. */
export const MAX_DEVICE_SCAN_DEPTH = 2;

/**
 * The most directories one `scan` visits (reads the entries of), its `base` included
 * ({@link SandboxProvider.scan}): breadth-first, each level in code-unit order of path.
 */
export const MAX_DEVICE_SCAN_DIRS = 500;

/**
 * Whether `v` is a valid project name (a project's identity on its device, and a `scan`
 * candidate's `suggestedName`): non-empty, at most {@link MAX_DEVICE_PROJECT_NAME_LENGTH} UTF-16
 * code units, not `.` or `..`, no `/`, no control characters, and no leading or trailing
 * whitespace.
 */
export function isDeviceProjectName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v !== "" &&
    v !== "." &&
    v !== ".." &&
    v.length <= MAX_DEVICE_PROJECT_NAME_LENGTH &&
    !CONTROL.test(v) &&
    !v.includes("/") &&
    !/^\s|\s$/.test(v)
  );
}

/**
 * The root-independent checks of a path inside an instance (non-empty, at most 4096 characters, no
 * control characters or backslashes, absolute, no empty or `..` segments); returns the errors,
 * empty when valid. {@link validateSandboxPath} adds root membership.
 */
export function validateSandboxPathShape(p: string): string[] {
  if (typeof p !== "string" || p.length === 0) return ["path must be a non-empty string"];
  if (p.length > MAX_PATH_LENGTH) return [`path must be at most ${MAX_PATH_LENGTH} characters`];
  if (CONTROL.test(p)) return ["path must not contain control characters"];
  if (p.includes("\\")) return ["path must not contain backslashes"];
  if (!p.startsWith("/")) return ["path must be absolute"];
  if (p.includes("//")) return ["path must not contain empty segments"];
  for (const seg of p.split("/")) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // invalid percent-encoding is taken literally
    }
    if (seg === ".." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return ["path must not contain '..' segments"];
    }
  }
  return [];
}

/** A structural error after which {@link validateSandboxPath} stops (before the root check). */
const STOPS = new Set([
  "path must be a non-empty string",
  `path must be at most ${MAX_PATH_LENGTH} characters`,
  "path must not contain control characters",
  "path must not contain backslashes",
  "path must be absolute",
  "path must not contain empty segments",
]);

/**
 * Checks a path inside an instance; returns the errors, empty when valid: the
 * {@link validateSandboxPathShape} checks, then root membership. `roots`: the instance's roots
 * ({@link rootsOf}); absent means {@link SANDBOX_ROOTS}. The path must be one of them or under one.
 */
export function validateSandboxPath(p: string, roots?: SandboxRoots): string[] {
  const errors = validateSandboxPathShape(p);
  if (errors.some((e) => STOPS.has(e))) return errors;
  const allowed: readonly string[] =
    roots === undefined ? SANDBOX_ROOTS : [roots.workspace, roots.skills, roots.tmp];
  if (!allowed.some((r) => p === r || p.startsWith(`${r}/`))) {
    errors.push(`path must be under ${allowed.join(", ")}`);
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
