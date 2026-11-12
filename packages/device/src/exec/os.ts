import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import { resolve } from "node:path";
import {
  type SandboxAskCallback,
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  type DeviceExecArgs,
  type ExecResult,
  isBackgroundLaunch,
  type SandboxLimits,
  type SandboxRoots,
  type SandboxTier,
} from "@capybara-hq/plugin-sdk";
import {
  type BlockedHost,
  blockedHosts,
  denyReason,
  isPublicName,
  networkTrailer,
} from "../network.js";
import {
  ANY_HOST,
  deviceTier,
  type EgressLimits,
  effectiveEgress,
  grantedHosts,
  srtConfig,
  type TierFacts,
  tierFacts,
} from "../policy.js";
import { detectLocalProxy, PROXY_GUARD_TTL_MS, type ProxyGuardResult } from "../proxy-guard.js";
import type { Policy } from "../state.js";
import { FS_HELPER_SCRIPT } from "./fs-helper.js";
import { EXEC_MARKER, killMarked } from "./procs.js";
import { Reaper, type ReaperDeps } from "./reap.js";
import {
  cacheEnv,
  cacheRoot,
  ENV_NAME_RE,
  HostFiles,
  isUnder,
  OutputCap,
  osRoots,
  PIPE_GRACE_MS,
  policyError,
  prepareSocketDir,
  RootGuard,
  shellQuote,
  socketDirPath,
  toolHomeEnv,
} from "./shared.js";
import { DeviceOpError, type Executor } from "./types.js";

export { osRoots, ROOT_MARKER, utf8Prefix } from "./shared.js";

/** A file operation in the sandboxed helper that takes longer than this is killed. */
const HELPER_TIMEOUT_MS = 30_000;

/** How often process groups of finished commands are checked for remaining members. */
const PRUNE_INTERVAL_MS = 5_000;

/**
 * The outer process (the sandbox wrapper itself) runs with this environment only; the request's
 * environment is applied inside the sandbox, so it can never steer the wrapper.
 */
const OUTER_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C.UTF-8",
};

/** Whether the OS sandbox can run here, and why not. */
export function sandboxAvailability(): { ok: true } | { ok: false; reason: string } {
  if (!SandboxManager.isSupportedPlatform()) {
    return { ok: false, reason: `the OS sandbox does not support ${process.platform}` };
  }
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    return {
      ok: false,
      reason: `the OS sandbox is missing dependencies: ${deps.errors.join("; ")}`,
    };
  }
  return { ok: true };
}

/**
 * One command's process group. It is tracked after the command's main process exits, as long as
 * the group has members (background children), so killTagged / killAll still reach them.
 */
interface Group {
  tag: string;
  pgid: number;
  /** The leader (the outer shell) has exited and been reaped. */
  exited: boolean;
  /** Called by a kill while the command runs: the result then has `exitCode: null`. */
  onKill?: (() => void) | undefined;
}

/** Sends SIGKILL to a process group; false when the group no longer exists. */
function killGroupId(pgid: number, signal: NodeJS.Signals | 0 = "SIGKILL"): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface OsExecutorOptions {
  /** The device directory (from login). */
  dir: string;
  /** The local policy now (read at each command, so a change applies without a restart). */
  policy: () => Policy;
  /** The home whose secret paths are denied (default: the user's home). */
  home?: string;
  /** More paths commands may not read (this program's state directory). */
  denyRead?: string[];
  /** The localhost proxy guard (default: {@link detectLocalProxy}); injectable for tests. */
  detectProxy?: () => Promise<ProxyGuardResult>;
  /** Where the macOS short socket directory is made (default `/private/tmp`). */
  socketBase?: string;
  /** The reaper's process operations (default: the real ones); injectable for tests. */
  reaper?: Partial<ReaperDeps>;
}

interface Spawned {
  child: ChildProcess;
  commandId: string;
}

/**
 * Runs every command inside `@anthropic-ai/sandbox-runtime` (macOS Seatbelt, Linux bubblewrap):
 * writes only under the workspace and tmp roots, the secret paths unreadable, network only to
 * the intersection of the local policy and the device's egress. File operations in the
 * workspace and tmp roots run in a sandboxed helper too. Construct it with
 * {@link createOsExecutor}; the constructor alone serves only `ensureRoot` and the skills root.
 */
