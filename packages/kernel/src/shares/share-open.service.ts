import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { FILE_PREVIEW_MAX_BYTES } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { isInlineArtifactType, isTextArtifactType } from "../conversations/artifacts.js";
import {
  FILE_CONTENT_MAX_BYTES,
  type FileOutput,
  previewKind,
  readPrefix,
  trimUtf8,
} from "../conversations/files.js";
import { ApiError } from "../errors.js";
import type { PreviewerItem } from "../files/previewers.js";
import { HTML_TOKEN_TTL_SECONDS, HtmlTokens } from "../html/html-token.js";
import { isHtmlType } from "../html/html-type.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { StorageService } from "../storage/storage.service.js";
import { type LiveShare, ShareLiveness } from "./liveness.js";

/** What `GET /api/v1/s/:code` answers (the web's `ShareMeta`). */
export interface ShareMeta {
  name: string;
  contentType: string;
  size: number;
  /** The creator's display name. */
  sharedBy: string;
  expiresAt: Date | null;
  audience: "internal" | "external";
  /** The built-in kind the share's text / inline routes serve (the conversation files list's rule). */
  previewable: FileOutput["previewable"];
  /** `html`: the HTML document; `previewers`: an extension previewer or a web built-in; `download`. */
  render: "html" | "previewers" | "download";
  /** The extension previewers that take the snapshot, in the org's order. */
  previewers: PreviewerItem[];
}

/** An opened share and who opened it (the account of a member's web session, else none). */
export interface OpenedShare {
  share: LiveShare;
  viewerAccountId: string | null;
}

/** The share-open throttler (`NAMED_THROTTLERS`): per client address, misses count. */
const THROTTLER = ["share-open"] as const;
/** How long one viewer's open of one share is audited once (ms). */
export const SHARE_OPENED_DEDUPE_MS = 600_000;

/** Every refusal of a share route: unknown, revoked, expired, not live, not a member. */
export const shareNotFound = () =>
  new ApiError("share.not_found", "This link is invalid or has expired");
const signInRequired = () =>
  new ApiError(
    "share.sign_in_required",
    "Sign in as a member of this organization to open this link",
  );
const notPreviewable = (message: string) =>
  new ApiError("conversation.artifact_not_previewable", message);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The headers every public share response carries (errors too: set before the lookup). */
export function publicShareHeaders(reply: FastifyReply): void {
  reply
    .header("x-robots-tag", "noindex")
    .header("referrer-policy", "no-referrer")
    .header("cache-control", "private, no-store");
}

/** Headers of agent bytes served on the app origin: never sniffed, never a page. */
function sandboxedBytes(reply: FastifyReply): FastifyReply {
  return reply
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "sandbox; default-src 'none'")
    .header("cache-control", "private, no-store");
}

/**
 * `content-disposition: attachment` with an ASCII fallback (`"` `\` and anything outside printable
 * ASCII become `_`) and the exact name as RFC 5987 `filename*` (UTF-8, percent-encoded).
 */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * The public share routes (file sharing spec §3). Each route reserves one `share-open` attempt for
 * the client address before the lookup ({@link open}) and gives it back only after a live hit the
 * viewer may open, so unknown, malformed, revoked, expired and refused codes are counted and codes
 * cannot be enumerated. Every refusal of a code is one answer, 404 `share.not_found`; an internal
 * share needs a web session of an active member of the share's own org (not the session's current
 * org): without one 401 `share.sign_in_required`, a signed-in non-member 404. `ShareLiveness`
 * checks the share and its creator; this service checks the viewer. The bytes are always streamed
 * by the kernel from the snapshot, never a presigned URL; nothing lives in process memory (the
 * throttler and the open dedupe are Redis keys with a TTL).
 */
