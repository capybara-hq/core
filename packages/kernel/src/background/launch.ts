import { randomBytes } from "node:crypto";
import type { KernelConfig } from "../config/schema.js";

/**
 * Launching a background Bash task (spec 2026-11-05-background-bash-design §4.2): the task id, the
 * one short exec that starts the command detached from the exec, and the model-visible result.
 * Every path is relative to `/workspace` (the launch exec's `cwd`), so a provider that maps
 * `/workspace` needs no rewriting inside the script.
 */

/** The launch exec's own time limit: it only writes a file and forks. */
export const LAUNCH_EXEC_TIMEOUT_MS = 30_000;

/**
 * The longest a background task may run, in seconds: `sandbox.background.maxSeconds`, at most
 * `sandbox.limits.maxCommandSeconds`. It is also a task's default `timeout`.
 */
export const backgroundMaxSeconds = (cfg: Pick<KernelConfig, "sandbox">): number =>
  Math.min(cfg.sandbox.background.maxSeconds, cfg.sandbox.limits.maxCommandSeconds);

/** The directory of the task files, relative to `/workspace`. */
export const TASKS_DIR = ".capybara/tasks";

/** A task's output file, relative to `/workspace` (`output_path`). */
export const taskOutputPath = (id: string): string => `${TASKS_DIR}/${id}.out`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new task id: `bt_` plus 6 lowercase base32 characters. */
export function newTaskId(): string {
  const bytes = randomBytes(6);
  let out = "bt_";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

/** The programs the launch and the later polls and stops need inside the sandbox. */
const REQUIRED = ["setsid", "nohup", "timeout", "pgrep", "pkill", "base64"];

/**
 * The shell of the launch exec: writes `command` (base64 in the script, so nothing is quoted by
 * hand) to `.capybara/tasks/<id>.sh`, starts it in a session of its own under `timeout -s KILL
 * <seconds>`, with its exit status written to `<id>.exit` and its output to `<id>.out`, and prints
 * the session id (`$!`, the pid `setsid` started). A sandbox without one of the needed programs
 * fails with a readable error on stderr and exit code 127, before anything starts.
 */
export function launchScript(id: string, command: string, seconds: number): string {
  const b64 = Buffer.from(command, "utf8").toString("base64");
  const t = `${TASKS_DIR}/${id}`;
  return [
    "set -e",
    `for c in ${REQUIRED.join(" ")}; do command -v "$c" >/dev/null 2>&1 || { echo "Background tasks need ${REQUIRED.join(", ")} in the sandbox; $c is missing." >&2; exit 127; }; done`,
    `mkdir -p ${TASKS_DIR}`,
    `printf '%s' '${b64}' | base64 -d > ${t}.sh`,
    `setsid nohup sh -c 'timeout -s KILL ${seconds} sh ${t}.sh; echo $? > ${t}.exit' > ${t}.out 2>&1 < /dev/null &`,
    "echo $!",
  ].join("\n");
}

/** The model-visible result of a launch (spec §2.1). */
export function startedText(id: string, description: string): string {
  return [
    `Started background task ${id} ("${description}").`,
    `Output: /workspace/${taskOutputPath(id)}`,
    "Read it with TaskOutput (or Read), stop it with TaskStop. You will be told when it finishes.",
  ].join("\n");
}
