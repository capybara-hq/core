import { unpinnedArchitectureProblem } from "./exec/docker-image.js";

/**
 * The interpreter the trusted helpers run with in OS mode, by absolute path (never looked up on
 * PATH). Docker mode needs none on the host: its helpers run in helper containers of the pinned
 * sandbox image.
 */
export const HOST_PYTHON = "/usr/bin/python3";

/** The host facts of the docker-mode check; injectable for tests. */
export interface HostProbes {
  /** The architecture docker mode would run on (default: `process.arch`). */
  arch?: string;
}

/** Why a docker-mode device cannot run on this host, with the JSON error code of login. */
export interface DockerHostProblem {
  code: "docker_unsupported_architecture";
  message: string;
}

/**
 * Why a docker-mode device cannot run on this host, or undefined when it can: an architecture the
 * pinned sandbox image has no platform for. Docker itself is checked when the device starts.
 */
export function dockerHostProblem(
  _platform: NodeJS.Platform,
  probes: HostProbes = {},
): DockerHostProblem | undefined {
  const arch = unpinnedArchitectureProblem(probes.arch);
  if (arch !== undefined) return { code: "docker_unsupported_architecture", message: arch };
  return undefined;
}