@Injectable()
export class ShareOpenService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ShareLiveness) private readonly liveness: Pick<ShareLiveness, "byCode">,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(HtmlTokens) private readonly tokens: Pick<HtmlTokens, "issue">,
    @Inject(LockService) private readonly locks: Pick<LockService, "lease">,
    @Inject(CredentialThrottler)
    private readonly throttler: Pick<CredentialThrottler, "reserve" | "succeeded">,
  ) {}

  /**
   * The live share with this code that the request may open, after reserving a `share-open`
   * attempt; the attempt is refunded only when it is returned. See the class comment.
   */
  async open(code: string, req: FastifyRequest, reply: FastifyReply): Promise<OpenedShare> {
    publicShareHeaders(reply);
    await this.throttler.reserve(THROTTLER, req, reply);
    const share = await this.liveness.byCode(code);
    if (share === null) throw shareNotFound();
    const p = req.principal;
    const sessionAccount =
      p?.kind === "user" && p.via === "session" && !p.account.mustChangePassword
        ? p.account.id
        : null;
    if (share.audience === "internal") {
      if (sessionAccount === null) throw signInRequired();
      if (!(await this.isMember(share.orgId, sessionAccount))) throw shareNotFound();
    }
    await this.throttler.succeeded(THROTTLER, req);
    return { share, viewerAccountId: sessionAccount };
  }

  /** The metadata of an opened share; audits the open at most once per viewer per 10 minutes. */
  async meta(opened: OpenedShare, ip: string): Promise<ShareMeta> {
    const { share } = opened;
    await this.recordOpenOnce(opened, ip);
    const previewable = previewKind(share.contentType);
    const html = isHtmlType(share.name, share.contentType) && share.size <= FILE_PREVIEW_MAX_BYTES;
    const previewers = html ? [] : await this.previewersFor(share);
    return {
      name: share.name,
      contentType: share.contentType,
      size: share.size,
      sharedBy: share.createdByName,
      expiresAt: share.expiresAt,
      audience: share.audience,
      previewable,
      render: html
        ? "html"
        : previewers.length > 0 || previewable !== null
          ? "previewers"
          : "download",
      previewers,
    };
  }

  /**
   * The extension previewers that take a share's snapshot, in the org's order. The seam the
   * share-scoped previewers (file sharing spec §7) fill; none until then.
   */
  async previewersFor(_share: LiveShare): Promise<PreviewerItem[]> {
    return [];
  }

  /** Streams the snapshot as `application/octet-stream` (spec §3); `download` adds the attachment name. */
  async content(share: LiveShare, download: boolean, reply: FastifyReply): Promise<void> {
    const got = await this.storage.kernel(share.orgId).get(share.objectKey);
    if (!got) throw shareNotFound();
    sandboxedBytes(reply)
      .header("content-type", "application/octet-stream")
      .header("content-length", String(got.head.size));
    if (download) reply.header("content-disposition", attachmentDisposition(share.name));
    await reply.send(Readable.fromWeb(got.body as NodeReadableStream<Uint8Array>));
  }

  /**
   * The first `limit` bytes (≤ 1 MiB) of a text snapshot as `text/plain; charset=utf-8`, as the
   * panel's text route: not text, or NUL bytes in what was read → 400
   * `conversation.artifact_not_previewable`; a cut never splits a UTF-8 character.
   */
  async text(share: LiveShare, limit: number, reply: FastifyReply): Promise<void> {
    if (!isTextArtifactType(share.contentType)) {
      throw notPreviewable("Only text files have content");
    }
    const max = Math.min(limit, FILE_CONTENT_MAX_BYTES);
    const got = await this.storage
      .kernel(share.orgId)
      .get(share.objectKey, { range: { start: 0, end: max - 1 } });
    if (!got) throw shareNotFound();
    let body = await readPrefix(got.body, max);
    if (body.includes(0)) {
      throw notPreviewable("This file contains binary data and has no text content");
    }
    const truncated = got.head.size > body.byteLength;
    if (truncated) body = trimUtf8(body);
    const base = (share.contentType.split(";")[0] ?? "").trim().toLowerCase();
    sandboxedBytes(reply)
      .header("content-type", "text/plain; charset=utf-8")
      .header("x-content-original-type", base);
    if (truncated) reply.header("x-content-truncated", "true");
    await reply.send(body);
  }

  /** Streams a bitmap snapshot (png, jpeg, gif, webp) with its type; any other type → 404. */
  async inline(share: LiveShare, reply: FastifyReply): Promise<void> {
    if (!isInlineArtifactType(share.contentType)) throw shareNotFound();
    const got = await this.storage.kernel(share.orgId).get(share.objectKey);
    if (!got) throw shareNotFound();
    const type = (share.contentType.split(";")[0] ?? "").trim().toLowerCase();
    sandboxedBytes(reply)
      .header("content-type", type)
      .header("content-length", String(got.head.size));
    await reply.send(Readable.fromWeb(got.body as NodeReadableStream<Uint8Array>));
  }

  /**
   * The HTML document path of an opened share (`/api/v1/html/<token>`, a fresh share token naming
   * its generation). Not HTML, or larger than `FILE_PREVIEW_MAX_BYTES` → 400
   * `conversation.artifact_not_previewable`.
   */
  htmlPath(share: LiveShare): { path: string; expiresIn: number } {
    if (!isHtmlType(share.name, share.contentType)) {
      throw notPreviewable("Only HTML files render as documents; download this file instead");
    }
    if (share.size > FILE_PREVIEW_MAX_BYTES) {
      throw notPreviewable("This HTML file is too large to render; download it instead");
    }
    const { token } = this.tokens.issue({
      kind: "share",
      shareId: share.id,
      generation: share.generation,
    });
    return { path: `/api/v1/html/${token}`, expiresIn: HTML_TOKEN_TTL_SECONDS };
  }

  /** An active account with a membership in a live org. */
  private async isMember(orgId: string, accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("memberships")
      .innerJoin("orgs", "orgs.id", "memberships.org_id")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("memberships.role")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("orgs.deleted_at", "is", null)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * `share.opened` at most once per share and viewer (the session's account, else the client
   * address hashed) per {@link SHARE_OPENED_DEDUPE_MS}: the first open sets a Redis marker with
   * that TTL (outside any transaction), then writes the audit and `last_opened_at`.
   */
  private async recordOpenOnce(opened: OpenedShare, ip: string): Promise<void> {
    const viewer = opened.viewerAccountId ?? `ip-${sha256(ip)}`;
    const first = await this.locks.lease(
      `capk:share-opened:${opened.share.id}:${viewer}`,
      "1",
      SHARE_OPENED_DEDUPE_MS,
    );
    if (first) await this.recordOpen(opened);
  }

  /** The audit of one open (the account for an internal share, none for an external one). */
  @Transactional()
  async recordOpen(opened: OpenedShare): Promise<void> {
    const { share } = opened;
    await this.db
      .updateTable("file_shares")
      .set({ last_opened_at: sql<Date>`now()` })
      .where("id", "=", share.id)
      .execute();
    await audit(this.db.db, {
      actorAccountId: share.audience === "internal" ? opened.viewerAccountId : null,
      orgId: share.orgId,
      action: "share.opened",
      target: share.id,
      detail: { shareId: share.id, audience: share.audience },
    });
  }
}
