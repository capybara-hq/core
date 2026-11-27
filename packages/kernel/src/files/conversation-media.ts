import { Inject, Injectable } from "@nestjs/common";
import { AttachmentsService } from "../conversations/attachments.service.js";
import { isImageContentType } from "../conversations/media-types.js";
import {
  fitImageForModel,
  MODEL_IMAGE_CACHE_SECONDS,
  modelImageKey,
  parseModelImage,
  serializeModelImage,
} from "../conversations/model-image.js";
import { CacheService } from "../infra/cache/cache.service.js";
import type { MediaBytes, MediaInfo } from "../runtime/context/build.js";
import { type ReferencedFile, ReferencedFiles } from "./referenced-files.js";

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * The media request building resolves a conversation's refs with (file library spec §5): a ref id
 * is a library file the conversation refers to (`conversation_files` → `files` → `blobs`, read
 * through `BlobsService`), else a `read` copy bound to it (an image a tool showed the agent:
 * `AttachmentsService`). The contract is the attachments' one: an id with neither is left out of
 * {@link mediaInfo} (request building renders the "no longer available" placeholder), and
 * {@link fetchMedia} returns null only when the bytes are certainly gone (a deleted file, a gone
 * blob, a replaced object) and throws on every other error (Ruling M4). No process state.
 */
@Injectable()
export class ConversationMedia {
  constructor(
    @Inject(ReferencedFiles)
    private readonly files: Pick<ReferencedFiles, "referenced" | "open" | "head" | "uri">,
    @Inject(AttachmentsService)
    private readonly attachments: Pick<AttachmentsService, "mediaInfo" | "fetchMedia">,
    /** where the model-sized copies of images are kept between steps ({@link fetchMedia}) */
    @Inject(CacheService) private readonly cache: Pick<CacheService, "get" | "set">,
  ) {}

  /** The live files of the conversation among `ids`, by id. */
  private async filesOf(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
  ): Promise<Map<string, ReferencedFile>> {
    const live = await this.files.referenced(orgId, [conversationId], ids);
    return new Map(live.map((f) => [f.id, f]));
  }

  /**
   * The recorded facts request building needs about the refs (size, PDF page count, etag and the
   * unsigned `uri` of the bytes): the blob's size and etag for a file, the row's for a `read` copy.
   * An id that is neither is left out; a failed query throws.
   */
  async mediaInfo(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
  ): Promise<Map<string, MediaInfo>> {
    if (ids.length === 0) return new Map();
    const files = await this.filesOf(orgId, conversationId, ids);
    const out = new Map<string, MediaInfo>();
    for (const f of files.values()) {
      out.set(f.id, {
        size: f.blob.size,
        pages: f.pages,
        etag: f.blob.etag,
        uri: this.files.uri(orgId, f),
      });
    }
    const rest = ids.filter((id) => !files.has(id));
    for (const [id, info] of await this.attachments.mediaInfo(orgId, conversationId, rest)) {
      out.set(id, info);
    }
    return out;
  }

  /**
   * The bytes request building sends for the refs. A file's bytes come from its blob (size and
   * etag checked); a `read` copy's from its row. Null only when certainly gone. An id in `caps` is
   * read by range up to that many leading bytes (the `text/*` cap). A whole image comes back as
   * its model-sized copy ({@link fitImageForModel}), cached for {@link MODEL_IMAGE_CACHE_SECONDS}
   * under the id and the recorded etag (or size), so later steps only check the object's head.
   */
  async fetchMedia(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
    caps?: ReadonlyMap<string, number>,
  ): Promise<Map<string, MediaBytes | null>> {
    const out = new Map<string, MediaBytes | null>();
    if (ids.length === 0) return out;
    const files = await this.filesOf(orgId, conversationId, ids);
    const rest = ids.filter((id) => !files.has(id));
    const [, others] = await Promise.all([
      Promise.all(
        [...files.values()].map(async (f) =>
          out.set(f.id, await this.fileBytes(orgId, f, caps?.get(f.id))),
        ),
      ),
      this.attachments.fetchMedia(orgId, conversationId, rest, caps),
    ]);
    for (const [id, media] of others) out.set(id, media);
    // every requested id answers (an unknown one: null), in the order asked
    return new Map(ids.map((id) => [id, out.get(id) ?? null]));
  }

  /** One file's bytes for the model (see {@link fetchMedia}). */
  private async fileBytes(
    orgId: string,
    f: ReferencedFile,
    cap: number | undefined,
  ): Promise<MediaBytes | null> {
    const size = f.blob.size;
    // a whole image already scaled for the model: the cached copy, once the object checks out
    const cacheKey =
      cap === undefined && isImageContentType(f.contentType)
        ? modelImageKey(orgId, { id: f.id, etag: f.blob.etag, size })
        : undefined;
    const cached = cacheKey === undefined ? null : parseModelImage(await this.cache.get(cacheKey));
    if (cached) return (await this.files.head(orgId, f)) ? cached : null;
    const want = cap !== undefined && cap < size ? Math.max(1, cap) : size;
    const got = await this.files.open(
      orgId,
      f,
      want < size ? { range: { start: 0, end: want - 1 } } : {},
    );
    if (!got) return null;
    // a store that ignored the range sent the whole object: keep only the head
    const all = await readAll(got.body);
    const data = all.byteLength === size ? all.subarray(0, want) : all;
    if (data.byteLength !== want) return null;
    const media = { mediaType: f.contentType, data };
    if (cacheKey === undefined) return media;
    // a whole image goes out as the model-sized copy (the stored object stays unchanged)
    const fitted = await fitImageForModel(media);
    if (fitted !== media) {
      await this.cache.set(cacheKey, serializeModelImage(fitted), MODEL_IMAGE_CACHE_SECONDS);
    }
    return fitted;
  }
}
