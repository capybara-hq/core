import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { BuiltinTool } from "../../registry.js";
import {
  checkWritable,
  clip,
  display,
  inSandbox,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
  withNotices,
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

const isDirectory = (path: string) =>
  `${clip(path, 200)} is a directory; pass the path of a file inside it.`;

/** 内置工具 `sandbox_write`：整文件写入。 */
export function sandboxWriteTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const path = checkWritable((input as WriteInput).path);
      const data = new TextEncoder().encode((input as WriteInput).content);
      const { value: existed, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, path, signal);
        if (st?.isDir) throw new ToolError(isDirectory(path));
        await p.writeFile(h, path, data, signal);
        return st !== null;
      });
      const text = `${existed ? "Overwrote" : "Created"} ${path} (${data.byteLength} bytes).`;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(`写入 ${clip(path, 180)}`, `Wrote ${clip(path, 180)}`),
      };
    },
  };
}
