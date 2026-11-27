import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import { ConversationAccess } from "../conversations/access.js";
import { ConversationFiles, FILE_VERSIONS_MAX } from "../conversations/files.js";
import type { FileShareRevokeReason, KernelDatabase } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { type BlobRef, BlobsService } from "../files/blobs.service.js";
import { ReferencedFiles } from "../files/referenced-files.js";
import { avatarColumns, personAvatarUrl } from "../identity/account-avatar.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { isAnonymousGuest } from "../orgs/members.service.js";
import { OrgLock } from "../orgs/org-lock.js";
import { can } from "../orgs/roles.js";
import { parseOrgSettings, readStoredOrgSettings } from "../orgs/settings.service.js";
import { UUID_RE } from "../ui/registry.js";
import { creatorStillHasAccess, shareSourceOk } from "./liveness.js";
import {
  type ExternalSharingState,
  effectiveExternalSharing,
  readExternalSharing,
  readShareMaxExpiry,
} from "./settings.js";
import { newShareCode } from "./share-code.js";
import { shareRefreshLockKey } from "./share-objects.js";

/**
 * Shares of files (file sharing spec §1, §2; file library spec §6): a share is a frozen snapshot of
 * one file, which is the file's blob: the row points at it (`blob_id`, locked `ready` by
 * `BlobsService.lockReady` in the transaction that writes the pointer), so nothing is copied and
 * nothing is owed when the share stops (the blob sweep frees a blob no file or share needs). A share
 * is made from a conversation (its file, `conversation_id` set) or from the library (`conversation_id`
 * null); either names the library file it came from (`source_file_id`). Nothing is held in process
 * memory; every read is live.
 */

/**
 * `live`: opens now. `suspended`: not revoked or expired, but it does not open now: an external
 * share while external sharing is off for the org, or its creator lost access to the file.
 */
export type ShareState = "live" | "expired" | "revoked" | "suspended";

