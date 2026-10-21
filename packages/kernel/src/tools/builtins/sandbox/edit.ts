import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import {
  checkWritable,
  clip,
  display,
  inSandbox,
  looksBinary,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

/** 可编辑的最大文件（字节）：更大的用 sandbox_bash 处理。 */
const EDIT_MAX_BYTES = 10 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "sandbox_edit",
  description:
    "Edit a text file in this conversation's sandbox by replacing exact text. oldText must match " +
    "the file exactly (including whitespace and indentation) and, unless replaceAll is true, occur " +
    "exactly once; include enough surrounding lines to make it unique. Read the file with " +
    "sandbox_read first. Use sandbox_write to create a file or replace all of it.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: 'Absolute path of the file, e.g. "/workspace/src/app.py".',
      },
      oldText: { type: "string", minLength: 1, description: "The exact text to replace." },
      newText: { type: "string", description: "The replacement text." },
      replaceAll: {
        type: "boolean",
        description: "Replace every occurrence of oldText instead of exactly one. Default false.",
      },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
};

interface EditInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

const notFound = (path: string) =>
  `File not found: ${clip(path, 200)}. Check the path with sandbox_glob, or use sandbox_write to create it.`;
const notText = (path: string) =>
  `${clip(path, 200)} is a directory, a binary file or larger than ${EDIT_MAX_BYTES} bytes; use sandbox_bash to change it.`;
const SAME_TEXT =
  "oldText and newText are the same; pass the text you want to change and its replacement.";
const noMatch = (path: string) =>
  `oldText was not found in ${clip(path, 200)}; call sandbox_read and pass the exact text, including whitespace.`;
const ambiguous = (n: number) =>
  `oldText occurs ${n} times; pass more surrounding text to make it unique, or pass replaceAll: true.`;

/** 出现次数（不重叠）。 */
function occurrences(text: string, sub: string): number {
  let n = 0;
  for (let i = text.indexOf(sub); i !== -1; i = text.indexOf(sub, i + sub.length)) n++;
  return n;
}

/** 内置工具 `sandbox_edit`：按精确文本替换。 */
export function sandboxEditTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const { oldText, newText, replaceAll = false } = input as EditInput;
      const path = checkWritable((input as EditInput).path);
      if (oldText === newText) throw new ToolError(SAME_TEXT);
      const { value: n, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        if (st.isDir) throw new ToolError(notText(path));
        const got = await p.readFile(h, path, { maxBytes: EDIT_MAX_BYTES, signal });
        if (got === null) throw new ToolError(notFound(path));
        if (got.truncated || looksBinary(got.data)) throw new ToolError(notText(path));
        const text = new TextDecoder().decode(got.data);
        const count = occurrences(text, oldText);
        if (count === 0) throw new ToolError(noMatch(path));
        if (count > 1 && !replaceAll) throw new ToolError(ambiguous(count));
        // 用函数形式替换：newText 里的 `$&` 等不被当成替换模式
        const next = replaceAll
          ? text.split(oldText).join(newText)
          : text.replace(oldText, () => newText);
        await p.writeFile(h, path, new TextEncoder().encode(next), signal);
        return replaceAll ? count : 1;
      });
      const text = `Edited ${path}: replaced ${n} occurrence${n === 1 ? "" : "s"}.`;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(`编辑 ${clip(path, 180)}`, `Edited ${clip(path, 180)}`),
      };
    },
  };
}
