import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import {
  checkPath,
  clip,
  display,
  inSandbox,
  type SandboxToolDeps,
  SYNC_MARKER,
  sandboxBaseTimeoutMs,
  shellQuote,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

/** 最多返回的匹配行数。 */
const MAX_MATCHES = 500;
/** 每个匹配行最多显示的字符数。 */
const MAX_LINE_CHARS = 500;
/** grep 输出的上限（字节）。 */
const MAX_GREP_BYTES = 4 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "sandbox_grep",
  description:
    "Search file contents in this conversation's sandbox with a regular expression (POSIX " +
    "extended, as grep -E). Use it to find where something is defined or mentioned. Searches path " +
    "(a file, or a directory recursively; default /workspace), skipping binary files; glob limits " +
    'the files searched by name, e.g. "*.py". Returns matching lines as <path>:<line>:<text>, up ' +
    "to 500. To find files by name, use sandbox_glob.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description: 'Regular expression (POSIX extended), e.g. "def [a-z_]+\\(" or "TODO".',
      },
      path: {
        type: "string",
        minLength: 1,
        description: "Absolute file or directory to search. Default /workspace.",
      },
      glob: {
        type: "string",
        minLength: 1,
        description: 'Only search files whose name matches this glob, e.g. "*.md".',
      },
      ignoreCase: { type: "boolean", description: "Case-insensitive match. Default false." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
}

const notFound = (path: string) =>
  `${clip(path, 200)} does not exist; check the path with sandbox_glob.`;
const failed = (stderr: string) =>
  `grep failed: ${clip(stderr, 300)}. Check the pattern (POSIX extended regular expression) and retry.`;
const GREP_TIMEOUT = "The search did not finish in time; pass a narrower path or a glob and retry.";

/** 内置工具 `sandbox_grep`：按正则搜文件内容（只读）。 */
export function sandboxGrepTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const { pattern, glob, ignoreCase = false } = input as GrepInput;
      const path = checkPath((input as GrepInput).path ?? "/workspace");
      const { value: lines, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        // 在目标所在目录里搜相对路径，输出再拼回绝对路径（命令里不出现沙箱绝对路径）
        const slash = path.lastIndexOf("/");
        const cwd = st.isDir ? path : path.slice(0, slash) || "/";
        const target = st.isDir ? "." : path.slice(slash + 1);
        const command = [
          "grep -rnHIE",
          ...(ignoreCase ? ["-i"] : []),
          ...(glob !== undefined ? [`--include=${shellQuote(glob)}`] : []),
          "-e",
          shellQuote(pattern),
          "--",
          shellQuote(target),
        ].join(" ");
        const r = await p.exec(h, {
          command,
          cwd,
          timeoutMs: deps.config().tools.timeoutMs,
          maxOutputBytes: MAX_GREP_BYTES,
          signal,
        });
        if (r.timedOut || r.exitCode === null) throw new ToolError(GREP_TIMEOUT);
        if (r.exitCode === 1) return [];
        if (r.exitCode !== 0) throw new ToolError(failed(r.stderr));
        const out = r.stdout.split("\n").filter((l) => l !== "");
        if (r.truncated) out.pop();
        const base = cwd === "/" ? "" : cwd;
        return out
          .map((l) => `${base}/${l.startsWith("./") ? l.slice(2) : l}`)
          .filter((l) => !l.startsWith(`${SYNC_MARKER}:`));
      });
      const shown = lines
        .slice(0, MAX_MATCHES)
        .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
      const text =
        lines.length === 0
          ? `No matches for ${pattern} in ${path}.`
          : shown.join("\n") +
            (lines.length > MAX_MATCHES
              ? `\n[Showing the first ${MAX_MATCHES} of ${lines.length} matching lines; use a narrower pattern, path or glob.]`
              : "");
      const n = lines.length;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(
          `搜索 ${clip(pattern, 120)}（${n} 处）`,
          `Searched for ${clip(pattern, 120)} (${n} match${n === 1 ? "" : "es"})`,
        ),
      };
    },
  };
}
