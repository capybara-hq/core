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
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";
import { compileGlob, GlobPatternError } from "./glob-match.js";

/** 最多列出的文件数。 */
const MAX_RESULTS = 1000;
/** `find` 输出的上限（字节）。 */
const MAX_FIND_BYTES = 8 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "sandbox_glob",
  description:
    "Find files by name pattern in this conversation's sandbox. Use it to list files and to " +
    'locate files by name, e.g. pattern "**/*.py" for all Python files. The pattern is matched ' +
    "against paths relative to path (default /workspace): * matches within one directory, ** " +
    "matches across directories, ? matches one character, {a,b} matches either. Returns absolute " +
    "paths sorted by name, up to 1000. To search file contents, use sandbox_grep.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description: 'Glob pattern relative to path, e.g. "**/*.csv" or "src/*.ts".',
      },
      path: {
        type: "string",
        minLength: 1,
        description: "Absolute directory to search in. Default /workspace.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

interface GlobInput {
  pattern: string;
  path?: string;
}

const ABSOLUTE_PATTERN =
  'The pattern must be relative to path; pass the directory in path and a relative pattern such as "**/*.py".';
const notDirectory = (path: string) =>
  `${clip(path, 200)} is not a directory; pass an existing directory in path (default /workspace).`;
const FIND_FAILED =
  "Listing files did not finish in time; pass a narrower path or pattern and retry.";

/** 内置工具 `sandbox_glob`：按文件名模式找文件（只读）。 */
export function sandboxGlobTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const startedAt = Date.now();
      const { pattern } = input as GlobInput;
      if (pattern.startsWith("/")) throw new ToolError(ABSOLUTE_PATTERN);
      const dir = checkPath((input as GlobInput).path ?? "/workspace");
      let matches: (rel: string) => boolean;
      try {
        matches = compileGlob(pattern);
      } catch (e) {
        if (!(e instanceof GlobPatternError)) throw e;
        throw new ToolError(
          `Invalid glob pattern: ${e.message}; pass a simpler pattern (fewer wildcards and braces) and retry.`,
        );
      }
      const { value: files, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, dir, signal);
        if (!st?.isDir) throw new ToolError(notDirectory(dir));
        const r = await p.exec(h, {
          command: "find . -type f -print0",
          cwd: dir,
          timeoutMs: searchTimeoutMs(deps.config(), startedAt, Date.now(), ctx.runDeadline),
          maxOutputBytes: MAX_FIND_BYTES,
          signal,
        });
        if (r.timedOut || r.exitCode === null) throw new ToolError(FIND_FAILED);
        // -print0：文件名里可能有换行，按 NUL 切分；最后一项（截断时不完整）丢掉
        const names = r.stdout.split("\0");
        names.pop();
        if (r.truncated) names.pop();
        const base = dir === "/" ? "" : dir;
        return (
          names
            .filter((l) => l.startsWith("./"))
            .map((l) => l.slice(2))
            .filter((rel) => matches(rel))
            .map((rel) => `${base}/${rel}`)
            .filter((abs) => abs !== SYNC_MARKER)
            .sort()
            // 文件名里的换行显示为 `\n`（与 sandbox_grep 一致），一行一个文件
            .map((abs) => abs.replace(/\n/g, "\\n"))
        );
      });
      const shown = files.slice(0, MAX_RESULTS);
      const text =
        files.length === 0
          ? `No files match ${pattern} under ${dir}.`
          : shown.join("\n") +
            (files.length > MAX_RESULTS
              ? `\n[Showing the first ${MAX_RESULTS} of ${files.length} files; use a narrower pattern.]`
              : "");
      const n = files.length;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(
          `查找文件 ${clip(pattern, 120)}（${n} 个）`,
          `Found ${n} file${n === 1 ? "" : "s"} matching ${clip(pattern, 120)}`,
        ),
      };
    },
  };
}
