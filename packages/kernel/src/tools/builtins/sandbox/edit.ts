import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import { lineDiff, viewPath } from "../../view.js";
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
  withPathLease,
} from "./common.js";
import {
  assertReadAndUnchanged,
  fileStateOf,
  normalizeSandboxPath,
  recordedFile,
} from "./file-state.js";
import { READ_MAX_BYTES } from "./read.js";

/** 可编辑的最大文件（字节）：更大的用 Bash 处理。 */
const EDIT_MAX_BYTES = 10 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "Edit",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["file_path"],
  description:
    "Edit a text file in this conversation's sandbox by replacing exact text. old_string must match " +
    "the file exactly (including whitespace and indentation) and, unless replace_all is true, occur " +
    "exactly once; include enough surrounding lines to make it unique. Read the file first; " +
    "editing a file you have not read, or one changed since you read it, fails. Use Write to create a file or replace all of it.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        minLength: 1,
        description: 'Absolute path of the file, e.g. "/workspace/src/app.py".',
      },
      old_string: { type: "string", minLength: 1, description: "The exact text to replace." },
      new_string: { type: "string", description: "The replacement text." },
      replace_all: {
        type: "boolean",
        description:
          "Replace every occurrence of old_string instead of exactly one. Default false.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const notFound = (path: string) =>
  `File not found: ${clip(path, 200)}. Check the path with Glob, or use Write to create it.`;
const notText = (path: string) =>
  `${clip(path, 200)} is a directory, a binary file or larger than ${EDIT_MAX_BYTES} bytes; use Bash to change it.`;
const SAME_TEXT =
  "old_string and new_string are the same; pass the text you want to change and its replacement.";
const noMatch = (path: string) =>
  `old_string was not found in ${clip(path, 200)}; call Read and pass the exact text, including whitespace.`;
const ambiguous = (n: number) =>
  `old_string occurs ${n} times; pass more surrounding text to make it unique, or pass replace_all: true.`;

/** 出现次数（不重叠）。 */
function occurrences(text: string, sub: string): number {
  let n = 0;
  for (let i = text.indexOf(sub); i !== -1; i = text.indexOf(sub, i + sub.length)) n++;
  return n;
}

/** 内置工具 `Edit`：按精确文本替换。 */
export function sandboxEditTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      const { old_string, new_string, replace_all = false } = input as EditInput;
      const path = checkWritable((input as EditInput).file_path);
      if (old_string === new_string) throw new ToolError(SAME_TEXT);
      const { value: edit, notices } = await inSandbox(
        deps,
        ctx,
        ({ environmentId, h, p, signal }) =>
          // read, replace, write: one holder at a time per file
          withPathLease(deps, { environmentId }, path, signal, async (signal) => {
            const st = await p.stat(h, path, signal);
            if (st === null) throw new ToolError(notFound(path));
            if (st.isDir) throw new ToolError(notText(path));
            const got = await p.readFile(h, path, { maxBytes: EDIT_MAX_BYTES, signal });
            if (got === null) throw new ToolError(notFound(path));
            if (got.truncated || looksBinary(got.data)) throw new ToolError(notText(path));
            await assertReadAndUnchanged(
              deps,
              ctx.conversationId,
              path,
              fileStateOf(got.data, st.size),
            );
            const text = new TextDecoder().decode(got.data);
            const count = occurrences(text, old_string);
            if (count === 0) throw new ToolError(noMatch(path));
            if (count > 1 && !replace_all) throw new ToolError(ambiguous(count));
            // 用函数形式替换：new_string 里的 `$&` 等不被当成替换模式
            const next = replace_all
              ? text.split(old_string).join(new_string)
              : text.replace(old_string, () => new_string);
            const nextBytes = new TextEncoder().encode(next);
            await p.writeFile(h, path, nextBytes, signal);
            return {
              n: replace_all ? count : 1,
              before: text,
              after: next,
              // over the bytes the next Write / Edit reads back (Read's limit), as Read records it
              file: recordedFile(
                normalizeSandboxPath(path),
                nextBytes.subarray(0, READ_MAX_BYTES),
                nextBytes.byteLength,
              ),
            };
          }),
      );
      const { n } = edit;
      const text = `Edited ${path}: replaced ${n} occurrence${n === 1 ? "" : "s"}.`;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(`编辑 ${clip(path, 180)}`, `Edited ${clip(path, 180)}`),
        // display only: the diff on the row
        view: {
          kind: "edit",
          path: viewPath(path),
          created: false,
          ...lineDiff(edit.before, edit.after),
          file: edit.file,
        },
      };
    },
  };
}
