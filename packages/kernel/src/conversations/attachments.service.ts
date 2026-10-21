import { randomUUID } from "node:crypto";
import {
  CapabilityUnavailableError,
  IMAGE_MEDIA_TYPES,
  type ImageMediaType,
  type Logger,
  MEDIA_LIMITS,
  type PresignedUpload,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { MediaBytes } from "../runtime/context/build.js";
import type { StorageService } from "../storage/storage.service.js";
import type { LogContentBlock } from "./events.js";

type Trx = Transaction<KernelDatabase>;

/** 预签名上传的有效期（秒）。 */
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 900;
/** 下载跳转的预签名有效期（秒）。 */
export const ATTACHMENT_DOWNLOAD_TTL_SECONDS = 300;

/** 维护任务：清理过期未绑定的附件（任务名与 scheduler id 不含 `:`）。 */
export const ATTACHMENT_CLEANUP_JOB = "attachment-cleanup";
export const ATTACHMENT_CLEANUP_SCHEDULER_ID = "attachment-cleanup-hourly";
export const ATTACHMENT_CLEANUP_EVERY_MS = 3_600_000;
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

/** `POST /attachments` 的返回：浏览器按 `upload` 直传存储，然后调 finalize。 */
export interface CreatedAttachment {
  id: string;
  upload: PresignedUpload;
  /** 预签名上传的过期时间（ISO 8601）。 */
  expiresAt: string;
}

export interface AttachmentsDeps {
  db: KernelDb;
  storage: StorageService;
  config: () => KernelConfig;
  /** viewer 能否访问该会话（与会话流相同的规则）。 */
  canAccessConversation: (
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ) => Promise<boolean>;
  log: Pick<Logger, "info" | "warn">;
}

const notFound = () => new ApiError("attachment.not_found", "Attachment not found");

/** 去掉参数、转小写：`Text/Plain; charset=utf-8` → `text/plain`。 */
export const normalizeContentType = (ct: string): string =>
  (ct.split(";")[0] ?? "").trim().toLowerCase();

const isImage = (ct: string): ct is ImageMediaType =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(ct);

/** 对象键：只用附件 id，用户的文件名不进键。 */
const objectKey = (id: string) => `attachments/${id}`;

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
    default:
      return !head.includes(0);
  }
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * 对话附件（M5 T3）：登记 → 浏览器按预签名直传对象存储 → finalize 核对 → 发消息时绑定到会话。
 * 字节只在对象存储（`kernel/<orgId>/attachments/<id>`），日志里只有引用；构建模型请求时经 {@link fetchMedia} 取字节。
 * 无进程内状态，可多副本共用。
 */
export class AttachmentsService {
  constructor(private readonly d: AttachmentsDeps) {}

  /** 单个附件的大小上限：配置的 `maxBytes`，图片再受 `MEDIA_LIMITS.imageBytes` 限制。 */
  private limitFor(contentType: string): number {
    const { maxBytes } = this.d.config().attachments;
    return Math.min(
      maxBytes,
      isImage(contentType) ? MEDIA_LIMITS.imageBytes : MEDIA_LIMITS.documentBytes,
    );
  }

  /**
   * 登记一个附件（`pending`）并返回预签名上传：存储端按声明的大小与类型限制上传。
   * 类型不在 `attachments.allowedTypes` → `attachment.type_not_allowed`；超过上限 → `attachment.too_large`；
   * 没有对象存储 → `storage.unavailable`。
   */
  async create(
    orgId: string,
    accountId: string,
    input: { name: string; contentType: string; size: number },
  ): Promise<CreatedAttachment> {
    this.d.storage.assertAvailable();
    const cfg = this.d.config().attachments;
    const contentType = normalizeContentType(input.contentType);
    if (!(cfg.allowedTypes as readonly string[]).includes(contentType)) {
      throw new ApiError(
        "attachment.type_not_allowed",
        `Attachment type ${JSON.stringify(contentType)} is not allowed`,
      );
    }
    const limit = this.limitFor(contentType);
    if (input.size > limit) {
      throw new ApiError(
        "attachment.too_large",
        `Attachment is ${input.size} bytes, over the limit of ${limit} bytes`,
      );
    }
    const id = randomUUID();
    const key = objectKey(id);
    const upload = await this.d.storage.kernel(orgId).presignPut(key, {
      contentType,
      maxSize: input.size,
      ttlSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
    });
    await this.d.db
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
        expires_at: sql<Date>`now() + make_interval(hours => ${cfg.unboundTtlHours})`,
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
    this.d.storage.assertAvailable();
    const row = await this.d.db
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
    const store = this.d.storage.kernel(orgId);
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
    const got = await store.get(row.object_key, {
      range: { start: 0, end: Math.max(0, Math.min(view.size, SNIFF_BYTES) - 1) },
    });
    const start = got ? await readAll(got.body) : new Uint8Array();
    if (!sniffMatches(view.contentType, start)) {
      await reject(
        new ApiError(
          "attachment.type_not_allowed",
          `Uploaded file content is not ${view.contentType}`,
        ),
      );
    }
    await this.d.db
      .updateTable("attachments")
      .set({ status: "ready" })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .execute();
    return view;
  }

