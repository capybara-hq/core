import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import {
  checkPathShape,
  checkToolPath,
  clip,
  display,
  inSandbox,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  searchTimeoutMs,
  shellQuote,
  syncMarkerMatcher,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

/** The most output entries (lines, files or counts) returned in one call, whatever `head_limit` says. */
const MAX_MATCHES = 500;
/** `head_limit` when the model gives none. */
const DEFAULT_HEAD_LIMIT = 250;
/** 每个匹配行最多显示的字符数。 */
const MAX_LINE_CHARS = 500;
/** grep 输出的上限（字节）。 */
const MAX_GREP_BYTES = 4 * 1024 * 1024;

const MODES = ["content", "files_with_matches", "count"] as const;
type OutputMode = (typeof MODES)[number];

const SPEC: ToolSpec = {
  name: "Grep",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["pattern", "path"],
  description:
    "Search file contents in this conversation's sandbox with a regular expression (POSIX " +
    "extended, as grep -E). Use it to find where something is defined or mentioned. Searches path " +
    "(a file, or a directory recursively; default: the workspace directory), skipping binary files; glob limits " +
    'the files searched by name, e.g. "*.py". output_mode picks what comes back: ' +
    '"files_with_matches" (default) lists the paths of files that match, "content" returns the ' +
    "matching lines as <path>:<line>:<text> (with -A, -B or -C lines of context around them), " +
    '"count" returns <path>:<number of matching lines> per file. -n (line numbers) and the context ' +
    "options apply only to content mode. head_limit caps the entries returned (default 250; " +
    "0 = up to 500); pass offset to skip entries and page through more. To find files by " +
    "name, use Glob. In auto mode paths may be anywhere on the machine; writes outside the workspace need the user's approval.",
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
        description: "Absolute file or directory to search. Default: the workspace directory.",
      },
      glob: {
        type: "string",
        minLength: 1,
        description: 'Only search files whose name matches this glob, e.g. "*.md".',
      },
      "-i": { type: "boolean", description: "Case-insensitive match. Default false." },
      output_mode: {
        type: "string",
        enum: [...MODES],
        description:
          'What to return: "files_with_matches" (file paths, default), "content" (matching lines) or "count" (matching lines per file).',
      },
      "-n": {
        type: "boolean",
        description: "Show line numbers in content mode. Default true.",
      },
      "-A": {
        type: "integer",
        minimum: 0,
        description: "Lines of context after each match (content mode).",
      },
      "-B": {
        type: "integer",
        minimum: 0,
        description: "Lines of context before each match (content mode).",
      },
      "-C": {
        type: "integer",
        minimum: 0,
        description: "Lines of context before and after each match (content mode).",
      },
      head_limit: {
        type: "integer",
        minimum: 0,
        description: `Return at most this many entries (lines, files or counts, by mode). Default ${DEFAULT_HEAD_LIMIT}; 0 = up to ${MAX_MATCHES}.`,
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Skip this many entries before returning (for paging). Default 0.",
      },
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
  "-i"?: boolean;
  output_mode?: OutputMode;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  head_limit?: number;
  offset?: number;
}

const notFound = (path: string) => `${clip(path, 200)} does not exist; check the path with Glob.`;
const failed = (stderr: string) =>
  `grep failed: ${clip(stderr, 300)}. Check the pattern (POSIX extended regular expression) and retry.`;
const GREP_TIMEOUT = "The search did not finish in time; pass a narrower path or a glob and retry.";

/**
 * Parses the output of `grep -H --null` (with `-n` when `numbered`): each entry is
 * `<file name>\0<line number>:<line>\n` (the file name may contain newlines, the line does not).
 * Returns `<absolute path>:<line number>:<line>`; context lines (`<line number>-<line>`, only with
 * `-A/-B/-C`) become `<absolute path>-<line number>-<line>`, and the `--` group separator is kept.
 * A newline in a file name shows as `\n`. An incomplete last entry (truncated output) is dropped.
 */
export function parseGrepNull(stdout: string, base: string, numbered = true): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    if (stdout.startsWith("--\n", pos)) {
      out.push("--");
      pos += 3;
      continue;
    }
    const nul = stdout.indexOf("\0", pos);
    if (nul === -1) break;
    const nl = stdout.indexOf("\n", nul);
    if (nl === -1) break;
    const raw = stdout.slice(pos, nul);
    const name = (raw.startsWith("./") ? raw.slice(2) : raw).replace(/\n/g, "\\n");
    const rest = stdout.slice(nul + 1, nl);
    out.push(
      numbered && /^\d+-/.test(rest) ? `${base}/${name}-${rest}` : `${base}/${name}:${rest}`,
    );
    pos = nl + 1;
  }
  return out;
}

const displayName = (raw: string): string =>
  (raw.startsWith("./") ? raw.slice(2) : raw).replace(/\n/g, "\\n");

/** `grep -l --null` output: the matching files, each followed by NUL. */
function parseFileList(stdout: string, base: string): string[] {
  const parts = stdout.split("\0");
  // the last part is empty, or an incomplete name when the output was truncated: dropped
  parts.pop();
  return parts.filter((n) => n !== "").map((n) => `${base}/${displayName(n)}`);
}

