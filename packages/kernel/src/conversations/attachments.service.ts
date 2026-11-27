import { randomUUID } from "node:crypto";
import type { PresignedUpload } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { AttachmentPurpose } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { MediaBytes, MediaInfo } from "../runtime/context/build.js";
import { StorageService } from "../storage/storage.service.js";
import { ConversationAccess } from "./access.js";
import { isImageContentType } from "./media-types.js";
import {
  fitImageForModel,
  MODEL_IMAGE_CACHE_SECONDS,
  modelImageKey,
  parseModelImage,
  serializeModelImage,
} from "./model-image.js";

/** 预签名上传的有效期（秒）。尽量短：表单在有效期内可被再次使用（内容替换由 etag 核对兜底）。 */
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 300;
/** 下载跳转的预签名有效期（秒）；不短于 {@link ATTACHMENT_DOWNLOAD_CACHE_SECONDS}（浏览器缓存的跳转仍可用）。 */
export const ATTACHMENT_DOWNLOAD_TTL_SECONDS = 300;
/** 下载 302 的 `Cache-Control: private, max-age=…`（秒）：同一页面里缩略图可复用跳转地址。 */
export const ATTACHMENT_DOWNLOAD_CACHE_SECONDS = 60;

/** 技能包 zip 的内容类型（上传时一律按它签名，finalize 时核对 zip 文件头）。 */
export const SKILL_PACKAGE_CONTENT_TYPE = "application/zip";
/** 技能包 zip 的大小上限（字节）。 */
export const SKILL_PACKAGE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** 同一账号在一个组织里最多的未 finalize 技能包上传数（与对话附件分开计数）。 */
export const MAX_PENDING_SKILL_PACKAGES = 5;
/**
 * 技能包上传的过期时间（小时）：没被 `POST /skills` 用掉的由清理任务删除（不跟对话附件的 `unboundTtlHours`）；
 * `POST /skills` 开始处理时再顺延这么久，处理期间不会被清理。
 */
export const SKILL_PACKAGE_TTL_HOURS = 1;
/** The image types an agent avatar upload may have (cropped square in the browser). */
export const AGENT_AVATAR_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** The size limit of an agent avatar upload (bytes). */
export const AGENT_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Unfinished avatar uploads one account may have in an org (counted apart from other uploads). */
export const MAX_PENDING_AGENT_AVATARS = 10;
/** An avatar upload not saved into a profile expires (and is cleaned up) after this many hours. */
export const AGENT_AVATAR_TTL_HOURS = 24;
/** Download redirect lifetime of an avatar (seconds); also its `Cache-Control` max-age. */
export const AGENT_AVATAR_DOWNLOAD_TTL_SECONDS = 300;

/**
 * 技能包解出的文件在 `kernel/<orgId>/` 下的前缀：按上传 id，同一上传重试写到同一批键（幂等），
 * 并发处理同一上传也不会互相覆盖出不同内容。版本行记下这个前缀（`skill_versions.object_prefix`）。
 */
export const skillFilesPrefix = (uploadId: string) => `skills/${uploadId}/`;

/** 周期任务：每小时清理过期未绑定的附件（`@LockedCron`）。 */
export const ATTACHMENT_CLEANUP_JOB = "attachment-cleanup";
/** 每批认领的行数。 */
const CLEANUP_BATCH = 100;
/** The hourly purge of `read` copies whose conversation was deleted long enough ago. */
export const ATTACHMENT_READ_PURGE_JOB = "attachments-read-purge";
/** Rows one claim of the read purge takes. */
const READ_PURGE_BATCH = 500;
/**
 * How many sub-agent levels below a deleted conversation the read purge walks (the bound of
 * `conversations/tree.ts`: far above `subagents.maxDepth`, so a corrupt chain cannot loop).
 */
const READ_PURGE_TREE_LEVELS = 16;
/** finalize 时读取开头多少字节核对文件签名。 */
const SNIFF_BYTES = 1024;

/** The purposes registered through {@link AttachmentsService.create} (a presigned upload). */
export type UploadPurpose = "agent-avatar" | "skill-package";

/** {@link AttachmentsService.storeRead}'s result: the bound copy, or refused by the cap. */
export type StoreReadResult =
  | { ok: true; attachmentId: string; size: number }
  | { ok: false; reason: "cap" };

/** 附件元数据（finalize 的返回）。 */
export interface AttachmentView {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

/** {@link AttachmentsService.openForConversation} 的结果。 */
export interface OpenedAttachment {
  name: string;
  contentType: string;
  size: number;
  body: ReadableStream<Uint8Array>;
}

/** A ready `read` copy bound to a conversation ({@link AttachmentsService.boundRows}). */
export interface BoundAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  objectKey: string;
  /** The etag recorded at finalize (null: none recorded). */
  etag: string | null;
  createdAt: Date;
}

/**
 * Whether a stored object is still the attachment finalize checked: the same size, and the same
 * etag when one was recorded. Anything else is treated as no longer available.
 */
export function attachmentContentMatches(
  recorded: { size: number; etag: string | null },
  head: { size: number; etag?: string | undefined },
): boolean {
  return head.size === recorded.size && (recorded.etag === null || recorded.etag === head.etag);
}

/** `POST /attachments` 的返回：浏览器按 `upload` 直传存储，然后调 finalize。 */
export interface CreatedAttachment {
  id: string;
  upload: PresignedUpload;
  /** 预签名上传的过期时间（ISO 8601）。 */
  expiresAt: string;
}

