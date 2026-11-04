import { setTimeout as sleep } from "node:timers/promises";
import { type SandboxHandle, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BackgroundFinish } from "../../../background/finish.js";
import { TASK_ID_RE, TASKS_DIR } from "../../../background/launch.js";
import { SID_RE } from "../../../background/session.js";
import {
  parsePollOutput,
  polledAs,
  pollScript,
  type TaskReport,
} from "../../../background/status.js";
import { notRunningAs, RECREATED } from "../../../background/stop.js";
import type { BackgroundTaskRow } from "../../../background/store.js";
import type {
  IfRunningResult,
  SandboxService,
  TaggedProvider,
} from "../../../sandbox/sandbox.service.js";
import type { BuiltinCallContext, BuiltinTool } from "../../registry.js";
import {
  clip,
  display,
  mapSandboxError,
  noSandboxError,
  runTimeLeftMs,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
} from "./common.js";

/** How long `TaskOutput` waits with `block` when `timeout` is not given (ms). */
export const TASK_OUTPUT_DEFAULT_TIMEOUT_MS = 30_000;
/** The longest `TaskOutput` wait (ms). */
export const TASK_OUTPUT_MAX_TIMEOUT_MS = 600_000;
/** How often a blocking `TaskOutput` checks the task (each check a short exec of its own). */
export const TASK_CHECK_INTERVAL_MS = 2000;
/** The time limit of one check or read exec. */
const READ_EXEC_TIMEOUT_MS = 30_000;

const SPEC: ToolSpec = {
  name: "TaskOutput",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["task_id"],
  description:
    "Read the status and output of a background task started with Bash and run_in_background. " +
    "The result has the status (running, completed, failed, stopped, timed out or lost), the " +
    "exit code and the elapsed time, then the output the task wrote since the last TaskOutput " +
    "call for it. With block (the default) it waits until the task finishes or timeout " +
    "milliseconds pass, checking every 2 seconds; prefer this over sleeping in Bash. Large " +
    "output is saved and can be paged with ReadToolOutput; the whole output file can also be " +
    "read with Read. You are told when a task finishes, so there is no need to poll for that.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        minLength: 1,
        description: "The id of the background task (bt_...) that Bash returned.",
      },
      block: {
        type: "boolean",
        description: "Whether to wait for the task to finish. Default true.",
      },
      timeout: {
        type: "number",
        minimum: 0,
        maximum: TASK_OUTPUT_MAX_TIMEOUT_MS,
        description: `Milliseconds to wait at most when block is true. Default ${TASK_OUTPUT_DEFAULT_TIMEOUT_MS}, at most ${TASK_OUTPUT_MAX_TIMEOUT_MS}; never past the run's own time limit.`,
      },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

interface TaskOutputInput {
  task_id: string;
  block?: boolean;
  /** Milliseconds. */
  timeout?: number;
}

// ---- shared with TaskStop ----

/** What `TaskOutput` and `TaskStop` work with. */
export interface TaskEnv {
  store: NonNullable<SandboxToolDeps["background"]>;
  tasks: NonNullable<SandboxToolDeps["tasks"]>;
  ifRunning: SandboxService["ifRunning"];
}

/** The task tools' dependencies; throws the tool's error when they are missing. */
export function taskEnv(deps: SandboxToolDeps): TaskEnv {
  if (!deps.sandbox.available) throw noSandboxError();
  const { background, tasks } = deps;
  if (!background || !tasks || !deps.sandbox.ifRunning) {
    throw new ToolError(
      "Background tasks are not available here; use Bash without run_in_background instead.",
    );
  }
  return { store: background, tasks, ifRunning: deps.sandbox.ifRunning.bind(deps.sandbox) };
}

const notFound = (id: string): ToolError =>
  new ToolError(
    `No background task ${clip(id, 40)} in this conversation. Pass a task id that Bash with run_in_background returned in this conversation.`,
  );

/**
 * The task `id` when it belongs to the calling conversation; a task of another conversation (a
 * sub-agent's, when called from its parent) is not found, the same as an unknown id.
 */
export async function ownedTask(
  env: TaskEnv,
  ctx: BuiltinCallContext,
  id: string,
): Promise<BackgroundTaskRow> {
  if (!TASK_ID_RE.test(id)) throw notFound(id);
  const task = await env.store.get(id);
  if (!task || task.conversationId !== ctx.conversationId) throw notFound(id);
  return task;
}