export class OsExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  private readonly dir: string;
  /** Marks every process of this device's commands: `<dirKey>.<tag>.<exec id>`. */
  private readonly dirKey: string;
  private readonly groups = new Set<Group>();
  private pruneTimer: NodeJS.Timeout | undefined;
  /** Kills what a foreground exec left running once it ends. */
  private readonly reaper: Reaper;
  private readonly guard: RootGuard;
  private readonly files: HostFiles;
  /**
   * The limits of the latest command. The ask callback has no command id; a device belongs to one
   * org, so these stand for the org's egress when it explains a refusal.
   */
  private lastLimits: EgressLimits | undefined;
  /** macOS: the short socket directory (TMPDIR in `dev` / `open`); undefined elsewhere. */
  private socketDir: string | undefined;
  /** The device's package caches (`<dir>/cache`). */
  private readonly cacheDir: string;
  /** The latest proxy guard result, and the policy object it was taken for. */
  private proxy: ProxyGuardResult = { detected: false, reasons: [] };
  private guardedPolicy: Policy | undefined;
  private guardedAt = 0;
  /** The configuration the sandbox runs with now, as JSON (see {@link applyConfig}). */
  private installed: string | undefined;
  /**
   * Commands spawned while nothing narrowed them (policy `open`, their limits `open`) and still
   * running. The ask callback allows any public name only while one runs.
   */
  private readonly openCommands = new Set<string>();

  constructor(private readonly opts: OsExecutorOptions) {
    this.reaper = new Reaper(opts.reaper);
    const dir = resolve(opts.dir);
    // The roots are reported as real paths, so what commands print matches what the kernel sends.
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.roots = osRoots(this.dir);
    this.guard = new RootGuard(this.dir, this.roots);
    this.files = new HostFiles(this.roots);
    this.dirKey = createHash("sha256").update(this.dir).digest("hex").slice(0, 16);
    this.cacheDir = cacheRoot(this.dir);
  }

  /**
   * The tier of work that has no limits of its own (the file helper): the device's choice cut to
   * the latest exec's ceiling, `strict` before any exec (no ceiling known yet).
   */
  tier(policy: Policy = this.opts.policy()): SandboxTier {
    return this.lastLimits === undefined ? "strict" : deviceTier(policy, this.lastLimits);
  }

  /** What the tier gives on this machine now (for the policy summary). */
  tierFacts(policy: Policy = this.opts.policy()): TierFacts {
    return tierFacts(policy, this.lastLimits, {
      proxyDetected: this.proxy.detected,
      mode: "os",
    });
  }

  /** The latest proxy guard result. */
  proxyGuard(): ProxyGuardResult {
    return this.proxy;
  }

  /** The sandbox configuration for the policy at `tier` (no domains: those are per command). */
  config(
    policy: Policy = this.opts.policy(),
    tier: SandboxTier = this.tier(policy),
  ): SandboxRuntimeConfig {
    return srtConfig(policy, this.roots, [], {
      tier,
      ...(this.opts.home !== undefined && { home: this.opts.home }),
      ...(this.opts.denyRead !== undefined && { denyRead: this.opts.denyRead }),
      proxyDetected: this.proxy.detected,
      ...(this.socketDir !== undefined && { socketDir: this.socketDir }),
      cacheDir: this.cacheDir,
    });
  }

  /**
   * Installs {@link config} when the policy or the tier changed it, so the change applies at the
   * next command without a restart. The runtime reads its global configuration at each wrap.
   */
  private applyConfig(policy: Policy, tier: SandboxTier): void {
    const config = this.config(policy, tier);
    const json = JSON.stringify(config);
    if (json === this.installed) return;
    if (this.installed !== undefined) SandboxManager.updateConfig(config);
    this.installed = json;
  }

  /** Records the configuration the sandbox was initialized with. */
  markInstalled(config: SandboxRuntimeConfig): void {
    this.installed = JSON.stringify(config);
  }

  /**
   * macOS: makes the short socket directory (0700) at creation, and again before a `dev` / `open`
   * command when it is gone (macOS prunes /tmp). A path taken by something else leaves the
   * device without one: commands then use the tmp root.
   */
  prepareSocketDir(): void {
    if (process.platform !== "darwin") return;
    this.socketDir = prepareSocketDir(socketDirPath(this.dirKey, this.opts.socketBase));
  }

  /**
   * Runs the localhost proxy guard at creation, when the policy was reloaded since the last run
   * (the store returns a new object for each new version of policy.json), and when the last result
   * is older than {@link PROXY_GUARD_TTL_MS} (a proxy started after this program). A guard that
   * fails counts as a proxy found (fail safe; `localhost: allow` still overrides).
   */
  async refreshProxyGuard(policy: Policy): Promise<void> {
    const now = Date.now();
    if (policy === this.guardedPolicy && now - this.guardedAt < PROXY_GUARD_TTL_MS) return;
    this.guardedPolicy = policy;
    this.guardedAt = now;
    try {
      this.proxy = await (this.opts.detectProxy ?? (() => detectLocalProxy()))();
    } catch (e) {
      this.proxy = {
        detected: true,
        reasons: [`the localhost proxy guard failed: ${(e as Error).message}`],
      };
    }
  }

  async ensureRoot(): Promise<"ok" | "gone"> {
    return this.guard.ensure();
  }

  /**
   * The sandbox's ask callback, reached only for a host no list allows. sandbox-runtime refuses `*`
   * in a per-command list, so a command that may reach any host (device policy `open`, its limits
   * `open`) is allowed here: a public name is allowed while such a command runs and the policy
   * and latest limits still say so (narrowing takes effect at once). The callback has no command
   * id, so a concurrent command of the same device may ride along meanwhile; the file helper never
   * opens it. Otherwise it refuses, with a reason clients that print the proxy's status phrase
   * show (spec §9.1).
   */
  readonly askCallback: SandboxAskCallback = async ({ host }) => {
    const policy = this.opts.policy();
    const limits = this.lastLimits;
    if (
      this.openCommands.size > 0 &&
      limits !== undefined &&
      effectiveEgress(policy, limits).includes(ANY_HOST) &&
      isPublicName(host)
    ) {
      return true;
    }
    return { allow: false, reason: denyReason(host, limits, policy) };
  };

  /** The classified network refusals of one command (read before it unregisters). */
  private blockedFor(commandId: string, limits: SandboxLimits, policy: Policy): BlockedHost[] {
    const lines = SandboxManager.getSandboxViolationStore()
      .getViolationsForCommand(commandId)
      .map((v) => v.line);
    return blockedHosts(lines, limits, policy);
  }

  /**
   * The marker value of a tag's processes. An exec's processes carry `<this>.<exec id>` (see
   * {@link execMarker}); {@link killTagged} matches both.
   */
  markerOf(tag: string): string {
    return `${this.dirKey}.${tag}`;
  }

  /** The marker value of one exec's processes: its tag's plus an id of its own (no dots in a tag). */
  private execMarker(tag: string): string {
    return `${this.markerOf(tag)}.${randomBytes(8).toString("hex")}`;
  }

  /**
   * Wraps `script` (run by bash inside the sandbox, after the request's `env` and TMPDIR are
   * exported) and spawns it as the leader of a new process group.
   */
  private async spawnSandboxed(
    script: string,
    o: {
      cwd: string;
      env?: Record<string, string>;
      /** The marker value every process of the command carries. */
      marker: string;
      egress: string[];
      policy: Policy;
      tier: SandboxTier;
      signal?: AbortSignal;
      stdin?: boolean;
    },
  ): Promise<Spawned> {
    const exports: string[] = [];
    const dev = o.tier !== "strict";
    // Re-checked before every dev / open command (macOS prunes /tmp, and a path swapped for a
    // link or another user's directory must not be used): prepareSocketDir never follows links.
    if (dev && process.platform === "darwin") this.prepareSocketDir();
    // dev / open on macOS: the short socket directory, where unix sockets are allowed.
    const tmp = dev && this.socketDir !== undefined ? this.socketDir : this.roots.tmp;
    const inner: Record<string, string> = {
      // The user's PATH applies inside the sandbox only (the wrapper runs with OUTER_ENV).
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: process.env.LANG ?? "C.UTF-8",
      SHELL: "/bin/bash",
      TERM: "dumb",
      HOME: this.roots.workspace,
      ...(process.env.USER !== undefined && { USER: process.env.USER }),
      // Version managers (asdf, nvm, pyenv, ...) read their data under the real home, at every
      // tier: HOME is the workspace here. Read only; the request's values win.
      ...toolHomeEnv(this.opts.home ?? homedir()),
      // dev / open: package caches under <dir>/cache; the command's own values win.
      ...(dev && cacheEnv(this.cacheDir, { create: true })),
      ...o.env,
      // The runtime points TMPDIR at its own /tmp/claude (denied by the config): use ours.
      TMPDIR: tmp,
      // Chromium on macOS ignores TMPDIR and reads this instead (its singleton socket).
      ...(process.platform === "darwin" && { MAC_CHROMIUM_TMPDIR: tmp }),
      [EXEC_MARKER]: o.marker,
    };
    for (const [k, v] of Object.entries(inner)) {
      if (!ENV_NAME_RE.test(k))
        throw policyError(`invalid environment variable name ${JSON.stringify(k)}`);
      exports.push(`export ${k}=${shellQuote(v)}`);
    }
    this.applyConfig(o.policy, o.tier);
    const commandId = randomBytes(16).toString("base64url");
    const wrapped = await SandboxManager.wrapWithSandbox(
      `${exports.join("\n")}\n${script}`,
      "/bin/bash",
      undefined,
      o.signal,
      { commandId, commandText: script },
    );
    // The kernel may have cancelled while the wrap was prepared.
    o.signal?.throwIfAborted();
    // "*" (any host) is refused in a per-command list: the ask callback allows those hosts.
    const listed = o.egress.filter((d) => d !== ANY_HOST);
    if (listed.length > 0) {
      SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: listed });
    }
    let child: ChildProcess;
    try {
      // detached: the command leads its own process group, so a kill reaches its children too.
      child = spawn("/bin/bash", ["-c", wrapped], {
        cwd: o.cwd,
        env: OUTER_ENV,
        detached: true,
        stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) {
      SandboxManager.unregisterCommandNetworkLists(commandId);
      SandboxManager.cleanupAfterCommand();
      throw e;
    }
    return { child, commandId };
  }

  /** Tracks a spawned command's process group; returns the entry. */
  private track(tag: string, child: ChildProcess): Group | undefined {
    if (child.pid === undefined) return undefined;
    const g: Group = { tag, pgid: child.pid, exited: false };
    this.groups.add(g);
    if (this.pruneTimer === undefined) {
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }
    return g;
  }

  /** Forgets finished groups with no members left (or whose id was taken by another process). */
  private prune(): void {
    for (const g of this.groups) {
      if (!g.exited) continue;
      // A reaped leader's pid can be reused only once its group is gone: a live process with
      // that pid means the id now belongs to someone else.
      if (pidAlive(g.pgid) || !killGroupId(g.pgid, 0)) this.groups.delete(g);
    }
    if (this.groups.size === 0 && this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  private killGroup(g: Group): void {
    if (g.exited) {
      this.prune();
      if (!this.groups.has(g)) return;
    }
    g.onKill?.();
    if (!killGroupId(g.pgid) && g.exited) this.groups.delete(g);
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const cwd = await this.files.inside(args.cwd ?? this.roots.workspace, "cwd");
    // Read once: the command's lists and the explanation of its refusals use the same policy.
    const policy = this.opts.policy();
    this.lastLimits = args.limits;
    await this.refreshProxyGuard(policy);
    // A granted host the command still could not reach is not the device's doing.
    const judged: Policy = {
      ...policy,
      allowedDomains: [...policy.allowedDomains, ...grantedHosts(policy, args.limits, args.grants)],
    };
    const egress = effectiveEgress(policy, args.limits, args.grants);
    const marker = this.execMarker(args.tag);
    // A background task launch detaches the task on purpose: what it leaves running stays.
    const reap = !isBackgroundLaunch(args.command);
    const { child, commandId } = await this.spawnSandboxed(args.command, {
      cwd,
      ...(args.env !== undefined && { env: args.env }),
      marker,
      egress,
      policy,
      tier: deviceTier(policy, args.limits),
      signal,
    });
    if (egress.includes(ANY_HOST)) this.openCommands.add(commandId);
    return new Promise<ExecResult>((resolvePromise, reject) => {
      const cap = new OutputCap(args.maxOutputBytes);
      let timedOut = false;
      let killed = false;
      let exit: { code: number | null; sig: NodeJS.Signals | null } | undefined;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const group = this.track(args.tag, child);
      if (group) {
        group.onKill = () => {
          // A kill after a clean exit (a background child) leaves the result alone.
          if (exit === undefined) killed = true;
        };
      }
      const kill = (): void => {
        if (group) this.killGroup(group);
      };
      const timer = setTimeout(() => {
        if (exit === undefined) timedOut = true;
        kill();
      }, args.timeoutMs);
      const onAbort = (): void => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        signal.removeEventListener("abort", onAbort);
        if (group) {
          group.exited = true;
          group.onKill = undefined;
        }
        this.openCommands.delete(commandId);
        SandboxManager.unregisterCommandNetworkLists(commandId);
        SandboxManager.cleanupAfterCommand();
      };
      const finish = (): void => {
        if (settled || exit === undefined) return;
        settled = true;
        // Before cleanup: the violations are looked up by the command's id.
        let blocked: BlockedHost[] = [];
        try {
          blocked = this.blockedFor(commandId, args.limits, judged);
        } catch {
          // The explanation is best effort: the command's result always comes back.
        }
        const trailer = networkTrailer(blocked);
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        let exitCode: number | null = exit.code;
        if (killed || timedOut) exitCode = null;
        else if (exitCode === null && exit.sig !== null) {
          exitCode = 128 + (osConstants.signals[exit.sig] ?? 0);
        }
        let stderr = cap.text("stderr");
        if (trailer !== "") {
          stderr += `${stderr === "" || stderr.endsWith("\n") ? "" : "\n"}${trailer}`;
        }
        resolvePromise({
          exitCode,
          stdout: cap.text("stdout"),
          stderr,
          truncated: cap.truncated,
          timedOut,
          ...(blocked.length > 0 && { network: { blocked } }),
        });
      };
      child.stdout?.on("data", (b: Buffer) => cap.push("stdout", b));
      child.stderr?.on("data", (b: Buffer) => cap.push("stderr", b));
      child.once("error", (e) => {
        if (settled) return;
        settled = true;
        if (group) this.groups.delete(group);
        cleanup();
        reject(e);
      });
      child.once("exit", (code, sig) => {
        exit = { code, sig };
        if (group) group.exited = true;
        // The call is over (exit, timeout or abort): nothing it started may outlive it, because no
        // later command can stop it (the sandbox lets no command signal another's processes).
        // Its group goes before the result; processes that left the group soon after.
        if (group && reap) void this.reaper.reap(group.pgid, marker);
        // A background child may hold the pipes open; do not wait for it past a short grace.
        grace = setTimeout(finish, PIPE_GRACE_MS);
      });
      child.once("close", () => finish());
    });
  }

  /** Runs one file operation in the sandboxed helper; returns its `r`, throws its `e`. */
  private async helper(
    op: "read" | "stat" | "write",
    path: string,
    maxBytes: number,
    data?: Uint8Array,
  ): Promise<unknown> {
    const script = [
      process.execPath,
      "-e",
      FS_HELPER_SCRIPT,
      op,
      path,
      String(maxBytes),
      this.roots.workspace,
      this.roots.tmp,
    ]
      .map(shellQuote)
      .join(" ");
    const { child, commandId } = await this.spawnSandboxed(script, {
      cwd: this.roots.workspace,
      marker: this.markerOf("fs-helper"),
      egress: [],
      policy: this.opts.policy(),
      tier: this.tier(),
      stdin: data !== undefined,
    });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => chunks.push(b));
    child.stderr?.on("data", (b: Buffer) => errs.push(b));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(data !== undefined ? Buffer.from(data) : undefined);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroupId(child.pid);
    }, HELPER_TIMEOUT_MS);
    try {
      await new Promise<void>((res, rej) => {
        child.once("error", rej);
        child.once("close", () => res());
      });
    } finally {
      clearTimeout(timer);
      if (child.pid !== undefined) killGroupId(child.pid);
      SandboxManager.unregisterCommandNetworkLists(commandId);
      SandboxManager.cleanupAfterCommand();
    }
    if (timedOut) throw new DeviceOpError("error", `${op} ${path} timed out`);
    const text = Buffer.concat(chunks).toString("utf8");
    let res: { r?: unknown; e?: "policy" | "error"; m?: string };
    try {
      res = JSON.parse(text) as typeof res;
    } catch {
      const stderr = Buffer.concat(errs).toString("utf8").trim().slice(0, 500);
      throw new DeviceOpError(
        "error",
        `${op} ${path} failed in the sandbox${stderr ? `: ${stderr}` : ""}`,
      );
    }
    if (res.e !== undefined)
      throw new DeviceOpError(res.e === "policy" ? "policy" : "error", res.m ?? "failed");
    return res.r ?? null;
  }

  async readFile(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    const p = this.files.lexical(path);
    if (isUnder(p, this.roots.skills)) return this.files.read(path, maxBytes);
    const r = (await this.helper("read", p, maxBytes)) as {
      b64: string;
      truncated: boolean;
    } | null;
    return r === null ? null : { data: Buffer.from(r.b64, "base64"), truncated: r.truncated };
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const p = this.files.lexical(path);
    if (isUnder(p, this.roots.skills)) return this.files.write(path, data);
    await this.helper("write", p, 0, data);
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean } | null> {
    const p = this.files.lexical(path);
    if (isUnder(p, this.roots.skills)) {
      return this.files.stat(path);
    }
    return (await this.helper("stat", p, 0)) as { size: number; isDir: boolean } | null;
  }

  async killTagged(tags: string[]): Promise<void> {
    const want = new Set(tags);
    for (const g of [...this.groups]) if (want.has(g.tag)) this.killGroup(g);
    const values = new Set(tags.map((t) => this.markerOf(t)));
    // `<dirKey>.<tag>` or an exec's `<dirKey>.<tag>.<id>`: a tag has no dot, so `ab` never
    // matches `ab-cd`'s processes.
    await killMarked((v) => {
      const dot = v.indexOf(".", this.dirKey.length + 1);
      return values.has(dot < 0 ? v : v.slice(0, dot));
    });
  }

  async killAll(): Promise<void> {
    for (const g of [...this.groups]) this.killGroup(g);
    await this.killLeftovers();
  }

  /** Kills every process carrying this device's marker (also a previous run's). */
  async killLeftovers(): Promise<void> {
    const prefix = `${this.dirKey}.`;
    await killMarked((v) => v.startsWith(prefix));
  }

  /** Kills every running command and shuts the sandbox's proxies down. */
  async dispose(): Promise<void> {
    await this.killAll();
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    await SandboxManager.reset();
  }
}

/**
 * The OS sandbox executor: checks the platform and dependencies, starts the sandbox's proxies
 * once for this process, and kills what a previous run of this device left running.
 * Network is denied unless a command's own list allows it.
 */
export async function createOsExecutor(opts: OsExecutorOptions): Promise<OsExecutor> {
  const available = sandboxAvailability();
  if (!available.ok) throw new Error(available.reason);
  const executor = new OsExecutor(opts);
  executor.prepareSocketDir();
  const policy = opts.policy();
  await executor.refreshProxyGuard(policy);
  // The ask callback never allows: a destination outside the lists is refused, with a reason
  // when this runtime carries one (an older runtime would read any answer object as an allow).
  const config = executor.config(policy);
  await SandboxManager.initialize(
    config,
    SandboxManager.askCallbackDenyReason === true ? executor.askCallback : undefined,
  );
  executor.markInstalled(config);
  await executor.killLeftovers();
  return executor;
}
