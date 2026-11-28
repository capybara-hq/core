import {
  MEDIA_NAME_MAX_CHARS,
  ToolError,
  type ToolResult,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { isValidArtifactName } from "../../../conversations/events.js";
import { ApiError } from "../../../errors.js";
import type { BuiltinCallContext, BuiltinTool } from "../../registry.js";
import {
  NO_STORAGE,
  NO_STORAGE_REASON,
  REPEAT_TEXT,
  type StoredArtifact,
  storeArtifacts,
} from "../artifacts.js";
import { type ConversationFile, findConversationFile } from "../conversation-files.js";
import {
  checkPathShape,
  checkToolPath,
  clip,
  display,
  inToolSandbox,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  sandboxConversationOf,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

const SPEC: ToolSpec = {
  name: "Deliver",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["file_path", "file_id"],
  description:
    "Deliver a file to the user as a downloadable artifact. Use it when the user should receive a " +
    "file you produced (a report, chart, spreadsheet, archive and so on); files that stay on the " +
    "device are not visible to the user, and images in tool results are shown to you, not " +
    "delivered to the user. Pass file_path for a file on the device, or file_id for a file id of " +
    "this conversation, such as the file_id an image in a tool result names (needs no device). Each call delivers only that one file, so a directory must first be packed into " +
    "one archive. The file size is limited (100 MB by default). Do not use it for intermediate " +
    "files the user does not need. An HTML file is shown on its own: files it references by " +
    "relative path are not delivered with it, so inline or embed them.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        minLength: 1,
        description:
          "Absolute path of the file on the device, e.g. out/report.pdf in the workspace directory.",
      },
      file_id: {
        type: "string",
        minLength: 1,
        description:
          "Instead of file_path: a file id of this conversation (a file the user sent, a delivered file, or the file_id of an image in a tool result).",
      },
      name: {
        type: "string",
        minLength: 1,
        maxLength: MEDIA_NAME_MAX_CHARS,
        description:
          'File name shown to the user, e.g. "Q3 report.pdf". Default: the file name in file_path, or the stored name of file_id.',
      },
    },
    additionalProperties: false,
  },
};

interface DeliverInput {
  file_path?: string;
  file_id?: string;
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
  tsx: "text/plain",
  jsx: "text/plain",
  mjs: "text/javascript",
  cjs: "text/javascript",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
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

/** The content type of a file name by its extension (Deliver, skill files); unknown: octet-stream. */
export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const notFound = (path: string) => `File not found: ${clip(path, 200)}. Check the path with Glob.`;
const isDirectory = (path: string) =>
  `${clip(path, 200)} is a directory; pass one file (pack the directory into one archive first).`;
const tooLarge = (path: string, size: number, max: number) =>
  `File ${clip(path, 200)} is ${size} bytes, over the delivery limit of ${max} bytes; compress or split it with Bash and retry.`;
/** Neither or both of `file_path` and `file_id`. */
export const DELIVER_ONE_SOURCE_TEXT =
  "Pass exactly one of file_path (a path on the device) and file_id (an attachment or artifact id).";
/** A `file_id` that is no file of this conversation or its root. */
const unknownFileId = (id: string) =>
  `file_id ${clip(id, 100)} is not an attachment or artifact of this conversation; pass the id of one.`;
const BAD_NAME =
  "name must not contain control characters, / or \\; pass a plain file name such as report.pdf.";
/** 默认产物名：路径的文件名部分，过长时保留末尾（扩展名）截到 255 个 UTF-16 单元以内。 */
function defaultName(path: string): string {
  const cps = [...path.slice(path.lastIndexOf("/") + 1)];
  let out = "";
  for (let i = cps.length - 1; i >= 0; i--) {
    const next = (cps[i] as string) + out;
    if (next.length > MEDIA_NAME_MAX_CHARS) break;
    out = next;
  }
  return isValidArtifactName(out) ? out : "artifact";
}

/** 内置工具 `Deliver`：把沙箱里的文件存进对象存储，写 `artifact_created`，用户可下载。 */
export function sandboxDeliverTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    // nothing is delivered without an object store; without a usable device only file_id is
    // (listed when the conversation's files can be read by id)
    unavailable: async (ctx) => {
      if (!deps.storage.available) {
        return (await unavailableWhenNoSandbox(deps)(ctx)) ?? NO_STORAGE_REASON;
      }
      if (deps.read !== undefined) return null;
      return unavailableWhenNoSandbox(deps)(ctx);
    },
    timeoutMs: () => 2 * sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      // 存储在调用前就核对：不为一个交付不了的文件去 stat / 读沙箱
      if (!deps.storage.available) throw new ToolError(NO_STORAGE);
      const given = (input as DeliverInput).name?.trim();
      // 与 artifact_created 的 schema 同一规则，在上传前检查（不合法的名字不会在写事件时才失败）
      if (given !== undefined && (!isValidArtifactName(given) || /[/\\]/.test(given))) {
        throw new ToolError(BAD_NAME);
      }
      const max = deps.config.get().sandbox.deliverMaxBytes;
      const { file_path: filePath, file_id: fileId } = input as DeliverInput;
      if ((filePath === undefined) === (fileId === undefined)) {
        throw new ToolError(DELIVER_ONE_SOURCE_TEXT);
      }
      if (fileId !== undefined) return deliverById(deps, ctx, fileId, given, max);
      checkPathShape(filePath as string, "file_path");
      let path = "";
      const { value: data, notices } = await inToolSandbox(deps, ctx, async (s) => {
        const { h, p, signal } = s;
        // bounded as the other file tools are: the admitted scope (a project file outside the
        // workspace too)
        path = checkToolPath(filePath as string, "file_path");
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        if (st.isDir) throw new ToolError(isDirectory(path));
        if (st.size > max) throw new ToolError(tooLarge(path, st.size, max));
        const got = await p.readFile(h, path, { maxBytes: max, signal });
        if (got === null) throw new ToolError(notFound(path));
        // the file grew while it was read
        if (got.truncated) throw new ToolError(tooLarge(path, max + 1, max));
        return got.data;
      });
      const name = given ?? defaultName(path);
      const contentType = contentTypeFor(name);
      return deliverBytes(deps, ctx, { name, contentType, data, sourcePath: path }, notices);
    },
  };
}

