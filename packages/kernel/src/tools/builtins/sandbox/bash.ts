import { type ExecResult, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import {
  clip,
  display,
  inSandbox,
  runBudgetNote,
  runTimeLeftMs,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

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
    "Run a shell command (bash) in this conversation's sandbox, an isolated Linux machine. " +
    "Use it to run programs and scripts, install packages, process files and inspect the " +
    "filesystem. The working directory is /workspace; files persist between calls in the same " +
    "conversation, but background processes may not: when the sandbox is suspended after a period " +
    "without use they can be stopped and /tmp cleared, so keep results in files under /workspace. " +
    "Files the user attached to the conversation are under /workspace/attachments, " +
    "and skill files under /skills (read-only). Each call runs in a fresh shell (no state such as " +
    "cd or environment variables carries over). The result has stdout, stderr and the exit code; " +
    "long output is saved and can be paged with ReadToolOutput. A command that runs longer than " +
    "timeout milliseconds is stopped. Prefer Read, Write, Edit, Glob and " +
    "Grep for reading, writing and searching files. To give a file to the user, use " +
    "Deliver. Other sub-agents of this conversation may run commands in this sandbox at " +
    "the same time. Always pass description: a few words saying what the command is for; the " +
    "user sees it instead of the command.",
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
        description: `Milliseconds before the command is stopped. Default ${BASH_DEFAULT_TIMEOUT_SECONDS * 1000}; the deployment sets a maximum (7200000 by default); a larger value is lowered to it.`,
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
}

/** This command's timeout in milliseconds: the given value or the default, at most the maximum. */
const msFor = (input: BashInput, maxSeconds: number): number =>
  Math.min(input.timeout ?? BASH_DEFAULT_TIMEOUT_SECONDS * 1000, maxSeconds * 1000);

/**
 * 命令结果 → 给模型的文本。`budgetClamped`：运行的时限把超时收紧到了 `seconds`（Ruling M20），超时说明改为
 * 指向 `runtime.maxRunSeconds`，而不是让模型加大 timeout。
 */
export function formatExec(r: ExecResult, seconds: number, budgetClamped = false): string {
  const parts: string[] = [];
  if (r.stdout !== "") parts.push(r.stdout.replace(/\n$/, ""));
  if (r.stderr !== "") parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
  if (r.truncated)
    parts.push(`[Output truncated: only the first ${MAX_OUTPUT_BYTES} bytes were kept.]`);
  if (r.timedOut && budgetClamped) {
    parts.push(
      `[timedOut: the command did not finish within ${seconds}s and was stopped. ${runBudgetNote(seconds)} The sandbox is still usable; split the work into shorter steps that save progress to files under /workspace, or run long jobs in the background and check on them in a later run.]`,
    );
  } else if (r.timedOut) {
    parts.push(
      `[timedOut: the command did not finish within ${seconds}s and was stopped. The sandbox is still usable; pass a larger timeout in milliseconds (up to the deployment maximum), or split the work into shorter steps that save progress to files under /workspace.]`,
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
      const max = cfg.sandbox.limits.maxCommandSeconds;
      return msFor(input as BashInput, max) + sandboxBaseTimeoutMs(cfg);
    },
    async run(input, ctx) {
      const { command, description } = input as BashInput;
      const max = deps.config.get().sandbox.limits.maxCommandSeconds;
      const requested = (input as BashInput).timeout;
      const maxMs = max * 1000;
      const askedMs = msFor(input as BashInput, max);
      // The run's deadline makes the command time out itself first (Ruling M20): counted after the
      // sandbox is obtained, so the time spent waiting for the lock and resuming is deducted
      let ms = askedMs;
      const { value: r, notices } = await inSandbox(deps, ctx, ({ h, p, signal }) => {
        const left = Math.floor(runTimeLeftMs(ctx.runDeadline) / 1000) * 1000;
        ms = Math.max(1000, Math.min(askedMs, left));
        return p.exec(h, {
          command,
          cwd: "/workspace",
          timeoutMs: ms,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal,
        });
      });
      const seconds = ms / 1000;
      const clamped = ms < askedMs;
      const shown = clip(command, 120);
      const lowered =
        requested !== undefined && requested > maxMs
          ? `\n[timeout ${requested} ms is over the deployment maximum; it was lowered to ${maxMs} ms.]`
          : "";
      const text = formatExec(r, seconds, clamped) + lowered;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        isError: r.timedOut || r.exitCode === null,
        // display only: a non-zero exit shows as failed on the row, `isError` stays as it was
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
      };
    },
  };
}
