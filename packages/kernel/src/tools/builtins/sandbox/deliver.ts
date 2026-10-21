import { randomUUID } from "node:crypto";
import {
  hasControlChars,
  MEDIA_NAME_MAX_CHARS,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../../../errors.js";
import type { BuiltinTool } from "../../registry.js";
import {
  checkPath,
  clip,
  display,
  inSandbox,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

const SPEC: ToolSpec = {
  name: "sandbox_deliver",
  description:
    "Deliver a file from this conversation's sandbox to the user as a downloadable artifact. Use " +
    "it when the user should receive a file you produced (a report, chart, spreadsheet, archive " +
    "and so on); files that stay in the sandbox are not visible to the user. Delivers one file " +
    "per call; archive a directory first (e.g. zip -r with sandbox_bash). The file size is " +
    "limited (100 MB by default). Do not use it for intermediate files the user does not need.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: 'Absolute path of the file in the sandbox, e.g. "/workspace/out/report.pdf".',
      },
      name: {
        type: "string",
        minLength: 1,
        maxLength: MEDIA_NAME_MAX_CHARS,
        description:
          'File name shown to the user, e.g. "Q3 report.pdf". Default: the file name in path.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

interface DeliverInput {
  path: string;
  name?: string;
}

/** 按扩展名猜的内容类型（下载一律 `attachment`，类型只用于显示与预览判断）。 */
const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  sql: "application/sql",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wav: "audio/wav",
};

export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const notFound = (path: string) =>
  `File not found: ${clip(path, 200)}. Check the path with sandbox_glob.`;
const isDirectory = (path: string) =>
  `${clip(path, 200)} is a directory; deliver one file, e.g. archive the directory first with sandbox_bash (zip -r) and retry.`;
const tooLarge = (path: string, size: number, max: number) =>
  `File ${clip(path, 200)} is ${size} bytes, over the delivery limit of ${max} bytes; compress or split it with sandbox_bash and retry.`;
const BAD_NAME =
  "name must not contain control characters, / or \\; pass a plain file name such as report.pdf.";
const NO_STORAGE =
  "File storage is not configured in this deployment, so files cannot be delivered; ask an administrator, or provide the result in your reply instead.";

/** 内置工具 `sandbox_deliver`：把沙箱里的文件存进对象存储，写 `artifact_created`，用户可下载。 */
export function sandboxDeliverTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => 2 * sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx) {
      const path = checkPath((input as DeliverInput).path);
      const given = (input as DeliverInput).name?.trim();
      if (given !== undefined && (given === "" || hasControlChars(given) || /[/\\]/.test(given))) {
        throw new ToolError(BAD_NAME);
      }
      const name =
        given ?? [...path.slice(path.lastIndexOf("/") + 1)].slice(-MEDIA_NAME_MAX_CHARS).join("");
      const max = deps.config().sandbox.deliverMaxBytes;
      const { value: data, notices } = await inSandbox(deps, ctx, async ({ h, p, signal }) => {
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        if (st.isDir) throw new ToolError(isDirectory(path));
        if (st.size > max) throw new ToolError(tooLarge(path, st.size, max));
        const got = await p.readFile(h, path, { maxBytes: max, signal });
        if (got === null) throw new ToolError(notFound(path));
        // 读的过程中文件变大了
        if (got.truncated) throw new ToolError(tooLarge(path, max + 1, max));
        return got.data;
      });
      // 上传在沙箱锁之外进行：不占着沙箱
      const artifactId = randomUUID();
      const objectKey = `artifacts/${ctx.conversationId}/${artifactId}`;
      const contentType = contentTypeFor(name);
      try {
        await deps.storage.kernel(ctx.orgId).put(objectKey, data, {
          contentType,
          size: data.byteLength,
          signal: ctx.signal,
        });
      } catch (e) {
        if (e instanceof ApiError && e.code === "storage.unavailable") {
          throw new ToolError(NO_STORAGE);
        }
        throw e;
      }
      await deps.eventLog.append(ctx.conversationId, [
        {
          type: "artifact_created",
          ...(ctx.runId !== undefined && { runId: ctx.runId }),
          payload: {
            artifactId,
            name,
            contentType,
            size: data.byteLength,
            objectKey,
            sourcePath: path,
            callId: ctx.callId,
          },
        },
      ]);
      const text = `Delivered ${name} (${data.byteLength} bytes, ${contentType}) to the user as artifact ${artifactId}; the user can download it from the conversation.`;
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(`交付文件 ${clip(name, 180)}`, `Delivered ${clip(name, 180)}`),
      };
    },
  };
}
