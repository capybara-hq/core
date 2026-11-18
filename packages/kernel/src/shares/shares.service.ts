import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import { ConversationAccess } from "../conversations/access.js";
import { attachmentContentMatches } from "../conversations/attachments.service.js";
import { ConversationFiles } from "../conversations/files.js";
import type { FileShareRevokeReason, KernelDatabase } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { can } from "../orgs/roles.js";
import { parseOrgSettings, readStoredOrgSettings } from "../orgs/settings.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StorageService } from "../storage/storage.service.js";
import { UUID_RE } from "../ui/registry.js";
import { creatorStillHasAccess } from "./liveness.js";
import {
  type ExternalSharingState,
  effectiveExternalSharing,
  readExternalSharing,
  readShareMaxExpiry,
} from "./settings.js";
import { newShareCode } from "./share-code.js";
import {
  SHARE_OBJECT_DELETE_JOB,
  type ShareObjectDeleteData,
  shareObjectDeleteJobId,
  shareObjectKey,
} from "./share-objects.js";

/**
 * Shares of conversation files (file sharing spec §1, §2): a share is a frozen snapshot of one
 * file, copied under `shares/<id>/<generation>` of the org's kernel prefix **before** the row that
 * names it is written (intent first: a crash leaves an orphan object the daily sweep frees, never a
 * row without its object). Freeing a snapshot is owed through the outbox by the transaction that
 * stops using it (a refresh, a revoke). Nothing is held in process memory; every read is live.
 */

/**
 * `live`: opens now. `suspended`: not revoked or expired, but it does not open now: an external
 * share while external sharing is off for the org, or its creator lost access to the file.
 */
export type ShareState = "live" | "expired" | "revoked" | "suspended";

export interface ShareView {
  id: string;
  code: string;
  audience: "internal" | "external";
  conversationId: string;
  fileId: string;
  sourcePath: string | null;
  name: string;
  contentType: string;
  size: number;
  generation: number;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  expiresAt: string | null;
  lastOpenedAt: string | null;
  state: ShareState;
  revokedAt: string | null;
  revokeReason: string | null;
  /**
   * A newer version of `sourcePath` was delivered after the snapshot's (refresh offered). In the
   * per-file list ({@link SharesService.forFile}) only a version whose object is still stored
   * counts; in the org and personal lists the event log alone decides (no storage reads).
   */
  newerVersion: boolean;
}

/** What the share dialog may offer: the effective external switch and the expiry maximum. */
export interface SharePolicy {
  external: ExternalSharingState;
  maxExpiryDays: number;
}

/** Who acts: a personal token's id for the audit, and the Platform tool's audit detail. */
export interface ShareActor {
  tokenId?: string | undefined;
  auditDetail?: Record<string, unknown> | undefined;
}

/** Revoked or expired shares stay in the lists this long (the "recent" section). */
export const SHARE_RECENT_DAYS = 7;
/** The most shares one list returns (newest first). */
export const SHARES_LIST_MAX = 500;
/** Attempts at a unique code before giving up (a collision is ~2^-59 per pair). */
const CODE_ATTEMPTS = 3;
/** The refresh lock's lifetime without renewal (renewed while the copy runs). */
const REFRESH_LOCK_TTL_MS = 30_000;
/** How long a refresh waits for another refresh of the same share. */
const REFRESH_LOCK_WAIT_MS = 10_000;

const notFound = () => new ApiError("share.not_found", "Share not found");
const fileUnavailable = (message = "The file is no longer available, so it cannot be shared") =>
  new ApiError("share.file_unavailable", message);
const conversationNotFound = () => new ApiError("conversation.not_found", "Conversation not found");

const externalNotAllowed = (state: ExternalSharingState): ApiError =>
  new ApiError(
    "share.external_not_allowed",
    state === "platform_denied"
      ? "External sharing is not allowed on this platform; a super admin must allow it first, then an org admin must turn it on in the organization settings."
      : "External sharing is off in this organization; an org admin can turn it on in the organization settings.",
  );

const expiryTooLong = (max: number): ApiError =>
  new ApiError(
    "share.expiry_too_long",
    `An external share must expire within ${max} day${max === 1 ? "" : "s"}; pick a shorter expiry.`,
  );

/** Whether `e` is the unique violation of `file_shares.code`. */
const isCodeConflict = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { code?: unknown }).code === "23505" &&
  (e as { constraint?: unknown }).constraint === "file_shares_code_key";

