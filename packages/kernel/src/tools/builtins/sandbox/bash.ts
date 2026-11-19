import {
  DEFAULT_SANDBOX_ROOTS,
  type ExecResult,
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import {
  backgroundMaxSeconds,
  LAUNCH_EXEC_TIMEOUT_MS,
  managedStartedText,
  managedTaskArtifactPath,
  newTaskId,
} from "../../../background/launch.js";
import { taskReasonText } from "../../../background/render.js";
import type { BackgroundTaskRow } from "../../../background/store.js";
import { isDeviceRequestNotSent } from "../../../local-devices/relay.js";
import { isEscalationGrantMissing } from "../../../sandbox/operation-authority-types.js";
import { launchRefusedText, operationIdFor } from "../../../sandbox/operation-intents.js";
import {
  ESCALATION_JUSTIFICATION_MAX_CHARS,
  ESCALATION_RETRY_HINT,
  SANDBOX_ESCALATED,
} from "../../../sandbox/review/permission-candidate.js";
import type { BuiltinCallContext, BuiltinResult, BuiltinTool } from "../../registry.js";
import {
  clip,
  display,
  inSandboxOperations,
  inToolSandbox,
  runBudgetNote,
  runTimeLeftMs,
  type SandboxToolDeps,
  SCOPE_DENIED_TOOL_TEXT,
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
    "files under the workspace directory. Files the user attached to the conversation are not in " +
    "the device until FetchAttachment copies one into the workspace's attachments directory; " +
    "skill files are in the skills directory (read-only). Each call runs in a fresh shell (no state such as " +
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
    "allows you to continue working while the command runs: use it for what must keep running " +
    "(a dev server, a watcher) or for a long job whose result you do not need yet while you do " +
    "other work. If you need the result before you can go on, run it in the foreground with a " +
    "larger timeout instead: starting it in the background and then waiting on it with TaskOutput " +
    "gains nothing. The call " +
    "returns at once with a task id and the command's output goes to a file under .capybara/tasks " +
    "in the workspace directory; you will be told when it finishes, so keep working meanwhile. " +
    "Read its new output with TaskOutput (block false to check a server's or watcher's log) and " +
    "stop it with TaskStop. TaskList lists this conversation's background tasks and their ids, " +
    "running ones first. TaskOutput shows what the command has written to that file so far. A " +
    "command that waits for a person (an interactive " +
    "login, a prompt) should run in the background so its output, such as a one-time code to " +
    "enter, can be read with TaskOutput while it waits. In the background, timeout defaults to the " +
    "deployment's background maximum (7200000 by default). A background task ends when its " +
    "command exits, and processes it left running are stopped. A background task is lost if the " +
    "sandbox is suspended (it is suspended after it has been running for a while, " +
    "sandbox.limits.maxRunningMinutes).\n\n" +
    "Commands run inside an OS sandbox under every permission profile: it limits which " +
    "directories they may write, keeps private, LAN, loopback and cloud metadata addresses and " +
    "the Docker socket closed, and, when the device's network is an allowlist, limits which " +
    "hosts they may reach. When the sandbox blocks a command you need (for example 'Operation " +
    "not permitted' writing outside the project, a dev server that must listen on a port, or a " +
    'service on localhost or the LAN), retry that one call with sandbox: "escalated" and a ' +
    "justification saying why; this conversation's permission profile decides (the user, a " +
    "review model, or Full access within the device's limits), and only that call runs outside " +
    "the sandbox. Do not escalate by default: try inside the sandbox first. Some devices and " +
    "organizations do not allow it.\n\n" +
    "Network access goes through a proxy set in HTTP_PROXY / HTTPS_PROXY / ALL_PROXY; HTTP(S)- " +
    "and SOCKS-aware clients work on any port. A tool that ignores them (plain ssh, for example) " +
    "fails with 'Operation not permitted' or cannot resolve names; pass the proxy through its " +
    "own option (for git over ssh, GIT_SSH_COMMAND with a SOCKS ProxyCommand). A blocked domain " +
    "is reported after the output.",
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
          "Set to true to run this command in the background (see the description for when).",
      },
      sandbox: {
        type: "string",
        enum: [SANDBOX_ESCALATED],
        description:
          "Set to \"escalated\" to ask to run this one call outside the OS sandbox (also in the background). Requires justification; this conversation's permission profile decides first (the user, a review model, or Full access within the device's limits).",
      },
      justification: {
        type: "string",
        minLength: 1,
        maxLength: ESCALATION_JUSTIFICATION_MAX_CHARS,
        description:
          'With sandbox: "escalated": one sentence saying why this command must run outside the sandbox, e.g. "The dev server must bind port 3000 on the machine". Shown to the approver.',
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
  /** `escalated`: run this one call outside the OS sandbox once approved. */
  sandbox?: typeof SANDBOX_ESCALATED;
  justification?: string;
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

/** The most output a background start keeps (the device acknowledges it with a typed ref). */
const LAUNCH_MAX_OUTPUT_BYTES = 64 * 1024;

/** How a managed launch ended (permission runtime cutover phase 8.2). */
type ManagedLaunch =
  | { kind: "full" }
  /** The same call reserved before with another command or working root. */
  | { kind: "changed" }
  /** Acknowledged, cancel-pending, or settled: the row as persisted after the start. */
  | { kind: "launched"; task: BackgroundTaskRow }
  /** Dispatched, outcome unknown: reconciled later under the same identity, never relaunched. */
  | { kind: "unknown"; task: BackgroundTaskRow }
  /** Refused before any effect (the reservation is settled as failed). */
  | { kind: "refused"; task: BackgroundTaskRow; why: string };

/**
 * Managed `Bash` background launch (permission runtime cutover phase 8.2): the tool's only
 * background path (the SID launch is gone, permission activation W5-P2).
 *
 * Inside the held operation session it reserves the task (or, for a retry of the same run call,
 * reuses the reservation it persisted before: the same task id, artifact, deadline and
 * retention, so the start input and its hash are unchanged), with its artifact at
 * `${workingRoot}/.capybara/tasks/${taskId}.out` under the trusted working root. The start then
 * goes through the operation facade: admitted, bound to the reservation and dispatched under the
 * stable operation id, and acknowledged with its exact typed ref. The output path is told to the
 * model only after the acknowledgement. A refusal before dispatch settles the reservation; an
 * unknown outcome leaves it dispatched for reconciliation under the same identity.
 */
export async function runInBackgroundManaged(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  input: BashInput,
): Promise<BuiltinResult> {
  const { background } = deps;
  const claim = ctx.executionClaim;
  if (!background?.reserveManaged || !background.failManagedPreEffect || !claim || !ctx.runId) {
    throw new ToolError(
      "Background tasks are not available here; call Bash without run_in_background.",
    );
  }
  const reserveManaged = background.reserveManaged.bind(background);
  const failManagedPreEffect = background.failManagedPreEffect.bind(background);
  const cfg = deps.config.get();
  const maxMs = backgroundMaxSeconds(cfg) * 1000;
  const requested = input.timeout;
  const seconds = Math.max(1, Math.ceil(Math.min(requested ?? maxMs, maxMs) / 1000));
  const root = sandboxConversationOf(ctx);
  const maxTasks = cfg.sandbox.background.maxTasks;
  const description = input.description ?? clip(input.command, 120);
  // The facade derives the same id from this call's first dispatched method.
  const operationId = operationIdFor({ claim, callId: ctx.callId, ordinal: 0 });
  const announce = async (): Promise<void> => {
    if (!deps.eventLog.publishChanged) return;
    for (const c of new Set([ctx.conversationId, root])) {
      await deps.eventLog.publishChanged(c, "background");
    }
  };
  const { value: launch, notices } = await inSandboxOperations(deps, ctx, async (s) => {
    const start = s.p.backgroundStart?.bind(s.p);
    if (!start) {
      throw new ToolError(
        "Background tasks are not available on this device; call Bash without run_in_background.",
      );
    }
    const id = newTaskId();
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + seconds * 1000);
    const reserved = await reserveManaged(
      {
        id,
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        sandboxConversationId: root,
        deviceId: s.deviceId,
        runId: ctx.runId as string,
        callId: ctx.callId,
        triggerAccountId: ctx.accountId,
        description,
        command: input.command,
        operationId,
        workingRoot: s.workingRoot,
        outputPath: managedTaskArtifactPath(s.workingRoot, id),
        startedAt,
        deadlineAt,
        retainUntil: new Date(deadlineAt.getTime() + cfg.tools.outputRetentionDays * 86_400_000),
      },
      maxTasks,
    );
    if (reserved.kind === "full") return { kind: "full" } satisfies ManagedLaunch;
    const task = reserved.row;
    if (
      task.command !== input.command ||
      task.workingRoot !== s.workingRoot ||
      task.operationId !== operationId
    )
      return { kind: "changed" } satisfies ManagedLaunch;
    if (task.launchState === "terminal" || task.retainUntil === null || task.workingRoot === null)
      return { kind: "launched", task } satisfies ManagedLaunch;
    try {
      await start(s.h, {
        command: input.command,
        cwd: task.workingRoot,
        timeoutMs: task.deadlineAt.getTime() - task.startedAt.getTime(),
        maxOutputBytes: LAUNCH_MAX_OUTPUT_BYTES,
        taskId: task.id,
        outputPath: task.outputPath,
        retainUntilMs: task.retainUntil.getTime(),
        signal: s.signal,
      });
    } catch (e) {
      // kernel-written text only: the provider's message is logged, never shown to the model
      const why = launchRefusedWhy(e);
      deps.log?.warn("managed background start failed", { taskId: task.id, err: e });
      // a reservation that never dispatched is settled; a dispatched one never is here
      if (await failManagedPreEffect(task.id, `launch refused: ${why}`, claim.executionId)) {
        return {
          kind: "refused",
          task: (await background.get(task.id)) ?? task,
          why,
        } satisfies ManagedLaunch;
      }
      const now = (await background.get(task.id)) ?? task;
      if (now.launchState === "dispatched" && !isRefusal(e))
        return { kind: "unknown", task: now } satisfies ManagedLaunch;
      // a dispatched start the provider refused was settled with it: the kernel's reason
      if (now.launchState === "terminal" && isRefusal(e))
        return { kind: "refused", task: now, why } satisfies ManagedLaunch;
      return { kind: "launched", task: now } satisfies ManagedLaunch;
    }
    return {
      kind: "launched",
      task: (await background.get(task.id)) ?? task,
    } satisfies ManagedLaunch;
  });
  if (launch.kind === "full") {
    throw new ToolError(
      `${maxTasks} background tasks are already running; stop one with TaskStop or wait for one to finish, then retry`,
    );
  }
  if (launch.kind === "changed") {
    throw new ToolError(
      "This call already reserved a background task with a different command or working directory; it cannot be reused with changed input. Call Bash again as a new call.",
    );
  }
  await announce();
  const { task } = launch;
  if (launch.kind === "unknown") {
    throw new ToolError(
      `Background task ${task.id} ("${description}") may have started, but its start was not confirmed; it is being reconciled under its original identity and will not be started again. Check TaskList before starting it again.`,
      { kind: "unavailable" },
    );
  }
  // a retry of a call whose acknowledged task has since ended reports the start it made
  const started =
    task.executionRef !== null &&
    (task.launchState === "acknowledged" || task.status !== "running");
  if (!started && launch.kind !== "refused" && task.status === "lost") {
    // revoked or given up before its start was confirmed: the process may have started, and its
    // exact revoke (owed with the revocation) stops it; never claim that nothing ran
    const how = task.lostReason === "launch_unknown" ? "given up" : "revoked";
    throw new ToolError(
      `Background task ${task.id} ("${description}") may have started before its launch was ${how} (${taskReasonText(task)}); any process it started is being stopped and will not keep running, but it may already have had effects. Check them before calling Bash again as a new call.`,
    );
  }
  if (!started && (launch.kind === "refused" || task.launchState === "terminal")) {
    // the recorded reason may hold a provider's words: the model gets kernel text only
    const why =
      launch.kind === "refused" ? launch.why : "it was stopped or refused before it started";
    // a scope refusal where running outside the sandbox is allowed: say the call may escalate
    const hint =
      launch.kind === "refused" &&
      ctx.sandboxEscalation === "available" &&
      why === launchRefusedText("denied")
        ? ESCALATION_RETRY_HINT
        : "";
    throw new ToolError(
      `The background task was not started: ${why}. Nothing runs; fix the cause, or call Bash without run_in_background.${hint}`,
    );
  }
  if (!started && task.launchState === "cancel-pending" && task.executionRef !== null) {
    // the device acknowledged the start; a stop, while or after it started, is being applied
    throw new ToolError(
      `Background task ${task.id} ("${description}") is being stopped: a stop was asked for while or after it started, and its cancellation is in progress. Call TaskOutput to see when it has ended, or call Bash again as a new call if it is still needed.`,
    );
  }
  if (!started && task.launchState === "cancel-pending") {
    throw new ToolError(
      `Background task ${task.id} ("${description}") was stopped while it was starting; its cancellation is in progress. Call Bash again if it is still needed.`,
    );
  }
  if (!started) {
    throw new ToolError(
      `Background task ${task.id} ("${description}") may have started, but its start was not confirmed; it will not be started again. Check TaskList before starting it again.`,
      { kind: "unavailable" },
    );
  }
  const lowered =
    requested !== undefined && requested > maxMs
      ? `\n[timeout ${requested} ms is over the background task maximum; it was lowered to ${maxMs} ms.]`
      : "";
  const shown = clip(input.command, 120);
  return {
    content: [
      {
        type: "text",
        text: withNotices(
          notices,
          managedStartedText(task.id, description, task.outputPath) + lowered,
        ),
      },
    ],
    isError: false,
    view: { kind: "command", description, exitCode: null, timedOut: false },
    display: display(`后台运行命令：${shown}`, `Started in the background: ${shown}`),
  };
}

/** Why a managed start was refused, in the kernel's own words (never the provider's message). */
function launchRefusedWhy(e: unknown): string {
  if (isEscalationGrantMissing(e))
    return 'its approval to run outside the sandbox no longer matches (the device, its Full access ceiling or the permission scope changed since it was approved); call Bash again with sandbox: "escalated" and a justification to ask again';
  return launchRefusedText(
    isDeviceRequestNotSent(e)
      ? "not_sent"
      : isSandboxScopeDeniedError(e)
        ? "denied"
        : isSandboxPermissionUnsupportedError(e)
          ? "unsupported"
          : undefined,
  );
}

/** A typed refusal: the provider or admission proved the start had no effect. */
const isRefusal = (e: unknown): boolean =>
  !isSandboxOperationOutcomeUnknownError(e) &&
  (isSandboxScopeDeniedError(e) || isSandboxPermissionUnsupportedError(e));

/**
 * Sandbox-specific signals in a command's output: the EPERM a Seatbelt or Landlock write denial
 * gives, the read-only bind of the Linux sandbox, Seatbelt's own deny report, and the sandbox
 * proxy refusing a host or a tunnel. A plain "Permission denied" (EACCES) is not one: ssh
 * publickey failures, git 403s and file modes print it too.
 */
const SANDBOX_DENIED_RE =
  /Operation not permitted|Read-only file system|Sandbox: \S+\(\d+\) deny\(\d+\)|Connection blocked by network allowlist|blocked-by-allowlist|HTTP code 403 from proxy after CONNECT/;
/**
 * Credential and auth failures: never a reason to run outside the sandbox, so they never get the
 * escalation hint, whatever else the output says.
 */
const AUTH_FAILURE_RE =
  /Permission denied \(publickey|Host key verification failed|Authentication failed|authentication required|could not read (?:Username|Password)|Bad credentials|invalid credentials|remote: Permission to \S+ denied|The requested URL returned error: 40[13]|\b401 Unauthorized\b/i;
/**
 * Whether a finished command failed in a way the OS sandbox may have caused: a host the device
 * refused (`network.blocked`) or a sandbox-specific message, and no credential or auth failure.
 */
export const sandboxDenied = (r: ExecResult): boolean => {
  if (r.exitCode === null || r.exitCode === 0) return false;
  const out = `${r.stdout}\n${r.stderr}`;
  if (AUTH_FAILURE_RE.test(out)) return false;
  return (r.network?.blocked.length ?? 0) > 0 || SANDBOX_DENIED_RE.test(out);
};
/**
 * {@link SCOPE_DENIED_TOOL_TEXT} followed by {@link ESCALATION_RETRY_HINT}, written out as a literal
 * for the tool design check (a unit test keeps the two copies equal).
 */
export const SCOPE_DENIED_ESCALATION_TEXT =
  "This operation reaches outside what this conversation's permission profile allows on the device (a path outside the directories it may read or write, or a host it may not reach), so it did not run. Keep the call inside the working directory and the directories already granted, or ask the user to grant the directory or choose a broader permission profile, then retry. If this command must reach outside the sandbox, retry the same Bash call with sandbox: \"escalated\" and justification: one sentence saying why; this conversation's permission profile decides whether it may run outside the sandbox for this call only (the user, the review model, or Full access within this device's limits).";
/**
 * A restricted call the scope refused ({@link SCOPE_DENIED_TOOL_TEXT}) where running outside the
 * sandbox is allowed: the refusal also says the call may be retried escalated.
 */
async function withEscalationHint<T>(ctx: BuiltinCallContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (
      ctx.sandboxEscalation === "available" &&
      e instanceof ToolError &&
      e.message === SCOPE_DENIED_TOOL_TEXT
    )
      throw new ToolError(SCOPE_DENIED_ESCALATION_TEXT);
    throw e;
  }
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
      // a background call is only the short start; the task's own timeout runs on the device
      if ((input as BashInput).run_in_background === true) {
        return LAUNCH_EXEC_TIMEOUT_MS + sandboxBaseTimeoutMs(cfg);
      }
      const max = cfg.sandbox.limits.maxCommandSeconds;
      return msFor(input as BashInput, max) + sandboxBaseTimeoutMs(cfg);
    },
    async run(input, ctx) {
      if ((input as BashInput).run_in_background === true) {
        // the managed launch only: it refuses before any effect where it cannot run
        return withEscalationHint(ctx, () => runInBackgroundManaged(deps, ctx, input as BashInput));
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
      const { value: r, notices } = await withEscalationHint(ctx, () =>
        inToolSandbox(deps, ctx, (s) => {
          const left = Math.floor(runTimeLeftMs(ctx.runDeadline) / 1000) * 1000;
          ms = Math.max(1000, Math.min(askedMs, left));
          workspace = s.roots.workspace;
          deviceId = s.deviceId;
          return s.p.exec(s.h, {
            command,
            // the working root: a bound project's root, else the workspace
            cwd: s.workingRoot,
            timeoutMs: ms,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            signal: s.signal,
          });
        }),
      );
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
      const text =
        formatExec(r, seconds, clamped, workspace) +
        lowered +
        (ctx.sandboxEscalation === "available" && sandboxDenied(r)
          ? `\n[sandbox] The OS sandbox may have blocked this command.${ESCALATION_RETRY_HINT}`
          : "");
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
