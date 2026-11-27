import { createHash } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import sharp from "sharp";
import { z } from "zod";
import {
  AttachmentsService,
  normalizeContentType,
  sniffMatches,
} from "../conversations/attachments.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { StorageService } from "../storage/storage.service.js";
import { findConversationFile } from "../tools/builtins/conversation-files.js";

/**
 * File references (platform web parity spec §5): a `Platform` write the web does with an upload
 * takes a file the agent already has instead, a conversation file (`fileId`: an attachment, a
 * generated or delivered artifact, a `read` copy). A file on the conversation's device is
 * delivered first (`Deliver`: the device rules, the command review and the permission profile
 * apply) and passed by the delivered file's id, so device files have one reading path. The tool
 * resolves it at the policy step (limits, sha256, a thumbnail for an image: the card's
 * `detail.file`) and again right before the run, which refuses bytes that differ from the ones the
 * person confirmed.
 */

export type FileRef = { fileId: string };

/** Model-visible: a device path where a file reference is expected. */
export const FILE_REF_PATH_TEXT = "Deliver the file first, then pass its fileId.";

export const FileRefSchema: z.ZodType<FileRef> = z.strictObject(
  {
    fileId: z
      .uuid()
      .describe(
        "The id of a file of this conversation: an attachment, a generated image or a delivered file (Deliver a device file first).",
      ),
  },
  {
    // a device path is not a file reference: the model delivers the file first
    error: (iss) =>
      iss.code === "unrecognized_keys" && iss.keys.includes("path")
        ? FILE_REF_PATH_TEXT
        : undefined,
  },
);

/** What an operation accepts: the route's byte limit and content types (absent: any type). */
export interface FileLimits {
  maxBytes: number;
  contentTypes?: readonly string[];
}

/** A resolved reference: the bytes and what the card shows of them. */
export interface ResolvedFile {
  name: string;
  /** Normalized (lower case, no parameters). */
  contentType: string;
  size: number;
  /** Hex sha256 of {@link bytes}. */
  sha256: string;
  bytes: Uint8Array;
}

/** What the approval card shows of a referenced file (`detail.file`; never the bytes). */
export interface FileCardDetail {
  name: string;
  size: number;
  sha256: string;
  contentType: string;
  /** A WebP data URL (ruling R9); absent for a non-image, an undecodable one or one too large. */
  thumbnail?: string;
}

/** Where a reference is resolved: the runtime's ids, never input. */
export interface FileRefContext {
  orgId: string;
  conversationId: string;
  /** The root of the conversation tree, from the call's context. */
  rootConversationId: string;
  signal: AbortSignal;
}

/** Ruling R9: the thumbnail's longest edge, quality and the most the data URL may take. */
export const THUMBNAIL_MAX_EDGE = 160;
const THUMBNAIL_QUALITY = 70;
export const THUMBNAIL_MAX_CHARS = 24 * 1024;

/**
 * The most an image may weigh, and the most pixels it may decode to, for a thumbnail: a card is
 * drawn at the policy step of every call, so a large or decompression-bomb image gets none.
 */
export const THUMBNAIL_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const THUMBNAIL_MAX_INPUT_PIXELS = 40_000_000;

/** Image types a thumbnail is made of (an SVG is never rendered by the kernel). */
const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Model-visible: the referenced file is over the operation's byte limit. */
export const fileTooLargeText = (size: number, max: number) =>
  `The file is ${size} bytes; this operation takes at most ${max}.`;
/** Model-visible: the referenced file's type is not one the operation takes. */
export const fileTypeText = (contentType: string, types: readonly string[]) =>
  `The file is ${contentType}; this operation takes ${types.join(", ")}.`;
/** Model-visible: the bytes at run time differ from the ones the person confirmed. */
export const FILE_CHANGED_TEXT =
  "The file changed after the person confirmed it; call the operation again.";
