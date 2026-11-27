import { randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { StorageService } from "../../src/storage/storage.service.js";

/**
 * Library files for tests that need a person's file without going through the upload routes
 * (`test/files/upload.http.test.ts` covers those): the bytes stored as a blob of their own and a
 * file row on it, written directly.
 */

/** What {@link seedLibraryFile} writes. */
export interface SeedFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
  pages?: number | null;
}

/**
 * Stores `bytes` as a ready blob of their own (`blobs/<blobId>`, no sha256: no two seeded files
 * share a blob) and writes a file of `accountId` on it: by default a composer `draft` expiring in
 * 24 hours (an upload not sent yet, which a message attaches); `status: "ready"` for a file already
 * in the library. With `key`, the blob keeps that object key instead (a migrated attachment's
 * `attachments/<id>`, the 0188 way). Returns the file id.
 */
export async function seedLibraryFile(
  app: Pick<INestApplicationContext, "get">,
  orgId: string,
  accountId: string,
  file: SeedFile,
  opts: { status?: "draft" | "ready"; id?: string; key?: (fileId: string) => string } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const blobId = randomUUID();
  const key = opts.key?.(id) ?? `blobs/${blobId}`;
  const head = await app
    .get(StorageService)
    .kernel(orgId)
    .put(key, file.bytes, { contentType: file.contentType, size: file.bytes.byteLength });
  const db = app.get(KernelDb);
  await db
    .insertInto("blobs")
    .values({
      id: blobId,
      org_id: orgId,
      sha256: null,
      size: file.bytes.byteLength,
      etag: head.etag ?? null,
      object_key: key,
      status: "ready",
    })
    .execute();
  const status = opts.status ?? "draft";
  await db
    .insertInto("files")
    .values({
      id,
      org_id: orgId,
      account_id: accountId,
      blob_id: blobId,
      name: file.name,
      content_type: file.contentType,
      size: file.bytes.byteLength,
      pages: file.pages ?? null,
      origin: "upload",
      status,
      // pinned at creation, as finalize pins it: the reference the model sees
      ref_key: key,
      ref_etag: head.etag ?? null,
      upload_purpose: status === "draft" ? "composer" : "library",
      expires_at: status === "draft" ? sql<Date>`now() + interval '24 hours'` : null,
    })
    .execute();
  return id;
}

/** The object key of a file's blob (to delete or replace the bytes under it). */
export async function blobKeyOf(db: KernelSchemaDb, fileId: string): Promise<string> {
  const row = await db
    .selectFrom("files")
    .innerJoin("blobs", "blobs.id", "files.blob_id")
    .select("blobs.object_key")
    .where("files.id", "=", fileId)
    .executeTakeFirstOrThrow();
  return row.object_key;
}

/** Marks a file deleted, as deleting it from the Files page does (its blob stays). */
export async function markFileDeleted(db: KernelSchemaDb, fileId: string): Promise<void> {
  await db
    .updateTable("files")
    .set({ status: "deleted", deleted_at: sql<Date>`now()` })
    .where("id", "=", fileId)
    .execute();
}

/**
 * A file the conversation refers to, as a sent message leaves it: {@link seedLibraryFile} (ready)
 * plus the conversation's `attached` reference. Returns the file id.
 */
export async function seedAttachedFile(
  app: Pick<INestApplicationContext, "get">,
  orgId: string,
  conversationId: string,
  accountId: string,
  file: SeedFile,
  opts: { key?: (fileId: string) => string } = {},
): Promise<string> {
  const id = await seedLibraryFile(app, orgId, accountId, file, { ...opts, status: "ready" });
  await app
    .get(KernelDb)
    .insertInto("conversation_files")
    .values({ conversation_id: conversationId, file_id: id, org_id: orgId, role: "attached" })
    .execute();
  return id;
}

/**
 * Runs the 0188 data copy (`file_library_copy`) over everything: chat attachments, delivered
 * artifacts (`artifact_created` events) and shares written the old way become library files,
 * blobs and conversation references, exactly as the deploy migrated them. Idempotent.
 */
export async function migrateLegacyFiles(db: KernelSchemaDb): Promise<void> {
  await sql`SELECT capybara.file_library_copy('-infinity'::timestamptz)`.execute(db);
}
