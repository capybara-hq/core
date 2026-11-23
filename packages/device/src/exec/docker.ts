import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import type { Policy } from "../state.js";
import {
  matchPinnedImage,
  type PinnedPlatform,
  pinnedPlatform,
  sandboxImageReference,
} from "./docker-image.js";
import type { OperationContainerHost } from "./docker-operations.js";
import {
  containerHelperLauncher,
  type HelperLauncher,
  removeLeftoverHelpers,
} from "./helper-launcher.js";
import { osRoots } from "./shared.js";
import { DeviceOpError } from "./types.js";

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

/**
 * The container format. It is part of the run flags, so a container an older format made (a
 * protocol 2 program's, which may hold its commands' leftovers and may run without a network) is
 * recreated at its first use, once nothing holds it, never reused.
 */
export const CONTAINER_FORMAT = 2;
export const CONTAINER_FORMAT_LABEL = "capybara.device.format";

/** The spec label of a container made with `runFlags`: a container made otherwise is recreated. */
export function containerSpec(runFlags: string[]): string {
  return createHash("sha256").update(JSON.stringify(runFlags)).digest("hex").slice(0, 16);
}

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

/**
 * Whether the docker CLI can reach a daemon, and why not; when it can, the pinned platform of the
 * daemon's architecture (the image platform it pulls), or a reason when the pin has none.
 */
export async function dockerAvailability(): Promise<
  | { ok: true; platform: PinnedPlatform; mountsPreserveIdentity: boolean }
  | { ok: false; reason: string }
> {
  let r: DockerRun;
  try {
    r = await docker(["info", "--format", "{{.Architecture}}|{{.OperatingSystem}}"], {
      timeoutMs: 10_000,
    });
  } catch {
    return { ok: false, reason: "the docker command was not found" };
  }
  if (r.code !== 0) {
    const why = r.stderr.toString("utf8").trim().split("\n")[0] ?? "";
    return { ok: false, reason: `Docker is not available${why ? `: ${why}` : ""}` };
  }
  const [arch = "", os = ""] = r.stdout.toString("utf8").trim().split("|");
  const platform = pinnedPlatform(arch);
  if (platform === undefined)
    return {
      ok: false,
      reason: `the Docker daemon's architecture (${arch || "unknown"}) has no pinned sandbox image`,
    };
  // a bind mount shows the host's device and inode numbers only from a native Linux daemon on
  // this machine; Docker Desktop (a VM's file sharing) or a remote daemon shows others
  const local = !process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith("unix://");
  return {
    ok: true,
    platform,
    mountsPreserveIdentity: process.platform === "linux" && local && !/docker desktop/i.test(os),
  };
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
  /** The daemon's image platform (from {@link dockerAvailability}); default: this host's. */
  platform?: PinnedPlatform;
  /** Whether bind mounts show the host's device and inode numbers (default: false). */
  mountsPreserveIdentity?: boolean;
  /** The environment the image repository override is read from (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
}

interface Inspected {
  /** The image id the container was created from. */
  Image: string;
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Running: boolean };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
  HostConfig: { NanoCpus: number; Memory: number };
  NetworkSettings: { Networks: Record<string, unknown> };
}

/**
 * The docker-mode device's one long-lived container of the pinned sandbox image (by digest, from
 * `docker-image.ts`): the device
 * directory's workspace, skills (read only) and tmp are mounted at /workspace, /skills and /tmp.
 * It hosts the permission operations (`docker-operations.ts`): each one holds the container
 * through {@link operationContainer}, so it is never recreated under a running operation. A change
 * of the container's flags recreates it at the next operation that finds it idle. Nothing here
 * runs commands or kills processes: the operation backend owns its work and stops it exactly.
 */
