import { setTimeout as sleep } from "node:timers/promises";
import {
  isSandboxGoneError,
  rootsOf,
  type SandboxHandle,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import type { BackgroundFinish } from "../../../background/finish.js";
import { TASK_ID_RE, TASKS_DIR, taskOutputFile } from "../../../background/launch.js";
import { formatElapsed, lostReasonText } from "../../../background/render.js";
import { actingAs, SID_RE, taskActor } from "../../../background/session.js";
import {
  parsePollOutput,
  polledAs,
  pollScript,
  type TaskReport,
} from "../../../background/status.js";
import { notRunningAs, RECREATED } from "../../../background/stop.js";
import type { BackgroundTaskRow } from "../../../background/store.js";
import type {
  HeldProvider,
  IfRunningResult,
  SandboxService,
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
  sandboxConversationOf,
  sandboxUsable,
  unavailableWhenNoSandbox,
} from "./common.js";
import { type DeviceCode, parseDeviceCode } from "./device-code.js";

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
    "milliseconds pass, checking every 2 seconds; prefer this over sleeping in Bash. Each call " +
    "returns a bounded slice of new output; the task's whole output file (its path is in the Bash " +
    "result) can also be read with Read. A background task that waits for a person (an " +
    "interactive login, a prompt) prints its prompt here; read it while the task waits. You are " +
    "told when a task finishes, so there is no need to poll for that.",
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
  devices: SandboxToolDeps["devices"];
  log: SandboxToolDeps["log"];
  subagents?: SandboxToolDeps["subagents"];
}

/**
 * The task tools' dependencies; throws the tool's error when they are missing, or when the
 * conversation's device cannot run (no cloud provider, and not a registered `@local` one:
 * ruling R8).
 */
export async function taskEnv(deps: SandboxToolDeps, ctx: BuiltinCallContext): Promise<TaskEnv> {
  if (!(await sandboxUsable(deps, ctx.orgId, sandboxConversationOf(ctx)))) throw noSandboxError();
  const { background, tasks } = deps;
  if (!background || !tasks || !deps.sandbox.ifRunning) {
    throw new ToolError(
      "Background tasks are not available here; use Bash without run_in_background instead.",
    );
  }
  return {
    store: background,
    tasks,
    ifRunning: deps.sandbox.ifRunning.bind(deps.sandbox),
    devices: deps.devices,
    log: deps.log,
    ...(deps.subagents !== undefined && { subagents: deps.subagents }),
  };
}

const notFound = (id: string): ToolError =>
  new ToolError(
    `No background task ${clip(id, 40)} in this conversation. Pass a task id that Bash with run_in_background returned in this conversation; call TaskList to see this conversation's tasks.`,
  );

/**
 * A sub-agent's agentId passed as a task id (as Claude Code's TaskOutput allows for background
 * agents): its report arrives on its own, so polling or sleeping for it only wastes the run.
 */
