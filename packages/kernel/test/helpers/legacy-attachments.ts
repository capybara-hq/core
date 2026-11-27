import { randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { StorageService } from "../../src/storage/storage.service.js";

/**
 * Chat attachments as they existed before the file library: no route creates them any more (a
 * person's uploads are library files), but the send and read paths still go through `attachments`
 * until they move to the library. These helpers give tests such rows.
 */

/**
 * Stores `bytes` at `attachments/<id>` and writes a ready, unbound chat attachment of
 * `accountId` (expiring in 24 hours, as an unsent upload did); returns its id.
 */
export async function seedChatAttachment(
  app: Pick<INestApplicationContext, "get">,
  orgId: string,
  accountId: string,
  file: { name: string; contentType: string; bytes: Uint8Array; pages?: number | null },
): Promise<string> {
  const id = randomUUID();
  const key = `attachments/${id}`;
  const head = await app
    .get(StorageService)
    .kernel(orgId)
    .put(key, file.bytes, { contentType: file.contentType, size: file.bytes.byteLength });
  await app
    .get(KernelDb)
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      account_id: accountId,
      name: file.name,
      content_type: file.contentType,
      size: file.bytes.byteLength,
      object_key: key,
      status: "ready",
      etag: head.etag ?? null,
      pages: file.pages ?? null,
      expires_at: sql<Date>`now() + interval '24 hours'`,
    })
    .execute();
  return id;
}

/**
 * Writes a ready, unbound chat attachment with the id, bytes and owner of a finalized library
 * file (its blob's object and etag), so a test that can only reach a kernel over HTTP (the
 * dual-replica harness) uploads through `/files` and sends the id as before.
 */
export async function mirrorFileAsChatAttachment(
  db: KernelSchemaDb,
  fileId: string,
): Promise<void> {
  const f = await db
    .selectFrom("files")
    .innerJoin("blobs", "blobs.id", "files.blob_id")
    .select([
      "files.org_id",
      "files.account_id",
      "files.name",
      "files.content_type",
      "files.size",
      "files.pages",
      "blobs.object_key",
      "blobs.etag",
    ])
    .where("files.id", "=", fileId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("attachments")
    .values({
      id: fileId,
      org_id: f.org_id,
      account_id: f.account_id,
      name: f.name,
      content_type: f.content_type,
      size: f.size,
      object_key: f.object_key,
      status: "ready",
      etag: f.etag,
      pages: f.pages,
      expires_at: sql<Date>`now() + interval '24 hours'`,
    })
    .execute();
}
