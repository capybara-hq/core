import { setTimeout as sleep } from "node:timers/promises";
import { isSandboxGoneError, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { type BackgroundFinish, finishedEventKey } from "../../../background/finish.js";
import { TASK_ID_RE, taskOutputFile } from "../../../background/launch.js";
import {
  exactRefOf,
  lastLinesByRef,
  ManagedRefError,
  onManagedInstance,
  readerOf,
  statusEnd,
  summaryLines,
} from "../../../background/managed.js";
import {
  assembleTaskOutput,
  ManagedOutputCapacityError,
  ManagedOutputUnavailableError,
  type TaskOutputAssembly,
} from "../../../background/managed-output.js";
import { formatElapsed, taskReasonText } from "../../../background/render.js";
import { notRunningAs, RECREATED } from "../../../background/stop.js";
import { type BackgroundTaskRow, isManagedTask } from "../../../background/store.js";
import {
  type IfRunningResult,
  RetirementPendingError,
  retirementPending,
  type SandboxService,
} from "../../../sandbox/sandbox.service.js";
import type { BuiltinCallContext, BuiltinResult, BuiltinTool } from "../../registry.js";
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
import { assertDeviceOfRunAccount } from "./device-owner.js";

/** How long `TaskOutput` waits with `block` when `timeout` is not given (ms). */
export const TASK_OUTPUT_DEFAULT_TIMEOUT_MS = 30_000;
/** The longest `TaskOutput` wait (ms). */
export const TASK_OUTPUT_MAX_TIMEOUT_MS = 600_000;
/** How often a blocking `TaskOutput` checks the task (each check an exact status read). */
export const TASK_CHECK_INTERVAL_MS = 2000;

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
 * The task's status line: `Status: running (2m05s)`, `Status: failed, exit code 3, after 4m12s`,
 * `Status: stopped after 1m00s`, `Status: lost (the sandbox was suspended) after 3s`.
 */
export function statusLine(task: BackgroundTaskRow, now = new Date()): string {
  const end = task.status === "running" ? now : (task.finishedAt ?? now);
  const elapsed = formatElapsed(end.getTime() - task.startedAt.getTime());
  if (task.status === "running") return `Status: running (${elapsed})`;
  let s = `Status: ${task.status === "timed_out" ? "timed out" : task.status}`;
  if (task.lostReason !== null) s += ` (${taskReasonText(task)})`;
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

/**
 * How many bytes before the read offset a `TaskOutput` read also reads again, so a prompt split
 * across reads still matches: `gh auth login --web` prints its one-time code and its URL line
 * separately, and a read that lands between them (or a read cap that splits them) otherwise sees
 * only one half, and no later read sees both. The tail only ever holds this many already-delivered
 * bytes, whatever the task's output size: a read's buffer stays bounded.
 */
export const READ_TAIL_BYTES = 4096;

/** The byte window one `TaskOutput` read covers. */
export interface ReadWindow {
  /** Where the read exec starts (the output offset minus at most {@link READ_TAIL_BYTES}). */
  offset: number;
  /** How many bytes the exec reads from there. */
  cap: number;
  /** How many of the returned bytes were already delivered by earlier reads. */
  skip: number;
}

/**
 * The window of a read at `offset` (the output bytes already delivered) with `cap` new bytes: it
 * starts up to {@link READ_TAIL_BYTES} earlier, and the first `skip` bytes of what it returns were
 * delivered already, so the parser can match a pattern spanning the boundary. Bounded: the window
 * is `cap + READ_TAIL_BYTES` bytes at most, never more as the output grows.
 */
export function readWindow(offset: number, cap: number): ReadWindow {
  const start = Math.max(0, offset - READ_TAIL_BYTES);
  const skip = offset - start;
  return { offset: start, cap: cap + skip, skip };
}

/** How a running task ended, as the poller would finish it. */
interface End {
  to: BackgroundFinish;
  lastLines: string;
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

/**
 * Built-in `TaskOutput` (spec 2026-11-05-background-bash-design §2.2): a task's status and the
 * output since this conversation's last read of it, by the task's exact ref only (no exec, no
 * path) through `SandboxService.ifRunning` on the task's own instance: it never creates or
 * resumes a sandbox, so a suspended or rebuilt one means the task is lost (its output
 * unavailable). With `block`, checks every {@link TASK_CHECK_INTERVAL_MS}, each under a lease of
 * its own, until the task ends or the wait (at most `timeout` and the run's time left) is over.
 * The output read is capped at `tools.outputSpillChars` bytes; the pipeline spills the result
 * beyond that. A legacy (SID) task is never read live ({@link legacyTaskOutput}).
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
      // another account's run never reads or stops on the owner's device (activated)
      assertDeviceOfRunAccount(deps.managedDeviceContextRequired, ctx);
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
      const task = await ownedTask(env, ctx, task_id);
      await recheckDevice(env, ctx);
      if (isManagedTask(task)) return managedTaskOutput(deps, env, ctx, task, block, timeout);
      return legacyTaskOutput(deps, env, task);
    },
  };
}

/**
 * A legacy task's own instance, never signalled or read (as `BackgroundTaskStopper` checks it):
 * a running one refuses with the retirement gate's own text before any provider call; one that is
 * not running or was replaced is returned. A task from before devices has none.
 */
async function legacyInstance(
  env: TaskEnv,
  task: BackgroundTaskRow,
): Promise<Exclude<IfRunningResult<never>, { kind: "ran" }>> {
  if (task.deviceId === null || task.sandboxCreatedAt === null)
    return { kind: "not_running", status: "gone" };
  let r: IfRunningResult<never>;
  try {
    r = await env.ifRunning(
      task.deviceId,
      { createdAt: task.sandboxCreatedAt },
      async () => {
        throw retirementPending();
      },
      AbortSignal.timeout(30_000),
    );
  } catch (e) {
    throw retirementRefusal(e, env);
  }
  if (r.kind === "ran") throw retirementRefusal(retirementPending(), env);
  return r;
}

/**
 * The retirement gate's refusal as the tool's error (the generic `device.unavailable` text would
 * name an inactive provider); anything else mapped as usual.
 */
export function retirementRefusal(e: unknown, env: Pick<TaskEnv, "log">): unknown {
  if (e instanceof RetirementPendingError) {
    return new ToolError(
      "This task's device is unavailable: background work started by an earlier version may still run on its previous instance, which has not been confirmed destroyed yet (for a local device, restarting its computer confirms it). The task cannot be read or stopped until then; continue without it, or start the work again with Bash on another device.",
    );
  }
  return mapSandboxError(e, env.log);
}

/**
 * `TaskOutput` of a legacy (SID) task: never read by an exec (permission activation W5-P2). A
 * running one whose instance still runs belongs to the retirement gate, so the call is refused
 * with its actionable text; one whose instance is gone, suspended or replaced is settled lost; a
 * finished one answers with its status and the last lines its finish kept.
 */
async function legacyTaskOutput(
  deps: SandboxToolDeps,
  env: TaskEnv,
  task: BackgroundTaskRow,
): Promise<BuiltinResult> {
  if (task.sandboxCreatedAt === null) {
    // a reservation that never started: nothing ran
    return result(task, [
      statusLine(task),
      task.status === "running"
        ? "[The task is still starting; no output yet.]"
        : "[No output: the command never started.]",
    ]);
  }
  if (task.status === "running") {
    // the instance first: only a running one belongs to the retirement gate; a gone, suspended
    // or replaced one settles the task lost (its processes went with it, or wait for retirement)
    const seen = await legacyInstance(env, task);
    const end: End = {
      to:
        seen.kind === "not_running"
          ? notRunningAs(seen.status, seen.status === "suspended")
          : RECREATED,
      lastLines: "",
    };
    const after = await settle(env, task, end);
    return result(after, [statusLine(after), unavailableText(after, seen)]);
  }
  const lines = [
    statusLine(task),
    "[Output unavailable: this task was started by an earlier version of the device runtime, whose output is not read live.]",
  ];
  const summary = await finishSummary(deps, task);
  if (summary !== null) {
    lines.push(`Last lines recorded when the task finished (not new output):\n${summary}`);
  }
  return result(task, lines);
}

/** A managed task's ref or provider failure as the tool's error (never a fallback read). */
function managedReadError(env: TaskEnv, task: BackgroundTaskRow, e: unknown): unknown {
  if (e instanceof ManagedRefError) {
    return new ToolError(
      `Background task ${task.id}'s recorded execution reference is malformed or inconsistent, so its output cannot be read; call TaskList to see its status, or Read ${outputFile(task)}.`,
    );
  }
  if (e instanceof ManagedOutputCapacityError) {
    return new ToolError(`Background task ${task.id}'s output could not be read: ${e.message}.`);
  }
  if (e instanceof ToolError) return e;
  const mapped = mapSandboxError(e, env.log);
  if (mapped instanceof ToolError) return mapped;
  const why = e instanceof Error ? e.message : String(e);
  return new ToolError(
    `Background task ${task.id}'s output could not be read (${clip(why, 300)}); nothing was consumed. Retry TaskOutput.`,
  );
}

/** Why a managed task's retained output cannot be read (the cursor never moves for it). */
function retainedUnavailableText(e: ManagedOutputUnavailableError): string {
  if (e.reason === "expired")
    return "[Output unavailable: the task's retained output has expired.]";
  if (e.reason === "mismatch") {
    return "[Output unavailable: the read position is past the task's retained output.]";
  }
  return "[Output unavailable: the task's retained output was lost.]";
}

/** What one exact-ref look at a managed task saw. */
interface ManagedSeen {
  end: BackgroundFinish | null;
  read: TaskOutputAssembly | ManagedOutputUnavailableError;
  lastLines: string;
}

/**
 * `TaskOutput` of a managed task (permission runtime cutover phase 8.3): status, positional
 * reads and the finish's tail by its exact ref on its exact instance (never resumed, no exec, no
 * path). The output is the bytes from the persisted cursor on, assembled through bounded reads
 * with a 4,096-byte parser history; the cursor advances only by the raw bytes delivered as text.
 * A live incomplete trailing character is left for a later read; at a verified terminal end
 * (status established before the read) every remaining byte is delivered with replacement
 * decoding. Unavailable retained output moves nothing and, for a finished task, shows its labelled
 * finish summary, never invented bytes.
 */
async function managedTaskOutput(
  deps: SandboxToolDeps,
  env: TaskEnv,
  ctx: BuiltinCallContext,
  first: BackgroundTaskRow,
  block: boolean,
  timeout: number | undefined,
): Promise<BuiltinResult> {
  let task = first;
  if (task.executionRef === null) {
    let why = "[No output: the command never started.]";
    if (task.status === "running") {
      why =
        task.launchState === "cancel-pending"
          ? "[No output: the task was stopped while it was starting.]"
          : "[The task is still starting; no output yet.]";
    } else if (task.lostReason === "launch_unknown") {
      why = "[No output: whether the command started could not be confirmed.]";
    }
    return result(task, [statusLine(task), why]);
  }
  try {
    exactRefOf(task);
  } catch (e) {
    throw managedReadError(env, task, e);
  }
  const ifRunning = env.ifRunning;
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
    while (task.status === "running" && Date.now() < until) {
      let r: Awaited<ReturnType<typeof onManagedInstance<BackgroundFinish | null>>>;
      try {
        r = await onManagedInstance(
          ifRunning,
          task,
          async (bg, h, ref, sig) => statusEnd(await bg.status(h, ref, sig)),
          ctx.signal,
        );
      } catch (e) {
        throw managedReadError(env, task, e);
      }
      if (r.kind !== "ran" || r.value !== null) break;
      const left = until - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(TASK_CHECK_INTERVAL_MS, left), undefined, { signal: ctx.signal });
      task = (await env.store.get(task.id)) ?? task;
    }
  }
  const budget = deps.config.get().tools.outputSpillChars;
  const cur = task;
  // A stop was asked for: the SDK status has no stopped state (an applied cancellation reads as an
  // exit), so the end is settled only by the provider's atomically claimed stop outcome.
  const cancelling = cur.launchState === "cancel-pending" || cur.cancelRequestedAt !== null;
  const settleEnd = async (
    t: BackgroundTaskRow,
    end: { to: BackgroundFinish; lastLines: string } | null,
  ): Promise<BackgroundTaskRow> => {
    if (end === null || t.status !== "running") return t;
    if (!cancelling) return settle(env, t, end);
    try {
      return await env.tasks.stopper.stop(t, "revoked", ctx.signal, { reported: true });
    } catch (e) {
      // the owed stop stays with the poller; this read still answers
      env.log?.warn("cannot settle a cancelled background task from TaskOutput", {
        taskId: t.id,
        err: e,
      });
      return (await env.store.get(t.id)) ?? t;
    }
  };
  let seen: Awaited<ReturnType<typeof onManagedInstance<ManagedSeen>>>;
  try {
    seen = await onManagedInstance(
      ifRunning,
      cur,
      async (bg, h, ref, sig): Promise<ManagedSeen> => {
        // terminal collection is established before the metadata snapshot, never after it
        const end = cur.status === "running" ? statusEnd(await bg.status(h, ref, sig)) : null;
        let read: ManagedSeen["read"];
        try {
          read = await assembleTaskOutput(readerOf(bg, h, ref, sig), {
            offset: cur.readOffset,
            budget,
            terminal: cur.status !== "running" || end !== null,
            signal: sig,
          });
        } catch (e) {
          if (!(e instanceof ManagedOutputUnavailableError)) throw e;
          read = e;
        }
        // a cancellation's end is settled by the exact stop below, which reads its own tail
        const lastLines =
          end === null || cancelling ? "" : summaryLines(await lastLinesByRef(bg, h, ref, sig));
        return { end, read, lastLines };
      },
      ctx.signal,
    );
  } catch (e) {
    if (isSandboxGoneError(e)) seen = { kind: "other_instance" };
    else throw managedReadError(env, task, e);
  }
  if (seen.kind !== "ran") {
    if (task.status === "running") {
      const to = seen.kind === "not_running" ? notRunningAs(seen.status, false) : RECREATED;
      task = await settleEnd(task, { to, lastLines: "" });
    }
    return result(task, [statusLine(task), unavailableText(task, seen)]);
  }
  const { end, read, lastLines } = seen.value;
  if (read instanceof ManagedOutputUnavailableError) {
    task = await settleEnd(task, end === null ? null : { to: end, lastLines });
    const lines = [statusLine(task), retainedUnavailableText(read)];
    const summary = task.status === "running" ? null : await finishSummary(deps, task);
    if (summary !== null) {
      lines.push(`Last lines recorded when the task finished (not new output):\n${summary}`);
    }
    return result(task, lines);
  }
  const used = read.delivered.length;
  if (used > 0) await env.store.advanceOffset(task.id, read.nextOffset);
  task = await settleEnd(task, end === null ? null : { to: end, lastLines });
  const parts: string[] = [];
  if (read.remaining > 0) {
    parts.push(
      `[${read.remaining} more bytes of output after this; call TaskOutput again to read them, or Read ${outputFile(task)}.]`,
    );
  }
  parts.push(used === 0 ? "[No new output.]" : read.text);
  // the parser sees the re-read history plus the new bytes, so a prompt split across reads matches
  const loginCode = used > 0 ? parseDeviceCode(read.parserText) : null;
  return result(task, [statusLine(task), ...parts], loginCode);
}

/** The last lines the task's finished event kept; null when there is none (or no event log). */
async function finishSummary(
  deps: SandboxToolDeps,
  task: BackgroundTaskRow,
): Promise<string | null> {
  const ev = await deps.eventLog.findByIdem?.(task.conversationId, finishedEventKey(task.id));
  if (ev?.type !== "background_task_finished") return null;
  return ev.payload.lastLines.replace(/\n$/, "") || "(none)";
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
