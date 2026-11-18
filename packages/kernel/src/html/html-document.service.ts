import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { FILE_PREVIEW_MAX_BYTES } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { attachmentContentMatches } from "../conversations/attachments.service.js";
import { ConversationFiles } from "../conversations/files.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ShareLiveness } from "../shares/liveness.js";
import { readHtmlCdnAllowlist } from "../shares/settings.js";
import { StorageService } from "../storage/storage.service.js";
import { htmlDocumentCsp } from "./csp.js";
import { HTML_TOKEN_TTL_SECONDS, type HtmlClaims, HtmlTokens } from "./html-token.js";
import { htmlContentType, isHtmlType } from "./html-type.js";

/** What `POST …/html-token` returns: `path` loads the document once within `expiresIn` seconds. */
export interface HtmlTokenResponse {
  path: string;
  expiresIn: number;
}

/** The object a document is served from, after its live checks. */
interface DocumentSource {
  orgId: string;
  objectKey: string;
  contentType: string;
  /** An upload's size and etag recorded at finalize: the object read must still match them. */
  recorded?: { size: number; etag: string | null } | undefined;
}

/** Every refusal of the document route: one answer, no reason (a token is not an oracle). */
export const htmlNotFound = () => new ApiError("not_found", "Not found");

const notPreviewable = (message: string) =>
  new ApiError("conversation.artifact_not_previewable", message);

/**
 * HTML files served as stand-alone documents (file sharing spec §4). The owner of a conversation
 * mints a short-lived document token for one version of an HTML file ({@link mint}); the public
 * route serves it ({@link serve}) under the sandbox CSP after re-checking, live, what the token
 * names: the owner can still read the file (`ConversationFiles.file`: membership, active account,
 * conversation and agent not deleted; an upload's object still the one finalize checked), or the
 * share is still live at that generation (`ShareLiveness.byId`). The bytes are streamed by the
 * kernel as stored; never a presigned URL on the app origin. HTML larger than
 * `FILE_PREVIEW_MAX_BYTES` is never rendered.
 */
@Injectable()
export class HtmlDocumentService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ConversationFiles) private readonly files: Pick<ConversationFiles, "file">,
    @Inject(ShareLiveness) private readonly liveness: Pick<ShareLiveness, "byId">,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(HtmlTokens) private readonly tokens: HtmlTokens,
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: KernelLogger,
  ) {}

  /**
   * A document token for one version of the caller's conversation file (a delivered version or an
   * upload). Not the owner → `conversation.not_found`; unknown file →
   * `conversation.artifact_not_found`; an upload changed since finalize →
   * `conversation.artifact_removed`; not HTML, or larger than `FILE_PREVIEW_MAX_BYTES` →
   * `conversation.artifact_not_previewable`.
   */
  async mint(
    orgId: string,
    conversationId: string,
    accountId: string,
    fileId: string,
  ): Promise<HtmlTokenResponse> {
    const f = await this.files.file(orgId, conversationId, accountId, fileId);
    if (!isHtmlType(f.name, f.contentType)) {
      throw notPreviewable("Only HTML files render as documents; download this file instead");
    }
    if (f.size > FILE_PREVIEW_MAX_BYTES) {
      throw notPreviewable("This HTML file is too large to render; download it instead");
    }
    const { token } = this.tokens.issue({
      kind: "file",
      orgId,
      conversationId,
      fileId: f.id,
      accountId,
    });
    return { path: `/api/v1/html/${token}`, expiresIn: HTML_TOKEN_TTL_SECONDS };
  }

  /**
   * Serves the document verified claims name with the spec §4 headers, the CSP built from the CDN
   * allowlist read now. Any live check failing → 404 `not_found`.
   */
  async serve(claims: HtmlClaims, reply: FastifyReply): Promise<void> {
    const source = await this.resolve(claims);
    if (source === null) throw htmlNotFound();
    // read before the object is opened, so no stream is held across this query
    const allowlist = await readHtmlCdnAllowlist(this.db.db, this.log);
    const got = await this.storage.kernel(source.orgId).get(source.objectKey);
    if (!got) throw htmlNotFound();
    if (
      got.head.size > FILE_PREVIEW_MAX_BYTES ||
      (source.recorded && !attachmentContentMatches(source.recorded, got.head))
    ) {
      await got.body.cancel().catch(() => {});
      throw htmlNotFound();
    }
    await reply
      .header("content-type", htmlContentType(source.contentType))
      .header("content-length", String(got.head.size))
      .header("content-security-policy", htmlDocumentCsp(allowlist))
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "private, no-store")
      .header("x-robots-tag", "noindex")
      .send(Readable.fromWeb(got.body as NodeReadableStream<Uint8Array>));
  }

  /** The object the claims name if their live checks pass now; null otherwise. */
  private async resolve(claims: HtmlClaims): Promise<DocumentSource | null> {
    if (claims.kind === "share") {
      const s = await this.liveness.byId(claims.shareId, claims.generation);
      if (s === null || !isHtmlType(s.name, s.contentType) || s.size > FILE_PREVIEW_MAX_BYTES) {
        return null;
      }
      return { orgId: s.orgId, objectKey: s.objectKey, contentType: s.contentType };
    }
    let f: Awaited<ReturnType<ConversationFiles["file"]>>;
    try {
      f = await this.files.file(
        claims.orgId,
        claims.conversationId,
        claims.accountId,
        claims.fileId,
      );
    } catch (e) {
      // the owner lost access, the file is unknown or the upload changed: all the same 404
      if (e instanceof ApiError) return null;
      throw e;
    }
    if (!isHtmlType(f.name, f.contentType) || f.size > FILE_PREVIEW_MAX_BYTES) return null;
    return {
      orgId: claims.orgId,
      objectKey: f.objectKey,
      contentType: f.contentType,
      recorded: f.recorded,
    };
  }
}
