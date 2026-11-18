import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import type { Policy } from "../state.js";
import type { OperationContainerHost } from "./docker-operations.js";
import { osRoots } from "./shared.js";
import { DeviceOpError } from "./types.js";

/** The version of the published sandbox images this program runs commands in. */
export const SANDBOX_IMAGE_TAG = "0.1.0-rc.5";

export const SANDBOX_IMAGE = `ghcr.io/capybara-hq/capybara-sandbox:${SANDBOX_IMAGE_TAG}`;

/** The image's `sandbox` user. */
const IMAGE_USER = "1000:1000";

/**
 * The user commands run as. On Linux the bind-mounted device directory belongs to the host user,
 * so the container runs as that uid:gid (never root: a root host user falls back to the image's user).
 * Docker Desktop (macOS) maps file ownership itself, so the image's user is used there.
 */
export function containerUser(
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
  gid: number | undefined = process.getgid?.(),
): string {
  if (platform !== "linux" || uid === undefined || gid === undefined || uid === 0)
    return IMAGE_USER;
  return `${uid}:${gid}`;
}

const SPEC_LABEL = "capybara.device.spec";

const ROOTS: SandboxRoots = DEFAULT_SANDBOX_ROOTS;

/** Container name of a device. */
export function containerName(deviceId: string): string {
  return `capybara-device-${deviceId}`;
}

interface DockerRun {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs `docker <args>` to completion (not a command of the device). */
function docker(
  args: string[],
  o: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<DockerRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const max = o.maxBytes ?? 64 * 1024 * 1024;
    child.stdout?.on("data", (b: Buffer) => {
      if (size < max) out.push(b);
      size += b.length;
    });
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    const timer =
      o.timeoutMs !== undefined ? setTimeout(() => child.kill("SIGKILL"), o.timeoutMs) : undefined;
    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

/** Whether the docker CLI can reach a daemon, and why not. */
export async function dockerAvailability(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const r = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 });
    if (r.code === 0) return { ok: true };
    const why = r.stderr.toString("utf8").trim().split("\n")[0] ?? "";
    return { ok: false, reason: `Docker is not available${why ? `: ${why}` : ""}` };
  } catch {
    return { ok: false, reason: "the docker command was not found" };
  }
}

/** The pids limit of a container (as the cloud sandbox). */
const PIDS_LIMIT = 1024;

export interface DockerContainerOptions {
  /** The device directory (from login). */
  dir: string;
  deviceId: string;
  /**
   * The local policy now; cpu and memory apply when the container is next created (when an
   * operation finds it idle with other flags). An unreadable policy refuses the operation.
   */
  policy: () => Policy;
}

interface Inspected {
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Running: boolean };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
  HostConfig: { NanoCpus: number; Memory: number };
  NetworkSettings: { Networks: Record<string, unknown> };
}

/**
 * The docker-mode device's one long-lived container of the published sandbox image: the device
 * directory's workspace, skills (read only) and tmp are mounted at /workspace, /skills and /tmp.
 * It hosts the permission operations (`docker-operations.ts`): each one holds the container
 * through {@link operationContainer}, so it is never recreated under a running operation. A change
 * of the container's flags recreates it at the next operation that finds it idle. Nothing here
 * runs commands or kills processes: the operation backend owns its work and stops it exactly.
 */
export class DockerContainer implements OperationContainerHost {
  readonly roots: SandboxRoots = ROOTS;
  readonly name: string;
  private readonly dir: string;
  private readonly hostRoots: SandboxRoots;
  private chain: Promise<unknown> = Promise.resolve();
  private ready = false;
  /** The container has the default bridge. */
  private netOpen = false;
  /** Operations holding the container now. */
  private inflight = 0;
  /** The spec hash of the container in use (set when it is created or reused). */
  private spec: string | undefined;

