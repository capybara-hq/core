import { randomBytes } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";

/**
 * Launching a background Bash task (spec 2026-11-05-background-bash-design §4.2): the task id, the
 * one short exec that starts the command detached from the exec, and the model-visible result.
 * Every path is relative to the instance's workspace root (the launch exec's `cwd`), so the
 * script is the same whatever the instance's roots are.
 */

/** The launch exec's own time limit: it only writes a file and forks. */
export const LAUNCH_EXEC_TIMEOUT_MS = 30_000;

/**
 * The longest a background task may run, in seconds: `sandbox.background.maxSeconds`, at most
 * `sandbox.limits.maxCommandSeconds`. It is also a task's default `timeout`.
 */
export const backgroundMaxSeconds = (cfg: Pick<KernelConfig, "sandbox">): number =>
  Math.min(cfg.sandbox.background.maxSeconds, cfg.sandbox.limits.maxCommandSeconds);

/** The directory of the task files, relative to the workspace root. */
export const TASKS_DIR = ".capybara/tasks";

/** A task's output file, relative to the workspace root (`output_path` while reserved). */
export const taskOutputPath = (id: string): string => `${TASKS_DIR}/${id}.out`;

/**
 * The absolute output file of a task from its `output_path`: absolute once the task started (the
 * launch records `<workspace>/.capybara/tasks/<id>.out` of its instance); a reservation's relative
 * path is read under the default workspace.
 */
export const taskOutputFile = (outputPath: string): string =>
  outputPath.startsWith("/") ? outputPath : `${DEFAULT_SANDBOX_ROOTS.workspace}/${outputPath}`;

/** The file the launch writes the session id to, relative to the workspace root. */
export const taskSidPath = (id: string): string => `${TASKS_DIR}/${id}.sid`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new task id: `bt_` plus 6 lowercase base32 characters. */
export function newTaskId(): string {
  const bytes = randomBytes(6);
  let out = "bt_";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

/** The programs the launch and the later polls and stops need in the environment. */
const REQUIRED = ["bash", "setsid", "nohup", "timeout", "pgrep", "pkill", "base64"];

/** A task id ({@link newTaskId}). */
export const TASK_ID_RE = /^bt_[a-z2-7]{6}$/;

/**
 * The shell of the launch exec: writes `command` (base64 in the script, so nothing is quoted by
 * hand) to `.capybara/tasks/<id>.sh` and starts it with bash (the shell a foreground `Bash` call
 * runs its command in) in a session of its own under `timeout -s KILL <seconds>`, with its exit
 * status written to `<id>.exit` and its output to `<id>.out`; writes the session id (`$!`, the pid
 * `setsid` started) to `<id>.sid` and prints it. An environment without one of the needed programs fails with a readable error on
 * stderr and exit code 127, before anything starts. `id` must be a task id and `seconds` a
 * positive integer (both go into the script unquoted).
 */
export function launchScript(id: string, command: string, seconds: number): string {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid background task id: ${JSON.stringify(id)}`);
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error(`invalid background task seconds: ${seconds}`);
  }
  const b64 = Buffer.from(command, "utf8").toString("base64");
  const t = `${TASKS_DIR}/${id}`;
  return [
    "set -e",
    `for c in ${REQUIRED.join(" ")}; do command -v "$c" >/dev/null 2>&1 || { echo "Background tasks need ${REQUIRED.join(", ")} in this environment; $c is missing." >&2; exit 127; }; done`,
    `mkdir -p ${TASKS_DIR}`,
    `printf '%s' '${b64}' | base64 -d > ${t}.sh`,
    `setsid nohup sh -c 'timeout -s KILL ${seconds} bash ${t}.sh; echo $? > ${t}.exit' > ${t}.out 2>&1 < /dev/null &`,
    // the session id goes to a file first: a launch that ends before its output comes back
    // (aborted, timed out) still leaves the id of what it started
    `echo $! > ${t}.sid`,
    `cat ${t}.sid`,
  ].join("\n");
}

/** The model-visible result of a launch (spec §2.1); `workspace`: the instance's workspace root. */
export function startedText(
  id: string,
  description: string,
  workspace: string = DEFAULT_SANDBOX_ROOTS.workspace,
): string {
  return [
    `Started background task ${id} ("${description}").`,
    `Output: ${workspace}/${taskOutputPath(id)}`,
    "Read it with TaskOutput (or Read), stop it with TaskStop. You will be told when it finishes.",
  ].join("\n");
}
