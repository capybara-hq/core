import { type ExecResult, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import {
  clip,
  display,
  inSandbox,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

/** 不给 `timeoutSeconds` 时的命令超时（秒），不超过 `sandbox.limits.maxCommandSeconds`。 */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 120;
/** bash 结果超过这么多字符即转存（走现有输出存档，模型用 read_tool_output 分页读）。 */
export const BASH_SPILL_CHARS = 30_000;
/** 一次命令最多收集的输出字节（stdout + stderr）；超出的丢弃并在结果里说明。 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "sandbox_bash",
  description:
    "Run a shell command (bash) in this conversation's sandbox, an isolated Linux machine. " +
    "Use it to run programs and scripts, install packages, process files and inspect the " +
    "filesystem. The working directory is /workspace; files persist between calls in the same " +
    "conversation. Files the user attached to the conversation are under /workspace/attachments, " +
    "and skill files under /skills (read-only). Each call runs in a fresh shell (no state such as " +
    "cd or environment variables carries over). The result has stdout, stderr and the exit code; " +
    "long output is saved and can be paged with read_tool_output. A command that runs longer than " +
    "timeoutSeconds is stopped. Prefer sandbox_read, sandbox_write, sandbox_edit, sandbox_glob and " +
    "sandbox_grep for reading, writing and searching files. To give a file to the user, use " +
    "sandbox_deliver.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        minLength: 1,
        description: 'The command line to run, e.g. "python3 analyze.py data.csv".',
      },
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        description: `Seconds before the command is stopped. Default ${BASH_DEFAULT_TIMEOUT_SECONDS}; the deployment sets a maximum (7200 by default).`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

interface BashInput {
  command: string;
  timeoutSeconds?: number;
}

/** 本次命令的超时（秒）：给定的值，或默认值（不超过上限）。 */
const secondsFor = (input: BashInput, max: number): number =>
  input.timeoutSeconds ?? Math.min(BASH_DEFAULT_TIMEOUT_SECONDS, max);

/** 命令结果 → 给模型的文本。 */
export function formatExec(r: ExecResult, seconds: number): string {
  const parts: string[] = [];
  if (r.stdout !== "") parts.push(r.stdout.replace(/\n$/, ""));
  if (r.stderr !== "") parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
  if (r.truncated)
    parts.push(`[Output truncated: only the first ${MAX_OUTPUT_BYTES} bytes were kept.]`);
  if (r.timedOut) {
    parts.push(
      `[timedOut: the command did not finish within ${seconds}s and was stopped. The sandbox is still usable; pass a larger timeoutSeconds or run the work in the background and check on it later.]`,
    );
  } else if (r.exitCode === null) {
    parts.push(
      "[The command was stopped before it finished; its effects may be partial. Check the sandbox state before retrying.]",
    );
  } else {
    parts.push(`[exit code: ${r.exitCode}]`);
  }
  return parts.join("\n");
}

/** 内置工具 `sandbox_bash`：在本对话的沙箱里执行命令。 */
export function sandboxBashTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    spillChars: BASH_SPILL_CHARS,
    unavailable: unavailableWhenNoSandbox(deps),
    // 命令自己的超时先到（提供方停掉命令、返回 timedOut），管线的时限再留出等锁与创建 / 恢复的余量
    timeoutMs: (input) => {
      const cfg = deps.config();
      const max = cfg.sandbox.limits.maxCommandSeconds;
      return Math.min(secondsFor(input as BashInput, max), max) * 1000 + sandboxBaseTimeoutMs(cfg);
    },
    async run(input, ctx) {
      const { command } = input as BashInput;
      const max = deps.config().sandbox.limits.maxCommandSeconds;
      const req = (input as BashInput).timeoutSeconds;
      if (req !== undefined && req > max) {
        throw new ToolError(
          `timeoutSeconds ${req} is over the limit of ${max} seconds; pass a value of at most ${max}.`,
        );
      }
      const seconds = secondsFor(input as BashInput, max);
      const { value: r, notices } = await inSandbox(deps, ctx, ({ h, p, signal }) =>
        p.exec(h, {
          command,
          cwd: "/workspace",
          timeoutMs: seconds * 1000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal,
        }),
      );
      const shown = clip(command, 120);
      return {
        content: [{ type: "text", text: withNotices(notices, formatExec(r, seconds)) }],
        isError: r.timedOut || r.exitCode === null,
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