  constructor(private readonly opts: DockerContainerOptions) {
    const dir = resolve(opts.dir);
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.hostRoots = osRoots(this.dir);
    this.name = containerName(opts.deviceId);
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => {});
    return next;
  }

  private async inspect(): Promise<Inspected | null> {
    const r = await docker(["inspect", "--type", "container", this.name]);
    if (r.code !== 0) return null;
    return (JSON.parse(r.stdout.toString("utf8")) as Inspected[])[0] ?? null;
  }

  private wanted(): { source: string; dest: string; rw: boolean }[] {
    return [
      { source: this.hostRoots.workspace, dest: ROOTS.workspace, rw: true },
      { source: this.hostRoots.skills, dest: ROOTS.skills, rw: false },
      { source: this.hostRoots.tmp, dest: ROOTS.tmp, rw: true },
    ];
  }

  /** Every `docker run` flag of the container except its name and spec label. */
  private runArgs(): string[] {
    const policy = this.opts.policy();
    return [
      "--init",
      "--read-only",
      "--user",
      containerUser(),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      String(PIDS_LIMIT),
      "--workdir",
      ROOTS.workspace,
      "--label",
      `capybara.device.id=${this.opts.deviceId}`,
      ...this.wanted().flatMap((m) => [
        "--mount",
        `type=bind,source=${m.source},target=${m.dest}${m.rw ? "" : ",readonly"}`,
      ]),
      ...(policy.cpu !== null ? ["--cpus", String(policy.cpu)] : []),
      ...(policy.memoryMb !== null
        ? ["--memory", `${policy.memoryMb}m`, "--memory-swap", `${policy.memoryMb}m`]
        : []),
      "--entrypoint",
      "sleep",
      SANDBOX_IMAGE,
      "infinity",
    ];
  }

  /** A hash of the run flags: a container made with other flags is recreated. */
  private specHash(): string {
    return this.hashOf(this.runArgs());
  }

  private hashOf(runArgs: string[]): string {
    return createHash("sha256").update(JSON.stringify(runArgs)).digest("hex").slice(0, 16);
  }

  private matches(c: Inspected): boolean {
    return c.Config.Labels?.[SPEC_LABEL] === this.specHash();
  }

  private async mustDocker(args: string[], what: string): Promise<DockerRun> {
    const r = await docker(args);
    if (r.code !== 0) {
      throw new DeviceOpError(
        "error",
        `${what} failed: ${r.stderr.toString("utf8").trim().slice(0, 500)}`,
      );
    }
    return r;
  }

  /** Creates the container, or reuses the existing one when it matches; call inside `serial`. */
  private async ensureContainer(): Promise<void> {
    if (this.ready) return;
    if (!existsSync(this.dir)) {
      throw new DeviceOpError("error", "the device directory is gone");
    }
    for (const r of Object.values(this.hostRoots)) {
      if (r.includes(",")) {
        throw new DeviceOpError("error", `the device directory ${this.dir} contains a comma`);
      }
      mkdirSync(r, { recursive: true });
    }
    let c = await this.inspect();
    if (c !== null && (!this.matches(c) || !(await this.seesHostRoots(c)))) {
      await this.mustDocker(["rm", "-f", this.name], "removing the old container");
      c = null;
    }
    if (c === null) {
      const runArgs = this.runArgs();
      const spec = this.hashOf(runArgs);
      await this.mustDocker(
        ["run", "-d", "--name", this.name, "--label", `${SPEC_LABEL}=${spec}`, ...runArgs],
        "creating the container",
      );
      this.spec = spec;
      // created on the default bridge
      this.netOpen = true;
    } else {
      if (!c.State.Running) await this.mustDocker(["start", this.name], "starting the container");
      this.netOpen = "bridge" in (c.NetworkSettings.Networks ?? {});
      this.spec = c.Config.Labels?.[SPEC_LABEL];
    }
    this.ready = true;
  }

  /**
   * Whether a reused container's mounts still show this directory's roots: after the directory was
   * removed and recreated (`login` again), a Linux bind mount still holds the deleted one.
   */
  private async seesHostRoots(c: Inspected): Promise<boolean> {
    if (!c.State.Running) await this.mustDocker(["start", this.name], "starting the container");
    const probe = `.capybara-mount-probe-${randomBytes(8).toString("hex")}`;
    const checks = this.wanted();
    try {
      for (const m of checks) writeFileSync(join(m.source, probe), "");
      const script = checks.map((m) => `[ -e ${m.dest}/${probe} ]`).join(" && ");
      const r = await docker(["exec", this.name, "/bin/sh", "-c", script], { timeoutMs: 10_000 });
      return r.code === 0;
    } finally {
      for (const m of checks) rmSync(join(m.source, probe), { force: true });
    }
  }

  /**
   * The container for one permission operation: running on its default bridge (Full access is
   * the container user's own network; restricted operations are mediated by the launcher). A
   * container left disconnected by an older program is connected again. The caller holds the
   * container (it is not recreated) until it calls `release`, once; an abort while waiting for it
   * rejects and holds nothing.
   */
  async operationContainer(
    signal: AbortSignal,
  ): Promise<{ name: string; user: string; release: () => void }> {
    signal.throwIfAborted();
    const acquired = this.serial(async () => {
      // the policy changed the container's flags (cpu, memory): recreate it once nothing holds it
      if (this.ready && this.inflight === 0 && this.spec !== this.specHash()) this.ready = false;
      await this.ensureContainer();
      if (!this.netOpen) {
        await this.mustDocker(["network", "connect", "bridge", this.name], "enabling the network");
        this.netOpen = true;
      }
      this.inflight++;
    });
    try {
      await new Promise<void>((resolveWait, rejectWait) => {
        const onAbort = (): void => rejectWait(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        acquired.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolveWait();
          },
          (e: unknown) => {
            signal.removeEventListener("abort", onAbort);
            rejectWait(e);
          },
        );
      });
    } catch (e) {
      // aborted while waiting: a hold acquired later is given back at once
      acquired.then(
        () => this.inflight--,
        () => {},
      );
      throw e;
    }
    let released = false;
    return {
      name: this.name,
      user: containerUser(),
      release: () => {
        if (released) return;
        released = true;
        this.inflight--;
      },
    };
  }
}

/**
 * The docker-mode device's container host: checks the daemon. It kills nothing at startup (no
 * marker reaper): work an earlier run left is the operation backend's, recovered and stopped
 * exactly through its journal.
 */
export async function createDockerContainer(
  opts: DockerContainerOptions,
): Promise<DockerContainer> {
  const available = await dockerAvailability();
  if (!available.ok) throw new Error(available.reason);
  return new DockerContainer(opts);
}