/** Not expired now (never-expiring included). */
const notExpired = (eb: ExpressionBuilder<KernelDatabase, "file_shares">) =>
  eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]);

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** A file to snapshot: where its bytes are, and what an upload's object must still match. */
interface SnapshotSource {
  id: string;
  name: string;
  contentType: string;
  objectKey: string;
  recorded?: { size: number; etag: string | null } | undefined;
}

@Injectable()
export class SharesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ConversationFiles)
    private readonly files: Pick<ConversationFiles, "file" | "identify" | "latestAvailable">,
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
    @Inject(LockService) private readonly locks: Pick<LockService, "run">,
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: KernelLogger,
  ) {}

  /** The effective external switch for the org and the platform's expiry maximum, read live. */
  async policy(orgId: string): Promise<SharePolicy> {
    const [platform, max, stored] = await Promise.all([
      readExternalSharing(this.db.db, this.config, this.log),
      readShareMaxExpiry(this.db.db, this.config, this.log),
      readStoredOrgSettings(this.db.db, orgId),
    ]);
    return {
      external: effectiveExternalSharing(platform.value, parseOrgSettings(stored).externalSharing),
      maxExpiryDays: max.value,
    };
  }

  /**
   * Shares one file of the viewer's conversation (any version shown in the panel, or an
   * attachment sent in it). The snapshot is streamed into its object first, outside any
   * transaction; then {@link insertShare} writes the row and the `share.created` audit. A code
   * collision retries the insert with a new code (the object is keyed by the id, not the code).
   */
  async create(
    orgId: string,
    accountId: string,
    conversationId: string,
    fileId: string,
    body: { audience: "internal" | "external"; expiresInDays: 1 | 7 | 30 | null },
    actor: ShareActor = {},
  ): Promise<ShareView> {
    const file = await this.fileToShare(orgId, conversationId, accountId, fileId);
    if (body.audience === "external") {
      const policy = await this.policy(orgId);
      if (policy.external !== "allowed") throw externalNotAllowed(policy.external);
      if (body.expiresInDays === null || body.expiresInDays > policy.maxExpiryDays) {
        throw expiryTooLong(policy.maxExpiryDays);
      }
    }
    const id = randomUUID();
    const objectKey = shareObjectKey(id, 1);
    const size = await this.copy(orgId, file, objectKey);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.insertShare(
          {
            id,
            orgId,
            code: newShareCode(),
            conversationId,
            fileId: file.id,
            sourcePath: file.sourcePath,
            accountId,
            audience: body.audience,
            name: file.name,
            contentType: file.contentType,
            size,
            objectKey,
            expiresInDays: body.expiresInDays,
          },
          actor,
        );
        break;
      } catch (e) {
        if (attempt < CODE_ATTEMPTS && isCodeConflict(e)) continue;
        throw e;
      }
    }
    return this.viewOf(orgId, id);
  }

  /**
   * The row and audit of a new share. The row's org is read from the conversation here (locked
   * `FOR SHARE`, so a concurrent delete waits and then revokes this share too), never taken from
   * the caller; the viewer's access is checked again inside the transaction, since the copy ran
   * without one. Internal: called by {@link create} only.
   */
  @Transactional()
  async insertShare(
    s: {
      id: string;
      orgId: string;
      code: string;
      conversationId: string;
      fileId: string;
      sourcePath: string | null;
      accountId: string;
      audience: "internal" | "external";
      name: string;
      contentType: string;
      size: number;
      objectKey: string;
      expiresInDays: number | null;
    },
    actor: ShareActor,
  ): Promise<void> {
    const conv = await this.db
      .selectFrom("conversations")
      .select("org_id")
      .where("id", "=", s.conversationId)
      .where("org_id", "=", s.orgId)
      .where("deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!conv || !(await this.access.isAccessible(conv.org_id, s.conversationId, s.accountId))) {
      throw conversationNotFound();
    }
    await this.db
      .insertInto("file_shares")
      .values({
        id: s.id,
        org_id: conv.org_id,
        code: s.code,
        conversation_id: s.conversationId,
        file_id: s.fileId,
        source_path: s.sourcePath,
        created_by: s.accountId,
        audience: s.audience,
        name: s.name,
        content_type: s.contentType,
        size: s.size,
        object_key: s.objectKey,
        generation: 1,
        expires_at:
          s.expiresInDays === null
            ? null
            : sql<Date>`now() + make_interval(days => ${s.expiresInDays})`,
      })
      .execute();
    await audit(this.db.db, {
      actorAccountId: s.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId: conv.org_id,
      action: "share.created",
      target: s.id,
      detail: { shareId: s.id, audience: s.audience, ...actor.auditDetail },
    });
  }

  /**
   * "Update to latest" (creator only): copies the newest available version of the share's source
   * path delivered after its current snapshot as the next generation under the same code, then
   * {@link commitRefresh} moves the row and owes the previous snapshot's deletion. Refreshes of one
   * share are serialized by a lock (taken outside any transaction), so two never write the same
   * generation's object.
   */
  async refresh(
    orgId: string,
    accountId: string,
    shareId: string,
    actor: ShareActor = {},
  ): Promise<ShareView> {
    if (!UUID_RE.test(shareId)) throw notFound();
    await this.locks.run(
      `share-refresh-${shareId}`,
      { ttlMs: REFRESH_LOCK_TTL_MS, waitMs: REFRESH_LOCK_WAIT_MS },
      async () => {
        const s = await this.db
          .selectFrom("file_shares")
          .select(["conversation_id", "file_id", "source_path", "generation"])
          .where("id", "=", shareId)
          .where("org_id", "=", orgId)
          .where("created_by", "=", accountId)
          .where("revoked_at", "is", null)
          .where(notExpired)
          .executeTakeFirst();
        if (!s) throw notFound();
        if (s.source_path === null) {
          throw new ApiError(
            "validation_failed",
            "A share of an uploaded file cannot be updated: it has no newer versions. Share the new file instead.",
          );
        }
        const next = await this.files.latestAvailable(
          orgId,
          s.conversation_id,
          accountId,
          s.source_path,
          { after: s.file_id },
        );
        if (next === null) {
          throw fileUnavailable("There is no newer available version of this file to share");
        }
        const generation = s.generation + 1;
        const objectKey = shareObjectKey(shareId, generation);
        const size = await this.copy(orgId, next, objectKey);
        const moved = await this.commitRefresh(
          { orgId, accountId, shareId, from: s.generation },
          { fileId: next.id, name: next.name, contentType: next.contentType, size, objectKey },
          actor,
        );
        // revoked or expired while copying: the new snapshot was owed for deletion instead
        if (!moved) throw notFound();
      },
    );
    return this.viewOf(orgId, shareId);
  }

  /**
   * The row move of a refresh: generation `from` → `from + 1` with the new snapshot, the previous
   * snapshot's deletion owed, `share.refreshed` audited. If the share was revoked or expired (or
   * moved) since the copy began, nothing moves and the new snapshot's deletion is owed instead;
   * returns whether it moved. Internal: called by {@link refresh} only.
   */
  @Transactional()
  async commitRefresh(
    at: { orgId: string; accountId: string; shareId: string; from: number },
    snap: { fileId: string; name: string; contentType: string; size: number; objectKey: string },
    actor: ShareActor,
  ): Promise<boolean> {
    const generation = at.from + 1;
    const row = await this.db
      .selectFrom("file_shares")
      .select(["object_key"])
      .where("id", "=", at.shareId)
      .where("org_id", "=", at.orgId)
      .where("created_by", "=", at.accountId)
      .where("generation", "=", at.from)
      .where("revoked_at", "is", null)
      .where(notExpired)
      .forUpdate()
      .executeTakeFirst();
    if (!row) {
      await this.oweDelete(at.orgId, at.shareId, generation);
      return false;
    }
    await this.db
      .updateTable("file_shares")
      .set({
        generation,
        file_id: snap.fileId,
        name: snap.name,
        content_type: snap.contentType,
        size: snap.size,
        object_key: snap.objectKey,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", at.shareId)
      .execute();
    if (row.object_key !== null) await this.oweDelete(at.orgId, at.shareId, at.from);
    await audit(this.db.db, {
      actorAccountId: at.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId: at.orgId,
      action: "share.refreshed",
      target: at.shareId,
      detail: { shareId: at.shareId, generation, ...actor.auditDetail },
    });
    return true;
  }

  /**
   * Revokes a share (its creator, or an org admin with `org.update`; anyone else: `share.not_found`)
   * and owes its snapshot's deletion. Idempotent: an already revoked share is left as it is, with
   * no second audit. An admin's role is re-read under the org row lock (taken before the share row).
   */
  @Transactional()
  async revoke(
    orgId: string,
    accountId: string,
    shareId: string,
    actor: ShareActor = {},
  ): Promise<void> {
    if (!UUID_RE.test(shareId)) throw notFound();
    const found = await this.db
      .selectFrom("file_shares")
      .select("created_by")
      .where("id", "=", shareId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!found) throw notFound();
    let reason: FileShareRevokeReason = "creator";
    if (found.created_by !== accountId) {
      try {
        await this.orgLock.lockAndAuthorize(orgId, accountId, "org.update");
      } catch (e) {
        if (e instanceof ApiError && e.code === "forbidden") throw notFound();
        throw e;
      }
      reason = "admin";
    }
    const s = await this.db
      .selectFrom("file_shares")
      .select(["revoked_at", "object_key", "generation"])
      .where("id", "=", shareId)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw notFound();
    if (s.revoked_at !== null) return;
    await this.db
      .updateTable("file_shares")
      .set({
        revoked_at: sql<Date>`now()`,
        revoked_by: accountId,
        revoke_reason: reason,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", shareId)
      .execute();
    if (s.object_key !== null) await this.oweDelete(orgId, shareId, s.generation);
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "share.revoked",
      target: shareId,
      detail: { shareId, reason, ...actor.auditDetail },
    });
  }

  /**
   * The live and recent shares of one file of the viewer's conversation (every share of the same
   * source path, any version, or of the attachment), newest first, with the share policy.
   */
  async forFile(
    orgId: string,
    accountId: string,
    conversationId: string,
    fileId: string,
  ): Promise<{ shares: ShareView[]; policy: SharePolicy }> {
    const f = await this.files.identify(orgId, conversationId, accountId, fileId);
    const policy = await this.policy(orgId);
    const rows = await this.views(orgId)
      .where("file_shares.conversation_id", "=", conversationId)
      .where((eb) =>
        f.sourcePath === null
          ? eb.and([
              eb("file_shares.source_path", "is", null),
              eb("file_shares.file_id", "=", f.id),
            ])
          : eb("file_shares.source_path", "=", f.sourcePath),
      )
      .execute();
    const shares = rows.map((r) => this.toView(r, policy.external));
    // only a newer version that is still stored can be shared: confirm the log's answer
    for (const s of shares) {
      if (!s.newerVersion || s.state === "revoked" || s.sourcePath === null) continue;
      s.newerVersion =
        (await this.files.latestAvailable(orgId, conversationId, accountId, s.sourcePath, {
          after: s.fileId,
        })) !== null;
    }
    return { shares, policy };
  }

  /**
   * The org's live and recent shares: the actor's own (`mine`), or every member's (`all`, org
   * admins with `org.update`, re-read live; anyone else `forbidden`). Newest first, at most
   * {@link SHARES_LIST_MAX}.
   */
  async list(
    orgId: string,
    accountId: string,
    scope: "mine" | "all",
  ): Promise<{ shares: ShareView[] }> {
    if (scope === "all") {
      const m = await this.db
        .selectFrom("memberships")
        .select("role")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      if (!m || !can(m.role, "org.update")) {
        throw new ApiError("forbidden", "Only org admins can list every member's shares");
      }
    }
    const { external } = await this.policy(orgId);
    let q = this.views(orgId);
    if (scope === "mine") q = q.where("file_shares.created_by", "=", accountId);
    const rows = await q.limit(SHARES_LIST_MAX).execute();
    return { shares: rows.map((r) => this.toView(r, external)) };
  }

  /** One share as the lists show it (just written by this service). */
  private async viewOf(orgId: string, shareId: string): Promise<ShareView> {
    const { external } = await this.policy(orgId);
    const row = await this.views(orgId, { all: true })
      .where("file_shares.id", "=", shareId)
      .executeTakeFirstOrThrow();
    return this.toView(row, external);
  }

  /** The list query: shares of the org, live and recent (unless `all`), newest first. */
  private views(orgId: string, opts: { all?: boolean } = {}) {
    let q = this.db
      .selectFrom("file_shares")
      .innerJoin("accounts as creator", "creator.id", "file_shares.created_by")
      .select([
        "file_shares.id",
        "file_shares.code",
        "file_shares.audience",
        "file_shares.conversation_id",
        "file_shares.file_id",
        "file_shares.source_path",
        "file_shares.name",
        "file_shares.content_type",
        "file_shares.size",
        "file_shares.generation",
        "file_shares.created_by",
        "creator.display_name",
        "file_shares.created_at",
        "file_shares.expires_at",
        "file_shares.last_opened_at",
        "file_shares.revoked_at",
        "file_shares.revoke_reason",
        sql<boolean>`file_shares.expires_at IS NOT NULL AND file_shares.expires_at <= now()`.as(
          "expired",
        ),
        (eb) =>
          creatorStillHasAccess(
            eb as unknown as ExpressionBuilder<KernelDatabase, "file_shares">,
          ).as("creator_ok"),
        // a later delivery of the same source path in the conversation (refresh offered)
        sql<boolean>`file_shares.source_path IS NOT NULL AND EXISTS (
          SELECT 1 FROM capybara.conversation_events later
          WHERE later.conversation_id = file_shares.conversation_id
            AND later.type = 'artifact_created'
            AND later.payload->>'sourcePath' = file_shares.source_path
            AND later.seq > (
              SELECT e.seq FROM capybara.conversation_events e
              WHERE e.conversation_id = file_shares.conversation_id
                AND e.type = 'artifact_created'
                AND e.payload->>'artifactId' = file_shares.file_id
              LIMIT 1
            )
        )`.as("newer_delivery"),
      ])
      .where("file_shares.org_id", "=", orgId)
      .orderBy("file_shares.created_at", "desc")
      .orderBy("file_shares.id", "desc");
    if (!opts.all) {
      const since = sql<Date>`now() - make_interval(days => ${SHARE_RECENT_DAYS})`;
      q = q.where((eb) =>
        eb.or([
          eb.and([
            eb("file_shares.revoked_at", "is", null),
            eb.or([
              eb("file_shares.expires_at", "is", null),
              eb("file_shares.expires_at", ">", since),
            ]),
          ]),
          eb("file_shares.revoked_at", ">", since),
        ]),
      );
    }
    return q;
  }

  private toView(
    r: Awaited<ReturnType<ReturnType<SharesService["views"]>["executeTakeFirstOrThrow"]>>,
    external: ExternalSharingState,
  ): ShareView {
    const state: ShareState =
      r.revoked_at !== null
        ? "revoked"
        : r.expired
          ? "expired"
          : !r.creator_ok || (r.audience === "external" && external !== "allowed")
            ? "suspended"
            : "live";
    return {
      id: r.id,
      code: r.code,
      audience: r.audience,
      conversationId: r.conversation_id,
      fileId: r.file_id,
      sourcePath: r.source_path,
      name: r.name,
      contentType: r.content_type,
      size: Number(r.size),
      generation: r.generation,
      createdBy: { id: r.created_by, displayName: r.display_name },
      createdAt: r.created_at.toISOString(),
      expiresAt: iso(r.expires_at),
      lastOpenedAt: iso(r.last_opened_at),
      state,
      revokedAt: iso(r.revoked_at),
      revokeReason: r.revoke_reason,
      newerVersion: Boolean(r.newer_delivery) && state !== "revoked",
    };
  }

  /**
   * The file to share, after the viewer's access check: a delivered version, or an attachment whose
   * stored object is still the one finalize checked (else `share.file_unavailable`).
   */
  private async fileToShare(
    orgId: string,
    conversationId: string,
    accountId: string,
    fileId: string,
  ): Promise<SnapshotSource & { sourcePath: string | null }> {
    try {
      return await this.files.file(orgId, conversationId, accountId, fileId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "conversation.artifact_removed") {
        throw fileUnavailable();
      }
      throw e;
    }
  }

  /**
   * Streams the file's object into `objectKey` (never buffered whole); returns the snapshot's size.
   * The object is gone, or an upload's object is no longer the one finalize checked →
   * `share.file_unavailable`. Runs with no transaction open.
   */
  private async copy(orgId: string, file: SnapshotSource, objectKey: string): Promise<number> {
    const store = this.storage.kernel(orgId);
    const got = await store.get(file.objectKey);
    if (!got) throw fileUnavailable();
    if (file.recorded && !attachmentContentMatches(file.recorded, got.head)) {
      await got.body.cancel().catch(() => {});
      throw fileUnavailable();
    }
    try {
      await store.put(objectKey, got.body, {
        contentType: file.contentType,
        size: got.head.size,
      });
    } catch (e) {
      await got.body.cancel().catch(() => {});
      throw e;
    }
    return got.head.size;
  }

  /** Owes the deletion of one share generation's snapshot (in the caller's transaction). */
  private async oweDelete(orgId: string, shareId: string, generation: number): Promise<void> {
    const data: ShareObjectDeleteData = {
      orgId,
      shareId,
      generation,
      objectKey: shareObjectKey(shareId, generation),
    };
    await this.outbox.add({
      queue: MAINTENANCE_QUEUE_NAME,
      name: SHARE_OBJECT_DELETE_JOB,
      jobId: shareObjectDeleteJobId(shareId, generation),
      data,
      orgId,
    });
  }
}