const notFound = () => new ApiError("attachment.not_found", "Attachment not found");

/**
 * The one purpose conversations read here: the `read` copies of the builtin Read and of tool
 * result images. A person's files (the `chat` rows the file library migrated) are read through the
 * library (`ReferencedFiles`), never here.
 */
const READ_PURPOSE: AttachmentPurpose = "read";

/** 去掉参数、转小写：`Text/Plain; charset=utf-8` → `text/plain`。 */
export const normalizeContentType = (ct: string): string =>
  (ct.split(";")[0] ?? "").trim().toLowerCase();

/**
 * The object key: the attachment id only (the user's file name never goes into a key), under one
 * prefix per purpose this service still writes (legacy `chat` rows are the file library's).
 */
const objectKey = (id: string, purpose: UploadPurpose | "read") =>
  purpose === "agent-avatar"
    ? `agent-avatars/${id}`
    : purpose === "read"
      ? `read-images/${id}`
      : `skill-packages/${id}`;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * Whether the head of the file matches the declared content type. Images, a PDF, a zip and the
 * Office formats (which are zips themselves) are checked by signature; text and JSON must not
 * contain a NUL byte. Any other accepted type has no signature to check, so it passes (its bytes are
 * never rendered: only images and a PDF are served inline).
 */
export function sniffMatches(contentType: string, head: Uint8Array): boolean {
  switch (contentType) {
    case "image/png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"));
    case "image/webp":
      return startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8);
    case "application/pdf":
      return Buffer.from(head.buffer, head.byteOffset, head.byteLength).includes("%PDF-");
    case "application/zip":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      // the local file header, or an empty zip's end of central directory (OOXML files are zips)
      return (
        startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])
      );
    case "application/json":
      return !head.includes(0);
    default:
      return contentType.startsWith("text/") ? !head.includes(0) : true;
  }
}