export interface ShareView {
  id: string;
  code: string;
  /**
   * The absolute link people open, `<http.publicUrl>/s/<code>`; null when `http.publicUrl` is not
   * set (the web builds it from its own origin then).
   */
  url: string | null;
  audience: "internal" | "external";
  conversationId: string | null;
  fileId: string;
  sourcePath: string | null;
  name: string;
  contentType: string;
  size: number;
  generation: number;
  createdBy: { id: string; displayName: string; avatarUrl: string | null };
  createdAt: string;
  expiresAt: string | null;
  lastOpenedAt: string | null;
  state: ShareState;
  revokedAt: string | null;
  revokeReason: string | null;
  /**
   * The creator has a newer ready version of the snapshot's file (same source conversation and
   * `sourcePath`; refresh offered). In the per-file lists only a version whose bytes are still
   * stored counts; in the org and personal lists the file rows alone decide (no storage reads).
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
/** The refresh lock's lifetime without renewal. */
const REFRESH_LOCK_TTL_MS = 30_000;
/** How long a refresh waits for another refresh of the same share. */
const REFRESH_LOCK_WAIT_MS = 10_000;

const notFound = () => new ApiError("share.not_found", "Share not found");
const fileUnavailable = (message = "The file is no longer available, so it cannot be shared") =>
  new ApiError("share.file_unavailable", message);
const conversationNotFound = () => new ApiError("conversation.not_found", "Conversation not found");
const fileNotFound = () => new ApiError("file.not_found", "File not found");
const guestCannotShare = () =>
  new ApiError(
    "member.anonymous_guest",
    "The anonymous guest of an organization cannot share files: sign in with your own account to share a file",
  );

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

/** The file a share snapshots: its row and its blob (read after the viewer's checks). */
interface ShareSource {
  id: string;
  name: string;
  contentType: string;
  /** The version group of a delivered file; null for an upload. */
  sourcePath: string | null;
  blob: BlobRef;
}

/** What {@link SharesService.nextVersion} needs of a share. */
interface ShareAnchor {
  id: string;
  file_id: string;
  source_file_id: string | null;
  source_path: string | null;
  conversation_id: string | null;
  created_by: string;
}

@Injectable()
export class SharesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ConversationFiles)
    private readonly files: Pick<ConversationFiles, "file" | "identify">,
    @Inject(ReferencedFiles) private readonly library: Pick<ReferencedFiles, "owned">,
    @Inject(BlobsService) private readonly blobs: Pick<BlobsService, "lockReady" | "head">,
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
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
   * attachment sent in it): {@link insertShare} points the row at the file's blob. The anonymous
   * guest cannot share (`member.anonymous_guest`).
   */
  async create(
    orgId: string,
    accountId: string,
    conversationId: string,
    fileId: string,
    body: { audience: "internal" | "external"; expiresInDays: 1 | 7 | 30 | null },
    actor: ShareActor = {},
  ): Promise<ShareView> {
    await this.rejectGuest(accountId);
    const file = await this.fileToShare(orgId, conversationId, accountId, fileId);
    return this.insertWithCode(orgId, accountId, conversationId, file, body, actor);
  }

  /**
   * Shares one of the viewer's library files (file library spec §6): the file must be the
   * viewer's and `ready` (else `file.not_found`) with its bytes still stored (else
   * `share.file_unavailable`). The share has no conversation. The anonymous guest cannot share.
   */
  async createForFile(
    orgId: string,
    accountId: string,
    fileId: string,
    body: { audience: "internal" | "external"; expiresInDays: 1 | 7 | 30 | null },
    actor: ShareActor = {},
  ): Promise<ShareView> {
    await this.rejectGuest(accountId);
    const f = await this.ownedReady(orgId, accountId, fileId);
    if (
      f.blob === null ||
      f.blob.status !== "ready" ||
      (await this.blobs.head(orgId, f.blob)) === null
    ) {
      throw fileUnavailable();
    }
    const file: ShareSource = {
      id: f.id,
      name: f.name,
      contentType: f.contentType,
      sourcePath: f.origin === "upload" ? null : f.sourcePath,
      blob: { id: f.blob.id, objectKey: f.blob.objectKey, size: f.blob.size, etag: f.blob.etag },
    };
    return this.insertWithCode(orgId, accountId, null, file, body, actor);
  }

  /** The policy checks of a new share, then its insert (a code collision retries with a new code). */
  private async insertWithCode(
    orgId: string,
    accountId: string,
    conversationId: string | null,
    file: ShareSource,
    body: { audience: "internal" | "external"; expiresInDays: 1 | 7 | 30 | null },
    actor: ShareActor,
  ): Promise<ShareView> {
    if (body.audience === "external") {
      const policy = await this.policy(orgId);
      if (policy.external !== "allowed") throw externalNotAllowed(policy.external);
      if (body.expiresInDays === null || body.expiresInDays > policy.maxExpiryDays) {
        throw expiryTooLong(policy.maxExpiryDays);
      }
    }
    const id = randomUUID();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.insertShare(
          {
            id,
            orgId,
            code: newShareCode(),
            conversationId,
            file,
            accountId,
            audience: body.audience,
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
   * The row and audit of a new share. A conversation's share locks the conversation `FOR SHARE`
   * (a concurrent delete waits and then revokes this share too) and checks the viewer's access
   * again. Either kind locks the file row `FOR SHARE` while it is the creator's and `ready` (a
   * concurrent delete waits and then revokes this share too) and the blob through
   * `BlobsService.lockReady` (a blob a deletion claimed is never pointed at again); a file deleted
   * or bytes claimed meanwhile → `share.file_unavailable`. Internal: called by {@link create} and
   * {@link createForFile} only.
   */
  @Transactional()
  async insertShare(
    s: {
      id: string;
      orgId: string;
      code: string;
      conversationId: string | null;
      file: ShareSource;
      accountId: string;
      audience: "internal" | "external";
      expiresInDays: number | null;
    },
    actor: ShareActor,
  ): Promise<void> {
    if (s.conversationId !== null) {
      const conv = await this.db
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", s.conversationId)
        .where("org_id", "=", s.orgId)
        .where("deleted_at", "is", null)
        .forShare()
        .executeTakeFirst();
      if (!conv || !(await this.access.isAccessible(s.orgId, s.conversationId, s.accountId))) {
        throw conversationNotFound();
      }
    }
    if (!(await this.lockFile(s.orgId, s.accountId, s.file.id, s.file.blob.id))) {
      throw fileUnavailable();
    }
    const blob = await this.blobs.lockReady(s.orgId, s.file.blob.id);
    if (blob === null) throw fileUnavailable();
    await this.db
      .insertInto("file_shares")
      .values({
        id: s.id,
        org_id: s.orgId,
        code: s.code,
        conversation_id: s.conversationId,
        file_id: s.file.id,
        source_file_id: s.file.id,
        source_path: s.file.sourcePath,
        created_by: s.accountId,
        audience: s.audience,
        name: s.file.name,
        content_type: s.file.contentType,
        size: blob.size,
        blob_id: blob.id,
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
      orgId: s.orgId,
      action: "share.created",
      target: s.id,
      detail: { shareId: s.id, audience: s.audience, ...actor.auditDetail },
    });
  }

  /**
   * "Update to latest" (creator only): points the share at the creator's newest ready version of
   * the same file (same source conversation and source path) made after the current one whose
   * bytes are still stored ({@link nextVersion}), as the next generation under the same code; nothing
   * is copied or deleted. A share of an upload has no versions (`validation_failed`). A
   * conversation's share also needs the creator to still own the conversation. Refreshes of one
   * share are serialized by a lock (taken outside any transaction).
   */
  async refresh(
    orgId: string,
    accountId: string,
    shareId: string,
    actor: ShareActor = {},
  ): Promise<ShareView> {
    if (!UUID_RE.test(shareId)) throw notFound();
    await this.locks.run(
      shareRefreshLockKey(shareId),
      { ttlMs: REFRESH_LOCK_TTL_MS, waitMs: REFRESH_LOCK_WAIT_MS },
      async () => {
        const s = await this.db
          .selectFrom("file_shares")
          .select([
            "id",
            "conversation_id",
            "file_id",
            "source_file_id",
            "source_path",
            "generation",
            "created_by",
          ])
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
        if (
          s.conversation_id !== null &&
          !(await this.access.isAccessible(orgId, s.conversation_id, accountId))
        ) {
          throw conversationNotFound();
        }
        const next = await this.nextVersion(orgId, s);
        if (next === null) {
          throw fileUnavailable("There is no newer available version of this file to share");
        }
        const moved = await this.commitRefresh(
          { orgId, accountId, shareId, from: s.generation },
          next,
          actor,
        );
        // revoked or expired meanwhile
        if (!moved) throw notFound();
      },
    );
    return this.viewOf(orgId, shareId);
  }

  /**
   * The row move of a refresh: generation `from` → `from + 1` pointing at `next`'s file and blob
   * (the file locked while it is the creator's and `ready`, the blob through `lockReady`; either
   * gone meanwhile → `share.file_unavailable`), `share.refreshed` audited. If the share was revoked
   * or expired (or moved) meanwhile, nothing moves; returns whether it moved. Internal: called by
   * {@link refresh} only.
   */
  @Transactional()
  async commitRefresh(
    at: { orgId: string; accountId: string; shareId: string; from: number },
    next: ShareSource,
    actor: ShareActor,
  ): Promise<boolean> {
    const generation = at.from + 1;
    const row = await this.db
      .selectFrom("file_shares")
      .select("id")
      .where("id", "=", at.shareId)
      .where("org_id", "=", at.orgId)
      .where("created_by", "=", at.accountId)
      .where("generation", "=", at.from)
      .where("revoked_at", "is", null)
      .where(notExpired)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    if (!(await this.lockFile(at.orgId, at.accountId, next.id, next.blob.id))) {
      throw fileUnavailable();
    }
    const blob = await this.blobs.lockReady(at.orgId, next.blob.id);
    if (blob === null) throw fileUnavailable();
    await this.db
      .updateTable("file_shares")
      .set({
        generation,
        file_id: next.id,
        source_file_id: next.id,
        name: next.name,
        content_type: next.contentType,
        size: blob.size,
        blob_id: blob.id,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", at.shareId)
      .where("org_id", "=", at.orgId)
      .execute();
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
   * Revokes a share (its creator, or an org admin with `org.update`; anyone else: `share.not_found`).
   * Nothing is owed: the blob sweep frees the blob once nothing needs it. Idempotent: an already revoked share is left as it is, with
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
      .select("revoked_at")
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
      .where("org_id", "=", orgId)
      .execute();
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
    return { shares: await this.confirmed(orgId, rows, policy.external), policy };
  }

  /**
   * The live and recent shares the viewer made of one of their library files (file library spec
   * §6): of any version of it (the same source conversation and source path) or, for an upload, of
   * the file itself, from a conversation or from the library; newest first, with the share policy.
   * Not the viewer's ready file → `file.not_found`.
   */
  async forLibraryFile(
    orgId: string,
    accountId: string,
    fileId: string,
  ): Promise<{ shares: ShareView[]; policy: SharePolicy }> {
    const f = await this.ownedReady(orgId, accountId, fileId);
    const policy = await this.policy(orgId);
    let ids = [f.id];
    if (f.origin !== "upload" && f.sourcePath !== null && f.sourceConversationId !== null) {
      const versions = await this.db
        .selectFrom("files")
        .select("id")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("source_conversation_id", "=", f.sourceConversationId)
        .where("source_path", "=", f.sourcePath)
        .execute();
      ids = [...new Set([f.id, ...versions.map((v) => v.id)])];
    }
    const rows = await this.views(orgId)
      .where("file_shares.created_by", "=", accountId)
      .where((eb) =>
        eb.or([eb("file_shares.source_file_id", "in", ids), eb("file_shares.file_id", "in", ids)]),
      )
      .execute();
    return { shares: await this.confirmed(orgId, rows, policy.external), policy };
  }

  /** The views of a per-file list: a newer version counts only while its bytes are stored. */
  private async confirmed(
    orgId: string,
    rows: ViewRow[],
    external: ExternalSharingState,
  ): Promise<ShareView[]> {
    const shares: ShareView[] = [];
    for (const r of rows) {
      const v = this.toView(r, external);
      if (v.newerVersion && v.state !== "revoked") {
        v.newerVersion = (await this.nextVersion(orgId, r)) !== null;
      }
      shares.push(v);
    }
    return shares;
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
      .select((eb) => [
        "file_shares.id",
        "file_shares.code",
        "file_shares.audience",
        "file_shares.conversation_id",
        "file_shares.file_id",
        "file_shares.source_file_id",
        "file_shares.source_path",
        "file_shares.name",
        "file_shares.content_type",
        "file_shares.size",
        "file_shares.generation",
        "file_shares.created_by",
        "creator.display_name",
        ...avatarColumns(eb, "creator", "creator"),
        "file_shares.created_at",
        "file_shares.expires_at",
        "file_shares.last_opened_at",
        "file_shares.revoked_at",
        "file_shares.revoke_reason",
        sql<boolean>`file_shares.expires_at IS NOT NULL AND file_shares.expires_at <= now()`.as(
          "expired",
        ),
        creatorStillHasAccess(eb as unknown as ExpressionBuilder<KernelDatabase, "file_shares">).as(
          "creator_ok",
        ),
        shareSourceOk(eb as unknown as ExpressionBuilder<KernelDatabase, "file_shares">).as(
          "source_ok",
        ),
        // a newer ready version (its blob ready too, as refresh requires) of the snapshot's file,
        // the creator's (refresh offered): the group
        // and order {@link nextVersion} uses, including its fallback when the current file row is
        // gone (the share's conversation, versions made after the share last moved)
        sql<boolean>`file_shares.source_path IS NOT NULL AND EXISTS (
          SELECT 1 FROM capybara.files later
          JOIN capybara.blobs b ON b.org_id = later.org_id AND b.id = later.blob_id
            AND b.status = 'ready'
          LEFT JOIN capybara.files cur
            ON cur.org_id = file_shares.org_id
           AND cur.id = coalesce(file_shares.source_file_id, file_shares.file_id)
          WHERE later.org_id = file_shares.org_id
            AND later.account_id = file_shares.created_by
            AND later.status = 'ready'
            AND later.origin <> 'upload'
            AND later.source_path = file_shares.source_path
            AND later.source_conversation_id = CASE WHEN cur.id IS NOT NULL
              THEN cur.source_conversation_id ELSE file_shares.conversation_id END
            AND CASE WHEN cur.id IS NOT NULL
              THEN (later.created_at, later.id) > (cur.created_at, cur.id)
              ELSE later.created_at > file_shares.updated_at END
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

  private toView(r: ViewRow, external: ExternalSharingState): ShareView {
    const state: ShareState =
      r.revoked_at !== null
        ? "revoked"
        : r.expired
          ? "expired"
          : !r.creator_ok || !r.source_ok || (r.audience === "external" && external !== "allowed")
            ? "suspended"
            : "live";
    const publicUrl = this.config.get().http.publicUrl;
    return {
      id: r.id,
      code: r.code,
      url: publicUrl ? `${publicUrl.replace(/\/+$/, "")}/s/${r.code}` : null,
      audience: r.audience,
      conversationId: r.conversation_id,
      fileId: r.file_id,
      sourcePath: r.source_path,
      name: r.name,
      contentType: r.content_type,
      size: Number(r.size),
      generation: r.generation,
      createdBy: {
        id: r.created_by,
        displayName: r.display_name,
        avatarUrl: personAvatarUrl(r, "creator", r.created_by),
      },
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
   * The file to share, after the viewer's access check: a delivered version, or an attachment,
   * whose stored bytes are still its blob's (else `share.file_unavailable`).
   */
  private async fileToShare(
    orgId: string,
    conversationId: string,
    accountId: string,
    fileId: string,
  ): Promise<ShareSource> {
    try {
      const f = await this.files.file(orgId, conversationId, accountId, fileId);
      return {
        id: f.id,
        name: f.name,
        contentType: f.contentType,
        sourcePath: f.sourcePath,
        blob: f.blob,
      };
    } catch (e) {
      if (e instanceof ApiError && e.code === "conversation.artifact_removed") {
        throw fileUnavailable();
      }
      throw e;
    }
  }

  /** One of the account's library files while it is `ready`; else `file.not_found`. */
  private async ownedReady(orgId: string, accountId: string, fileId: string) {
    if (!UUID_RE.test(fileId)) throw fileNotFound();
    const f = await this.library.owned(orgId, accountId, fileId);
    if (f.status !== "ready") throw fileNotFound();
    return f;
  }

  /**
   * In the caller's transaction: locks the file row `FOR SHARE` while it is the account's, `ready`
   * and still on `blobId` (the blob the caller then locks; a hashing merge that moved the file
   * meanwhile refuses), so a delete waits for the caller, then revokes what it wrote; false
   * otherwise.
   */
  private async lockFile(
    orgId: string,
    accountId: string,
    fileId: string,
    blobId: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom("files")
      .select("id")
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("status", "=", "ready")
      .where("blob_id", "=", blobId)
      .forShare()
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The creator's newest ready version of a share's file made after the current one (the same
   * source conversation and source path; file library spec §6) whose bytes are still stored, or
   * null. The current file is the share's `source_file_id` (else `file_id`); when it no longer
   * exists, the group is the share's conversation and versions made after the share last moved.
   * At most {@link FILE_VERSIONS_MAX} candidates are looked at. Reads storage: no transaction open.
   */
  private async nextVersion(orgId: string, s: ShareAnchor): Promise<ShareSource | null> {
    if (s.source_path === null) return null;
    const cur = await this.db
      .selectFrom("files")
      .select(["id", "source_conversation_id"])
      .where("org_id", "=", orgId)
      .where("id", "=", s.source_file_id ?? s.file_id)
      .executeTakeFirst();
    const group = cur ? cur.source_conversation_id : s.conversation_id;
    if (group === null) return null;
    const rows = await this.db
      .selectFrom("files as f")
      .innerJoin("blobs as b", (j) => j.onRef("b.id", "=", "f.blob_id").on("b.org_id", "=", orgId))
      .select([
        "f.id",
        "f.name",
        "f.content_type",
        "b.id as blob_id",
        "b.object_key",
        "b.size",
        "b.etag",
      ])
      .where("f.org_id", "=", orgId)
      .where("f.account_id", "=", s.created_by)
      .where("f.status", "=", "ready")
      .where("f.origin", "<>", "upload")
      .where("f.source_conversation_id", "=", group)
      .where("f.source_path", "=", s.source_path)
      .where("b.status", "=", "ready")
      // compared in SQL: a JS Date would drop the microseconds of the stored time
      .where((eb) =>
        cur
          ? eb(
              sql`(f.created_at, f.id)`,
              ">",
              sql`(SELECT c.created_at, c.id FROM capybara.files c
                WHERE c.org_id = ${orgId} AND c.id = ${cur.id})`,
            )
          : eb(
              "f.created_at",
              ">",
              sql<Date>`(SELECT sh.updated_at FROM capybara.file_shares sh
                WHERE sh.org_id = ${orgId} AND sh.id = ${s.id})`,
            ),
      )
      .orderBy("f.created_at", "desc")
      .orderBy("f.id", "desc")
      .limit(FILE_VERSIONS_MAX)
      .execute();
    for (const r of rows) {
      const blob: BlobRef = {
        id: r.blob_id,
        objectKey: r.object_key,
        size: Number(r.size),
        etag: r.etag,
      };
      if ((await this.blobs.head(orgId, blob)) === null) continue;
      return {
        id: r.id,
        name: r.name,
        contentType: r.content_type,
        sourcePath: s.source_path,
        blob,
      };
    }
    return null;
  }

  /** The anonymous guest (channel guests, no sign-in) cannot share (file library spec §2). */
  private async rejectGuest(accountId: string): Promise<void> {
    if (await isAnonymousGuest(this.db.db, accountId)) throw guestCannotShare();
  }
}

/** One row of {@link SharesService}'s list query. */
type ViewRow = Awaited<ReturnType<ReturnType<SharesService["views"]>["executeTakeFirstOrThrow"]>>;
