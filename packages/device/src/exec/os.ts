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
} from "@capybara-hq/plugin-sdk";
import { type BlockedHost, blockedHosts, denyReason, networkTrailer } from "../network.js";
import { effectiveEgress, grantedHosts, srtConfig } from "../policy.js";
import type { Policy } from "../state.js";
import { FS_HELPER_SCRIPT } from "./fs-helper.js";
import { EXEC_MARKER, killMarked } from "./procs.js";
import { Reaper, type ReaperDeps } from "./reap.js";
import {
  ENV_NAME_RE,
  HostFiles,
  isUnder,
  OutputCap,
  osRoots,
  PIPE_GRACE_MS,
  policyError,
  RootGuard,
  shellQuote,
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
  /** The reaper's process operations (default: the real ones); injectable for tests. */
  reaper?: Partial<ReaperDeps>;
}

interface Spawned {
  child: ChildProcess;
  commandId: string;
}

/**
 * Runs every command inside `@anthropic-ai/sandbox-runtime` (macOS Seatbelt, Linux bubblewrap),
 * today's strict profile (spec §4.4): writes only under the workspace and tmp roots, the secret
 * paths unreadable, no local binding or unix sockets, network only to the intersection of the
 * device's allowlist and the kernel's. File operations in the workspace, tmp and skills roots run
 * in a sandboxed helper too. Construct it with {@link createOsExecutor}; the constructor alone
 * serves only `ensureRoot`.
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
   * The network limits of the latest command. The ask callback has no command id; a device belongs
   * to one organization, so these stand for its allowlist when it explains a refusal.
   */
  private lastLimits: Pick<SandboxLimits, "mode" | "network"> | undefined;
  /** The configuration the sandbox runs with now, as JSON (see {@link applyConfig}). */
  private installed: string | undefined;
  /**
   * Background tasks launched on macOS that still run, by the command id of their launch, with
   * the task's process group id (its sid). A task keeps its launch's network permissions (the
   * per-command list) until its group is gone: it uses the launch's proxy credentials long after
   * the launch returned. Checked on the prune tick.
   */
  private readonly backgroundNet = new Map<string, number>();

  constructor(private readonly opts: OsExecutorOptions) {
    this.reaper = new Reaper(opts.reaper);
    const dir = resolve(opts.dir);
    // The roots are reported as real paths, so what commands print matches what the kernel sends.
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.roots = osRoots(this.dir);
    this.guard = new RootGuard(this.dir, this.roots);
    this.files = new HostFiles(this.roots, "sandbox");
    this.dirKey = createHash("sha256").update(this.dir).digest("hex").slice(0, 16);
  }

  /** The sandbox configuration (no domains: those are per command). */
  config(): SandboxRuntimeConfig {
    return srtConfig(this.roots, [], {
      ...(this.opts.home !== undefined && { home: this.opts.home }),
      ...(this.opts.denyRead !== undefined && { denyRead: this.opts.denyRead }),
    });
  }

  /**
   * Installs {@link config} when it changed, so a policy change applies at the next command
   * without a restart. The runtime reads its global configuration at each wrap.
   */
  private applyConfig(): void {
    const config = this.config();
    const json = JSON.stringify(config);
    if (json === this.installed) return;
    if (this.installed !== undefined) SandboxManager.updateConfig(config);
    this.installed = json;
  }

  /** Records the configuration the sandbox was initialized with. */
  markInstalled(config: SandboxRuntimeConfig): void {
    this.installed = JSON.stringify(config);
  }

  async ensureRoot(): Promise<"ok" | "gone"> {
    return this.guard.ensure();
  }

  /**
   * The sandbox's ask callback, reached only for a host no list allows: it refuses, with a reason
   * clients that print the proxy's status phrase show (spec §9.1). Sandbox mode has no
   * "any host" state (auto mode runs without the OS sandbox and has the machine's network), so
   * this never allows.
   */
  readonly askCallback: SandboxAskCallback = async ({ host }) => {
    return { allow: false, reason: denyReason(host, this.lastLimits, this.opts.policy()) };
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
      signal?: AbortSignal;
      stdin?: boolean;
    },
  ): Promise<Spawned> {
    const exports: string[] = [];
    const inner: Record<string, string> = {
      // The user's PATH applies inside the sandbox only (the wrapper runs with OUTER_ENV).
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: process.env.LANG ?? "C.UTF-8",
      SHELL: "/bin/bash",
      TERM: "dumb",
      HOME: this.roots.workspace,
      ...(process.env.USER !== undefined && { USER: process.env.USER }),
      // Version managers (asdf, nvm, pyenv, ...) read their data under the real home: HOME is the
      // workspace here. Read only; the request's values win.
      ...toolHomeEnv(this.opts.home ?? homedir()),
      ...o.env,
      // The runtime points TMPDIR at its own /tmp/claude (denied by the config): use ours.
      TMPDIR: this.roots.tmp,
      [EXEC_MARKER]: o.marker,
    };
    for (const [k, v] of Object.entries(inner)) {
      if (!ENV_NAME_RE.test(k))
        throw policyError(`invalid environment variable name ${JSON.stringify(k)}`);
      exports.push(`export ${k}=${shellQuote(v)}`);
    }
    this.applyConfig();
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
    if (o.egress.length > 0) {
      SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: o.egress });
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

  /** Drops a command's network permissions (its per-command list). */
  private releaseNet(commandId: string): void {
    this.backgroundNet.delete(commandId);
    SandboxManager.unregisterCommandNetworkLists(commandId);
  }

  /** Keeps a launched background task's network permissions while its group `sid` lives. */
  private keepBackgroundNet(commandId: string, sid: number): void {
    if (!killGroupId(sid, 0)) {
      this.releaseNet(commandId);
      return;
    }
    this.backgroundNet.set(commandId, sid);
    this.startPruning();
  }

  /** Releases the network permissions of background tasks whose group is gone (all: `all`). */
  private pruneBackgroundNet(all = false): void {
    for (const [commandId, sid] of [...this.backgroundNet]) {
      if (all || !killGroupId(sid, 0)) this.releaseNet(commandId);
    }
  }

  private startPruning(): void {
    if (this.pruneTimer === undefined) {
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }
  }

  /** Tracks a spawned command's process group; returns the entry. */
  private track(tag: string, child: ChildProcess): Group | undefined {
    if (child.pid === undefined) return undefined;
    const g: Group = { tag, pgid: child.pid, exited: false };
    this.groups.add(g);
    this.startPruning();
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
    this.pruneBackgroundNet();
    if (this.groups.size === 0 && this.backgroundNet.size === 0 && this.pruneTimer !== undefined) {
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
    // A granted host the command still could not reach is not the device's doing.
    const judged: Policy = {
      ...policy,
      allowedDomains: [...policy.allowedDomains, ...grantedHosts(args.limits, args.grants)],
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
      signal,
    });
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
      const cleanup = (keepFor?: number): void => {
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        signal.removeEventListener("abort", onAbort);
        if (group) {
          group.exited = true;
          group.onKill = undefined;
        }
        if (keepFor !== undefined) this.keepBackgroundNet(commandId, keepFor);
        else this.releaseNet(commandId);
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
        cleanup(
          reap || killed || timedOut || exit.code !== 0
            ? undefined
            : launchedGroup(cap.text("stdout")),
        );
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
      "sandbox",
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
    this.pruneBackgroundNet(true);
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
 * The process group id a background task launch printed as its last line (the task's sid), on
 * macOS only: there the sandbox shares the host's process ids, so the device can watch the group.
 * Elsewhere (Linux: bwrap's own pid namespace) undefined, and the launch's permissions end with it.
 */
export function launchedGroup(stdout: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "darwin") return undefined;
  const last = stdout.trimEnd().split("\n").pop()?.trim() ?? "";
  return /^[1-9][0-9]*$/.test(last) ? Number(last) : undefined;
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
  // The ask callback never allows: a destination outside the lists is refused, with a reason
  // when this runtime carries one (an older runtime would read any answer object as an allow).
  const config = executor.config();
  await SandboxManager.initialize(
    config,
    SandboxManager.askCallbackDenyReason === true ? executor.askCallback : undefined,
  );
  executor.markInstalled(config);
  await executor.killLeftovers();
  return executor;
}