const notFoundText = (id: string) =>
  `File ${id} is not a file of this conversation. Pass the id of an attachment, a generated image or a delivered file of this conversation, or Deliver a device file first and pass its fileId.`;

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The card's view of a resolved file, with a thumbnail for an image (R9). */
export async function fileCardDetail(file: ResolvedFile): Promise<FileCardDetail> {
  const thumbnail = await thumbnailOf(file);
  return {
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    contentType: file.contentType,
    ...(thumbnail !== null && { thumbnail }),
  };
}

/**
 * A 160 px (longest edge) WebP q70 data URL of an image, or null: not an image type the kernel
 * decodes, bytes over {@link THUMBNAIL_MAX_INPUT_BYTES} or decoding to more than
 * {@link THUMBNAIL_MAX_INPUT_PIXELS}, bytes that fail to decode, or a data URL over
 * {@link THUMBNAIL_MAX_CHARS} (ruling R9).
 */
export async function thumbnailOf(file: Pick<ResolvedFile, "contentType" | "bytes">) {
  if (!THUMBNAIL_TYPES.has(file.contentType)) return null;
  if (file.bytes.byteLength > THUMBNAIL_MAX_INPUT_BYTES) return null;
  try {
    const out = await sharp(file.bytes, {
      failOn: "error",
      limitInputPixels: THUMBNAIL_MAX_INPUT_PIXELS,
    })
      .autoOrient()
      .resize({
        width: THUMBNAIL_MAX_EDGE,
        height: THUMBNAIL_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toBuffer();
    const url = `data:image/webp;base64,${out.toString("base64")}`;
    return url.length <= THUMBNAIL_MAX_CHARS ? url : null;
  } catch {
    return null;
  }
}

/**
 * Resolves file references for the `Platform` tool. `fileId` goes through
 * `findConversationFile` (the resolver `Read` uses: the conversation and its root, inside the
 * org).
 * Every refusal is a model-visible `ToolError`.
 */
@Injectable()
export class FileRefs {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async resolve(ref: FileRef, limits: FileLimits, ctx: FileRefContext): Promise<ResolvedFile> {
    const got = await this.conversationFile(ref.fileId, limits, ctx);
    const contentType = normalizeContentType(got.contentType);
    return {
      name: got.name,
      contentType,
      size: got.bytes.byteLength,
      sha256: sha256Of(got.bytes),
      bytes: got.bytes,
    };
  }

  private async conversationFile(id: string, limits: FileLimits, ctx: FileRefContext) {
    const db = this.db.db;
    const file = await findConversationFile(
      { db, attachments: this.attachments, storage: this.storage },
      {
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        rootConversationId: ctx.rootConversationId,
        id,
        // one byte past the limit tells a file that grew from one that fits
        maxBytes: limits.maxBytes + 1,
        signal: ctx.signal,
      },
    );
    if (file === null) throw new ToolError(notFoundText(id));
    if (file.size > limits.maxBytes) {
      await file.discard();
      throw new ToolError(fileTooLargeText(file.size, limits.maxBytes));
    }
    const types = limits.contentTypes;
    const declared = normalizeContentType(file.contentType);
    if (types !== undefined && !types.includes(declared)) {
      await file.discard();
      throw new ToolError(fileTypeText(declared, types));
    }
    const bytes = await file.open({ maxBytes: limits.maxBytes + 1 });
    if (bytes.byteLength > limits.maxBytes) {
      await file.discard();
      throw new ToolError(fileTooLargeText(bytes.byteLength, limits.maxBytes));
    }
    // the bytes must be what the type says (the upload routes sniff the same way)
    if (types !== undefined && !sniffMatches(declared, bytes.subarray(0, 4096))) {
      await file.discard();
      throw new ToolError(
        `The file's bytes are not ${declared}; this operation takes ${types.join(", ")}.`,
      );
    }
    return { name: file.name, contentType: file.contentType, bytes };
  }
}
