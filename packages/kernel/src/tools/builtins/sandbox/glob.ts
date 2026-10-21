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
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

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

const REGEX_SPECIAL = /[.+^$()|\\]/;

/**
 * glob → 正则（整串匹配，路径分隔符 `/`）：`**` 跨目录（`**​/` 也匹配零层），`*` 不跨 `/`，`?` 一个字符，
 * `{a,b}` 二选一，`[...]` / `[!...]` 字符类；其余字符按字面。
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) {
      re += "|";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) {
        re += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (REGEX_SPECIAL.test(c) || c === "}" || c === "]") {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  while (braces-- > 0) re += ")";
  return new RegExp(`^${re}$`);
}

/** 内置工具 `sandbox_glob`：按文件名模式找文件（只读）。 */
export function sandboxGlobTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const { pattern } = input as GlobInput;
      if (pattern.startsWith("/")) throw new ToolError(ABSOLUTE_PATTERN);
      const dir = checkPath((input as GlobInput).path ?? "/workspace");
      let re: RegExp;
      try {
        re = globToRegExp(pattern);
      } catch {
        throw new ToolError(
          `Invalid glob pattern "${clip(pattern, 200)}"; check the brackets and braces and retry.`,
        );
      }
      const { value: files, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, dir, signal);
        if (!st?.isDir) throw new ToolError(notDirectory(dir));
        const r = await p.exec(h, {
          command: "find . -type f",
          cwd: dir,
          timeoutMs: deps.config().tools.timeoutMs,
          maxOutputBytes: MAX_FIND_BYTES,
          signal,
        });
        if (r.timedOut || r.exitCode === null) throw new ToolError(FIND_FAILED);
        const lines = r.stdout.split("\n").filter((l) => l.startsWith("./"));
        // 输出被截断时最后一行可能不完整
        if (r.truncated) lines.pop();
        const base = dir === "/" ? "" : dir;
        return lines
          .map((l) => l.slice(2))
          .filter((rel) => re.test(rel))
          .map((rel) => `${base}/${rel}`)
          .filter((abs) => abs !== SYNC_MARKER)
          .sort();
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
