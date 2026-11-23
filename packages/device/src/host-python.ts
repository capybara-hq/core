import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { unpinnedArchitectureProblem } from "./exec/docker-image.js";

/** The interpreter the trusted helpers run with, by absolute path (never looked up on PATH). */
export const HOST_PYTHON = "/usr/bin/python3";

/** Whether `path` is an executable file on this machine (injectable for tests). */
export type ExecutableCheck = (path: string) => boolean;

export const isExecutableFile: ExecutableCheck = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether the macOS command line tools are installed (`xcode-select -p`, never the python shim). */
export type CommandLineToolsCheck = () => boolean;

export const commandLineToolsInstalled: CommandLineToolsCheck = () => {
  try {
    return (
      spawnSync("/usr/bin/xcode-select", ["-p"], { timeout: 5000, stdio: "ignore" }).status === 0
    );
  } catch {
    return false;
  }
};

/** The host probes of the docker-mode check; both injectable for tests. */
export interface HostProbes {
  isExecutable?: ExecutableCheck;
  commandLineTools?: CommandLineToolsCheck;
  /** The architecture docker mode would run on (default: `process.arch`). */
  arch?: string;
}

/** Why a docker-mode device cannot run on this host, with the JSON error code of login. */
export interface DockerHostProblem {
  code: "docker_unsupported_architecture" | "host_python_missing";
  message: string;
}

/**
 * Why a docker-mode device cannot run on this host, or undefined when it can: an architecture the
 * pinned sandbox image has no platform for, or a missing host interpreter ({@link hostPythonProblem}).
 */
export function dockerHostProblem(
  platform: NodeJS.Platform,
  probes: HostProbes = {},
): DockerHostProblem | undefined {
  const arch = unpinnedArchitectureProblem(probes.arch);
  if (arch !== undefined) return { code: "docker_unsupported_architecture", message: arch };
  const python = hostPythonProblem(platform, probes);
  if (python !== undefined) return { code: "host_python_missing", message: python };
  return undefined;
}

/**
 * Why a docker-mode device cannot run on this host, or undefined when it can. Docker mode runs the
 * operations in a container, but the program still verifies and stages its runtime on the host with
 * the host's `/usr/bin/python3` (trusted helpers launched by absolute path, never from PATH).
 */
export function hostPythonProblem(
  platform: NodeJS.Platform,
  probes: HostProbes = {},
): string | undefined {
  const present = (probes.isExecutable ?? isExecutableFile)(HOST_PYTHON);
  // on macOS /usr/bin/python3 is always an executable shim: it only works with the command line
  // tools, and running it without them may open an install dialog, so ask xcode-select instead
  if (
    present &&
    (platform !== "darwin" || (probes.commandLineTools ?? commandLineToolsInstalled)())
  )
    return undefined;
  const install =
    platform === "darwin"
      ? "Install the Xcode command line tools: xcode-select --install"
      : "Install it with your package manager, e.g. sudo apt install python3 (Debian, Ubuntu) or " +
        "sudo dnf install python3 (Fedora, RHEL)";
  return (
    `Docker mode needs ${HOST_PYTHON} on this machine, and it is missing or not usable. ` +
    "The program runs its trusted helpers with it on the host (it verifies and stages the runtime " +
    "that serves the device container), even though the work itself runs in the container. " +
    `${install}, then try again.`
  );
}
