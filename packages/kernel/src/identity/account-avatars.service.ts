import { randomUUID } from "node:crypto";
import type { PresignedUpload } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  AGENT_AVATAR_CONTENT_TYPES,
  AGENT_AVATAR_DOWNLOAD_TTL_SECONDS,
  AGENT_AVATAR_MAX_BYTES,
  AGENT_AVATAR_TTL_HOURS,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  MAX_PENDING_AGENT_AVATARS,
  normalizeContentType,
  sniffMatches,
} from "../conversations/attachments.service.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { StorageService } from "../storage/storage.service.js";

/** The hourly cleanup of expired, unbound account avatar uploads (`@LockedCron`). */
export const ACCOUNT_AVATAR_CLEANUP_JOB = "account-avatar-cleanup";
/** Rows one claim of the cleanup takes. */
const CLEANUP_BATCH = 100;
/** How many leading bytes `prepare` reads to check the image signature. */
const SNIFF_BYTES = 64;

/** The object key under `deployment/` (the kernel adds that prefix). */
const objectKey = (accountId: string, uploadId: string) =>
  `account-avatars/${accountId}/${uploadId}`;

const notFound = () => new ApiError("attachment.not_found", "Avatar upload not found");

const isAvatarType = (contentType: string) =>
  (AGENT_AVATAR_CONTENT_TYPES as readonly string[]).includes(contentType);

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * A person's own avatar uploads (account profile spec §5.3): register → the browser uploads to
 * the presigned URL → `prepare` checks the object → `bind` in the profile write's transaction.
 * Bytes live under `deployment/account-avatars/<accountId>/<uploadId>`; an unbound upload carries
 * `expires_at` and is swept by {@link AccountAvatarCleanupJob}. No in-process state.
 */
