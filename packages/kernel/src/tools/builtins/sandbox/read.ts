import { posix } from "node:path";
import { IMAGE_MEDIA_TYPES, MEDIA_LIMITS, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { AttachmentsService } from "../../../conversations/attachments.service.js";
import type { ToolView } from "../../../conversations/events.js";
import { ApiError } from "../../../errors.js";
import { type SniffedImage, sniffImage } from "../../../media/image-header.js";
import type {
  BuiltinCallContext,
  BuiltinResult,
  BuiltinTool,
  ToolResultMedia,
} from "../../registry.js";
import { viewPath } from "../../view.js";
import {
  type ConversationFile,
  type ConversationFileDeps,
  findConversationFile,
} from "../conversation-files.js";
import { sizeText } from "../size-text.js";
import { readImageWithVisionModel, type VisionReadDeps } from "../vision/read-image.js";
import {
  checkFilePathShape,
  checkToolPath,
  clip,
  display,
  inToolSandbox,
  looksBinary,
  resolveToolPath,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  sandboxConversationOf,
  sandboxUsable,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";
import { normalizeSandboxPath, recordedFile } from "./file-state.js";

/** 不给 `limit` 时一次读的行数。 */
const DEFAULT_LIMIT = 2000;
/** 单行最多显示的字符数（更长的截断并注明）。 */
const MAX_LINE_CHARS = 2000;
/** 最多读出的字节数（更大的文件只读开头，并说明用 Bash 读其余部分）。 */
export const READ_MAX_BYTES = 10 * 1024 * 1024;

const SPEC: ToolSpec = {
  name: "Read",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["file_path", "file_id"],
  // vision-read design §1.5, verbatim
  description:
    "Read a file and return it to you. Text files come back with line numbers; pass offset and limit " +
    "for part of a long file. Images (PNG, JPEG, GIF, WebP up to 5 MB) are shown to you; if this " +
    "model cannot view images, the organization's vision model reads the image and answers prompt, " +
    "which is a billed model call. Images read are stored with the conversation. Other binary files " +
    "are not shown; use Bash. file_path is an absolute path on the device (under the workspace, " +
    "skills or temporary directory; anywhere in auto mode); file_id is an attachment or artifact id " +
    "of this conversation and needs no device. Do not use it to list directories; use Glob instead. " +
    "Read a file before you write it: Write and Edit fail on a file you have not read, or one changed " +
    "since you read it.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        minLength: 1,
        description:
          "Absolute path of the file on the device, e.g. src/main.py in the workspace directory.",
      },
      file_id: {
        type: "string",
        minLength: 1,
        description: "Id of an attachment or artifact of this conversation (instead of file_path).",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "First line to read (1-based), text files only. Default 1.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: `Maximum number of lines to read, text files only. Default ${DEFAULT_LIMIT}.`,
      },
      prompt: {
        type: "string",
        minLength: 1,
        description:
          "What to look for in an image; used only when the organization's vision model reads it for you.",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

/** The `Read` description (vision-read design §1.5; verbatim). */
export const READ_DESCRIPTION = SPEC.description;

interface ReadInput {
  file_path?: string;
  file_id?: string;
  offset?: number;
  limit?: number;
  prompt?: string;
}

const notFound = (path: string) => `File not found: ${clip(path, 200)}. Check the path with Glob.`;
const isDirectory = (path: string) =>
  `${clip(path, 200)} is a directory; use Glob to list its files.`;
const pastEnd = (offset: number, total: number) =>
  `offset ${offset} is past the end of the file (${total} lines); pass an offset of at most ${total}.`;

/** Neither or both of `file_path` and `file_id` (spec §1.1). */
export const READ_ONE_SOURCE_TEXT =
  "Pass exactly one of file_path (a path on the device) and file_id (an attachment or artifact id).";
/** A `file_path` read without a usable device (spec §1.1; verbatim). */
export const READ_NO_DEVICE_TEXT =
  "This agent has no device; pass file_id to read an attachment or artifact.";
/** A `file_id` that is no file of this conversation or its root. */
export const unknownFileIdText = (id: string): string =>
  `file_id ${clip(id, 100)} is not an attachment or artifact of this conversation; pass the id of one.`;
/** A `file_id` read in a deployment without an object store. */
export const READ_NO_STORAGE_TEXT =
  "File storage is not configured in this deployment, so file_id cannot be read; pass file_path to read a file on the device.";

/** An image over `MEDIA_LIMITS.imageBytes` (spec §1.2; verbatim). */
export const tooLargeText = (name: string, size: number): string =>
  `Image ${name} is ${sizeText(size)}; the limit is 5 MB. Make a smaller copy and Read it.`;
/** A PDF (sniffed `%PDF-`; spec §1.5; verbatim). */
export const pdfText = (size: number): string =>
  `PDF document (${sizeText(size)}). Read does not parse PDFs; images it reads are shown, so pages rendered as images can be read.`;
/** Any other binary file (unchanged). */
const binaryText = (size: number): string => `Binary file (${size} bytes); use Bash to inspect it.`;
/** The first line of an image result (spec §1.2; verbatim). */
export const readImageText = (
  name: string,
  mediaType: string,
  size: number,
  dims: { width?: number; height?: number },
  attachmentId: string,
): string =>
  `Read image ${name} (${mediaType}, ${sizeText(size)}${dimsText(dims)}; file_id ${attachmentId}).`;
/** The fallback answer paragraph (spec §1.2; verbatim). */
export const fallbackAnswerText = (provider: string, model: string, answer: string): string =>
  `${provider}/${model} read the image for you (this model cannot view images):\n${answer}`;
/** An image read but not stored: the per-conversation cap, or no object store. */
export const notStoredText = (
  name: string,
  mediaType: string,
  size: number,
  dims: { width?: number; height?: number },
  reason: "cap" | "storage",
): string =>
  `Read image ${name} (${mediaType}, ${sizeText(size)}${dimsText(dims)}). ${
    reason === "cap"
      ? "This conversation reached its limit for stored images"
      : "File storage is not configured in this deployment"
  }, so the image is not stored: it is not shown and will not stay in the history.`;

const dimsText = (d: { width?: number; height?: number }): string =>
  d.width !== undefined && d.height !== undefined ? `, ${d.width}×${d.height}` : "";

/** The file names a raster image Read can show by its extension (an SVG is text). */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
/** A content type of one of the raster images Read can show (`image/svg+xml` is not one). */
const isRasterType = (contentType: string): boolean =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(
    contentType.split(";")[0]?.trim().toLowerCase() ?? "",
  );
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const isPdf = (data: Uint8Array): boolean => PDF_MAGIC.every((b, i) => data[i] === b);

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
/**
 * What `Read` needs beyond the device (vision-read design §1): the conversation's files by id
 * ({@link findConversationFile}), the stored copy of an image (`storeRead`), the vision read for a
 * model that cannot view images, and whether the model of the step that issued the call can.
 */
export interface ReadFileDeps {
  files: ConversationFileDeps;
  reads: Pick<AttachmentsService, "storeRead">;
  vision: VisionReadDeps;
  /**
   * Whether "the chat model" can view images: the model of the latest `model_call` of the call's
   * run, its capabilities from the model list cache.
   */
  chatModelSeesImages(ctx: BuiltinCallContext): Promise<boolean>;
}

/** The bytes of one read, wherever they came from. */
interface ReadBytes {
  /** The file name shown in an image result (the path's base name, or the stored name). */
  name: string;
  data: Uint8Array;
  /** The file's full size (`data` may be its head only). */
  size: number;
  truncated: boolean;
}

/**
 * The builtin `Read` (read-only; never asks, even when the org's sandbox tool policy is ask): a
 * text file with line numbers, an image shown to the model (or read by the `vision` purpose for a
 * model that cannot view images) and stored with the conversation, a PDF or other binary file
 * named only. `file_path` reads the device; `file_id` an attachment or artifact of the
 * conversation or its root, never entering the device. Listed when a device is usable or (with
 * `deps.read`) an object store is there.
 */
export function sandboxReadTool(deps: SandboxToolDeps): BuiltinTool {
  const sandboxUnavailable = unavailableWhenNoSandbox(deps);
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: async (scope) => {
      const reason = await sandboxUnavailable(scope);
      if (reason === null) return null;
      return deps.read !== undefined && deps.storage.available === true ? null : reason;
    },
    timeoutMs: () => {
      const cfg = deps.config.get();
      return Math.max(sandboxBaseTimeoutMs(cfg), cfg.models.visionTimeoutMs + 10_000);
    },
    async run(raw, ctx) {
      const input = raw as ReadInput;
      if ((input.file_path === undefined) === (input.file_id === undefined)) {
        throw new ToolError(READ_ONE_SOURCE_TEXT);
      }
      if (input.file_id !== undefined) return readById(deps, ctx, input, input.file_id);
      const filePath = input.file_path as string;
      checkFilePathShape(filePath);
      if (!(await sandboxUsable(deps, ctx.orgId, sandboxConversationOf(ctx)))) {
        throw new ToolError(READ_NO_DEVICE_TEXT);
      }
      let path = "";
      const { value, notices } = await inToolSandbox(deps, ctx, async (s) => {
        const { h, p, signal } = s;
        path = checkToolPath(resolveToolPath(filePath, s), s, "file_path");
        const st = await p.stat(h, path, signal);
        if (st === null) throw new ToolError(notFound(path));
        if (st.isDir) throw new ToolError(isDirectory(path));
        // read as before (up to the cap) so the file state is recorded for the read-before-write
        // guard even when the image is too large to show (readImage gives the too-large text)
        const got = await p.readFile(h, path, { maxBytes: READ_MAX_BYTES, signal });
        if (got === null) throw new ToolError(notFound(path));
        return { ...got, size: st.size };
      });
      const name = posix.basename(path);
      const summary = { display: display(`读取 ${clip(path, 180)}`, `Read ${clip(path, 180)}`) };
      const view = (range: { fromLine?: number; toLine?: number }): ToolView => ({
        kind: "read",
        path: viewPath(path),
        ...range,
        file: recordedFile(normalizeSandboxPath(path), value.data, value.size),
      });
      const out = await readContent(deps, ctx, input, {
        name,
        data: value.data,
        size: value.size,
        truncated: value.truncated,
      });
      return {
        ...out,
        content: [{ type: "text", text: withNotices(notices, out.text) }],
        ...summary,
        view: view(out.range),
      };
    },
  };
}

/**
 * A `file_id` read: the file of the conversation or its root, read from the object store (no
 * device). It does not feed the read-before-write guard.
 */
async function readById(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  input: ReadInput,
  id: string,
): Promise<BuiltinResult> {
  const read = deps.read;
  if (read === undefined) throw new ToolError(READ_NO_STORAGE_TEXT);
  let found: ConversationFile | null;
  try {
    found = await findConversationFile(read.files, {
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      rootConversationId: sandboxConversationOf(ctx),
      id,
      // one byte past the cap tells a truncated read
      maxBytes: READ_MAX_BYTES + 1,
      signal: ctx.signal,
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === "storage.unavailable") {
      throw new ToolError(READ_NO_STORAGE_TEXT);
    }
    throw e;
  }
  if (found === null) throw new ToolError(unknownFileIdText(id));
  const summary = {
    display: display(`读取 ${clip(found.name, 180)}`, `Read ${clip(found.name, 180)}`),
  };
  const imageLike = IMAGE_EXTENSION.test(found.name) || isRasterType(found.contentType);
  if (found.size > MEDIA_LIMITS.imageBytes && imageLike) {
    await found.discard();
    return {
      content: [{ type: "text", text: tooLargeText(found.name, found.size) }],
      ...summary,
    };
  }
  let data: Uint8Array;
  try {
    // never more than the cap (an image: its limit), plus one byte that tells a truncated read
    data = await found.open({
      maxBytes: (imageLike ? MEDIA_LIMITS.imageBytes : READ_MAX_BYTES) + 1,
    });
  } catch (e) {
    await found.discard();
    throw e;
  }
  ctx.signal.throwIfAborted();
  const out = await readContent(deps, ctx, input, {
    name: found.name,
    data: data.subarray(0, READ_MAX_BYTES),
    size: Math.max(found.size, data.byteLength),
    truncated: found.size > READ_MAX_BYTES || data.byteLength > READ_MAX_BYTES,
  });
  return {
    ...out,
    content: [{ type: "text", text: out.text }],
    ...summary,
    view: { kind: "read", path: viewPath(found.name), ...out.range },
  };
}

/**
 * The answer for read bytes (spec §1.2, in order): an image (too large, then shown or read by the
 * vision purpose, then stored), a PDF, another binary file, or numbered text lines.
 */
async function readContent(
  deps: SandboxToolDeps,
  ctx: BuiltinCallContext,
  input: ReadInput,
  file: ReadBytes,
): Promise<{
  text: string;
  range: { fromLine?: number; toLine?: number };
  media?: ToolResultMedia[];
}> {
  const { offset = 1, limit = DEFAULT_LIMIT } = input;
  const image = deps.read === undefined ? null : sniffImage(file.data);
  if (image !== null && deps.read !== undefined) {
    return { ...(await readImage(deps.read, ctx, input, file, image)), range: {} };
  }
  if (looksBinary(file.data)) {
    return { text: isPdf(file.data) ? pdfText(file.size) : binaryText(file.size), range: {} };
  }
  if (file.data.byteLength === 0) return { text: "(empty file)", range: {} };
  const decoded = new TextDecoder().decode(file.data);
  let text = numberLines(decoded, offset, limit);
  if (file.truncated) {
    text += `\n[Only the first ${READ_MAX_BYTES} bytes of this ${file.size}-byte file were read; use Bash to read the rest.]`;
  }
  return {
    text,
    // display only: the line range shown on the row
    range: { fromLine: offset, toLine: Math.min(fileLines(decoded).length, offset - 1 + limit) },
  };
}

/**
 * An image (spec §1.2): over the limit gives the too-large text; a chat model that cannot view
 * images gets the `vision` purpose's answer first (its errors are the call's, nothing stored);
 * then the copy is stored on the calling conversation (never the root), outside any transaction,
 * and named in `media`. Past the per-conversation cap, or with no object store, nothing is stored
 * and the result carries no `media`.
 */
async function readImage(
  read: ReadFileDeps,
  ctx: BuiltinCallContext,
  input: ReadInput,
  file: ReadBytes,
  image: SniffedImage,
): Promise<{ text: string; media?: ToolResultMedia[] }> {
  if (file.truncated || file.data.byteLength > MEDIA_LIMITS.imageBytes) {
    return { text: tooLargeText(file.name, file.size) };
  }
  const size = file.data.byteLength;
  let answer: string | null = null;
  if (!(await read.chatModelSeesImages(ctx))) {
    const got = await readImageWithVisionModel(read.vision, ctx, {
      name: file.name,
      mediaType: image.mediaType,
      data: file.data,
      ...(input.prompt !== undefined && { prompt: input.prompt }),
      signal: ctx.signal,
    });
    answer = fallbackAnswerText(got.provider, got.model, got.text);
  }
  const withAnswer = (text: string) => (answer === null ? text : `${text}\n\n${answer}`);
  // storeRead takes no signal: an aborted call stores nothing
  ctx.signal.throwIfAborted();
  let stored: Awaited<ReturnType<AttachmentsService["storeRead"]>> | "storage";
  try {
    stored = await read.reads.storeRead(ctx.orgId, ctx.conversationId, ctx.accountId || null, {
      name: file.name,
      contentType: image.mediaType,
      data: file.data,
    });
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "storage.unavailable")) throw e;
    stored = "storage";
  }
  if (stored === "storage" || !stored.ok) {
    const reason = stored === "storage" ? "storage" : "cap";
    return { text: withAnswer(notStoredText(file.name, image.mediaType, size, image, reason)) };
  }
  return {
    text: withAnswer(
      readImageText(file.name, image.mediaType, stored.size, image, stored.attachmentId),
    ),
    media: [
      {
        attachmentId: stored.attachmentId,
        name: file.name,
        mediaType: image.mediaType,
        size: stored.size,
      },
    ],
  };
}