  /**
   * 下载地址（预签名，{@link ATTACHMENT_DOWNLOAD_TTL_SECONDS} 秒）：已绑定的附件要求能访问其会话，
   * 未绑定的只有上传者；否则 `attachment.not_found`。
   */
  async downloadUrl(orgId: string, accountId: string, id: string): Promise<string> {
    this.d.storage.assertAvailable();
    const row = await this.d.db
      .selectFrom("attachments")
      .select(["account_id", "conversation_id", "name", "object_key"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .executeTakeFirst();
    if (!row) throw notFound();
    const allowed =
      row.conversation_id === null
        ? row.account_id === accountId
        : await this.d.canAccessConversation(orgId, row.conversation_id, accountId);
    if (!allowed) throw notFound();
    return this.d.storage.kernel(orgId).presignGet(row.object_key, {
      ttlSeconds: ATTACHMENT_DOWNLOAD_TTL_SECONDS,
      downloadName: row.name,
    });
  }

  /**
   * 发消息时在调用方事务里绑定附件（行锁），返回写进 user_message 的媒体块（`ref`，按 ids 顺序，重复的只算一次）：
   * - 超过 `attachments.maxPerMessage` → `validation_failed`；
   * - 不存在、不是发送者上传的、已绑定到别的会话、未绑定且已过期 → `attachment.not_found`；
   * - 还没 finalize → `attachment.not_ready`。
   * 已绑定到本会话的（重试）照常返回块。
   */
  async bindForMessage(
    trx: Trx,
    orgId: string,
    conversationId: string,
    accountId: string,
    ids: readonly string[],
  ): Promise<LogContentBlock[]> {
    const unique = [...new Set(ids)];
    const max = this.d.config().attachments.maxPerMessage;
    if (ids.length > max) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "files", message: `At most ${max} files per message` },
      ]);
    }
    if (unique.length === 0) return [];
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
        throw new ApiError(
          "attachment.not_found",
          `Attachment ${id} not found, expired, or already used in another conversation`,
        );
      }
      if (r.status !== "ready") {
        throw new ApiError("attachment.not_ready", `Attachment ${id} has not been finalized`);
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

  /**
   * 构建模型请求时取附件字节：只取绑定在该会话、已 ready 的附件。取不到（行或对象已不存在、没有对象存储、
   * 读取失败）的为 null，构建时换成「不再可用」占位。
   */
  async fetchMedia(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
  ): Promise<Map<string, MediaBytes | null>> {
    const out = new Map<string, MediaBytes | null>();
    if (ids.length === 0) return out;
    const rows = await this.d.db
      .selectFrom("attachments")
      .select(["id", "content_type", "object_key", "size"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("status", "=", "ready")
      .where("id", "in", [...ids])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    await Promise.all(
      ids.map(async (id) => {
        const r = byId.get(id);
        if (!r) return out.set(id, null);
        try {
          const got = await this.d.storage.kernel(orgId).get(r.object_key);
          // 大小与 finalize 核对过的不一致（预签名表单在有效期内被再次使用）→ 按取不到处理
          if (!got || got.head.size !== Number(r.size)) {
            await got?.body.cancel().catch(() => {});
            return out.set(id, null);
          }
          const data = await readAll(got.body);
          out.set(
            id,
            data.byteLength === Number(r.size) ? { mediaType: r.content_type, data } : null,
          );
        } catch (err) {
          if (!(err instanceof CapabilityUnavailableError)) {
            this.d.log.warn("cannot read attachment for model request", {
              orgId,
              conversationId,
              attachmentId: id,
              err,
            });
          }
          out.set(id, null);
        }
      }),
    );
    return out;
  }

  /**
   * 删除过期（`expires_at < now()`）且从未绑定到会话的附件：先把行认领为 `deleting`（`FOR UPDATE SKIP LOCKED`，
   * 多副本并发时互不重复），再删对象、删行。删对象失败的行保持 `deleting`，下次运行重试。
   * 没有对象存储时什么也不做。返回删除的附件数。
   */
  async deleteExpired(): Promise<number> {
    if (!this.d.storage.available) return 0;
    let deleted = 0;
    const failed: string[] = [];
    for (;;) {
      const claimed = await this.d.db
        .updateTable("attachments")
        .set({ status: "deleting" })
        .where(
          "id",
          "in",
          this.d.db
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
        .returning(["id", "org_id", "object_key"])
        .execute();
      if (claimed.length === 0) return deleted;
      for (const r of claimed) {
        try {
          await this.d.storage.kernel(r.org_id).delete(r.object_key);
          await this.d.db
            .deleteFrom("attachments")
            .where("id", "=", r.id)
            .where("conversation_id", "is", null)
            .execute();
          deleted++;
        } catch (err) {
          failed.push(r.id);
          this.d.log.warn("cannot delete expired attachment; will retry", {
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