export class DockerContainer implements OperationContainerHost {
  readonly roots: SandboxRoots = ROOTS;
  readonly name: string;
  /** The image platform the daemon runs: the pinned digests a container's image id may match. */
  readonly imagePlatform: PinnedPlatform | undefined;
  /** The device's trusted helpers, in helper containers of the same pinned image. */
  readonly helpers: HelperLauncher;
  /** Whether a helper container sees the host's identity of a mounted directory. */
  readonly mountsPreserveIdentity: boolean;
  private readonly dir: string;
  private readonly hostRoots: SandboxRoots;
  private chain: Promise<unknown> = Promise.resolve();
  private ready = false;
  /** Operations holding the container now. */
  private inflight = 0;
  /** The spec hash of the container in use (set when it is created or reused). */
  private spec: string | undefined;

  constructor(private readonly opts: DockerContainerOptions) {
    const dir = resolve(opts.dir);
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.hostRoots = osRoots(this.dir);
    this.name = containerName(opts.deviceId);
    this.imagePlatform = opts.platform ?? pinnedPlatform(process.arch);
    this.mountsPreserveIdentity = opts.mountsPreserveIdentity ?? false;
    this.helpers = containerHelperLauncher({
      deviceId: opts.deviceId,
      image: sandboxImageReference(opts.env),
      user: containerUser(),
    });
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
  runFlags(): string[] {
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
      "--label",
      `${CONTAINER_FORMAT_LABEL}=${CONTAINER_FORMAT}`,
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
      sandboxImageReference(this.opts.env),
      "infinity",
    ];
  }

  /** A hash of the run flags: a container made with other flags is recreated. */
  private specHash(): string {
    return containerSpec(this.runFlags());
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
    // other flags, an older format, another image, a lost bridge or stale mounts: recreated, never
    // repaired
    if (
      c !== null &&
      (!this.matches(c) ||
        !this.pinnedImage(c) ||
        !("bridge" in (c.NetworkSettings.Networks ?? {})) ||
        !(await this.seesHostRoots(c)))
    ) {
      await this.mustDocker(["rm", "-f", this.name], "removing the old container");
      c = null;
    }
    if (c === null) {
      const runArgs = this.runFlags();
      const spec = containerSpec(runArgs);
      await this.mustDocker(
        ["run", "-d", "--name", this.name, "--label", `${SPEC_LABEL}=${spec}`, ...runArgs],
        "creating the container",
      );
      // created on the default bridge, from the pinned digest: anything else is never used
      const made = await this.inspect();
      if (made === null || !this.pinnedImage(made)) {
        await docker(["rm", "-f", this.name]).catch(() => {});
        throw new DeviceOpError(
          "error",
          `the device container was not created from the pinned sandbox image (${made?.Image ?? "gone"})`,
        );
      }
      this.spec = spec;
    } else {
      if (!c.State.Running) await this.mustDocker(["start", this.name], "starting the container");
      this.spec = c.Config.Labels?.[SPEC_LABEL];
    }
    this.ready = true;
  }

  /** Whether a container runs a pinned digest of the sandbox image (`docker-image.ts`). */
  private pinnedImage(c: Inspected): boolean {
    return matchPinnedImage(c.Image, this.imagePlatform) !== undefined;
  }

  /** Whether the container in use still exists, runs and carries the spec it was made with. */
  private async stillRunning(): Promise<boolean> {
    const c = await this.inspect();
    return c !== null && c.State.Running && c.Config.Labels?.[SPEC_LABEL] === this.spec;
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
   * the container user's own network; restricted operations are mediated by the launcher). The
   * caller holds the
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
      // nothing holds it: check it is still there and running. A `docker rm` or a daemon
      // restart behind this program's back would otherwise fail every operation until it
      // restarts; with operations in flight it is left alone (they fail on their own), and the
      // next idle acquire repairs it
      if (this.ready && this.inflight === 0 && !(await this.stillRunning())) this.ready = false;
      await this.ensureContainer();
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
  // an invalid repository override fails here, at start, not at the first operation
  sandboxImageReference(opts.env);
  // helper containers a killed earlier run left hold nothing the journal relies on
  await removeLeftoverHelpers(opts.deviceId);
  return new DockerContainer({
    ...opts,
    platform: available.platform,
    mountsPreserveIdentity: available.mountsPreserveIdentity,
  });
}
