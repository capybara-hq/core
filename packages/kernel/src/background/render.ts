import type { EventPayload } from "../conversations/events.js";

/** `42s`, `2m05s`, `1h02m05s`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m${pad(s % 60)}s`;
}

const LOST_REASONS: Readonly<Record<string, string>> = {
  sandbox_suspended: "the sandbox was suspended",
  sandbox_gone: "the sandbox is gone",
  sandbox_recreated: "the sandbox was recreated",
  process_gone: "its processes ended without an exit code",
  launch_abandoned: "its launch was interrupted",
  supervision_lost: "its supervision was lost",
  launch_unknown:
    "whether its launch started could not be confirmed; any process it started is being stopped",
  launch_revoked:
    "its launch was revoked before its start was confirmed; any process it started is being stopped",
};

/** Why a task was lost, as the model reads it (an unknown reason as is). */
export const lostReasonText = (reason: string): string => LOST_REASONS[reason] ?? reason;

/**
 * Why a legacy (SID) launch failed is recorded in the old launcher's raw words (a provider's
 * stderr): never shown, the model gets this instead.
 */
const LEGACY_LAUNCH_FAILED =
  "its launch failed under an earlier version of the device runtime; call Bash with run_in_background again to start it";

/**
 * A task's lost or failure reason as the model reads it (`TaskOutput`, `TaskList`): kernel text
 * only. A managed task's reasons are the kernel's own; a legacy row's unknown reason is the old
 * launcher's raw text and is replaced.
 */
export function taskReasonText(task: { lostReason: string | null; launchState: string }): string {
  const reason = task.lostReason ?? "";
  const known = lostReasonText(reason);
  if (known !== reason || task.launchState !== "legacy") return known;
  return LEGACY_LAUNCH_FAILED;
}

type Finished = EventPayload<"background_task_finished">;

const statusWord = (status: Finished["status"]): string =>
  status === "timed_out" ? "timed out" : status;

/**
 * The model-visible text of a `background_task_finished` event, rendered as a system message (spec
 * 2026-11-05-background-bash-design §2.4):
 *
 * ```
 * Background task bt_k3f9a2 ("Run the test suite") completed with exit code 1 after 4m12s.
 * Last lines:
 * …
 * Full output: /workspace/.capybara/tasks/bt_k3f9a2.out
 * ```
 *
 * Without an exit code the first line has no "with exit code"; without output the last lines are
 * `Last lines: (none)`. A finish a tool call already reported (`reported`) is one short line.
 * Read only from the payload, so a replay renders it identically.
 */
export function renderBackgroundFinished(p: Finished): string {
  const head = `Background task ${p.taskId} (${JSON.stringify(p.description)}) ${statusWord(p.status)}`;
  if (p.reported) return `${head}; already reported.`;
  const lost = p.lostReason === undefined ? "" : ` (${lostReasonText(p.lostReason)})`;
  const exit = p.exitCode === null ? "" : ` with exit code ${p.exitCode}`;
  const lines = p.lastLines.replace(/\n+$/, "");
  return [
    `${head}${lost}${exit} after ${formatElapsed(p.elapsedMs)}.`,
    lines === "" ? "Last lines: (none)" : `Last lines:\n${lines}`,
    `Full output: ${p.outputPath}`,
  ].join("\n");
}