/**
 * PDF 的页数：数未压缩的页对象（`/Type /Page`，不含 `/Pages`）。页对象放在压缩的对象流里时数不到，返回 0。
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * Uploads that are not a person's files (agent avatars, skill packages: register → the browser
 * uploads with the presigned form → finalize checks) and the `read` copies of images the agent was
 * shown (bound to their conversation; request building reads them through {@link fetchMedia}). A
 * person's files are the file library's (`LibraryFilesService`, `ReferencedFiles`). Bytes live only
 * in the object store; logs hold refs. No process state.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService)
    private readonly storage: Pick<StorageService, "available" | "assertAvailable" | "kernel">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    /** viewer 能否访问该会话（与会话流相同的规则）。 */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** where the model-sized copies of images are kept between steps ({@link fetchMedia}) */
    @Inject(CacheService) private readonly cache: Pick<CacheService, "get" | "set">,
  ) {}

  /**
   * Registers an agent avatar or skill package upload (`pending`) and returns its presigned form;
   * the store enforces the declared size and type. A type or size the purpose does not take →
   * `attachment.type_not_allowed` / `attachment.too_large`; too many unfinished uploads of the
   * purpose → `attachment.too_many_pending` (a soft cap); no object store → `storage.unavailable`.
   * A person's files go through the file library (`LibraryFilesService`), never here.
   */
  async create(
    orgId: string,
    accountId: string,
    input: { name: string; contentType: string; size: number },
    purpose: UploadPurpose,
  ): Promise<CreatedAttachment> {
    this.storage.assertAvailable();
    const { contentType, ttlHours } = await this.admit(orgId, accountId, purpose, input, false);
    const id = randomUUID();
    const key = objectKey(id, purpose);
    const upload = await this.storage.kernel(orgId).presignPut(key, {
      contentType,
      maxSize: input.size,
      ttlSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
    });
    await this.db
      .insertInto("attachments")
      .values({
        id,
        org_id: orgId,
        account_id: accountId,
        name: input.name,
        content_type: contentType,
        size: input.size,
        object_key: key,
        status: "pending",
        purpose,
        expires_at: sql<Date>`now() + make_interval(hours => ${ttlHours})`,
      })
      .execute();
    return {
      id,
      upload,
      expiresAt: new Date(Date.now() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * The checks of registering an upload of `purpose` (type, size, the account's unfinished uploads
   * of that purpose) and its expiry. `countStored`: uploads already stored but not yet used (ready,
   * still expiring, bound to no agent) count as unfinished too ({@link createFromBytes}'s rows do
   * not stay pending).
   */
  private async admit(
    orgId: string,
    accountId: string,
    purpose: UploadPurpose,
    input: { contentType: string; size: number },
    countStored: boolean,
  ): Promise<{ contentType: string; ttlHours: number }> {
    const contentType = normalizeContentType(input.contentType);
    const skill = purpose === "skill-package";
    if (
      skill
        ? contentType !== SKILL_PACKAGE_CONTENT_TYPE
        : !(AGENT_AVATAR_CONTENT_TYPES as readonly string[]).includes(contentType)
    ) {
      throw new ApiError(
        "attachment.type_not_allowed",
        `Attachment type ${JSON.stringify(contentType)} is not allowed`,
      );
    }
    const limit = skill ? SKILL_PACKAGE_UPLOAD_MAX_BYTES : AGENT_AVATAR_MAX_BYTES;
    if (input.size > limit) {
      throw new ApiError(
        "attachment.too_large",
        `Attachment is ${input.size} bytes, over the limit of ${limit} bytes`,
      );
    }
    const pending = await this.db
      .selectFrom("attachments")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("purpose", "=", purpose)
      .where((eb) =>
        countStored
          ? eb.or([
              eb("status", "=", "pending"),
              eb.and([
                eb("status", "=", "ready"),
                eb("expires_at", "is not", null),
                eb("agent_id", "is", null),
              ]),
            ])
          : eb("status", "=", "pending"),
      )
      .executeTakeFirst();
    const maxPending = skill ? MAX_PENDING_SKILL_PACKAGES : MAX_PENDING_AGENT_AVATARS;
    if (Number(pending?.n ?? 0) >= maxPending) {
      throw new ApiError(
        "attachment.too_many_pending",
        `Too many unfinished uploads (at most ${maxPending}); finish or wait for them first`,
      );
    }
    const ttlHours = skill ? SKILL_PACKAGE_TTL_HOURS : AGENT_AVATAR_TTL_HOURS;
    return { contentType, ttlHours };
  }

  /**
   * Stores bytes the kernel already holds as an upload of `purpose`, as if a person had uploaded
   * and finalized them (platform web parity spec §5: a `Platform` write takes a file in place of
   * an upload), then the route's next step takes its id (the profile save, `POST /skills`). The
   * checks, expiry and caps of {@link create} apply; no presigned URL is made. Intent first: the
   * `pending` row is committed before the put (a failed put leaves it to expire and be cleaned
   * up), then one update makes it `ready` with the stored size and etag. The type is not sniffed
   * here: callers pass bytes they checked (the Platform tool sniffs a file reference).
   */
  async createFromBytes(
    orgId: string,
    accountId: string,
    purpose: "agent-avatar" | "skill-package",
    file: { name: string; contentType: string; bytes: Uint8Array },
  ): Promise<{ id: string }> {
    this.storage.assertAvailable();
    const size = file.bytes.byteLength;
    const { contentType, ttlHours } = await this.admit(
      orgId,
      accountId,
      purpose,
      { contentType: file.contentType, size },
      true,
    );
    const id = randomUUID();
    const key = objectKey(id, purpose);
    await this.insertUploadIntent({
      id,
      orgId,
      accountId,
      name: file.name,
      contentType,
      size,
      key,
      purpose,
      ttlHours,
    });
    const head = await this.storage.kernel(orgId).put(key, file.bytes, { contentType, size });
    await this.markStored(orgId, id, head.size, head.etag ?? null);
    return { id };
  }

  /**
   * Gives up an upload {@link createFromBytes} stored when the write meant to take it failed: a
   * `ready` upload of the account no agent uses becomes `deleting`, expiring now, so it no longer
   * counts toward the cap and the cleanup job deletes it with its object. One already taken (a
   * consumed skill package, an avatar bound to an agent) is left alone.
   */
  @Transactional()
  async discardUpload(orgId: string, accountId: string, id: string): Promise<void> {
    await this.db.db
      .updateTable("attachments")
      .set({ status: "deleting", expires_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("purpose", "in", ["agent-avatar", "skill-package"])
      .where("status", "=", "ready")
      .where("agent_id", "is", null)
      .execute();
  }

  /** The last step of {@link createFromBytes}: the stored object's size and etag, `ready`. */
  @Transactional()
  private async markStored(
    orgId: string,
    id: string,
    size: number,
    etag: string | null,
  ): Promise<void> {
    await this.db.db
      .updateTable("attachments")
      .set({ status: "ready", size, etag })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "pending")
      .execute();
  }

  /** The `pending` row of {@link createFromBytes}, committed on its own before the put. */
  @Transactional({ propagation: "requires_new" })
  private async insertUploadIntent(r: {
    id: string;
    orgId: string;
    accountId: string;
    name: string;
    contentType: string;
    size: number;
    key: string;
    purpose: AttachmentPurpose;
    ttlHours: number;
  }): Promise<void> {
    await this.db.db
      .insertInto("attachments")
      .values({
        id: r.id,
        org_id: r.orgId,
        account_id: r.accountId,
        name: r.name,
        content_type: r.contentType,
        size: r.size,
        object_key: r.key,
        status: "pending",
        purpose: r.purpose,
        expires_at: sql<Date>`now() + make_interval(hours => ${r.ttlHours})`,
      })
      .execute();
  }

  /**
   * 上传完成后核对并标记为 `ready`（只有上传者能做；已 ready 时直接返回）：
   * - 对象还不存在 → `attachment.not_ready`；
   * - 大小与声明不符 → 删除已传的对象，大了 `attachment.too_large`、小了 `attachment.not_ready`（可重传）；
   * - 存储记录的类型或文件开头的签名与声明不符 → 删除对象，`attachment.type_not_allowed`。
   */
  async finalize(orgId: string, accountId: string, id: string): Promise<AttachmentView> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("attachments")
      .select(["id", "name", "content_type", "size", "object_key", "status"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("status", "in", ["pending", "ready"])
      // read copies are the kernel's own (storeRead binds them); a person's files are finalized
      // by the file library
      .where("purpose", "in", ["agent-avatar", "skill-package"])
      .executeTakeFirst();
    if (!row) throw notFound();
    const view: AttachmentView = {
      id: row.id,
      name: row.name,
      contentType: row.content_type,
      size: Number(row.size),
    };
    if (row.status === "ready") return view;
    const store = this.storage.kernel(orgId);
    const head = await store.head(row.object_key);
    if (!head) {
      throw new ApiError("attachment.not_ready", "The file has not been uploaded yet");
    }
    const reject = async (err: ApiError): Promise<never> => {
      await store.delete(row.object_key);
      throw err;
    };
    if (head.size !== view.size) {
      await reject(
        head.size > view.size
          ? new ApiError("attachment.too_large", "Uploaded file is larger than declared")
          : new ApiError(
              "attachment.not_ready",
              `Uploaded file is ${head.size} bytes, but ${view.size} bytes were declared; upload it again`,
            ),
      );
    }
    if (normalizeContentType(head.contentType) !== view.contentType) {
      await reject(
        new ApiError("attachment.type_not_allowed", "Uploaded file type does not match"),
      );
    }
    // PDF 读全文（数页数，供 token 估算）；其他类型只读开头核对签名
    const pdf = view.contentType === "application/pdf";
    const got = await store.get(
      row.object_key,
      pdf ? {} : { range: { start: 0, end: Math.max(0, Math.min(view.size, SNIFF_BYTES) - 1) } },
    );
    const data = got ? await readAll(got.body) : new Uint8Array();
    const pages = pdf ? countPdfPages(data) || null : null;
    if (!sniffMatches(view.contentType, data.subarray(0, SNIFF_BYTES))) {
      await reject(
        new ApiError(
          "attachment.type_not_allowed",
          `Uploaded file content is not ${view.contentType}`,
        ),
      );
    }
    await this.db
      .updateTable("attachments")
      .set({ status: "ready", etag: got?.head.etag ?? head.etag ?? null, pages })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "pending")
      .execute();
    return view;
  }

  /**
   * The download address (presigned, {@link ATTACHMENT_DOWNLOAD_TTL_SECONDS} seconds) of a `read`
   * copy (an image a tool showed the agent), for whoever can open its conversation, so the web can
   * show it on the call's row (tool result images design §4); anything else →
   * `attachment.not_found` (a person's files are downloaded through the file library). Only images
   * and PDFs open `inline`; the response type is the recorded one.
   */
  async downloadUrl(orgId: string, accountId: string, id: string): Promise<string> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("attachments")
      .select([
        "account_id",
        "conversation_id",
        "name",
        "content_type",
        "object_key",
        "size",
        "etag",
      ])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .where("purpose", "=", READ_PURPOSE)
      .executeTakeFirst();
    if (!row) throw notFound();
    const allowed =
      row.conversation_id === null
        ? row.account_id === accountId
        : await this.access.isAccessible(orgId, row.conversation_id, accountId);
    if (!allowed) throw notFound();
    const store = this.storage.kernel(orgId);
    const head = await store.head(row.object_key);
    if (!this.storedMatches({ id, size: Number(row.size), etag: row.etag }, head, { orgId })) {
      throw notFound();
    }
    const inline = isImageContentType(row.content_type) || row.content_type === "application/pdf";
    return store.presignGet(row.object_key, {
      ttlSeconds: ATTACHMENT_DOWNLOAD_TTL_SECONDS,
      downloadName: row.name,
      disposition: inline ? "inline" : "attachment",
      responseContentType: row.content_type,
    });
  }

  /**
   * The ready `read` copies bound to the conversation in this org (vision-read design §1.1), oldest
   * first, then id; with `id`, only that one. Nothing here checks who reads them: callers check the
   * conversation's access first.
   */
  async boundRows(orgId: string, conversationId: string, id?: string): Promise<BoundAttachment[]> {
    let q = this.db
      .selectFrom("attachments")
      .select(["id", "name", "content_type", "size", "object_key", "etag", "created_at"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", READ_PURPOSE)
      .where("status", "=", "ready");
    if (id !== undefined) q = q.where("id", "=", id);
    const rows = await q.orderBy("created_at").orderBy("id").execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      contentType: r.content_type,
      size: Number(r.size),
      objectKey: r.object_key,
      etag: r.etag,
      createdAt: r.created_at,
    }));
  }

  /**
   * {@link attachmentContentMatches} for a bound attachment's stored object (`null`: gone), with
   * the warning logged when the content was replaced after finalize.
   */
  storedMatches(
    a: Pick<BoundAttachment, "id" | "size" | "etag">,
    head: { size: number; etag?: string | undefined } | null,
    where: { orgId: string; conversationId?: string },
  ): boolean {
    if (!head) return false;
    if (attachmentContentMatches(a, head)) return true;
    this.log.warn("attachment content changed after finalize; treating it as unavailable", {
      ...where,
      attachmentId: a.id,
    });
    return false;
  }

  /**
   * Opens a ready `read` copy bound to the conversation (the model-facing file lookup): no row, not
   * bound to it, the object gone, or its size or etag not the recorded one → null. Other errors
   * (storage unavailable) throw. The caller reads or cancels `body`.
   */
  async openForConversation(
    orgId: string,
    conversationId: string,
    attachmentId: string,
    opts: {
      /** Read at most this many bytes (a range read; a store that ignores it serves the whole). */
      maxBytes?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<OpenedAttachment | null> {
    const [row] = await this.boundRows(orgId, conversationId, attachmentId);
    if (!row) return null;
    const got = await this.storage.kernel(orgId).get(row.objectKey, {
      ...(opts.signal !== undefined && { signal: opts.signal }),
      // only a larger object is ranged (a range on an empty object is unsatisfiable)
      ...(opts.maxBytes !== undefined &&
        row.size > opts.maxBytes && { range: { start: 0, end: opts.maxBytes - 1 } }),
    });
    if (!got) return null;
    if (!this.storedMatches(row, got.head, { orgId, conversationId })) {
      await got.body.cancel().catch(() => {});
      return null;
    }
    return { name: row.name, contentType: row.contentType, size: row.size, body: got.body };
  }

  /** 下载 / 取字节时核对 etag：finalize 记下的与当前对象的不一致 → 内容被替换（记 warn）。没有记录时不核对。 */
  private sameContent(
    recorded: string | null,
    current: string | undefined,
    where: { orgId: string; attachmentId: string; conversationId?: string },
  ): boolean {
    if (recorded === null || recorded === (current ?? null)) return true;
    this.log.warn("attachment content changed after finalize; treating it as unavailable", where);
    return false;
  }

  /**
   * The recorded facts request building needs about `read` copies (only ready rows bound to this
   * conversation; `ConversationMedia` asks here for the refs that are not library files): size, PDF page count, and the object's unsigned reference
   * (`ObjectStore.uri`, falling back to `capybara://attachments/<id>`). An id with no row is left
   * out; a failed query throws.
   */
  async mediaInfo(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
  ): Promise<Map<string, MediaInfo>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("attachments")
      .select(["id", "size", "pages", "etag", "object_key"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", READ_PURPOSE)
      .where("status", "=", "ready")
      .where("id", "in", [...ids])
      .execute();
    const store = this.storage.kernel(orgId);
    return new Map(
      rows.map((r) => [
        r.id,
        {
          size: Number(r.size),
          pages: r.pages,
          etag: r.etag,
          uri: store.uri?.(r.object_key) ?? `capybara://attachments/${r.id}`,
        },
      ]),
    );
  }

  /**
   * The bytes request building sends, only of ready `read` copies bound to this conversation. Null only when certainly gone: no row, the object missing, or its size or etag
   * not the recorded one (content replaced, logged as a warning). Every other error (storage
   * unavailable, network) throws (Ruling M4) for the caller to treat as retryable, never a
   * placeholder. An id in `caps` is read by range up to that many leading bytes (the `text/*` cap).
   * A whole image comes back as its model-sized copy ({@link fitImageForModel}), whose media type
   * may differ from the row's; the copy is cached for {@link MODEL_IMAGE_CACHE_SECONDS} under the
   * attachment's id and etag, so later steps of the conversation only check the object's head.
   */
  async fetchMedia(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
    caps?: ReadonlyMap<string, number>,
  ): Promise<Map<string, MediaBytes | null>> {
    const out = new Map<string, MediaBytes | null>();
    if (ids.length === 0) return out;
    const rows = await this.db
      .selectFrom("attachments")
      .select(["id", "content_type", "object_key", "size", "etag"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", READ_PURPOSE)
      .where("status", "=", "ready")
      .where("id", "in", [...ids])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const store = this.storage.kernel(orgId);
    await Promise.all(
      ids.map(async (id) => {
        const r = byId.get(id);
        if (!r) return out.set(id, null);
        const cap = caps?.get(id);
        const where = { orgId, conversationId, attachmentId: id };
        // a whole image already scaled for the model: the cached copy, once the object checks out
        const cacheKey =
          cap === undefined && isImageContentType(r.content_type)
            ? modelImageKey(orgId, r)
            : undefined;
        const cached =
          cacheKey === undefined ? null : parseModelImage(await this.cache.get(cacheKey));
        if (cached) {
          const head = await store.head(r.object_key);
          if (!head) return out.set(id, null);
          if (head.size !== Number(r.size) || !this.sameContent(r.etag, head.etag, where)) {
            if (head.size !== Number(r.size)) {
              this.log.warn(
                "attachment size changed after finalize; treating it as unavailable",
                where,
              );
            }
            return out.set(id, null);
          }
          return out.set(id, cached);
        }
        const want = cap !== undefined && cap < Number(r.size) ? Math.max(1, cap) : Number(r.size);
        const got = await store.get(
          r.object_key,
          want < Number(r.size) ? { range: { start: 0, end: want - 1 } } : undefined,
        );
        if (!got) return out.set(id, null);
        if (got.head.size !== Number(r.size) || !this.sameContent(r.etag, got.head.etag, where)) {
          if (got.head.size !== Number(r.size)) {
            this.log.warn(
              "attachment size changed after finalize; treating it as unavailable",
              where,
            );
          }
          await got.body.cancel().catch(() => {});
          return out.set(id, null);
        }
        // 提供方没按范围读、给了整个对象时只留开头
        const all = await readAll(got.body);
        const data = all.byteLength === Number(r.size) ? all.subarray(0, want) : all;
        if (data.byteLength !== want) return out.set(id, null);
        const media = { mediaType: r.content_type, data };
        if (cacheKey === undefined) {
          return out.set(id, media);
        }
        // a whole image goes out as the model-sized copy (the stored object stays unchanged)
        const fitted = await fitImageForModel(media);
        if (fitted !== media) {
          await this.cache.set(cacheKey, serializeModelImage(fitted), MODEL_IMAGE_CACHE_SECONDS);
        }
        out.set(id, fitted);
      }),
    );
    return out;
  }

  /**
   * 取一个技能包上传的字节，供 `POST /skills` 解包（只有上传者、只认 `skill-package` 用途）：
   * 还没 finalize 的先 finalize（核对大小与 zip 文件头）；过期时间顺延 {@link SKILL_PACKAGE_TTL_HOURS} 小时，
   * 处理期间不会被清理任务删掉。不存在、不是技能包、已用掉或已过期 → `attachment.not_found`；
   * 对象已不在或内容与 finalize 时不符 → `attachment.not_found`。
   */
  async readSkillPackage(orgId: string, accountId: string, id: string): Promise<Uint8Array> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("attachments")
      .select(["status", "purpose", sql<boolean>`expires_at <= now()`.as("expired")])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (row?.purpose !== "skill-package" || row.status === "deleting" || row.expired) {
      throw notFound();
    }
    if (row.status === "pending") await this.finalize(orgId, accountId, id);
    const live = await this.db
      .updateTable("attachments")
      .set({ expires_at: sql<Date>`now() + make_interval(hours => ${SKILL_PACKAGE_TTL_HOURS})` })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .where("purpose", "=", "skill-package")
      .returning(["object_key", "size", "etag"])
      .executeTakeFirst();
    if (!live) throw notFound();
    const got = await this.storage.kernel(orgId).get(live.object_key);
    if (!got) throw notFound();
    if (
      got.head.size !== Number(live.size) ||
      !this.sameContent(live.etag, got.head.etag, { orgId, attachmentId: id })
    ) {
      await got.body.cancel().catch(() => {});
      throw notFound();
    }
    return readAll(got.body);
  }

  /**
   * 在调用方事务里把技能包上传标记为已用掉（行锁；之后由清理任务删 zip，解出的文件因被版本引用而保留）。
   * 不是该账号的 ready 技能包（如已被并发的请求用掉）→ `attachment.not_found`。
   */
  @Transactional({ propagation: "mandatory" })
  async consumeSkillPackage(orgId: string, accountId: string, id: string): Promise<void> {
    const trx = this.db.db;
    const row = await trx
      .selectFrom("attachments")
      .select("status")
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("purpose", "=", "skill-package")
      .forUpdate()
      .executeTakeFirst();
    if (row?.status !== "ready") throw notFound();
    await trx
      .updateTable("attachments")
      .set({ status: "deleting", expires_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .execute();
  }

  /**
   * Makes an agent avatar upload ready to be saved into a profile (outside any transaction: it may
   * read the object store): only the uploader, only the `agent-avatar` purpose, an image type, not
   * expired and not yet used by another agent, else `attachment.not_found`. An upload still
   * `pending` is finalized first (size, type and the image signature are checked). The expiry is
   * extended so the cleanup job cannot delete it before {@link consumeAgentAvatar} runs.
   */
  async prepareAgentAvatar(
    orgId: string,
    accountId: string,
    id: string,
    agentId: string,
  ): Promise<void> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("attachments")
      .select([
        "status",
        "purpose",
        "content_type",
        "agent_id",
        sql<boolean>`expires_at is not null and expires_at <= now()`.as("expired"),
      ])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (
      row?.purpose !== "agent-avatar" ||
      row.status === "deleting" ||
      row.expired ||
      (row.agent_id !== null && row.agent_id !== agentId) ||
      !(AGENT_AVATAR_CONTENT_TYPES as readonly string[]).includes(row.content_type)
    ) {
      throw notFound();
    }
    if (row.status === "pending") await this.finalize(orgId, accountId, id);
    await this.db
      .updateTable("attachments")
      .set({ expires_at: sql<Date>`now() + make_interval(hours => ${AGENT_AVATAR_TTL_HOURS})` })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .where("agent_id", "is", null)
      .where("expires_at", "is not", null)
      .execute();
  }

  /**
   * In the caller's transaction, binds a ready avatar upload to `agentId` (row lock; the expiry is
   * cleared, so the cleanup job keeps it while the profile uses it). An upload another agent
   * already uses, or one that is not the account's ready avatar → `attachment.not_found`; saving
   * the same upload to the same agent again is fine.
   */
  @Transactional({ propagation: "mandatory" })
  async consumeAgentAvatar(
    orgId: string,
    accountId: string,
    id: string,
    agentId: string,
  ): Promise<void> {
    const trx = this.db.db;
    const row = await trx
      .selectFrom("attachments")
      .select(["status", "agent_id"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("purpose", "=", "agent-avatar")
      .forUpdate()
      .executeTakeFirst();
    if (row?.status !== "ready" || (row.agent_id !== null && row.agent_id !== agentId)) {
      throw notFound();
    }
    await trx
      .updateTable("attachments")
      .set({ agent_id: agentId, expires_at: null })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .execute();
  }

  /**
   * A short-lived presigned GET (inline, with the checked image type) of the avatar upload bound
   * to `agentId`; `null` when there is none or its object is gone or no longer the finalized one.
   */
  async agentAvatarUrl(orgId: string, agentId: string, id: string): Promise<string | null> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("attachments")
      .select(["content_type", "object_key", "etag"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("agent_id", "=", agentId)
      .where("purpose", "=", "agent-avatar")
      .where("status", "=", "ready")
      .executeTakeFirst();
    if (!row) return null;
    const store = this.storage.kernel(orgId);
    const head = await store.head(row.object_key);
    if (!head || !this.sameContent(row.etag, head.etag, { orgId, attachmentId: id })) return null;
    return store.presignGet(row.object_key, {
      ttlSeconds: AGENT_AVATAR_DOWNLOAD_TTL_SECONDS,
      disposition: "inline",
      responseContentType: row.content_type,
    });
  }

  /**
   * Stores the copy of an image the builtin Read read, bound to the calling conversation (never its
   * root), intent first so a crash leaves nothing unowned (vision-read design §1.3):
   * 1. the per-conversation cap `attachments.readMaxBytesPerConversation` (the sizes of the
   *    conversation's `read` rows plus this one; 0 refuses always) → `{ ok: false, reason: "cap" }`,
   *    nothing stored. Concurrent calls may pass it together: a soft cap;
   * 2. the row, unbound, `pending`, expiring after `attachments.unboundTtlHours`, so
   *    {@link deleteExpired} collects it after a crash; with no `accountId` (a run nobody started)
   *    it is the conversation owner's;
   * 3. the object under `read-images/<id>` (a failed put throws and leaves the row to expire);
   * 4. one transaction binding it: the conversation, `ready`, no expiry, the stored size and etag.
   * No object store → `storage.unavailable`. A conversation not in the org → an error, nothing stored.
   */
  async storeRead(
    orgId: string,
    conversationId: string,
    accountId: string | null,
    file: { name: string; contentType: string; data: Uint8Array },
  ): Promise<StoreReadResult> {
    this.storage.assertAvailable();
    const size = file.data.byteLength;
    const cap = this.config.get().attachments.readMaxBytesPerConversation;
    if (cap === 0) return { ok: false, reason: "cap" };
    const used = await this.db
      .selectFrom("attachments")
      .select(sql<string>`coalesce(sum(size), 0)`.as("n"))
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", "read")
      .executeTakeFirst();
    if (Number(used?.n ?? 0) + size > cap) return { ok: false, reason: "cap" };

    const id = randomUUID();
    const key = objectKey(id, "read");
    const contentType = normalizeContentType(file.contentType);
    await this.insertReadIntent(orgId, conversationId, accountId, {
      id,
      key,
      name: file.name,
      contentType,
      size,
    });
    const head = await this.storage
      .kernel(orgId)
      .put(key, file.data, { contentType: contentType || "application/octet-stream" });
    await this.bindRead(orgId, id, conversationId, head.size, head.etag ?? null);
    return { ok: true, attachmentId: id, size: head.size };
  }

  /**
   * Step 2 of {@link storeRead}: the unbound intent row, in its own transaction so it is committed
   * before the put even when the caller holds one (a rollback must never leave an object with no
   * row). The INSERT ... SELECT proves the conversation is in the org; with no `accountId` the row
   * is the conversation owner's.
   */
  @Transactional({ propagation: "requires_new" })
  private async insertReadIntent(
    orgId: string,
    conversationId: string,
    accountId: string | null,
    r: { id: string; key: string; name: string; contentType: string; size: number },
  ): Promise<void> {
    const { unboundTtlHours } = this.config.get().attachments;
    const inserted = await this.db.db
      .insertInto("attachments")
      .columns([
        "id",
        "org_id",
        "account_id",
        "name",
        "content_type",
        "size",
        "object_key",
        "status",
        "purpose",
        "expires_at",
      ])
      .expression((eb) =>
        eb
          .selectFrom("conversations")
          .select([
            sql.val(r.id).as("id"),
            "org_id",
            accountId === null ? "account_id" : sql.val(accountId).as("account_id"),
            sql.val(r.name).as("name"),
            sql.val(r.contentType).as("content_type"),
            sql.val(r.size).as("size"),
            sql.val(r.key).as("object_key"),
            sql.lit("pending").as("status"),
            sql.lit("read").as("purpose"),
            sql<Date>`now() + make_interval(hours => ${unboundTtlHours})`.as("expires_at"),
          ])
          .where("id", "=", conversationId)
          .where("org_id", "=", orgId),
      )
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) !== 1) {
      throw new Error(`conversation ${conversationId} not found in org ${orgId}`);
    }
  }

  /** Step 4 of {@link storeRead}: binds the unbound row in one transaction. */
  @Transactional()
  private async bindRead(
    orgId: string,
    id: string,
    conversationId: string,
    size: number,
    etag: string | null,
  ): Promise<void> {
    const bound = await this.db.db
      .updateTable("attachments")
      .set({ conversation_id: conversationId, status: "ready", expires_at: null, size, etag })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("purpose", "=", "read")
      .where("status", "=", "pending")
      .where("conversation_id", "is", null)
      .executeTakeFirst();
    if (Number(bound.numUpdatedRows) !== 1) {
      throw new Error(`read attachment ${id} is no longer pending; cannot bind it`);
    }
  }

  /**
   * Purges the `read` copies of conversations deleted more than `attachments.readPurgeAfterHours`
   * ago (read at run time), and of the sub-agent conversations below them (a sub-agent
   * conversation keeps `deleted_at` null when its root is deleted): claims up to
   * {@link READ_PURGE_BATCH} rows at a time as `deleting` (`FOR UPDATE SKIP LOCKED`, so concurrent
   * runs never share a row), deletes each object, then the row. A row whose object delete fails stays `deleting` and is claimed again on the next run.
   * Chat attachments of deleted conversations are not touched. Does nothing without an object
   * store. Returns the number of rows deleted.
   */
  // org-filter: deployment-wide cleanup job across all orgs; each claimed row is deleted by its
  // own id and handled in its own org (r.org_id)
  async purgeRead(): Promise<number> {
    return asPlatform("deployment-wide cleanup job across all orgs", async () => {
      if (!this.storage.available) return 0;
      const hours = this.config.get().attachments.readPurgeAfterHours;
      let deleted = 0;
      const failed: string[] = [];
      for (;;) {
        const claimed = await this.db
          .updateTable("attachments")
          .set({ status: "deleting" })
          .where(
            "id",
            "in",
            this.db
              .selectFrom("attachments")
              .select("id")
              .where("purpose", "=", "read")
              .where(
                "conversation_id",
                "in",
                sql<string>`(
                WITH RECURSIVE gone(id, level) AS (
                  SELECT c.id, 0 FROM capybara.conversations c
                  WHERE c.deleted_at < now() - make_interval(hours => ${hours})
                  UNION ALL
                  SELECT c.id, g.level + 1
                  FROM capybara.conversations c JOIN gone g ON c.parent_conversation_id = g.id
                  WHERE c.kind = 'subagent' AND g.level < ${READ_PURGE_TREE_LEVELS}
                )
                SELECT id FROM gone
              )`,
              )
              .$if(failed.length > 0, (q) => q.where("id", "not in", failed))
              .orderBy("created_at")
              .limit(READ_PURGE_BATCH)
              .forUpdate()
              .skipLocked(),
          )
          .returning(["id", "org_id", "object_key"])
          .execute();
        if (claimed.length === 0) return deleted;
        for (const r of claimed) {
          try {
            await this.storage.kernel(r.org_id).delete(r.object_key);
            await this.db
              .deleteFrom("attachments")
              .where("id", "=", r.id)
              .where("purpose", "=", "read")
              .execute();
            deleted++;
          } catch (err) {
            failed.push(r.id);
            this.log.warn("cannot purge read attachment; will retry", {
              orgId: r.org_id,
              attachmentId: r.id,
              err,
            });
          }
        }
        if (claimed.length < READ_PURGE_BATCH) return deleted;
      }
    });
  }

  /**
   * 删除过期（`expires_at < now()`）且从未绑定到会话的附件：先把行认领为 `deleting`（`FOR UPDATE SKIP LOCKED`，
   * 多副本并发时互不重复），再删对象、删行。删对象失败的行保持 `deleting`，下次运行重试。
   * 技能包上传（过期未用掉的，或已被 `POST /skills` 用掉、`expires_at` 置为当时的）同样由这里删 zip；
   * 解出的文件 `skills/<id>/` 只在没有任何技能版本引用时一并删除。
   * 没有对象存储时什么也不做。返回删除的附件数。
   */
  // org-filter: deployment-wide cleanup job across all orgs; each claimed row is deleted by its
  // own id and handled in its own org (r.org_id)
  async deleteExpired(): Promise<number> {
    return asPlatform("deployment-wide cleanup job across all orgs", async () => {
      if (!this.storage.available) return 0;
      let deleted = 0;
      const failed: string[] = [];
      for (;;) {
        const claimed = await this.db
          .updateTable("attachments")
          .set({ status: "deleting" })
          .where(
            "id",
            "in",
            this.db
              .selectFrom("attachments")
              .select("id")
              .where("conversation_id", "is", null)
              // chat rows are the file library's now (a migrated draft's object is a blob's)
              .where("purpose", "<>", "chat")
              .where("expires_at", "<", sql<Date>`now()`)
              .$if(failed.length > 0, (q) => q.where("id", "not in", failed))
              .orderBy("expires_at")
              .limit(CLEANUP_BATCH)
              .forUpdate()
              .skipLocked(),
          )
          .returning(["id", "org_id", "object_key", "purpose"])
          .execute();
        if (claimed.length === 0) return deleted;
        for (const r of claimed) {
          try {
            const store = this.storage.kernel(r.org_id);
            await store.delete(r.object_key);
            if (r.purpose === "skill-package") {
              // delete the unpacked files only when no version references them (a failed or unused upload)
              const prefix = skillFilesPrefix(r.id);
              const used = await this.db
                .selectFrom("skill_versions")
                .select("skill_id")
                .where("object_prefix", "=", prefix)
                .executeTakeFirst();
              if (!used) await store.deletePrefix(prefix);
            }
            await this.db
              .deleteFrom("attachments")
              .where("id", "=", r.id)
              .where("conversation_id", "is", null)
              .execute();
            deleted++;
          } catch (err) {
            failed.push(r.id);
            this.log.warn("cannot delete expired attachment; will retry", {
              orgId: r.org_id,
              attachmentId: r.id,
              err,
            });
          }
        }
        if (claimed.length < CLEANUP_BATCH) return deleted;
      }
    });
  }
}

/**
 * The hourly attachment jobs, each once per tick across replicas (provided only under
 * `WorkerModule`): the cleanup of expired unbound attachments and the purge of `read` copies of
 * deleted conversations.
 */
@Injectable()
export class AttachmentCleanupJob {
  constructor(
    @Inject(AttachmentsService)
    private readonly attachments: Pick<AttachmentsService, "deleteExpired" | "purgeRead">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("0 * * * *", { name: ATTACHMENT_CLEANUP_JOB })
  async run(): Promise<void> {
    const n = await this.attachments.deleteExpired();
    if (n > 0) this.log.info("expired attachments deleted", { count: n });
  }

  @LockedCron("0 * * * *", { name: ATTACHMENT_READ_PURGE_JOB })
  async purgeRead(): Promise<void> {
    const n = await this.attachments.purgeRead();
    if (n > 0) this.log.info("read attachments of deleted conversations purged", { count: n });
  }
}
