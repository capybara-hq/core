import { accessSync, constants, statSync } from "node:fs";

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

/**
 * Why a docker-mode device cannot run on this host, or undefined when it can. Docker mode runs the
 * operations in a container, but the program still verifies and stages its runtime on the host with
 * the host's `/usr/bin/python3` (trusted helpers launched by absolute path, never from PATH).
 */
export function hostPythonProblem(
  platform: NodeJS.Platform,
  check: ExecutableCheck = isExecutableFile,
): string | undefined {
  if (check(HOST_PYTHON)) return undefined;
  const install =
    platform === "darwin"
      ? "Install the Xcode command line tools: xcode-select --install"
      : "Install it with your package manager, e.g. sudo apt install python3 (Debian, Ubuntu) or " +
        "sudo dnf install python3 (Fedora, RHEL)";
  return (
    `Docker mode needs ${HOST_PYTHON} on this machine, and it is missing or not executable. ` +
    "The program runs its trusted helpers with it on the host (it verifies and stages the runtime " +
    "that serves the device container), even though the work itself runs in the container. " +
    `${install}, then try again.`
  );
}