/**
 * A `file_id` delivery: a file of the conversation or its root ({@link findConversationFile}: a
 * library file they refer to, or a `read` copy such as a tool result's image) read from the object
 * store, no device; the artifact's source path is `file_id/<id>`.
 */
async function deliverById(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  id: string,
  given: string | undefined,
  max: number,
): Promise<ToolResult> {
  if (deps.read === undefined) throw new ToolError(NO_STORAGE);
  let found: ConversationFile | null;
  try {
    found = await findConversationFile(deps.read.files, {
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      rootConversationId: sandboxConversationOf(ctx),
      id,
      maxBytes: max + 1,
      signal: ctx.signal,
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === "storage.unavailable") throw new ToolError(NO_STORAGE);
    throw e;
  }
  if (found === null) throw new ToolError(unknownFileId(id));
  const name = given ?? (isValidArtifactName(found.name) ? found.name : defaultName(found.name));
  if (found.size > max) {
    await found.discard();
    throw new ToolError(tooLarge(name, found.size, max));
  }
  const data = await found.open({ maxBytes: max + 1 });
  if (data.byteLength > max) throw new ToolError(tooLarge(name, data.byteLength, max));
  ctx.signal.throwIfAborted();
  const contentType =
    given === undefined && found.contentType ? found.contentType : contentTypeFor(name);
  return deliverBytes(
    deps,
    ctx,
    { name, contentType, data, sourcePath: `file_id/${found.id}` },
    [],
  );
}

/** Stores one file as an artifact and answers with what the user received (or the repeat). */
async function deliverBytes(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  file: { name: string; contentType: string; data: Uint8Array; sourcePath: string },
  notices: readonly string[],
): Promise<ToolResult> {
  const { name, contentType, data } = file;
  // uploaded outside the device lock: the device is not held meanwhile
  const [stored] = await storeArtifacts(deps, ctx, [file]);
  const { artifactId, repeatOf } = stored as StoredArtifact;
  if (repeatOf !== undefined) {
    return {
      content: [{ type: "text", text: withNotices(notices, REPEAT_TEXT(name, repeatOf)) }],
      display: display(
        `已交付过（内容相同）${clip(name, 160)}`,
        `Already delivered (same content): ${clip(name, 160)}`,
      ),
    };
  }
  const text = `Delivered ${name} (${data.byteLength} bytes, ${contentType}) to the user as artifact ${artifactId}; the user can download it from the conversation.`;
  return {
    content: [{ type: "text", text: withNotices(notices, text) }],
    display: display(`交付文件 ${clip(name, 180)}`, `Delivered ${clip(name, 180)}`),
  };
}
