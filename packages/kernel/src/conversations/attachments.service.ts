import { randomUUID } from "node:crypto";
import {
  IMAGE_MEDIA_TYPES,
  type ImageMediaType,
  MEDIA_LIMITS,
  type PresignedUpload,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { AttachmentPurpose } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { MediaBytes, MediaInfo } from "../runtime/context/build.js";
import { StorageService } from "../storage/storage.service.js";
import { ConversationAccess } from "./access.js";
import type { LogContentBlock } from "./events.js";

/** 预签名上传的有效期（秒）。尽量短：表单在有效期内可被再次使用（内容替换由 etag 核对兜底）。 */
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 300;
/** 下载跳转的预签名有效期（秒）；不短于 {@link ATTACHMENT_DOWNLOAD_CACHE_SECONDS}（浏览器缓存的跳转仍可用）。 */
export const ATTACHMENT_DOWNLOAD_TTL_SECONDS = 300;
/** 下载 302 的 `Cache-Control: private, max-age=…`（秒）：同一页面里缩略图可复用跳转地址。 */
export const ATTACHMENT_DOWNLOAD_CACHE_SECONDS = 60;
/** 同一账号在一个组织里最多的未 finalize 附件数（超过 → 429 `attachment.too_many_pending`）。 */
export const MAX_PENDING_ATTACHMENTS = 50;

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
/**
 * 技能包解出的文件在 `kernel/<orgId>/` 下的前缀：按上传 id，同一上传重试写到同一批键（幂等），
 * 并发处理同一上传也不会互相覆盖出不同内容。版本行记下这个前缀（`skill_versions.object_prefix`）。
 */
export const skillFilesPrefix = (uploadId: string) => `skills/${uploadId}/`;

/** 周期任务：每小时清理过期未绑定的附件（`@LockedCron`）。 */
export const ATTACHMENT_CLEANUP_JOB = "attachment-cleanup";
/** The retired BullMQ repeatable scheduler of the cleanup (removed from Redis at worker start). */
export const ATTACHMENT_CLEANUP_SCHEDULER_ID = "attachment-cleanup-hourly";
/** 每批认领的行数。 */
const CLEANUP_BATCH = 100;
/** finalize 时读取开头多少字节核对文件签名。 */
const SNIFF_BYTES = 1024;

/** 附件元数据（finalize 的返回）。 */
export interface AttachmentView {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

/** 附件上限（`GET /attachments/limits`）：网页据此在上传前预检。 */
export interface AttachmentLimits {
  /** 允许的内容类型。 */
  types: string[];
  /** 非图片的单个上限（字节）。 */
  maxBytes: number;
  /** 图片的单个上限（字节，另受 `MEDIA_LIMITS.imageBytes` 限制）。 */
  imageMaxBytes: number;
  /** 单条消息最多附件数。 */
  maxPerMessage: number;
  /** 单次模型请求里媒体原始字节的预算（网页据此在发送前提醒总大小）。 */
  requestMediaBytes: number;
  /** 部署是否配置了对象存储；为 false 时上传不可用。 */
  available: boolean;
}

/** {@link AttachmentsService.openForConversation} 的结果。 */
export interface OpenedAttachment {
  name: string;
  contentType: string;
  size: number;
  body: ReadableStream<Uint8Array>;
}

/** `POST /attachments` 的返回：浏览器按 `upload` 直传存储，然后调 finalize。 */
export interface CreatedAttachment {
  id: string;
  upload: PresignedUpload;
  /** 预签名上传的过期时间（ISO 8601）。 */
  expiresAt: string;
}

const notFound = () => new ApiError("attachment.not_found", "Attachment not found");

/** 去掉参数、转小写：`Text/Plain; charset=utf-8` → `text/plain`。 */
export const normalizeContentType = (ct: string): string =>
  (ct.split(";")[0] ?? "").trim().toLowerCase();

const isImage = (ct: string): ct is ImageMediaType =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(ct);

/** 对象键：只用附件 id，用户的文件名不进键。技能包另放 `skill-packages/<id>`。 */
const objectKey = (id: string, purpose: AttachmentPurpose = "chat") =>
  purpose === "chat" ? `attachments/${id}` : `skill-packages/${id}`;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** 文件开头是否与声明的类型相符（图片与 PDF 看签名，文本不能含 NUL）。 */
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
      // 本地文件头，或空 zip 的中央目录结尾
      return (
        startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])
      );
    default:
      return !head.includes(0);
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
 * 对话附件（M5 T3）：登记 → 浏览器按预签名直传对象存储 → finalize 核对 → 发消息时绑定到会话。
 * 字节只在对象存储（`kernel/<orgId>/attachments/<id>`），日志里只有引用；构建模型请求时经 {@link fetchMedia} 取字节。
 * 无进程内状态，可多副本共用。
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
  ) {}

  /** 单个附件的大小上限：配置的 `maxBytes`，图片再受 `MEDIA_LIMITS.imageBytes` 限制。 */
  private limitFor(contentType: string): number {
    const { maxBytes } = this.config.get().attachments;
    return Math.min(
      maxBytes,
      isImage(contentType) ? MEDIA_LIMITS.imageBytes : MEDIA_LIMITS.documentBytes,
    );
  }

  /** 当前配置下的上限（不需要对象存储）。 */
  limits(): AttachmentLimits {
    const cfg = this.config.get().attachments;
    return {
      types: [...cfg.allowedTypes],
      maxBytes: Math.min(cfg.maxBytes, MEDIA_LIMITS.documentBytes),
      imageMaxBytes: Math.min(cfg.maxBytes, MEDIA_LIMITS.imageBytes),
      maxPerMessage: cfg.maxPerMessage,
      requestMediaBytes: cfg.requestMediaBytes,
      available: this.storage.available,
    };
  }

  /**
   * 登记一个附件（`pending`）并返回预签名上传：存储端按声明的大小与类型限制上传。
   * 类型不在 `attachments.allowedTypes` → `attachment.type_not_allowed`；超过上限 → `attachment.too_large`；
   * 该账号在组织里已有 {@link MAX_PENDING_ATTACHMENTS} 个未 finalize 的附件 → `attachment.too_many_pending`
   * （软上限：并发登记可能略超）；没有对象存储 → `storage.unavailable`。
   */
  async create(
    orgId: string,
    accountId: string,
    input: { name: string; contentType: string; size: number },
    purpose: AttachmentPurpose = "chat",
  ): Promise<CreatedAttachment> {
    this.storage.assertAvailable();
    const cfg = this.config.get().attachments;
    const contentType = normalizeContentType(input.contentType);
    const skill = purpose === "skill-package";
    if (
      skill
        ? contentType !== SKILL_PACKAGE_CONTENT_TYPE
        : !(cfg.allowedTypes as readonly string[]).includes(contentType)
    ) {
      throw new ApiError(
        "attachment.type_not_allowed",
        `Attachment type ${JSON.stringify(contentType)} is not allowed`,
      );
    }
    const limit = skill ? SKILL_PACKAGE_UPLOAD_MAX_BYTES : this.limitFor(contentType);
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
      .where("status", "=", "pending")
      .where("purpose", "=", purpose)
      .executeTakeFirst();
    const maxPending = skill ? MAX_PENDING_SKILL_PACKAGES : MAX_PENDING_ATTACHMENTS;
    if (Number(pending?.n ?? 0) >= maxPending) {
      throw new ApiError(
        "attachment.too_many_pending",
        `Too many unfinished uploads (at most ${maxPending}); finish or wait for them first`,
      );
    }
    const id = randomUUID();
    const key = objectKey(id, purpose);
    const ttlHours = skill ? SKILL_PACKAGE_TTL_HOURS : cfg.unboundTtlHours;
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
      .where("status", "=", "pending")
      .execute();
    return view;
  }

  /**
   * 下载地址（预签名，{@link ATTACHMENT_DOWNLOAD_TTL_SECONDS} 秒）：已绑定的附件要求能访问其会话，
   * 未绑定的只有上传者；否则 `attachment.not_found`。只有图片与 PDF 以 `inline` 打开，其余一律 `attachment`
   * （即使存储里的类型被改成 text/html 也不会在页面里渲染）；响应类型按 finalize 核对过的类型返回。
   */
  async downloadUrl(orgId: string, accountId: string, id: string): Promise<string> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("attachments")
      .select(["account_id", "conversation_id", "name", "content_type", "object_key", "etag"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .where("purpose", "=", "chat")
      .executeTakeFirst();
    if (!row) throw notFound();
    const allowed =
      row.conversation_id === null
        ? row.account_id === accountId
        : await this.access.isAccessible(orgId, row.conversation_id, accountId);
    if (!allowed) throw notFound();
    const store = this.storage.kernel(orgId);
    const head = await store.head(row.object_key);
    if (!head || !this.sameContent(row.etag, head.etag, { orgId, attachmentId: id })) {
      throw notFound();
    }
    const inline = isImage(row.content_type) || row.content_type === "application/pdf";
    return store.presignGet(row.object_key, {
      ttlSeconds: ATTACHMENT_DOWNLOAD_TTL_SECONDS,
      downloadName: row.name,
      disposition: inline ? "inline" : "attachment",
      responseContentType: row.content_type,
    });
  }

  /**
   * 绑定在该会话、已 ready 的附件（id 与原始文件名），按上传时间、id 排序（沙箱同步按这个顺序分配文件名）。
   */
  async listForConversation(
    orgId: string,
    conversationId: string,
  ): Promise<{ id: string; name: string }[]> {
    return this.db
      .selectFrom("attachments")
      .select(["id", "name"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", "chat")
      .where("status", "=", "ready")
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  /**
   * 读取一个绑定在该会话、已 ready 的附件（沙箱同步等内核内部用途）：没有行、未绑定到该会话、对象已不在、
   * 大小或 etag 与 finalize 时不符 → null。其余错误（存储不可用等）照常抛出。调用方负责读完或取消 `body`。
   */
  async openForConversation(
    orgId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<OpenedAttachment | null> {
    const row = await this.db
      .selectFrom("attachments")
      .select(["name", "content_type", "object_key", "size", "etag"])
      .where("id", "=", attachmentId)
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", "chat")
      .where("status", "=", "ready")
      .executeTakeFirst();
    if (!row) return null;
    const got = await this.storage.kernel(orgId).get(row.object_key);
    if (!got) return null;
    const size = Number(row.size);
    if (
      got.head.size !== size ||
      !this.sameContent(row.etag, got.head.etag, { orgId, conversationId, attachmentId })
    ) {
      await got.body.cancel().catch(() => {});
      return null;
    }
    return { name: row.name, contentType: row.content_type, size, body: got.body };
  }

  /**
   * 发消息时在调用方事务里绑定附件（行锁），返回写进 user_message 的媒体块（`ref`，按 ids 顺序）：
   * - 超过 `attachments.maxPerMessage`、或同一个 id 出现多次 → `validation_failed`；
   * - 不存在、不是发送者上传的、已绑定到别的会话、未绑定且已过期 → `attachment.not_found`；
   * - 还没 finalize → `attachment.not_ready`。
   * 后两种的 details 为 `[{ path: "files", message, attachmentId }]`，网页据此标出对应条目。
   * 已绑定到本会话的（重试）照常返回块。
   */
  @Transactional({ propagation: "mandatory" })
  async bindForMessage(
    orgId: string,
    conversationId: string,
    accountId: string,
    ids: readonly string[],
  ): Promise<LogContentBlock[]> {
    const unique = [...new Set(ids)];
    const max = this.config.get().attachments.maxPerMessage;
    if (ids.length > max) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "files", message: `At most ${max} files per message` },
      ]);
    }
    if (unique.length !== ids.length) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "files", message: "Each file may appear only once per message" },
      ]);
    }
    if (unique.length === 0) return [];
    const trx = this.db.db;
    const rows = await trx
      .selectFrom("attachments")
      .select([
        "id",
        "account_id",
        "conversation_id",
        "name",
        "content_type",
        "status",
        sql<boolean>`expires_at IS NOT NULL AND expires_at <= now()`.as("expired"),
      ])
      .where("org_id", "=", orgId)
      .where("id", "in", unique)
      // 技能包上传不能当附件发出（当作不存在）
      .where("purpose", "=", "chat")
      .orderBy("id")
      .forUpdate()
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const blocks: LogContentBlock[] = [];
    const toBind: string[] = [];
    for (const id of unique) {
      const r = byId.get(id);
      if (
        !r ||
        r.account_id !== accountId ||
        r.status === "deleting" ||
        (r.conversation_id !== null && r.conversation_id !== conversationId) ||
        (r.conversation_id === null && r.expired)
      ) {
        const message = `Attachment ${id} not found, expired, or already used in another conversation`;
        throw new ApiError("attachment.not_found", message, [
          { path: "files", message, attachmentId: id },
        ]);
      }
      if (r.status !== "ready") {
        const message = `Attachment ${id} has not been finalized`;
        throw new ApiError("attachment.not_ready", message, [
          { path: "files", message, attachmentId: id },
        ]);
      }
      if (r.conversation_id === null) toBind.push(id);
      const source = { kind: "ref" as const, attachmentId: id };
      blocks.push(
        isImage(r.content_type)
          ? { type: "image", mediaType: r.content_type, source, name: r.name }
          : {
              type: "document",
              mediaType: r.content_type as Extract<
                LogContentBlock,
                { type: "document" }
              >["mediaType"],
              source,
              name: r.name,
            },
      );
    }
    if (toBind.length > 0) {
      await trx
        .updateTable("attachments")
        .set({ conversation_id: conversationId, expires_at: null })
        .where("id", "in", toBind)
        .execute();
    }
    return blocks;
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
   * 构建模型请求时查附件行的声明信息（只含绑定在该会话、已 ready 的）：大小与 PDF 页数。
   * 没有行的不在结果里；查询失败照常抛出。
   */
  async mediaInfo(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
  ): Promise<Map<string, MediaInfo>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("attachments")
      .select(["id", "size", "pages", "etag"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", "chat")
      .where("status", "=", "ready")
      .where("id", "in", [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { size: Number(r.size), pages: r.pages, etag: r.etag }]));
  }

  /**
   * 构建模型请求时取附件字节：只取绑定在该会话、已 ready 的附件。只有「确定不存在」才为 null：没有行、对象已不在、
   * 大小或 etag 与 finalize 时不符（内容被替换，记 warn）。其余错误（存储不可用、网络错误）一律抛出（Ruling M4），
   * 由调用方按可重试处理，不会变成占位。`caps` 里的附件只按范围读开头若干字节（`text/*` 封顶，更后面的不取）。
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
      .where("purpose", "=", "chat")
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
        const want = cap !== undefined && cap < Number(r.size) ? Math.max(1, cap) : Number(r.size);
        const got = await store.get(
          r.object_key,
          want < Number(r.size) ? { range: { start: 0, end: want - 1 } } : undefined,
        );
        if (!got) return out.set(id, null);
        const where = { orgId, conversationId, attachmentId: id };
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
        out.set(id, data.byteLength === want ? { mediaType: r.content_type, data } : null);
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
      .execute();
  }

  /**
   * 删除过期（`expires_at < now()`）且从未绑定到会话的附件：先把行认领为 `deleting`（`FOR UPDATE SKIP LOCKED`，
   * 多副本并发时互不重复），再删对象、删行。删对象失败的行保持 `deleting`，下次运行重试。
   * 技能包上传（过期未用掉的，或已被 `POST /skills` 用掉、`expires_at` 置为当时的）同样由这里删 zip；
   * 解出的文件 `skills/<id>/` 只在没有任何技能版本引用时一并删除。
   * 没有对象存储时什么也不做。返回删除的附件数。
   */
  async deleteExpired(): Promise<number> {
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
            // 解出的文件没被任何版本引用（处理中途失败、或从未用掉）才删
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
  }
}

/** The hourly cleanup of expired unbound attachments, once per tick across replicas. */
@Injectable()
export class AttachmentCleanupJob {
  constructor(
    @Inject(AttachmentsService)
    private readonly attachments: Pick<AttachmentsService, "deleteExpired">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("0 * * * *", { name: ATTACHMENT_CLEANUP_JOB })
  async run(): Promise<void> {
    const n = await this.attachments.deleteExpired();
    if (n > 0) this.log.info("expired attachments deleted", { count: n });
  }
}
