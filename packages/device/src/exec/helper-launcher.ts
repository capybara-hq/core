import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/**
 * How the trusted Python helpers run (the output spool, recovered-output finalization, the native
 * helper of a docker-mode device's skills preparation, the image's interpreter probe). Each helper
 * is a fixed inline source of the verified program run as `python3 -I -c <source> [args]`; what
 * differs is the interpreter and what the helper can reach.
 */
export interface HelperLauncher {
  readonly kind: "host" | "container";
  /**
   * Starts a helper that lives while its stdin is open. `paths` are the host paths it works on:
   * a container helper sees exactly those (bind-mounted at the same absolute paths) and nothing
   * else of the host. `kill()` on the returned child ends the helper for good.
   */
  spawn(
    source: string,
    args: readonly string[],
    paths: readonly string[],
  ): ChildProcessWithoutNullStreams;
  /** Runs a helper to completion with `input` on its stdin. */
  run(
    source: string,
    args: readonly string[],
    paths: readonly string[],
    input: string,
    maxBuffer: number,
  ): { status: number | null; stdout: string; error?: Error | undefined };
}

/** The host interpreter by absolute path (OS mode; never looked up on PATH). */
export function hostHelperLauncher(pythonPath: string): HelperLauncher {
  return {
    kind: "host",
    spawn: (source, args) =>
      spawn(pythonPath, ["-I", "-c", source, ...args], { stdio: ["pipe", "pipe", "pipe"] }),
    run: (source, args, _paths, input, maxBuffer) => {
      const r = spawnSync(pythonPath, ["-I", "-c", source, ...args], {
        input,
        encoding: "utf8",
        maxBuffer,
      });
      return { status: r.status, stdout: r.stdout ?? "", error: r.error };
    },
  };
}

/** The label every helper container of a device carries (leftovers are removed by it at start). */
export const HELPER_LABEL = "capybara.device.helper";
/** The image's interpreter, by absolute path. */
const IMAGE_PYTHON = "/usr/bin/python3";
const HELPER_PIDS_LIMIT = 64;

/**
 * A host path a helper container may mount at the same path: absolute, normalized, its own real
 * path (no link anywhere, so the mount is exactly the directory checked), and nothing the
 * `--mount` value would parse as syntax (a comma or quote) or that a path cannot hold.
 */
export function checkMountPath(path: string): string {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === "/" ||
    path.endsWith("/") ||
    /[,"'\n\r\0]/.test(path)
  )
    throw new Error(`A helper container cannot mount ${JSON.stringify(path)}`);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`A helper container cannot mount ${JSON.stringify(path)}: it does not exist`);
  }
  if (real !== path)
    throw new Error(
      `A helper container cannot mount ${JSON.stringify(path)}: it resolves to ${real}`,
    );
  return path;
}

export interface ContainerHelperOptions {
  deviceId: string;
  /** The pinned image reference (`repository@index`). */
  image: string;
  /** The uid:gid the helper runs as (the device container's user). */
  user: string;
  /** A unique suffix for container names (default: random). */
  suffix?: () => string;
}

/**
 * Every `docker run` argument of one trusted helper container: the pinned image's interpreter, no
 * network, a read-only root, no capabilities, no new privileges, a small pids limit, no log
 * driver (a helper's stdout carries output bytes, which must not land in Docker's logs), and
 * exactly the step's host paths mounted read-write at the same absolute paths.
 */
export function helperContainerArgs(
  o: ContainerHelperOptions,
  name: string,
  source: string,
  args: readonly string[],
  paths: readonly string[],
): string[] {
  const mounts = [...new Set(paths.map(checkMountPath))];
  return [
    "run",
    "--rm",
    "-i",
    // never a pull: the device container already runs the pinned image, so a missing image fails
    // fast (and closed) instead of blocking on the registry
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    `${HELPER_LABEL}=${o.deviceId}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    String(HELPER_PIDS_LIMIT),
    "--log-driver",
    "none",
    "--user",
    o.user,
    "--workdir",
    "/",
    ...mounts.flatMap((p) => ["--mount", `type=bind,source=${p},target=${p}`]),
    "--entrypoint",
    IMAGE_PYTHON,
    o.image,
    "-I",
    "-c",
    source,
    ...args,
  ];
}

/** Removes a helper container by name; resolves once `docker rm -f` returned. */
function removeContainer(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    } catch {
      resolve();
    }
  });
}

/** The removal each killed container helper started, by its client process. */
const gone = new WeakMap<object, Promise<void>>();

/**
 * Resolves once a killed helper is gone for good: for a container helper, once its container was
 * removed (killing the `docker run` client alone does not stop a helper that already read its
 * request); at once for a host helper or one never killed.
 */
export function helperGone(child: object): Promise<void> {
  return gone.get(child) ?? Promise.resolve();
}

/**
 * Trusted helpers in short-lived containers of the pinned image (docker mode): the host needs no
 * interpreter, and a link planted in a mounted tree can reach only what the helper container
 * mounts, never the rest of the host. The helper ends when its stdin closes (the program exiting
 * included: `docker run` without a terminal closes the container's stdin when its client goes),
 * and `--rm` removes it; `kill()` also removes it at once.
 */
export function containerHelperLauncher(o: ContainerHelperOptions): HelperLauncher {
  const name = () =>
    `capybara-helper-${o.deviceId}-${o.suffix ? o.suffix() : randomBytes(6).toString("hex")}`;
  return {
    kind: "container",
    spawn: (source, args, paths) => {
      const n = name();
      const child = spawn("docker", helperContainerArgs(o, n, source, args, paths), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const kill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals | number) => {
        if (!gone.has(child)) gone.set(child, removeContainer(n));
        return kill(signal);
      };
      return child;
    },
    run: (source, args, paths, input, maxBuffer) => {
      const n = name();
      const r = spawnSync("docker", helperContainerArgs(o, n, source, args, paths), {
        input,
        encoding: "utf8",
        maxBuffer,
        timeout: 60_000,
      });
      if (r.error || r.signal) void removeContainer(n);
      return { status: r.status, stdout: r.stdout ?? "", error: r.error };
    },
  };
}

/**
 * Removes the helper containers an earlier run of this device left (a killed program): they hold
 * nothing the journal relies on, since a spool's durable state is on the host disk and recovery
 * re-verifies it.
 */
export async function removeLeftoverHelpers(deviceId: string): Promise<void> {
  const out = await new Promise<string | undefined>((resolve) => {
    const child = spawn("docker", ["ps", "-aq", "--filter", `label=${HELPER_LABEL}=${deviceId}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "";
    child.stdout?.on("data", (b: Buffer) => {
      text += b.toString("utf8");
    });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? text : undefined));
  });
  const ids = (out ?? "").split("\n").filter((l) => /^[0-9a-f]{12,64}$/.test(l));
  if (ids.length === 0) return;
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}
