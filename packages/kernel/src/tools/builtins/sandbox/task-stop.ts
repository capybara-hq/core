import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { decodeTail, tailCommand } from "../../../background/session.js";
import type { BackgroundTaskRow } from "../../../background/store.js";
import type { BuiltinResult, BuiltinTool } from "../../registry.js";
import {
  clip,
  display,
  mapSandboxError,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
} from "./common.js";
import {
  onTaskInstance,
  ownedTask,
  recheckEnvironment,
  statusLine,
  type TaskEnv,
  taskEnv,
} from "./task-output.js";

/** The time limit of reading a stopped task's last lines. */
const TAIL_EXEC_TIMEOUT_MS = 10_000;

const SPEC: ToolSpec = {
  name: "TaskStop",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["task_id"],
  description:
    "Stop a background task started with Bash and run_in_background: every process of the task " +
    "gets SIGTERM, then SIGKILL after 5 seconds. The result has the final status and the last " +
    "lines of output. Stopping a task that has already finished is not an error; the result says " +
    "so. A conversation can stop only its own tasks.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        minLength: 1,
        description: "The id of the background task (bt_...) that Bash returned.",
      },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

interface TaskStopInput {
  task_id: string;
}

/** The task's last 20 lines, read from its own sandbox instance; null when that is not running. */
async function lastLinesOf(
  env: TaskEnv,
  task: BackgroundTaskRow,
  signal: AbortSignal,
): Promise<string | null> {
  if (task.sandboxCreatedAt === null) return null;
  try {
    const r = await onTaskInstance(
      env,
      task,
      async (p, h, sig) => {
        const res = await p.exec(h, {
          command: tailCommand(task.id),
          cwd: "/workspace",
          timeoutMs: TAIL_EXEC_TIMEOUT_MS,
          maxOutputBytes: 64 * 1024,
          signal: sig,
        });
        return res.exitCode === 0 ? decodeTail(res.stdout) : null;
      },
      signal,
    );
    return r.kind === "ran" ? r.value : null;
  } catch {
    // the task is stopped either way; only its last lines are missing
    return null;
  }
}

/** The result text: what happened, the status line and the last lines. */
async function ended(
  env: TaskEnv,
  task: BackgroundTaskRow,
  what: string,
  signal: AbortSignal,
): Promise<BuiltinResult> {
  const lines = await lastLinesOf(env, task, signal);
  const tail =
    task.sandboxCreatedAt === null
      ? "[No output: the command never started.]"
      : lines === null
        ? "[Last lines unavailable: the sandbox that ran this task is not running.]"
        : lines === ""
          ? "[No output.]"
          : `Last lines:\n${lines.replace(/\n$/, "")}`;
  return text(
    task,
    `Background task ${task.id} ("${task.description}") ${what}.\n${statusLine(task)}\n${tail}`,
  );
}

function text(task: BackgroundTaskRow, body: string): BuiltinResult {
  const d = clip(task.description, 120);
  return {
    content: [{ type: "text", text: body }],
    isError: false,
    display: display(`停止后台任务：${d}`, `Stop background task: ${d}`),
  };
}

/**
 * Built-in `TaskStop` (spec 2026-11-05-background-bash-design §2.3): stops one of this
 * conversation's background tasks through `BackgroundTaskStopper` (SIGTERM to its session, SIGKILL
 * after 5 s, never creating or resuming a sandbox). A task that had already finished is not an
 * error; a reservation still launching, or a task another stop already claimed, is reported as
 * stopping. A stop that failed leaves the task running and is an error the model can retry.
 */
export function taskStopTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      const { task_id } = input as TaskStopInput;
      const env = taskEnv(deps);
      const task = await ownedTask(env, ctx, task_id);
      await recheckEnvironment(env, ctx);
      if (task.status !== "running") {
        return ended(env, task, "had already finished", ctx.signal);
      }
      let after: BackgroundTaskRow;
      try {
        after = await env.tasks.stopper.stop(task, "tool", ctx.signal);
      } catch (e) {
        const mapped = mapSandboxError(e, env.log);
        if (mapped instanceof ToolError) throw mapped;
        const why = e instanceof Error ? e.message : String(e);
        throw new ToolError(
          `Background task ${task.id} could not be stopped (${clip(why, 300)}); it keeps running. Retry TaskStop, or check the sandbox with Bash.`,
        );
      }
      if (after.status === "running") {
        return text(
          after,
          `Background task ${after.id} ("${after.description}") is stopping: it is still starting, or another stop is in progress. Call TaskOutput to see when it has ended.`,
        );
      }
      const what =
        after.status === "stopped"
          ? "was stopped"
          : after.status === "lost"
            ? "is lost"
            : "had already finished";
      return ended(env, after, what, ctx.signal);
    },
  };
}