/**
 * `grep -c` output as `<path>:<count>` for the files with at least one matching line. GNU grep
 * with `--null` writes `<file>\0<count>\n`; other implementations write `<file>:<count>`.
 */
function parseCounts(stdout: string, base: string): string[] {
  const out: string[] = [];
  if (stdout.includes("\0")) {
    for (const l of parseGrepNull(stdout, base, false)) {
      if (!l.endsWith(":0")) out.push(l);
    }
    return out;
  }
  for (const line of stdout.split("\n")) {
    const i = line.lastIndexOf(":");
    if (i <= 0) continue;
    const count = line.slice(i + 1);
    if (count === "0" || !/^\d+$/.test(count)) continue;
    out.push(`${base}/${displayName(line.slice(0, i))}:${count}`);
  }
  return out;
}

/** 内置工具 `Grep`：按正则搜文件内容（只读）。 */
export function sandboxGrepTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      const startedAt = Date.now();
      const g = input as GrepInput;
      const { pattern, glob } = g;
      const mode: OutputMode = g.output_mode ?? "files_with_matches";
      const numbered = g["-n"] ?? true;
      if (g.path !== undefined) checkPathShape(g.path);
      let path = "";
      const { value, notices } = await inSandbox(deps, ctx, async (s) => {
        const { h, p, signal } = s;
        path = checkToolPath(g.path ?? s.roots.workspace, s);
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        // 在目标所在目录里搜相对路径，输出再拼回绝对路径（命令里不出现沙箱绝对路径）
        const slash = path.lastIndexOf("/");
        const cwd = st.isDir ? path : path.slice(0, slash) || "/";
        const target = st.isDir ? "." : path.slice(slash + 1);
        const base = cwd === "/" ? "" : cwd;
        // GNU grep options (`-l`, `-c`, `-n`, `-A/-B/-C`, `--null`): the sandbox images are Debian
        const modeFlags =
          mode === "files_with_matches"
            ? ["-rlIE", "--null"]
            : mode === "count"
              ? ["-rcHIE", "--null"]
              : [numbered ? "-rnHIE" : "-rHIE", "--null"];
        const context =
          mode === "content"
            ? (["-A", "-B", "-C"] as const).flatMap((f) =>
                g[f] !== undefined ? [f, String(g[f])] : [],
              )
            : [];
        const command = [
          // --null：文件名后跟 NUL 而不是 `:`，文件名里有换行或冒号也能解析
          "grep",
          ...modeFlags,
          ...(g["-i"] === true ? ["-i"] : []),
          ...context,
          ...(glob !== undefined ? [`--include=${shellQuote(glob)}`] : []),
          "-e",
          shellQuote(pattern),
          "--",
          shellQuote(target),
        ].join(" ");
        const r = await p.exec(h, {
          command,
          cwd,
          timeoutMs: searchTimeoutMs(deps.config.get(), startedAt, Date.now(), ctx.runDeadline),
          maxOutputBytes: MAX_GREP_BYTES,
          signal,
        });
        if (r.timedOut || r.exitCode === null) throw new ToolError(GREP_TIMEOUT);
        if (r.exitCode === 1) return { entries: [], warning: null };
        const all =
          mode === "files_with_matches"
            ? parseFileList(r.stdout, base)
            : mode === "count"
              ? parseCounts(r.stdout, base)
              : parseGrepNull(r.stdout, base, numbered);
        const isMarker = syncMarkerMatcher(s.roots);
        const entries = all.filter((l) => !isMarker(l));
        // 退出码 2 = 有错误（如个别文件不可读）；有输出时照常返回（可能为空：只匹配到隐藏的标记文件）并附上说明
        if (r.exitCode !== 0 && all.length === 0) throw new ToolError(failed(r.stderr));
        const warning = r.exitCode !== 0 ? clip(r.stderr, 300) : null;
        return { entries, warning };
      });
      const { entries, warning } = value;
      const total = entries.length;
      const offset = g.offset ?? 0;
      const headLimit = g.head_limit === undefined ? DEFAULT_HEAD_LIMIT : g.head_limit;
      const limit = headLimit === 0 ? MAX_MATCHES : Math.min(headLimit, MAX_MATCHES);
      const page = entries.slice(offset, offset + limit);
      const shown = page.map((l) =>
        l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l,
      );
      const note = warning !== null ? `\n[grep also reported errors: ${warning}]` : "";
      let text: string;
      if (total === 0) {
        text = `No matches for ${pattern} in ${path}.${note}`;
      } else if (page.length === 0) {
        text = `No more results (${total} total).${note}`;
      } else {
        const end = offset + page.length;
        text =
          shown.join("\n") +
          (end < total
            ? `\n[Showing entries ${offset + 1}–${end} of ${total}; pass offset=${end} to continue, or use a narrower pattern, path or glob.]`
            : "") +
          note;
      }
      const n = total;
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
