import { randomBytes } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxOperationScope,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";

/**
 * Launching a background Bash task (spec 2026-11-05-background-bash-design §4.2, permission
 * runtime cutover phase 8.2): the task id, the managed artifact placement and the model-visible
 * result. A task starts only through the device's exact `backgroundStart` operation; no shell
 * script launches, polls or stops a task.
 */

/** The time limit of the start itself (the task's own time limit runs on the device). */
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
 * The absolute output file of a task from its `output_path`: a managed task's is always absolute;
 * a legacy row reserved but never started kept a relative one, read under the default workspace.
 */
export const taskOutputFile = (outputPath: string): string =>
  outputPath.startsWith("/") ? outputPath : `${DEFAULT_SANDBOX_ROOTS.workspace}/${outputPath}`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new task id: `bt_` plus 6 lowercase base32 characters. */
export function newTaskId(): string {
  const bytes = randomBytes(6);
  let out = "bt_";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

/** A task id ({@link newTaskId}). */
export const TASK_ID_RE = /^bt_[a-z2-7]{6}$/;

/**
 * The launch result's last line: how the task's end is reported and how to read and stop it.
 */
export const LAUNCH_NEXT_STEP =
  "You will be told when it finishes. Read its output with TaskOutput (or Read), stop it with TaskStop.";

/**
 * The artifact of a managed task (permission runtime cutover §"Artifact location decision"):
 * `${workingRoot}/.capybara/tasks/${taskId}.out`, where the working root is the trusted root the
 * command executes in (the selected project's root, else the device workspace). Never a
 * caller-selected path, never roots.tmp or the default workspace as a fallback.
 */
export function managedTaskArtifactPath(workingRoot: string, taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`invalid background task id: ${taskId}`);
  return `${workingRoot === "/" ? "" : workingRoot}/${taskOutputPath(taskId)}`;
}

/** An absolute path without empty, `.` or `..` components or a trailing slash. */
const isNormalAbsolute = (p: string): boolean =>
  p === "/" ||
  (p.startsWith("/") &&
    p
      .split("/")
      .slice(1)
      .every((c) => c !== "" && c !== "." && c !== ".."));

/** Whether `path` is `root` or inside it (both normalized absolute paths). */
const within = (path: string, root: string): boolean =>
  root === "/" || path === root || path.startsWith(`${root}/`);

/**
 * Checks, before any effect, that a managed start's artifact is the deterministic placement under
 * its working root and is covered by the admitted starting write roots and the implicit write
 * protections (no `.git` component: devices deny Git configuration and hooks). Full access
 * (`device` filesystem scope) uses the same placement. Throws {@link SandboxScopeDeniedError}:
 * no fallback location, no added root or grant.
 */
export function assertManagedArtifactAdmitted(
  scope: Pick<SandboxOperationScope, "filesystem">,
  args: { cwd: string; taskId: string; outputPath: string; retainUntilMs: number },
): void {
  const deny = (why: string): never => {
    throw new SandboxScopeDeniedError(
      `The background task output cannot be created: ${why}. Choose a working directory this conversation may write to, then retry.`,
    );
  };
  if (!TASK_ID_RE.test(args.taskId)) deny("the task id is invalid");
  if (!isNormalAbsolute(args.cwd)) deny("the working root is not a normalized absolute path");
  if (args.outputPath !== managedTaskArtifactPath(args.cwd, args.taskId))
    deny("the output path is not the task's placement under its working root");
  if (!Number.isSafeInteger(args.retainUntilMs) || args.retainUntilMs <= 0)
    deny("the retention deadline is invalid");
  // case-insensitive: a case-insensitive file system resolves `.GIT` to `.git`
  if (args.outputPath.split("/").some((c) => c.toLowerCase() === ".git"))
    deny("the working root is inside protected Git metadata");
  const fs = scope.filesystem;
  if (fs.kind === "scoped" && !fs.writeRoots.some((root) => within(args.outputPath, root)))
    deny(`${args.outputPath} is outside the admitted write roots`);
}

/** The model-visible result of an acknowledged managed launch; `outputPath` is its artifact. */
export function managedStartedText(id: string, description: string, outputPath: string): string {
  return [
    `Started background task ${id} ("${description}").`,
    `Output: ${outputPath}`,
    LAUNCH_NEXT_STEP,
  ].join("\n");
}
