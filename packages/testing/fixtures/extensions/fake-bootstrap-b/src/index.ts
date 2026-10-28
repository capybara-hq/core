import {
  defineExtension,
  type ExtensionContext,
  OBJECT_STORE_EXTENSION_POINT,
  type ObjectHead,
  type ObjectStore,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake for the bootstrap step: an object store (`object-store@1`) that keeps objects in its
 * own PostgreSQL table, so bootstrap tests need no S3 container. Its deployment config has a
 * non-secret `bucket` (can come from the admin console, i.e. PG) and a required secret `secretKey`
 * (from the startup config), so an unconfigured deployment leaves it pending configuration, as the
 * image's object store is. Presigning is not supported (it throws): bootstrap tests never upload
 * from a browser.
 */

const DeploymentConfig = z.object({
  bucket: z.string().min(1),
  secretKey: secret(z.string().min(1)),
});

type Db = ExtensionContext["db"];

const PAGE_MAX = 1000;

const toBytes = async (body: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());

function createPgObjectStore(db: Db, bucket: string): ObjectStore {
  const objects = () => db.selectFrom("objects").where("bucket", "=", bucket);
  const headOf = (r: { key: string; size: number | string; content_type: string }): ObjectHead => ({
    key: r.key,
    size: Number(r.size),
    contentType: r.content_type,
  });
  return {
    async put(key, body, opts) {
      const data = await toBytes(body);
      await db
        .insertInto("objects")
        .values({ bucket, key, content_type: opts.contentType, data: Buffer.from(data) })
        .onConflict((oc) =>
          oc.columns(["bucket", "key"]).doUpdateSet((eb) => ({
            content_type: eb.ref("excluded.content_type"),
            data: eb.ref("excluded.data"),
            updated_at: new Date(),
          })),
        )
        .execute();
      return { key, size: data.byteLength, contentType: opts.contentType };
    },
    async get(key, opts) {
      const row = await objects()
        .select(["key", "content_type", "data"])
        .where("key", "=", key)
        .executeTakeFirst();
      if (row === undefined) return null;
      const all = new Uint8Array(row.data as Buffer);
      const range = opts?.range;
      const bytes =
        range === undefined ? all : all.subarray(range.start, (range.end ?? all.length - 1) + 1);
      return {
        head: { key, size: all.byteLength, contentType: row.content_type as string },
        body: new Response(bytes).body as ReadableStream<Uint8Array>,
      };
    },
    async head(key) {
      const row = await objects()
        .select(["key", "content_type"])
        .select((eb) => eb.fn<number>("octet_length", ["data"]).as("size"))
        .where("key", "=", key)
        .executeTakeFirst();
      return row === undefined ? null : headOf(row);
    },
    async delete(key) {
      await db.deleteFrom("objects").where("bucket", "=", bucket).where("key", "=", key).execute();
    },
    async deletePrefix(prefix) {
      const r = await db
        .deleteFrom("objects")
        .where("bucket", "=", bucket)
        .where((eb) => eb.fn<boolean>("starts_with", [eb.ref("key"), eb.val(prefix)]))
        .executeTakeFirst();
      return Number(r.numDeletedRows);
    },
    async list(prefix, opts) {
      const limit = Math.min(Math.max(1, opts?.limit ?? PAGE_MAX), PAGE_MAX);
      let q = objects()
        .select(["key", "content_type"])
        .select((eb) => eb.fn<number>("octet_length", ["data"]).as("size"))
        .where((eb) => eb.fn<boolean>("starts_with", [eb.ref("key"), eb.val(prefix)]))
        .orderBy("key")
        .limit(limit + 1);
      if (opts?.cursor !== undefined) q = q.where("key", ">", opts.cursor);
      const rows = await q.execute();
      const items = rows.slice(0, limit).map((r) => ({ ...headOf(r), contentType: "" }));
      const last = items.at(-1);
      return rows.length > limit && last !== undefined ? { items, cursor: last.key } : { items };
    },
    async presignGet() {
      throw new Error("fake-bootstrap-b: presigned URLs are not supported");
    },
    async presignPut() {
      throw new Error("fake-bootstrap-b: presigned URLs are not supported");
    },
  };
}

export default defineExtension({
  name: "fake-bootstrap-b",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [OBJECT_STORE_EXTENSION_POINT],
  migrations: "../migrations",
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { bucket } = DeploymentConfig.parse(ctx.config);
    ctx.provide(OBJECT_STORE_EXTENSION_POINT, createPgObjectStore(ctx.db, bucket));
  },
});
