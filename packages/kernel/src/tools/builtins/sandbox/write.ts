import { isSandboxGoneError, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
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

const SPEC: ToolSpec = {
  name: "sandbox_write",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["path"],
  description:
    "Write a text file in this conversation's sandbox, creating parent directories as needed. " +
    "Each call replaces the whole file (it is created if missing). Use it to create scripts, " +
    "source files and data files. The path is absolute, under /workspace or /tmp (/skills is " +
    "read-only). To change part of an existing file, use sandbox_edit instead; to give a file to " +
    "the user, use sandbox_deliver.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: 'Absolute path of the file, e.g. "/workspace/report.md".',
      },
      content: { type: "string", description: "The complete new content of the file." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

interface WriteInput {
  path: string;
  content: string;
}

/**
 * The most of an existing file read to diff against (display only): the size above which a diff
 * has no hunks anyway. A larger or binary file (a NUL anywhere) is overwritten as usual and the
 * result carries no view.
 */
const PREVIOUS_MAX_BYTES = TOOL_VIEW_DIFF_MAX_BYTES;

const isDirectory = (path: string) =>
  `${clip(path, 200)} is a directory; pass the path of a file inside it.`;

/** 内置工具 `sandbox_write`：整文件写入。 */
export function sandboxWriteTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      const path = checkWritable((input as WriteInput).path);
      const data = new TextEncoder().encode((input as WriteInput).content);
      const { value, notices } = await inSandbox(deps, ctx, ({ h, p, signal }) =>
        // stat, read the previous content, write: one holder at a time per file
        withPathLease(deps, ctx, path, signal, async (signal) => {
          const st = await p.stat(h, path, signal);
          if (st?.isDir) throw new ToolError(isDirectory(path));
          // the previous content, for the diff on the row (display only: a failure here never
          // fails the write, the result just carries no view)
          let previous: string | null = "";
          if (st !== null) {
            try {
              const got =
                st.size <= PREVIOUS_MAX_BYTES
                  ? await p.readFile(h, path, { maxBytes: PREVIOUS_MAX_BYTES, signal })
                  : null;
              previous =
                got === null || got.truncated || looksBinary(got.data) || got.data.includes(0)
                  ? null
                  : new TextDecoder().decode(got.data);
            } catch (e) {
              if (signal.aborted || isSandboxGoneError(e)) throw e;
              previous = null;
            }
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
        ...(previous !== null && {
          view: {
            kind: "edit" as const,
            path: viewPath(path),
            created: !existed,
            ...lineDiff(previous, (input as WriteInput).content),
          },
        }),
      };
    },
  };
}
