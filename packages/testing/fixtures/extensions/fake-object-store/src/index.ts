import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  defineExtension,
  OBJECT_STORE_EXTENSION_POINT,
  type ObjectHead,
  type ObjectStore,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of an object store extension (`object-store@1`) backed by the S3 container of
 * `startTestS3()` (SeaweedFS). It exists so core tests do not load the official object store; it
 * implements what the kernel relies on and no more: the deployment config has the same shape as
 * `startTestS3()` returns (`endpoint`, `region`, `bucket`, secret `accessKeyId` /
 * `secretAccessKey`, `forcePathStyle`), streams are buffered in memory (test objects are small),
 * `presignPut` is a POST policy whose size and type the store enforces, keys containing `${` are
 * refused, `presignGet` sets the disposition and response type.
 */

const DeploymentConfig = z.object({
  endpoint: z.string().url().optional(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  accessKeyId: secret(z.string().min(1)),
  secretAccessKey: secret(z.string().min(1)),
  forcePathStyle: z.boolean().default(true),
});

/** The deployment config of the fake (as `startTestS3()` gives it). */
export type FakeObjectStoreConfig = z.input<typeof DeploymentConfig>;

const PAGE_MAX = 1000;

const isNotFound = (e: unknown): boolean =>
  e instanceof S3ServiceException &&
  (e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata.httpStatusCode === 404);

const etag = (v: string | undefined) => (v ? { etag: v.replaceAll('"', "") } : {});

/** `Content-Range: bytes 0-4/11` -> 11. */
const totalFromRange = (range: string | undefined): number | undefined => {
  const m = range?.match(/\/(\d+)$/);
  return m ? Number(m[1]) : undefined;
};

/** RFC 6266 disposition with an ASCII fallback and the UTF-8 `filename*`. */
const contentDisposition = (disposition: string, name: string | undefined): string =>
  name === undefined
    ? disposition
    : `${disposition}; filename="${name.replace(/[^\x20-\x7e]|["\\%]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });

/** Creates the S3-backed store (exported for tests that use it without a kernel). */
export function createFakeObjectStore(input: FakeObjectStoreConfig): ObjectStore {
  const cfg = DeploymentConfig.parse(input);
  const client = new S3Client({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
    ...(cfg.endpoint !== undefined && { endpoint: cfg.endpoint }),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = cfg.bucket;
  return {
    async put(key, body, opts) {
      const data =
        body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      const r = await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: data, ContentType: opts.contentType }),
        opts.signal ? { abortSignal: opts.signal } : {},
      );
      return { key, size: data.byteLength, contentType: opts.contentType, ...etag(r.ETag) };
    },
    async get(key, opts) {
      const range = opts?.range;
      try {
        const r = await client.send(
          new GetObjectCommand({
            Bucket,
            Key: key,
            ...(range !== undefined && { Range: `bytes=${range.start}-${range.end ?? ""}` }),
          }),
          opts?.signal ? { abortSignal: opts.signal } : {},
        );
        const head: ObjectHead = {
          key,
          size: totalFromRange(r.ContentRange) ?? r.ContentLength ?? 0,
          contentType: r.ContentType ?? "application/octet-stream",
          ...etag(r.ETag),
        };
        const stream = r.Body?.transformToWebStream() as ReadableStream<Uint8Array> | undefined;
        return { head, body: stream ?? emptyStream() };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          key,
          size: r.ContentLength ?? 0,
          contentType: r.ContentType ?? "application/octet-stream",
          ...etag(r.ETag),
        };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async deletePrefix(prefix) {
      let deleted = 0;
      for (;;) {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: PAGE_MAX }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
        if (keys.length === 0) return deleted;
        for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket, Key }));
        deleted += keys.length;
      }
    },
    async list(prefix, opts) {
      const r = await client.send(
        new ListObjectsV2Command({
          Bucket,
          Prefix: prefix,
          MaxKeys: Math.min(Math.max(1, opts?.limit ?? PAGE_MAX), PAGE_MAX),
          ...(opts?.cursor !== undefined && { ContinuationToken: opts.cursor }),
        }),
      );
      const items: ObjectHead[] = (r.Contents ?? []).flatMap((o) =>
        o.Key === undefined ? [] : [{ key: o.Key, size: o.Size ?? 0, contentType: "" }],
      );
      return r.IsTruncated && r.NextContinuationToken
        ? { items, cursor: r.NextContinuationToken }
        : { items };
    },
    async presignGet(key, opts) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: contentDisposition(
            opts.disposition ?? "attachment",
            opts.downloadName,
          ),
          ...(opts.responseContentType !== undefined && {
            ResponseContentType: opts.responseContentType,
          }),
        }),
        { expiresIn: opts.ttlSeconds },
      );
    },
    async presignPut(key, opts) {
      if (key.includes("${")) {
        throw new Error("fake-object-store: presignPut key must not contain '${'");
      }
      const { url, fields } = await createPresignedPost(client, {
        Bucket,
        Key: key,
        Conditions: [
          { key },
          ["content-length-range", 0, opts.maxSize],
          ["eq", "$Content-Type", opts.contentType],
        ],
        Fields: { "Content-Type": opts.contentType },
        Expires: opts.ttlSeconds,
      });
      return { method: "POST", url, headers: {}, fields };
    },
  };
}

export default defineExtension({
  name: "fake-object-store",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [OBJECT_STORE_EXTENSION_POINT],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(
      OBJECT_STORE_EXTENSION_POINT,
      createFakeObjectStore(ctx.config as FakeObjectStoreConfig),
    );
  },
});