@Injectable()
export class AccountAvatarsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService)
    private readonly storage: Pick<StorageService, "available" | "assertAvailable" | "deployment">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Registers a `pending` upload (intent first: the row, expiring in 24 h, is written before the
   * presigned upload is returned, so a crash leaves only an expiring row). A type other than
   * png / jpeg / webp → `attachment.type_not_allowed`; over 2 MB → `attachment.too_large`; already
   * 10 pending uploads → `attachment.too_many_pending` (soft: concurrent calls may pass together);
   * no object store → `storage.unavailable`.
   */
  async createUpload(
    accountId: string,
    input: { contentType: string; size: number },
  ): Promise<{ uploadId: string; upload: PresignedUpload; expiresAt: string }> {
    this.storage.assertAvailable();
    const contentType = normalizeContentType(input.contentType);
    if (!isAvatarType(contentType)) {
      throw new ApiError(
        "attachment.type_not_allowed",
        `Avatar type ${JSON.stringify(contentType)} is not allowed; use PNG, JPEG or WebP`,
      );
    }
    if (input.size > AGENT_AVATAR_MAX_BYTES) {
      throw new ApiError(
        "attachment.too_large",
        `Avatar is ${input.size} bytes, over the limit of ${AGENT_AVATAR_MAX_BYTES} bytes`,
      );
    }
    const pending = await this.db
      .selectFrom("account_avatar_uploads")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("account_id", "=", accountId)
      .where("status", "=", "pending")
      .where(sql<boolean>`expires_at is null or expires_at > now()`)
      .executeTakeFirst();
    if (Number(pending?.n ?? 0) >= MAX_PENDING_AGENT_AVATARS) {
      throw new ApiError(
        "attachment.too_many_pending",
        `Too many unfinished avatar uploads (at most ${MAX_PENDING_AGENT_AVATARS}); finish or wait for them first`,
      );
    }
    const uploadId = randomUUID();
    const key = objectKey(accountId, uploadId);
    await this.db
      .insertInto("account_avatar_uploads")
      .values({
        id: uploadId,
        account_id: accountId,
        storage_key: key,
        content_type: contentType,
        size: input.size,
        status: "pending",
        expires_at: sql<Date>`now() + make_interval(hours => ${AGENT_AVATAR_TTL_HOURS})`,
      })
      .execute();
    const upload = await this.storage.deployment().presignPut(key, {
      contentType,
      maxSize: input.size,
      ttlSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
    });
    return {
      uploadId,
      upload,
      expiresAt: new Date(Date.now() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Makes the account's upload ready to be bound (outside any transaction: it reads the object
   * store). Not the account's, or expired → `attachment.not_found`. A `pending` upload is checked
   * against the store: no object → `attachment.not_ready`; a size other than declared, a stored
   * type or an image signature other than declared → the object is deleted and
   * `attachment.too_large` / `attachment.not_ready` / `attachment.type_not_allowed`. The expiry of
   * an unbound upload is extended so the cleanup cannot remove it before {@link bind} runs.
   */
  async prepare(accountId: string, uploadId: string): Promise<void> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("account_avatar_uploads")
      .select([
        "status",
        "content_type",
        "size",
        "storage_key",
        sql<boolean>`expires_at is not null and expires_at <= now()`.as("expired"),
      ])
      .where("id", "=", uploadId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (!row || row.expired || !isAvatarType(row.content_type)) throw notFound();
    if (row.status === "pending") {
      const size = await this.check(row.storage_key, row.content_type, Number(row.size));
      await this.db
        .updateTable("account_avatar_uploads")
        .set({ status: "ready", size })
        .where("id", "=", uploadId)
        .where("status", "=", "pending")
        .execute();
    }
    await this.db
      .updateTable("account_avatar_uploads")
      .set({ expires_at: sql<Date>`now() + make_interval(hours => ${AGENT_AVATAR_TTL_HOURS})` })
      .where("id", "=", uploadId)
      .where("expires_at", "is not", null)
      .execute();
  }

  /** The store-side checks of {@link prepare}; returns the stored size. */
  private async check(key: string, contentType: string, declared: number): Promise<number> {
    const store = this.storage.deployment();
    const head = await store.head(key);
    if (!head) throw new ApiError("attachment.not_ready", "The avatar has not been uploaded yet");
    const reject = async (err: ApiError): Promise<never> => {
      await store.delete(key);
      throw err;
    };
    if (head.size !== declared) {
      await reject(
        head.size > declared
          ? new ApiError("attachment.too_large", "Uploaded avatar is larger than declared")
          : new ApiError(
              "attachment.not_ready",
              `Uploaded avatar is ${head.size} bytes, but ${declared} bytes were declared; upload it again`,
            ),
      );
    }
    if (normalizeContentType(head.contentType) !== contentType) {
      await reject(
        new ApiError("attachment.type_not_allowed", "Uploaded avatar type does not match"),
      );
    }
    const got = await store.get(key, {
      range: { start: 0, end: Math.max(0, Math.min(declared, SNIFF_BYTES) - 1) },
    });
    const data = got ? await readAll(got.body) : new Uint8Array();
    if (!sniffMatches(contentType, data.subarray(0, SNIFF_BYTES))) {
      await reject(
        new ApiError("attachment.type_not_allowed", `Uploaded avatar is not ${contentType}`),
      );
    }
    return head.size;
  }

  /**
   * In the caller's transaction: binds the account's ready, unexpired upload (row lock; its
   * `expires_at` is cleared, so the cleanup keeps it) and expires every other upload of the
   * account, the previous avatar among them. `null` binds none (the avatar is removed). An upload
   * that is not the account's ready one → `attachment.not_ready` while pending, else
   * `attachment.not_found`; binding the bound upload again is fine.
   */
  @Transactional({ propagation: "mandatory" })
  async bind(accountId: string, uploadId: string | null): Promise<void> {
    const trx = this.db.db;
    if (uploadId !== null) {
      const row = await trx
        .selectFrom("account_avatar_uploads")
        .select([
          "status",
          sql<boolean>`expires_at is not null and expires_at <= now()`.as("expired"),
        ])
        .where("id", "=", uploadId)
        .where("account_id", "=", accountId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.expired) throw notFound();
      if (row.status !== "ready") {
        throw new ApiError("attachment.not_ready", "The avatar has not been uploaded yet");
      }
      await trx
        .updateTable("account_avatar_uploads")
        .set({ expires_at: null })
        .where("id", "=", uploadId)
        .execute();
    }
    await trx
      .updateTable("account_avatar_uploads")
      .set({ expires_at: sql<Date>`now()` })
      .where("account_id", "=", accountId)
      .$if(uploadId !== null, (q) => q.where("id", "<>", uploadId as string))
      .where(sql<boolean>`expires_at is null or expires_at > now()`)
      .execute();
  }

  /**
   * A short-lived presigned GET (inline, with the checked type) of the account's bound upload;
   * null when there is none, or its object is gone or no longer the size checked.
   */
  async objectUrl(accountId: string, uploadId: string): Promise<string | null> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("account_avatar_uploads")
      .select(["storage_key", "content_type", "size"])
      .where("id", "=", uploadId)
      .where("account_id", "=", accountId)
      .where("status", "=", "ready")
      .where("expires_at", "is", null)
      .executeTakeFirst();
    if (!row) return null;
    const store = this.storage.deployment();
    const head = await store.head(row.storage_key);
    if (!head || head.size !== Number(row.size)) return null;
    return store.presignGet(row.storage_key, {
      ttlSeconds: AGENT_AVATAR_DOWNLOAD_TTL_SECONDS,
      disposition: "inline",
      responseContentType: row.content_type,
    });
  }

  /**
   * Deletes expired uploads (`expires_at < now()`), bound ones never: each batch of 100 is claimed
   * with `FOR UPDATE SKIP LOCKED` in its own transaction, so a concurrent {@link bind} of a claimed
   * row waits and then finds it gone; each object is deleted, then its row. A failed object delete
   * keeps the row for the next run. Does nothing without an object store. Returns the rows deleted.
   */
  async deleteExpired(): Promise<number> {
    if (!this.storage.available) return 0;
    let deleted = 0;
    const failed: string[] = [];
    for (;;) {
      const r = await this.deleteBatch(failed);
      deleted += r.deleted;
      if (r.claimed < CLEANUP_BATCH) return deleted;
    }
  }

  @Transactional()
  private async deleteBatch(failed: string[]): Promise<{ claimed: number; deleted: number }> {
    const trx = this.db.db;
    const claimed = await trx
      .selectFrom("account_avatar_uploads")
      .select(["id", "account_id", "storage_key"])
      .where("expires_at", "<", sql<Date>`now()`)
      .$if(failed.length > 0, (q) => q.where("id", "not in", failed))
      .orderBy("expires_at")
      .limit(CLEANUP_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    const store = this.storage.deployment();
    let deleted = 0;
    for (const r of claimed) {
      try {
        await store.delete(r.storage_key);
      } catch (err) {
        failed.push(r.id);
        this.log.warn("cannot delete expired account avatar upload; will retry", {
          accountId: r.account_id,
          uploadId: r.id,
          err,
        });
        continue;
      }
      await trx.deleteFrom("account_avatar_uploads").where("id", "=", r.id).execute();
      deleted++;
    }
    return { claimed: claimed.length, deleted };
  }
}

/** Deletes expired account avatar uploads once per hour across replicas; the worker role's. */
@Injectable()
export class AccountAvatarCleanupJob {
  constructor(
    @Inject(AccountAvatarsService)
    private readonly avatars: Pick<AccountAvatarsService, "deleteExpired">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("0 * * * *", { name: ACCOUNT_AVATAR_CLEANUP_JOB })
  async run(): Promise<void> {
    const n = await this.avatars.deleteExpired();
    if (n > 0) this.log.info("expired account avatar uploads deleted", { count: n });
  }
}
