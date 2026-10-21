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
  searchTimeoutMs,
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

/**
 * 解析 `grep -nH --null` 的输出：每条为 `<文件名>\0<行号>:<行>\n`（文件名可能含换行，行本身不含）。
 * 返回 `<绝对路径>:<行号>:<行>`；文件名里的换行显示为 `\n`。最后一条不完整（输出被截断）时丢掉。
 */
export function parseGrepNull(stdout: string, base: string): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const nul = stdout.indexOf("\0", pos);
    if (nul === -1) break;
    const nl = stdout.indexOf("\n", nul);
    if (nl === -1) break;
    const raw = stdout.slice(pos, nul);
    const name = (raw.startsWith("./") ? raw.slice(2) : raw).replace(/\n/g, "\\n");
    out.push(`${base}/${name}:${stdout.slice(nul + 1, nl)}`);
    pos = nl + 1;
  }
  return out;
}

/** 内置工具 `sandbox_grep`：按正则搜文件内容（只读）。 */
export function sandboxGrepTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const startedAt = Date.now();
      const { pattern, glob, ignoreCase = false } = input as GrepInput;
      const path = checkPath((input as GrepInput).path ?? "/workspace");
      const { value, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        // 在目标所在目录里搜相对路径，输出再拼回绝对路径（命令里不出现沙箱绝对路径）
        const slash = path.lastIndexOf("/");
        const cwd = st.isDir ? path : path.slice(0, slash) || "/";
        const target = st.isDir ? "." : path.slice(slash + 1);
        const command = [
          // --null：文件名后跟 NUL 而不是 `:`，文件名里有换行或冒号也能解析
          "grep -rnHIE --null",
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
          timeoutMs: searchTimeoutMs(deps.config(), startedAt),
          maxOutputBytes: MAX_GREP_BYTES,
          signal,
        });
        if (r.timedOut || r.exitCode === null) throw new ToolError(GREP_TIMEOUT);
        if (r.exitCode === 1) return { lines: [], warning: null };
        const all = parseGrepNull(r.stdout, cwd === "/" ? "" : cwd);
        const lines = all.filter((l) => !l.startsWith(`${SYNC_MARKER}:`));
        // 退出码 2 = 有错误（如个别文件不可读）；有输出时照常返回（可能为空：只匹配到隐藏的标记文件）并附上说明
        if (r.exitCode !== 0 && all.length === 0) throw new ToolError(failed(r.stderr));
        const warning = r.exitCode !== 0 ? clip(r.stderr, 300) : null;
        return { lines, warning };
      });
      const { lines, warning } = value;
      const shown = lines
        .slice(0, MAX_MATCHES)
        .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
      const note = warning !== null ? `\n[grep also reported errors: ${warning}]` : "";
      const text =
        (lines.length === 0
          ? `No matches for ${pattern} in ${path}.`
          : shown.join("\n") +
            (lines.length > MAX_MATCHES
              ? `\n[Showing the first ${MAX_MATCHES} of ${lines.length} matching lines; use a narrower pattern, path or glob.]`
              : "")) + note;
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