export const subagentNotTaskText = (id: string): string =>
  `${clip(id, 40)} is a sub-agent, not a background task. Its report arrives in this conversation as a notification when it hands back or finishes. Don't poll or sleep for it: keep working or end your turn. Use SendMessage to give it more instructions.`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` is the agentId of a sub-agent in the caller's tree (not a task id). */
async function isSubagentId(env: TaskEnv, ctx: BuiltinCallContext, id: string): Promise<boolean> {
  const trimmed = id.trim();
  return (
    !TASK_ID_RE.test(id) &&
    env.subagents !== undefined &&
    UUID_RE.test(trimmed) &&
    (await env.subagents.inTree(sandboxConversationOf(ctx), trimmed.toLowerCase()))
  );
}

/** {@link notFound}, or {@link subagentNotTaskText} when `id` is a sub-agent of the caller's tree. */
async function missingTask(env: TaskEnv, ctx: BuiltinCallContext, id: string): Promise<ToolError> {
  if (await isSubagentId(env, ctx, id)) return new ToolError(subagentNotTaskText(id.trim()));
  return notFound(id);
}

/**
 * The task `id` when it belongs to the calling conversation; a task of another conversation (a
 * sub-agent's, when called from its parent) is not found, the same as an unknown id. A sub-agent's
 * agentId gets its own text ({@link subagentNotTaskText}).
 */
export async function ownedTask(
  env: TaskEnv,
  ctx: BuiltinCallContext,
  id: string,
): Promise<BackgroundTaskRow> {
  if (!TASK_ID_RE.test(id)) throw await missingTask(env, ctx, id);
  const task = await env.store.get(id);
  if (!task || task.conversationId !== ctx.conversationId) throw notFound(id);
  return task;
}

/**
 * The per-call access re-check of every sandbox tool (`inSandbox`): the conversation's device
 * may still be used by its owner. The task tools read a task's own instance without `inSandbox`,
 * so they check here first; errors become the tools' errors.
 */
export async function recheckDevice(env: TaskEnv, ctx: BuiltinCallContext): Promise<void> {
  try {
    await env.devices.forTool(ctx.orgId, sandboxConversationOf(ctx));
  } catch (e) {
    throw mapSandboxError(e, env.log);
  }
}

/**
 * `ifRunning` on the task's own device instance (its execs act for the task's trigger in its
 * conversation); sandbox errors become the tools' errors. A task from before devices has no
 * instance (`not_running`).
 */
export async function onTaskInstance<T>(
  env: TaskEnv,
  task: BackgroundTaskRow,
  fn: (p: HeldProvider, h: SandboxHandle, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<IfRunningResult<T>> {
  if (task.deviceId === null) return { kind: "not_running", status: "gone" };
  try {
    return await env.ifRunning(
      task.deviceId,
      { createdAt: task.sandboxCreatedAt as Date },
      (p, h, sig) => fn(actingAs(p, taskActor(task)), h, sig),
      signal,
    );
  } catch (e) {
    throw mapSandboxError(e, env.log);
  }
}

/**
 * The task's status line: `Status: running (2m05s)`, `Status: failed, exit code 3, after 4m12s`,
 * `Status: stopped after 1m00s`, `Status: lost (the sandbox was suspended) after 3s`.
 */
export function statusLine(task: BackgroundTaskRow, now = new Date()): string {
  const end = task.status === "running" ? now : (task.finishedAt ?? now);
  const elapsed = formatElapsed(end.getTime() - task.startedAt.getTime());
  if (task.status === "running") return `Status: running (${elapsed})`;
  let s = `Status: ${task.status === "timed_out" ? "timed out" : task.status}`;
  if (task.lostReason !== null) s += ` (${lostReasonText(task.lostReason)})`;
  if (task.exitCode !== null) return `${s}, exit code ${task.exitCode}, after ${elapsed}`;
  return `${s} after ${elapsed}`;
}

/** The absolute path of the task's output file, as the model sees it. */
export const outputFile = (task: BackgroundTaskRow): string => taskOutputFile(task.outputPath);

/** Why the output cannot be read: the task's sandbox instance is not running. */
export function unavailableText(task: BackgroundTaskRow, r: IfRunningResult<unknown>): string {
  if (r.kind === "not_running" && r.status === "suspended") {
    return `[Output unavailable: the sandbox is suspended. Read ${outputFile(task)} resumes it and reads what the task wrote.]`;
  }
  return "[Output unavailable: the sandbox that ran this task is gone, and its output with it.]";
}

// ---- reading a task ----

/**
 * The exec that checks and reads task `t` (relative to the workspace root): for a running task first
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
        cwd: rootsOf(h).workspace,
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

/** How a running task ended, as the poller would finish it. */
interface End {
  to: BackgroundFinish;
  lastLines: string;
}

/**
 * How `seen` shows the running `task` ended (an exit file, no process left, its sandbox instance
 * not running), or null while it runs (or when the row is no longer running).
 */
function endOf(task: BackgroundTaskRow, seen: IfRunningResult<Seen>): End | null {
  if (task.status !== "running") return null;
  if (seen.kind === "not_running") {
    return { to: notRunningAs(seen.status, seen.status === "suspended"), lastLines: "" };
  }
  if (seen.kind === "other_instance") return { to: RECREATED, lastLines: "" };
  const r = seen.value.report;
  const to = r ? polledAs(task, r, new Date()) : null;
  return to === null ? null : { to, lastLines: r?.lastLines ?? "" };
}

/**
 * Finishes the task as `end` says, marked reported: called only once nothing can fail before the
 * result reaches the model, so a reported finish is one the model saw. A task a stop claimed is
 * left to the stop. Returns the task's row afterwards.
 */
async function settle(
  env: TaskEnv,
  task: BackgroundTaskRow,
  end: End | null,
): Promise<BackgroundTaskRow> {
  if (end === null) return task;
  await env.tasks.finisher.finish(task, end.to, end.lastLines, true, { unclaimed: true });
  return (await env.store.get(task.id)) ?? task;
}

/** {@link look}, with a `SandboxGoneError` from the exec as null (the instance is gone). */
async function lookOrGone(
  env: TaskEnv,
  task: BackgroundTaskRow,
  read: { offset: number; cap: number } | null,
  signal: AbortSignal,
): Promise<IfRunningResult<Seen> | null> {
  try {
    return await look(env, task, read, signal);
  } catch (e) {
    if (isSandboxGoneError(e)) return null;
    throw e;
  }
}

/**
 * Built-in `TaskOutput` (spec 2026-11-05-background-bash-design §2.2): a task's status and the
 * output since this conversation's last read of it. Every check is a short exec through
 * `SandboxService.ifRunning` on the task's own sandbox instance: it never creates or resumes a
 * sandbox, so a suspended or rebuilt one means the task is lost (its output unavailable). With
 * `block`, checks every {@link TASK_CHECK_INTERVAL_MS}, each under a lease of its own, until the
 * task ends or the wait (at most `timeout` and the run's time left) is over; the checks only
 * detect the end, and the one read that makes the result finishes the task (reported). The output
 * read is capped at `tools.outputSpillChars` bytes; the pipeline spills the result beyond that.
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
      const env = await taskEnv(deps, ctx);
      // A sub-agent's agentId is answered, not refused: where its report arrives is the answer
      // (acceptance 2026-11-13: guidance the model is expected to follow is not a failed call).
      // TaskStop keeps the error: it cannot stop a sub-agent.
      if (await isSubagentId(env, ctx, task_id)) {
        const id = clip(task_id.trim(), 40);
        return {
          content: [{ type: "text" as const, text: subagentNotTaskText(task_id.trim()) }],
          isError: false,
          display: display(`查看子智能体：${id}`, `Checked sub-agent: ${id}`),
        };
      }
      let task = await ownedTask(env, ctx, task_id);
      await recheckDevice(env, ctx);
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
        // no check right before the final read: the loop ends when the wait does
        while (task.status === "running" && Date.now() < until) {
          if (task.sandboxCreatedAt !== null) {
            const seen = await lookOrGone(env, task, null, ctx.signal);
            if (seen === null || endOf(task, seen) !== null) break;
          }
          const left = until - Date.now();
          if (left <= 0) break;
          await sleep(Math.min(TASK_CHECK_INTERVAL_MS, left), undefined, { signal: ctx.signal });
          task = (await env.store.get(task.id)) ?? task;
        }
      }

      if (task.sandboxCreatedAt === null) {
        // a reservation still launching, or a launch that failed: nothing ran
        return result(task, [
          statusLine(task),
          task.status === "running"
            ? "[The task is still starting; no output yet.]"
            : "[No output: the command never started.]",
        ]);
      }
      const offset = task.readOffset;
      const cap = deps.config.get().tools.outputSpillChars;
      const seen = await lookOrGone(env, task, { offset, cap }, ctx.signal);
      if (seen === null) {
        return result(task, [statusLine(task), unavailableText(task, { kind: "other_instance" })]);
      }
      const end = endOf(task, seen);
      if (seen.kind !== "ran") {
        task = await settle(env, task, end);
        return result(task, [statusLine(task), unavailableText(task, seen)]);
      }
      const { data, size } = seen.value;
      // an ended task's output is complete: only a read cut by the cap can end inside a character
      const ended = task.status !== "running" || end !== null;
      const used = ended && data.length < cap ? data.length : wholeUtf8Length(data);
      if (used > 0) await env.store.advanceOffset(task.id, offset + used);
      task = await settle(env, task, end);
      const parts: string[] = [];
      const more = size - (offset + used);
      if (more > 0) {
        parts.push(
          `[${more} more bytes of output after this; call TaskOutput again to read them, or Read ${outputFile(task)}.]`,
        );
      }
      const text = used === 0 ? "" : data.subarray(0, used).toString("utf8");
      parts.push(used === 0 ? "[No new output.]" : text);
      // A background command that waits for a person (`gh auth login --web`, any interactive
      // login) prints its prompt while TaskOutput reads it (auto mode spec §6, P-D13): this is
      // the path that shows the device-code card while the login is still pending.
      return result(task, [statusLine(task), ...parts], parseDeviceCode(text));
    },
  };
}

function result(task: BackgroundTaskRow, lines: string[], loginCode: DeviceCode | null = null) {
  const d = clip(task.description, 120);
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    isError: false,
    display: display(`读取后台任务输出：${d}`, `Read background task output: ${d}`),
    // kernel-internal (see `BuiltinResult.loginCode`): never part of the content above
    ...(loginCode !== null && { loginCode }),
  };
}
