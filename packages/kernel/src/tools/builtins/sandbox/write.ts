import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import { lineDiff, TOOL_VIEW_DIFF_MAX_BYTES, viewPath } from "../../view.js";
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

const SPEC: ToolSpec = {
  name: "Write",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["file_path"],
  description:
    "Write a text file in this conversation's sandbox, creating parent directories as needed. " +
    "Each call replaces the whole file (it is created if missing). Use it to create scripts, " +
    "source files and data files. The path is absolute, under /workspace or /tmp (/skills is " +
    "read-only). Read an existing file first; overwriting a file you have not read, or one changed " +
    "since you read it, fails. To change part of an existing file, use Edit instead; to give a file to " +
    "the user, use Deliver.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        minLength: 1,
        description: 'Absolute path of the file, e.g. "/workspace/report.md".',
      },
      content: { type: "string", description: "The complete new content of the file." },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
};

interface WriteInput {
  file_path: string;
  content: string;
}

/**
 * The most of an existing file read to diff against (display only): the size above which a diff
 * has no hunks anyway. A larger or binary file (a NUL anywhere) is overwritten as usual and the
 * result carries no view.
 */
const PREVIOUS_MAX_BYTES = TOOL_VIEW_DIFF_MAX_BYTES;

const vanished = (path: string) =>
  `${clip(path, 200)} disappeared while it was being written; retry the call.`;
const isDirectory = (path: string) =>
  `${clip(path, 200)} is a directory; pass the path of a file inside it.`;

/** 内置工具 `Write`：整文件写入。 */
export function sandboxWriteTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      const path = checkWritable((input as WriteInput).file_path);
      const data = new TextEncoder().encode((input as WriteInput).content);
      const { value, notices } = await inSandbox(deps, ctx, ({ h, p, signal }) =>
        // stat, read the previous content, write: one holder at a time per file
        withPathLease(deps, ctx, path, signal, async (signal) => {
          const st = await p.stat(h, path, signal);
          if (st?.isDir) throw new ToolError(isDirectory(path));
          // the previous content: for the read-before-write check, and the diff on the row (display
          // only: a file too large or binary to diff just leaves the view without hunks)
          let previous: string | null = "";
          if (st !== null) {
            const got = await p.readFile(h, path, { maxBytes: READ_MAX_BYTES, signal });
            if (got === null) throw new ToolError(vanished(path));
            await assertReadAndUnchanged(
              deps,
              ctx.conversationId,
              path,
              fileStateOf(got.data, st.size),
            );
            previous =
              st.size > PREVIOUS_MAX_BYTES ||
              got.truncated ||
              looksBinary(got.data) ||
              got.data.includes(0)
                ? null
                : new TextDecoder().decode(got.data);
          }
          await p.writeFile(h, path, data, signal);
          return { existed: st !== null, previous };
        }),
      );
      const { existed, previous } = value;
      const text = `${existed ? "Overwrote" : "Created"} ${path} (${data.byteLength} bytes).`;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(`写入 ${clip(path, 180)}`, `Wrote ${clip(path, 180)}`),
        // the view always carries the file state: the next Write / Edit of the path needs it
        view: {
          kind: "edit" as const,
          path: viewPath(path),
          created: !existed,
          ...(previous !== null
            ? lineDiff(previous, (input as WriteInput).content)
            : { added: 0, removed: 0, truncated: true, hunks: [] }),
          // over the bytes the next Write / Edit reads back (Read's limit), as Read records it
          file: recordedFile(
            normalizeSandboxPath(path),
            data.subarray(0, READ_MAX_BYTES),
            data.byteLength,
          ),
        },
      };
    },
  };
}
