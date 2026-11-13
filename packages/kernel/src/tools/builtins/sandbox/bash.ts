import {
  DEFAULT_SANDBOX_ROOTS,
  type ExecResult,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import {
  backgroundMaxSeconds,
  LAUNCH_EXEC_TIMEOUT_MS,
  launchScript,
  newTaskId,
  startedText,
  taskOutputPath,
  taskSidPath,
} from "../../../background/launch.js";
import { KILL_SESSION_TIMEOUT_MS, killSession, SID_RE } from "../../../background/session.js";
import type { BuiltinCallContext, BuiltinResult, BuiltinTool } from "../../registry.js";
import {
  clip,
  display,
  inSandbox,
  mapSandboxError,
  noSandboxError,
  runBudgetNote,
  runTimeLeftMs,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  sandboxConversationOf,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";
import { parseDeviceCode } from "./device-code.js";

/** The command timeout in seconds when `timeout` is not given, at most `sandbox.limits.maxCommandSeconds`. */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 120;
/** The longest `description` (the shell row shows it instead of the command). */
export const BASH_DESCRIPTION_MAX_CHARS = 120;
/** bash 结果超过这么多字符即转存（走现有输出存档，模型用 ReadToolOutput 分页读）。 */
export const BASH_SPILL_CHARS = 30_000;
/** 一次命令最多收集的输出字节（stdout + stderr）；超出的丢弃并在结果里说明。 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "Bash",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["command"],
  description:
    "Run a shell command (bash) in this conversation's sandbox, an isolated machine. " +
    "Use it to run programs and scripts, install packages, process files and inspect the " +
    "filesystem. The working directory is the workspace directory; files persist between calls in the same " +
    "conversation, but background processes may not: when the sandbox is suspended after a period " +
    "without use they can be stopped and the temporary files directory cleared, so keep results in " +
    "files under the workspace directory. Files the user attached to the conversation are copied to " +
    "attachments/<conversation>/ in the workspace directory (the result names the paths), " +
    "and skill files to the skills directory (read-only). Each call runs in a fresh shell (no state such as " +
    "cd or environment variables carries over). The result has stdout, stderr and the exit code; " +
    "long output is saved and can be paged with ReadToolOutput. A command that runs longer than " +
    "timeout milliseconds is stopped. Prefer Read, Write, Edit, Glob and " +
    "Grep for reading, writing and searching files. To give a file to the user, use " +
    "Deliver. Other sub-agents of this conversation may run commands in this sandbox at " +
    "the same time. Always pass description: a few words saying what the command is for; the " +
    "user sees it instead of the command.\n\n" +
    "Processes a normal call leaves running (started with '&' or nohup) may be stopped when the " +
    "call ends, depending on the device, so use run_in_background for a dev server, a watcher or " +
    "anything that must keep running after the call.\n\n" +
    "You can use the run_in_background parameter to run the command in the background, which " +
    "allows you to continue working while the command runs, e.g. a dev server, a long build or a " +
    "test suite. The call returns at once with a task id and the command's output goes to a file " +
    "under .capybara/tasks in the workspace directory. Read the output with TaskOutput and stop the " +
    "task with TaskStop; you will be told when it finishes. TaskList lists this conversation's " +
    "background tasks and their ids, running ones first. You do not need to use '&' at the end " +
    "of the command when using this parameter. A command that waits for a person (an interactive " +
    "login, a prompt) should run in the background so its output, such as a one-time code to " +
    "enter, can be read with TaskOutput while it waits. In the background, timeout defaults to the " +
    "deployment's background maximum (7200000 by default). A background task ends when its " +
    "command exits, and processes it left running are stopped. A background task is lost if the " +
    "sandbox is suspended (it is suspended after it has been running for a while, " +
    "sandbox.limits.maxRunningMinutes), so keep its results in files under the workspace directory.\n\n" +
    "Network access goes through a proxy set in HTTP_PROXY / HTTPS_PROXY / ALL_PROXY; a tool " +
    "that ignores them fails with 'Operation not permitted' or cannot resolve names. Such tools, " +
    "browsers for example, need the proxy passed explicitly: for Chromium (also headless, as " +
    "Playwright or Puppeteer launch it) pass --proxy-server=$HTTPS_PROXY. A blocked domain is " +
    "reported after the output.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        minLength: 1,
        description: 'The command line to run, e.g. "python3 analyze.py data.csv".',
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength: BASH_DESCRIPTION_MAX_CHARS,
        description:
          'What this command does, in a few words (e.g. "Generate the final PDF"). Shown to the user.',
      },
      timeout: {
        type: "integer",
        minimum: 1,
        description: `Milliseconds before the command is stopped. Default ${BASH_DEFAULT_TIMEOUT_SECONDS * 1000} (in the background: the background maximum); the deployment sets a maximum (7200000 by default); a larger value is lowered to it.`,
      },
      run_in_background: {
        type: "boolean",
        description:
          "Set to true to run this command in the background. Use TaskOutput to read the output later.",
      },
    },
    required: ["command", "description"],
    additionalProperties: false,
  },
};

interface BashInput {
  command: string;
  /** Required since UI refresh B; calls recorded before it have none. */
  description?: string;
  /** Milliseconds. */
  timeout?: number;
  run_in_background?: boolean;
}

/** This command's timeout in milliseconds: the given value or the default, at most the maximum. */
const msFor = (input: BashInput, maxSeconds: number): number =>
  Math.min(input.timeout ?? BASH_DEFAULT_TIMEOUT_SECONDS * 1000, maxSeconds * 1000);

/**
 * 命令结果 → 给模型的文本。`budgetClamped`：运行的时限把超时收紧到了 `seconds`（Ruling M20），超时说明改为
 * 指向 `runtime.maxRunSeconds`，而不是让模型加大 timeout。`workspace`: the instance's workspace root.
 */
export function formatExec(
  r: ExecResult,
  seconds: number,
  budgetClamped = false,
  workspace: string = DEFAULT_SANDBOX_ROOTS.workspace,
): string {
  const parts: string[] = [];
  if (r.stdout !== "") parts.push(r.stdout.replace(/\n$/, ""));
  if (r.stderr !== "") parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
  if (r.truncated)
    parts.push(`[Output truncated: only the first ${MAX_OUTPUT_BYTES} bytes were kept.]`);
  if (r.timedOut && budgetClamped) {
    parts.push(
      `[timedOut: the command did not finish within ${seconds}s and was stopped. ${runBudgetNote(seconds)} The sandbox is still usable; split the work into shorter steps that save progress to files under ${workspace}, or run long jobs in the background and check on them in a later run.]`,
    );
  } else if (r.timedOut) {
    parts.push(
      `[timedOut: the command did not finish within ${seconds}s and was stopped. The sandbox is still usable; pass a larger timeout in milliseconds (up to the deployment maximum), or split the work into shorter steps that save progress to files under ${workspace}.]`,
    );
  } else if (r.exitCode === null) {
    parts.push(
      "[The command was stopped before it finished; its effects may be partial. Check the sandbox state before retrying.]",
    );
  } else {
    parts.push(`[exit code: ${r.exitCode}]`);
    if (budgetClamped) parts.push(`[${runBudgetNote(seconds)}]`);
  }
  return parts.join("\n");
}

/** The most output the launch exec keeps (it prints only the session id, or an error). */
const LAUNCH_MAX_OUTPUT_BYTES = 64 * 1024;
/** Above about this many bytes of base64, a provider may refuse the launch exec's command. */
const LARGE_COMMAND_BASE64_BYTES = 96 * 1024;

/** How a launch ended, decided under the call's lease. */
type Launch =
  | { kind: "started" }
  /** A stop claimed the reservation while it launched: the command was killed at once. */
  | { kind: "stopped" }
  /** The launch failed (any session it started and whose id could be read was killed). */
  | { kind: "not_started"; why: string }
  /**
   * The command started, but its row could not be completed; `stopped` when the kill confirmed
   * its session empty.
   */
  | { kind: "unrecorded"; why: string; stopped: boolean };

/** Why a launch exec did not start the command, for the model and the row's reason. */
function launchFailure(r: ExecResult): string {
  if (r.timedOut) return `the launch did not finish within ${LAUNCH_EXEC_TIMEOUT_MS / 1000}s`;
  if (r.exitCode === null) return "the launch was stopped before it finished";
  const said = clip(r.stderr || (r.exitCode === 0 ? "" : r.stdout), 500).replace(/\.$/, "");
  if (said !== "") return said;
  return r.exitCode === 0
    ? "the launch printed no session id"
    : `the launch exited with code ${r.exitCode}`;
}

/**
 * `Bash` with `run_in_background` (spec 2026-11-05-background-bash-design §2.1, §4.2):
 * 1. reserves the task's row (`BackgroundTaskStore.reserve`: `running`, no `sid`), refused once
 *    the sandbox runs `sandbox.background.maxTasks` tasks; the count and the insert are one step
 *    under the sandbox's launch lock;
 * 2. runs one short launch exec under the call's shared lease, and in the same lease records the
 *    session id and the instance (`markStarted`); a command that started but could not be
 *    recorded is killed there (`pkill -KILL -s <sid>`), so no process runs untracked;
 * 3. any failure finishes the row as `failed` with the reason (`failLaunch`);
 * 4. a stop that claimed the reservation meanwhile (`markStarted` answers `stopping`) has the
 *    command killed at once and the row finished `stopped` (`finishStoppedLaunch`).
 * The command runs in a session of its own under its own `timeout` (default and maximum
 * {@link backgroundMaxSeconds}).
 */
async function runInBackground(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  input: BashInput,
): Promise<BuiltinResult> {
  const { background, sandbox } = deps;
  if (!background || !sandbox.currentInstance) {
    throw new ToolError(
      "Background tasks are not available here; call Bash without run_in_background.",
    );
  }
  if (ctx.runId === undefined) {
    throw new ToolError(
      "Background tasks can only be started from an agent run; call Bash without run_in_background.",
    );
  }
  const currentInstance = sandbox.currentInstance.bind(sandbox);
  const cfg = deps.config.get();
  const maxMs = backgroundMaxSeconds(cfg) * 1000;
  const requested = input.timeout;
  const seconds = Math.max(1, Math.ceil(Math.min(requested ?? maxMs, maxMs) / 1000));
  const root = sandboxConversationOf(ctx);
  // the device the task will run in (the root conversation's, bound for good)
  let deviceId: string;
  try {
    deviceId = await deps.devices.forTool(ctx.orgId, root);
  } catch (e) {
    throw mapSandboxError(e, deps.log);
  }
  if (!(await sandbox.availableFor(deviceId))) throw noSandboxError();
  const maxTasks = cfg.sandbox.background.maxTasks;
  const id = newTaskId();
  const description = input.description ?? clip(input.command, 120);
  const startedAt = new Date();
  const reserved = await background.reserve(
    {
      id,
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      sandboxConversationId: root,
      deviceId,
      runId: ctx.runId,
      callId: ctx.callId,
      // the run's trigger account (the pipeline passes `runs.trigger_account_id` as `accountId`)
      triggerAccountId: ctx.accountId,
      description,
      command: input.command,
      outputPath: taskOutputPath(id),
      startedAt,
      deadlineAt: new Date(startedAt.getTime() + seconds * 1000),
    },
    maxTasks,
  );
  if (!reserved) {
    throw new ToolError(
      `${maxTasks} background tasks are already running; stop one with TaskStop or wait for one to finish, then retry`,
    );
  }

  // the conversation's background panel lists the task live (a sub-agent's task shows in its
  // parent's panel too): announced when it starts and when its launch ends it (failed, stopped),
  // since a client may have listed the reservation as running meanwhile; a failed publish only logs
  const announce = async (): Promise<void> => {
    if (!deps.eventLog.publishChanged) return;
    for (const c of new Set([ctx.conversationId, root])) {
      await deps.eventLog.publishChanged(c, "background");
    }
  };
  // the instance's workspace once the call entered it (the default until then)
  let workspace = DEFAULT_SANDBOX_ROOTS.workspace;
  const isLarge =
    Math.ceil(Buffer.byteLength(input.command, "utf8") / 3) * 4 > LARGE_COMMAND_BASE64_BYTES;
  const largeText = (): string =>
    isLarge
      ? ` A very large command (over about 96 KB after base64) cannot be started in the background; write it to a script under ${workspace} and run that instead.`
      : "";
  // set once the row has its sid: from then on the task runs and is tracked, whatever follows
  let started = false;
  let launch: Launch;
  let notices: string[];
  try {
    ({ value: launch, notices } = await inSandbox(deps, ctx, async ({ h, roots, p, signal }) => {
      workspace = roots.workspace;
      // right after the launch a process may fork while it is killed: killSession repeats
      const kill = (sid: string): Promise<boolean> => killSession(p, h, sid);
      // the session id the launch wrote before printing it: the launch may have ended (aborted,
      // timed out, thrown) after starting the command but before its output came back
      const sidFile = async (): Promise<string | null> => {
        const f = await p
          .readFile(h, `${roots.workspace}/${taskSidPath(id)}`, {
            maxBytes: 64,
            signal: AbortSignal.timeout(KILL_SESSION_TIMEOUT_MS),
          })
          .catch(() => null);
        const v = f ? new TextDecoder().decode(f.data).trim() : "";
        return SID_RE.test(v) ? v : null;
      };
      let r: ExecResult;
      try {
        r = await p.exec(h, {
          command: launchScript(id, input.command, seconds),
          cwd: roots.workspace,
          timeoutMs: LAUNCH_EXEC_TIMEOUT_MS,
          maxOutputBytes: LAUNCH_MAX_OUTPUT_BYTES,
          signal,
        });
      } catch (e) {
        const sid = await sidFile();
        if (sid !== null) await kill(sid);
        throw e;
      }
      const out = r.stdout.trim();
      if (r.exitCode !== 0 || !SID_RE.test(out)) {
        const sid = SID_RE.test(out) ? out : await sidFile();
        if (sid !== null) await kill(sid);
        return { kind: "not_started", why: launchFailure(r) } satisfies Launch;
      }
      const sid = out;
      try {
        // under the shared lease: no rebuild can come between the launch and this read
        const instance = await currentInstance(deviceId);
        if (instance === null) throw new Error("the sandbox instance could not be read");
        const marked = await background.markStarted(id, {
          sid,
          sandboxCreatedAt: instance.createdAt,
          outputPath: `${roots.workspace}/${taskOutputPath(id)}`,
        });
        if (!marked) throw new Error("its task record was finished meanwhile");
        started = true;
        if (marked === "stopping") {
          // a stop claimed the reservation before the command started: kill it at once
          if (await kill(sid)) {
            await background.finishStoppedLaunch(id);
            return { kind: "stopped" } satisfies Launch;
          }
          // not confirmed: the task runs on and is tracked like any other (the poller checks it)
          await background.releaseStop(id);
        }
        return { kind: "started" } satisfies Launch;
      } catch (e) {
        const stopped = await kill(sid);
        const why = e instanceof Error ? e.message : String(e);
        return { kind: "unrecorded", why, stopped } satisfies Launch;
      }
    }));
  } catch (e) {
    if (started) {
      // the task runs and its row has its sid: an error after that (releasing the lease, say)
      // does not undo the launch
      launch = { kind: "started" };
      notices = [];
    } else {
      // no sandbox, a busy or lost lease, an abort, a provider error: nothing started (or what
      // did was killed above, when its session id could be read)
      const why = e instanceof Error ? e.message : String(e);
      await background.failLaunch(id, `launch failed: ${why}`).catch(() => undefined);
      await announce();
      if (!isLarge || e instanceof ToolError) throw e;
      throw new ToolError(
        `The background task was not started: ${clip(why, 500).replace(/\.$/, "")}. Check the environment, or call Bash without run_in_background.${largeText()}`,
      );
    }
  }
  if (launch.kind === "not_started") {
    await background.failLaunch(id, launch.why);
    await announce();
    throw new ToolError(
      `The background task was not started: ${launch.why}. Check the environment, or call Bash without run_in_background.${largeText()}`,
    );
  }
  if (launch.kind === "stopped") {
    await announce();
    throw new ToolError(
      `Background task ${id} ("${description}") was stopped while it was starting, so nothing runs. Call Bash again if it is still needed.`,
    );
  }
  if (launch.kind === "unrecorded") {
    await background.failLaunch(id, `started but not recorded: ${launch.why}`);
    await announce();
    if (launch.stopped) {
      throw new ToolError(
        `The background command started but could not be recorded (${launch.why}), so it was stopped. Retry, or call Bash without run_in_background.`,
      );
    }
    throw new ToolError(
      `The background command started but could not be recorded (${launch.why}); an attempt to stop it failed, so it ends at its timeout. Check the sandbox before you retry, or call Bash without run_in_background.`,
    );
  }
  await announce();
  const lowered =
    requested !== undefined && requested > maxMs
      ? `\n[timeout ${requested} ms is over the background task maximum; it was lowered to ${maxMs} ms.]`
      : "";
  const shown = clip(input.command, 120);
  return {
    content: [
      {
        type: "text",
        text: withNotices(notices, startedText(id, description, workspace) + lowered),
      },
    ],
    isError: false,
    view: { kind: "command", description, exitCode: null, timedOut: false },
    display: display(`后台运行命令：${shown}`, `Started in the background: ${shown}`),
  };
}

/** 内置工具 `Bash`：在本对话的沙箱里执行命令。 */
export function sandboxBashTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    spillChars: BASH_SPILL_CHARS,
    unavailable: unavailableWhenNoSandbox(deps),
    // 命令自己的超时先到（提供方停掉命令、返回 timedOut），管线的时限再留出等锁与创建 / 恢复的余量
    timeoutMs: (input) => {
      const cfg = deps.config.get();
      // a background call is only the short launch; the task's own timeout runs in the sandbox
      if ((input as BashInput).run_in_background === true) {
        return LAUNCH_EXEC_TIMEOUT_MS + sandboxBaseTimeoutMs(cfg);
      }
      const max = cfg.sandbox.limits.maxCommandSeconds;
      return msFor(input as BashInput, max) + sandboxBaseTimeoutMs(cfg);
    },
    async run(input, ctx) {
      if ((input as BashInput).run_in_background === true) {
        return runInBackground(deps, ctx, input as BashInput);
      }
      const { command, description } = input as BashInput;
      const max = deps.config.get().sandbox.limits.maxCommandSeconds;
      const requested = (input as BashInput).timeout;
      const maxMs = max * 1000;
      const askedMs = msFor(input as BashInput, max);
      // The run's deadline makes the command time out itself first (Ruling M20): counted after the
      // sandbox is obtained, so the time spent waiting for the lock and resuming is deducted
      let ms = askedMs;
      let workspace = DEFAULT_SANDBOX_ROOTS.workspace;
      // the device the command ran on (a refused network host is asked about there)
      let deviceId = "";
      const { value: r, notices } = await inSandbox(deps, ctx, (s) => {
        const left = Math.floor(runTimeLeftMs(ctx.runDeadline) / 1000) * 1000;
        ms = Math.max(1000, Math.min(askedMs, left));
        workspace = s.roots.workspace;
        deviceId = s.deviceId;
        return s.p.exec(s.h, {
          command,
          cwd: s.roots.workspace,
          timeoutMs: ms,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal: s.signal,
        });
      });
      const blocked = r.network?.blocked ?? [];
      // kernel-internal (auto mode spec §6, P-D13): `gh auth login --web`'s device code, which the
      // pipeline shows to the person. It never becomes part of the result the model sees.
      const loginCode = parseDeviceCode(`${r.stdout}\n${r.stderr}`);
      const seconds = ms / 1000;
      const clamped = ms < askedMs;
      const shown = clip(command, 120);
      const lowered =
        requested !== undefined && requested > maxMs
          ? `\n[timeout ${requested} ms is over the deployment maximum; it was lowered to ${maxMs} ms.]`
          : "";
      const text = formatExec(r, seconds, clamped, workspace) + lowered;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        isError: r.timedOut || r.exitCode === null,
        // display only: a non-zero exit is information on the row (not a failure), like `isError`
        view: {
          kind: "command",
          ...(description !== undefined && { description }),
          exitCode: r.exitCode,
          timedOut: r.timedOut,
        },
        display: r.timedOut
          ? display(
              `命令超时（${seconds} 秒）：${shown}`,
              `Command timed out (${seconds}s): ${shown}`,
            )
          : r.exitCode === null
            ? display(`命令被中止：${shown}`, `Command stopped: ${shown}`)
            : display(
                `运行命令（退出码 ${r.exitCode}）：${shown}`,
                `Ran command (exit ${r.exitCode}): ${shown}`,
              ),
        // kernel-internal: the pipeline asks the device owner or writes notes (spec §6.2)
        ...(blocked.length > 0 && deviceId !== "" && { networkReport: { deviceId, blocked } }),
        // kernel-internal: the pipeline writes the display-only `device_code` event (auto mode §6)
        ...(loginCode !== null && { loginCode }),
      };
    },
  };
}
