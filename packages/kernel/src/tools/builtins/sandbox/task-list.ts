import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { formatElapsed, lostReasonText } from "../../../background/render.js";
import type { BackgroundTaskRow } from "../../../background/store.js";
import type { ChildAgent } from "../../../conversations/agent-tree.js";
import type { BuiltinResult, BuiltinTool } from "../../registry.js";
import {
  clip,
  display,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
} from "./common.js";
import { outputFile, taskEnv } from "./task-output.js";

/** How many finished background tasks (and finished sub-agents) `TaskList` lists at most. */
export const TASK_LIST_FINISHED_LIMIT = 20;

const SPEC: ToolSpec = {
  name: "TaskList",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["status"],
  description:
    "List this conversation's background tasks (started with Bash and run_in_background) and the " +
    "sub-agents it dispatched. Running tasks come first, then the most recently finished ones " +
    "(at most 20); each has its id, description, status (running, " +
    "completed, failed, timed_out, stopped or lost), elapsed time, exit code once finished and " +
    "output file. Sub-agents are listed with their agentId, description and status. Use it to " +
    "find a task id you lost track of, for example after a long run; then use TaskOutput to read " +
    "a task's output or TaskStop to stop it. Statuses are as last checked: TaskOutput checks a " +
    "task now. It only reads, and lists nothing from other conversations.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["running", "all"],
        description: `"running" lists only what is still running; "all" (the default) also lists the ${TASK_LIST_FINISHED_LIMIT} most recently finished tasks and sub-agents.`,
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

interface TaskListInput {
  status?: "running" | "all";
}

/** `running for 2m05s`, `failed, exit code 3, after 4m12s`, `lost (the sandbox was suspended), after 3s`. */
function taskState(task: BackgroundTaskRow, now: Date): string {
  const end = task.status === "running" ? now : (task.finishedAt ?? now);
  const elapsed = formatElapsed(end.getTime() - task.startedAt.getTime());
  if (task.status === "running") {
    return task.sandboxCreatedAt === null ? "starting" : `running for ${elapsed}`;
  }
  let s: string = task.status;
  if (task.lostReason !== null) s += ` (${lostReasonText(task.lostReason)})`;
  if (task.exitCode !== null) s += `, exit code ${task.exitCode}`;
  return `${s}, after ${elapsed}`;
}

function taskEntry(task: BackgroundTaskRow, now: Date): string {
  const output =
    task.sandboxCreatedAt === null && task.status !== "running"
      ? "none (the command never started)"
      : outputFile(task);
  return `- ${task.id} ${taskState(task, now)}: ${JSON.stringify(task.description)}\n  Output: ${output}`;
}

const ACTIVE_AGENT: ReadonlySet<ChildAgent["status"]> = new Set(["queued", "running", "waiting"]);

const agentStatus = (s: ChildAgent["status"]): string => (s === "aborted" ? "stopped" : s);

const agentEntry = (a: ChildAgent): string =>
  `- ${a.id} ${agentStatus(a.status)}: ${JSON.stringify(clip(a.description, 200))}`;

/** `1 running, 2 finished` (a zero count left out; `none` when both are). */
function counts(running: number, finished: number, onlyRunning: boolean): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (finished > 0) parts.push(`${finished} finished`);
  if (parts.length === 0) return onlyRunning ? "none running" : "none";
  return parts.join(", ");
}

/**
 * Built-in `TaskList`: the calling conversation's own background tasks (never its sub-agents' or
 * another conversation's: owner `conversation_id`, as `TaskOutput` checks) and the sub-agents it
 * dispatched itself. Running entries first (oldest first), then with `status: "all"` the
 * {@link TASK_LIST_FINISHED_LIMIT} most recently finished. Reads PG only: it never checks a task in
 * its sandbox, so a status is the poller's or a tool's last one.
 */
export function taskListTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      const onlyRunning = (input as TaskListInput).status === "running";
      const env = await taskEnv(deps, ctx);
      const store = deps.background as NonNullable<SandboxToolDeps["background"]>;
      const [running, finished, agents] = await Promise.all([
        store.runningOwnedBy(ctx.conversationId),
        onlyRunning
          ? { rows: [], total: 0 }
          : store.finishedOwnedBy(ctx.conversationId, TASK_LIST_FINISHED_LIMIT),
        env.subagents?.childrenOf(ctx.orgId, ctx.conversationId) ?? [],
      ]);
      const now = new Date();
      const activeAgents = agents.filter((a) => ACTIVE_AGENT.has(a.status));
      const doneAgents = onlyRunning
        ? []
        : agents
            .filter((a) => !ACTIVE_AGENT.has(a.status))
            .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0));
      const listedDone = doneAgents.slice(0, TASK_LIST_FINISHED_LIMIT);

      if (running.length + finished.total + activeAgents.length + doneAgents.length === 0) {
        return result(
          onlyRunning
            ? "No background tasks or sub-agents are running in this conversation."
            : "No background tasks or sub-agents in this conversation.",
        );
      }

      const lines: string[] = [
        `Background tasks: ${counts(running.length, finished.total, onlyRunning)}.`,
        ...running.map((t) => taskEntry(t, now)),
        ...finished.rows.map((t) => taskEntry(t, now)),
      ];
      const olderTasks = finished.total - finished.rows.length;
      if (olderTasks > 0) lines.push(`(${olderTasks} older finished tasks are not listed.)`);
      if (agents.length > 0) {
        lines.push(
          "",
          `Sub-agents: ${counts(activeAgents.length, doneAgents.length, onlyRunning)}.`,
          ...activeAgents.map(agentEntry),
          ...listedDone.map(agentEntry),
        );
        const olderAgents = doneAgents.length - listedDone.length;
        if (olderAgents > 0)
          lines.push(`(${olderAgents} older finished sub-agents are not listed.)`);
      }
      lines.push(
        "",
        "Statuses are as last checked. Use TaskOutput to check a task now and read its output, TaskStop to stop it." +
          (agents.length > 0
            ? " A sub-agent's report arrives on its own; use SendMessage to give it more instructions."
            : ""),
      );
      return result(lines.join("\n"));
    },
  };
}

function result(text: string): BuiltinResult {
  return {
    content: [{ type: "text", text }],
    isError: false,
    display: display("列出后台任务", "List background tasks"),
  };
}
