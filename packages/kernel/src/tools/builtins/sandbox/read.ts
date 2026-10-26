import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import { viewPath } from "../../view.js";
import {
  checkPath,
  clip,
  display,
  inSandbox,
  looksBinary,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

/** 不给 `limit` 时一次读的行数。 */
const DEFAULT_LIMIT = 2000;
/** 单行最多显示的字符数（更长的截断并注明）。 */
const MAX_LINE_CHARS = 2000;
/** 最多读出的字节数（更大的文件只读开头，并说明用 sandbox_bash 读其余部分）。 */
export const READ_MAX_BYTES = 10 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "sandbox_read",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["path"],
  description:
    "Read a text file from this conversation's sandbox, with line numbers. Use it to look at " +
    "source code, data files, logs and files the user attached (under /workspace/attachments). " +
    "Paths are absolute, under /workspace, /skills or /tmp. Lines are numbered from 1; pass " +
    "offset and limit to read part of a long file. Binary files are not shown; use sandbox_bash " +
    "to inspect them. Do not use it to list directories; use sandbox_glob instead.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: 'Absolute path of the file, e.g. "/workspace/src/main.py".',
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "First line to read (1-based). Default 1.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: `Maximum number of lines to read. Default ${DEFAULT_LIMIT}.`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

const notFound = (path: string) =>
  `File not found: ${clip(path, 200)}. Check the path with sandbox_glob.`;
const isDirectory = (path: string) =>
  `${clip(path, 200)} is a directory; use sandbox_glob to list its files.`;
const pastEnd = (offset: number, total: number) =>
  `offset ${offset} is past the end of the file (${total} lines); pass an offset of at most ${total}.`;

/** The file's lines (a final newline does not start another line). */
function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** 按行编号显示 `[offset, offset + limit)`（1 起），结尾注明还有多少行。 */
export function numberLines(text: string, offset: number, limit: number): string {
  const lines = fileLines(text);
  const total = lines.length;
  if (offset > total) throw new ToolError(pastEnd(offset, total));
  const end = Math.min(total, offset - 1 + limit);
  const out: string[] = [];
  for (let i = offset - 1; i < end; i++) {
    const line = lines[i] as string;
    const shown =
      line.length > MAX_LINE_CHARS
        ? `${line.slice(0, MAX_LINE_CHARS)}… [line cut at ${MAX_LINE_CHARS} characters]`
        : line;
    out.push(`${String(i + 1).padStart(6)}\t${shown}`);
  }
  if (end < total) {
    out.push(`[Lines ${offset}–${end} of ${total}; continue with offset=${end + 1}]`);
  }
  return out.join("\n");
}

/** 内置工具 `sandbox_read`：读沙箱里的文本文件（只读，组织策略为 ask 时也不审批）。 */
export function sandboxReadTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const { offset = 1, limit = DEFAULT_LIMIT } = input as ReadInput;
      const path = checkPath((input as ReadInput).path);
      const { value, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        if (st.isDir) throw new ToolError(isDirectory(path));
        const got = await p.readFile(h, path, { maxBytes: READ_MAX_BYTES, signal });
        if (got === null) throw new ToolError(notFound(path));
        return { ...got, size: st.size };
      });
      let text: string;
      // display only: the line range shown on the row
      let range: { fromLine?: number; toLine?: number } = {};
      if (looksBinary(value.data)) {
        text = `Binary file (${value.size} bytes); use sandbox_bash to inspect it (for example file or xxd).`;
      } else if (value.data.byteLength === 0) {
        text = "(empty file)";
      } else {
        const decoded = new TextDecoder().decode(value.data);
        text = numberLines(decoded, offset, limit);
        range = {
          fromLine: offset,
          toLine: Math.min(fileLines(decoded).length, offset - 1 + limit),
        };
        if (value.truncated) {
          text += `\n[Only the first ${READ_MAX_BYTES} bytes of this ${value.size}-byte file were read; use sandbox_bash (e.g. sed -n or tail) for the rest.]`;
        }
      }
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(`读取 ${clip(path, 180)}`, `Read ${clip(path, 180)}`),
        view: { kind: "read", path: viewPath(path), ...range },
      };
    },
  };
}