/** `ifRunning` on the task's own sandbox instance; sandbox errors become the tools' errors. */
export async function onTaskInstance<T>(
  env: TaskEnv,
  task: BackgroundTaskRow,
  fn: (p: TaggedProvider, h: SandboxHandle, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<IfRunningResult<T>> {
  try {
    return await env.ifRunning(
      task.sandboxConversationId,
      { createdAt: task.sandboxCreatedAt as Date },
      fn,
      signal,
    );
  } catch (e) {
    throw mapSandboxError(e);
  }
}

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
};

/**
 * The task's status line: `Status: running (2m05s)`, `Status: failed, exit code 3, after 4m12s`,
 * `Status: stopped after 1m00s`, `Status: lost (the sandbox was suspended) after 3s`.
 */
export function statusLine(task: BackgroundTaskRow, now = new Date()): string {
  const end = task.status === "running" ? now : (task.finishedAt ?? now);
  const elapsed = formatElapsed(end.getTime() - task.startedAt.getTime());
  if (task.status === "running") return `Status: running (${elapsed})`;
  let s = `Status: ${task.status === "timed_out" ? "timed out" : task.status}`;
  if (task.lostReason !== null) s += ` (${LOST_REASONS[task.lostReason] ?? task.lostReason})`;
  if (task.exitCode !== null) return `${s}, exit code ${task.exitCode}, after ${elapsed}`;
  return `${s} after ${elapsed}`;
}

/** The absolute path of the task's output file, as the model sees it. */
export const outputFile = (task: BackgroundTaskRow): string => `/workspace/${task.outputPath}`;

/** Why the output cannot be read: the task's sandbox instance is not running. */
export function unavailableText(task: BackgroundTaskRow, r: IfRunningResult<unknown>): string {
  if (r.kind === "not_running" && r.status === "suspended") {
    return `[Output unavailable: the sandbox is suspended. Read ${outputFile(task)} resumes it and reads what the task wrote.]`;
  }
  return "[Output unavailable: the sandbox that ran this task is gone, and its output with it.]";
}

// ---- reading a task ----

/**
 * The exec that checks and reads task `t` (relative to `/workspace`): for a running task first
 * its status line (the poller's, {@link pollScript}: liveness, then the exit file), then
 * `size <bytes>` and `out <base64>`, at most `cap` bytes of the output from byte `offset` on.
 * The file is never read whole: `tail -c +<offset+1> | head -c <cap>`. Without `read` only the
 * status line.
 */
export function taskReadScript(
  t: { id: string; sid: string | null; running: boolean },
  offset: number,
  cap: number,
  read = true,
): string {
  if (!TASK_ID_RE.test(t.id)) throw new Error(`invalid background task id: ${t.id}`);
  const lines: string[] = [];
  if (t.running && t.sid !== null) lines.push(pollScript([{ id: t.id, sid: t.sid }]));
  if (read) {
    const f = `${TASKS_DIR}/${t.id}.out`;
    const from = Math.max(0, Math.floor(offset)) + 1;
    const n = Math.max(1, Math.floor(cap));
    lines.push(`s=$({ wc -c < ${f}; } 2>/dev/null | tr -d ' '); echo "size \${s:-0}"`);
    lines.push(
      `printf 'out '; { tail -c +${from} ${f} 2>/dev/null | head -c ${n} | base64 | tr -d '\\n'; }; echo`,
    );
  }
  return lines.join("\n");
}

/** What one check or read of a task saw. */
interface Seen {
  /** The status line of a running task (absent for a finished one, or when not reported). */
  report: TaskReport | undefined;
  /** The output file's size in bytes. */
  size: number;
  /** The bytes read. */
  data: Buffer;
}

function parseRead(id: string, stdout: string): Seen {
  const size = /^size ([0-9]+)$/m.exec(stdout);
  const out = /^out ?([A-Za-z0-9+/=]*)$/m.exec(stdout);
  return {
    report: parsePollOutput(stdout).get(id),
    size: size ? Number(size[1]) : 0,
    data: Buffer.from(out?.[1] ?? "", "base64"),
  };
}

/**
 * The bytes of `buf` up to its last whole UTF-8 character: a character cut by the read's cap is
 * left for the next read.
 */
export function wholeUtf8Length(buf: Uint8Array): number {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 3 && ((buf[i] as number) & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) return buf.length;
  const b = buf[i] as number;
  const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return i + need > buf.length ? i : buf.length;
}

/** Checks (and with `read`, reads) the task in its sandbox instance; never creates or resumes one. */
async function look(
  env: TaskEnv,
  task: BackgroundTaskRow,
  read: { offset: number; cap: number } | null,
  signal: AbortSignal,
): Promise<IfRunningResult<Seen>> {
  if (task.sid !== null && !SID_RE.test(task.sid)) {
    throw new Error(`invalid background task session: ${task.sid}`);
  }
  const script = taskReadScript(
    { id: task.id, sid: task.sid, running: task.status === "running" },
    read?.offset ?? 0,
    read?.cap ?? 1,
    read !== null,
  );
  const maxBytes = Math.ceil((read?.cap ?? 0) / 3) * 4 + 64 * 1024;
  return onTaskInstance(
    env,
    task,
    async (p, h, sig) => {
      const r = await p.exec(h, {
        command: script,
        cwd: "/workspace",
        timeoutMs: READ_EXEC_TIMEOUT_MS,
        maxOutputBytes: maxBytes,
        signal: sig,
      });
      if (r.exitCode !== 0 || r.truncated) {
        throw new ToolError(
          `Background task ${task.id} could not be read (exit ${r.exitCode}${r.truncated ? ", output truncated" : ""}); retry TaskOutput, or Read ${outputFile(task)}.`,
        );
      }
      return parseRead(task.id, r.stdout);
    },
    signal,
  );
}

/**
 * When `seen` shows a running task ended (an exit file, no process left, its sandbox instance not
 * running), finishes it as the poller would, marked reported (this call tells the model); returns
 * the task's row afterwards. A task a stop claimed is left to the stop.
 */
async function settle(
  env: TaskEnv,
  task: BackgroundTaskRow,
  seen: IfRunningResult<Seen>,
): Promise<BackgroundTaskRow> {
  if (task.status !== "running") return task;
  let to: BackgroundFinish | null = null;
  let lastLines = "";
  if (seen.kind === "ran") {
    const r = seen.value.report;
    to = r ? polledAs(task, r, new Date()) : null;
    lastLines = r?.lastLines ?? "";
  } else if (seen.kind === "not_running") {
    to = notRunningAs(seen.status, seen.status === "suspended");
  } else {
    to = RECREATED;
  }
  if (to === null) return task;
  await env.tasks.finisher.finish(task, to, lastLines, true, { unclaimed: true });
  return (await env.store.get(task.id)) ?? task;
}

/**
 * Built-in `TaskOutput` (spec 2026-11-05-background-bash-design §2.2): a task's status and the
 * output since this conversation's last read of it. Every check is a short exec through
 * `SandboxService.ifRunning` on the task's own sandbox instance: it never creates or resumes a
 * sandbox, so a suspended or rebuilt one means the task is lost (its output unavailable). With
 * `block`, checks every {@link TASK_CHECK_INTERVAL_MS}, each under a lease of its own, until the
 * task ends or the wait (at most `timeout` and the run's time left) is over. The output read is
 * capped at `tools.outputSpillChars` bytes; the pipeline spills the result beyond that.
 */
export function taskOutputTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: (input) => {
      const { block, timeout } = input as TaskOutputInput;
      const wait =
        block === false
          ? 0
          : Math.min(timeout ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS, TASK_OUTPUT_MAX_TIMEOUT_MS);
      return wait + sandboxBaseTimeoutMs(deps.config.get());
    },
    async run(input, ctx) {
      const { task_id, block = true, timeout } = input as TaskOutputInput;
      const env = taskEnv(deps);
      let task = await ownedTask(env, ctx, task_id);
      if (block && task.status === "running") {
        const wait = Math.max(
          0,
          Math.min(
            timeout ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS,
            TASK_OUTPUT_MAX_TIMEOUT_MS,
            runTimeLeftMs(ctx.runDeadline),
          ),
        );
        const until = Date.now() + wait;
        for (;;) {
          if (task.sandboxCreatedAt !== null) {
            task = await settle(env, task, await look(env, task, null, ctx.signal));
            if (task.status !== "running") break;
          }
          const left = until - Date.now();
          if (left <= 0) break;
          await sleep(Math.min(TASK_CHECK_INTERVAL_MS, left), undefined, { signal: ctx.signal });
          task = (await env.store.get(task.id)) ?? task;
          if (task.status !== "running") break;
        }
      }

      const parts: string[] = [];
      if (task.sandboxCreatedAt === null) {
        // a reservation still launching, or a launch that failed: nothing ran
        if (task.status === "running") parts.push("[The task is still starting; no output yet.]");
        else parts.push("[No output: the command never started.]");
        return result(task, [statusLine(task), ...parts]);
      }
      const offset = task.readOffset;
      const cap = deps.config.get().tools.outputSpillChars;
      const seen = await look(env, task, { offset, cap }, ctx.signal);
      task = await settle(env, task, seen);
      if (seen.kind !== "ran") return result(task, [statusLine(task), unavailableText(task, seen)]);
      const { data, size } = seen.value;
      // an ended task's output is complete: only a read cut by the cap can end inside a character
      const used =
        task.status !== "running" && data.length < cap ? data.length : wholeUtf8Length(data);
      if (used > 0) await env.store.advanceOffset(task.id, offset + used);
      const more = size - (offset + used);
      if (more > 0) {
        parts.push(
          `[${more} more bytes of output after this; call TaskOutput again to read them, or Read ${outputFile(task)}.]`,
        );
      }
      parts.push(used === 0 ? "[No new output.]" : data.subarray(0, used).toString("utf8"));
      return result(task, [statusLine(task), ...parts]);
    },
  };
}

function result(task: BackgroundTaskRow, lines: string[]) {
  const d = clip(task.description, 120);
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    isError: false,
    display: display(`读取后台任务输出：${d}`, `Read background task output: ${d}`),
  };
}
