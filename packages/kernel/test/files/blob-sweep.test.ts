import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { BlobObjects } from "../../src/files/blob-objects.js";
import { BlobSweepJob } from "../../src/files/blob-sweep.job.js";
import { BlobsService } from "../../src/files/blobs.service.js";
import {
  FILE_LIBRARY_COPY_SETTLED,
  FileLibraryBackfill,
} from "../../src/files/library-backfill.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { accountsFor } from "../helpers/identity.js";
import { blobKeyOf, markFileDeleted, seedLibraryFile } from "../helpers/library-files.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * File library spec §7: the daily blob sweep deletes `deleted` files past the retention
 * (`files.deletedRetentionDays`), releases blobs older than a day that no file row and no share
 * refers to (the deletion owed through the outbox, which the worker drains), and releases
 * `pending` blobs older than an hour with no file. A blob referenced by a deleted file within the
 * retention, by a recent share, or locked by a transaction pointing a reference at it stays.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, fixture("mem-store")] },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrgWithProviders(k, await session(k, "owner"));
  // the catch-up copy settled (the seeded blobs below are unhashed, as migrated ones are)
  expect(await k.app.get(FileLibraryBackfill).run()).toBe("copied");
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const sweep = () => k.app.get(BlobSweepJob).runOnce();
const store = () => k.app.get(StorageService).kernel(orgId);

/** A ready library file with its own blob; returns the file and blob ids. */
async function seeded(text: string): Promise<{ fileId: string; blobId: string }> {
  const fileId = await seedLibraryFile(
    k.app,
    orgId,
    ownerId,
    { name: `${text}.txt`, contentType: "text/plain", bytes: new TextEncoder().encode(text) },
    { status: "ready" },
  );
  return { fileId, blobId: await blobOf(fileId) };
}

async function blobOf(fileId: string): Promise<string> {
  const row = await db
    .selectFrom("files")
    .select("blob_id")
    .where("id", "=", fileId)
    .executeTakeFirstOrThrow();
  return row.blob_id as string;
}

const blobRow = (id: string) =>
  db.selectFrom("blobs").select(["status"]).where("id", "=", id).executeTakeFirst();

const ageBlob = (id: string, interval: string) =>
  sql`UPDATE capybara.blobs SET created_at = now() - ${interval}::interval WHERE id = ${id}`.execute(
    raw,
  );

/** Detaches a file from its blob by deleting its row (an unreferenced blob of a given age). */
async function orphanBlob(text: string, age: string): Promise<{ blobId: string; key: string }> {
  const { fileId, blobId } = await seeded(text);
  const key = await blobKeyOf(db, fileId);
  await db.deleteFrom("files").where("id", "=", fileId).execute();
  await ageBlob(blobId, age);
  return { blobId, key };
}

/** A share of the blob, internal, made by the owner. */
async function shareOf(blobId: string, fileId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("file_shares")
    .values({
      id,
      org_id: orgId,
      code: id.replace(/-/g, "").slice(0, 10),
      conversation_id: null,
      file_id: fileId,
      created_by: ownerId,
      audience: "internal",
      name: "shared.txt",
      content_type: "text/plain",
      size: 1,
      blob_id: blobId,
    })
    .execute();
  return id;
}

/** Waits until the worker drained the blob's owed deletion: row and object gone. */
async function deleted(blobId: string, key: string): Promise<void> {
  await expect.poll(async () => (await blobRow(blobId)) ?? null, { timeout: 30_000 }).toBeNull();
  expect(await store().head(key)).toBeNull();
}

describe("blob sweep", () => {
  it("releases a blob older than a day that nothing refers to, and the worker deletes its object", async () => {
    const { blobId, key } = await orphanBlob("orphan", "25 hours");
    const r = await sweep();
    expect(r.blobsReleased).toBeGreaterThanOrEqual(1);
    await deleted(blobId, key);
  });

  it("keeps an unreferenced blob younger than a day", async () => {
    const { blobId, key } = await orphanBlob("young", "2 hours");
    await sweep();
    expect(await blobRow(blobId)).toEqual({ status: "ready" });
    expect(await store().head(key)).not.toBeNull();
  });

  it("keeps a blob referenced by a ready file", async () => {
    const { blobId } = await seeded("in use");
    await ageBlob(blobId, "40 days");
    await sweep();
    expect(await blobRow(blobId)).toEqual({ status: "ready" });
  });

  it("keeps a blob of a file deleted within the retention; past it the file row and the blob go", async () => {
    const { fileId, blobId } = await seeded("deleted file");
    const key = await blobKeyOf(db, fileId);
    await ageBlob(blobId, "40 days");
    await markFileDeleted(db, fileId);
    await sql`UPDATE capybara.files SET deleted_at = now() - interval '29 days'
      WHERE id = ${fileId}`.execute(raw);
    await sweep();
    expect(await blobRow(blobId)).toEqual({ status: "ready" });
    expect(await db.selectFrom("files").select("id").where("id", "=", fileId).execute()).toEqual([
      { id: fileId },
    ]);

    await sql`UPDATE capybara.files SET deleted_at = now() - interval '31 days'
      WHERE id = ${fileId}`.execute(raw);
    const r = await sweep();
    expect(r.filesDeleted).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom("files").select("id").where("id", "=", fileId).execute()).toEqual(
      [],
    );
    await deleted(blobId, key);
  });

  it("keeps a blob a share points at, and releases it once the share let go of it", async () => {
    const { fileId, blobId } = await seeded("shared");
    const key = await blobKeyOf(db, fileId);
    const shareId = await shareOf(blobId, fileId);
    // the file is gone; the share alone keeps the bytes
    await db.deleteFrom("files").where("id", "=", fileId).execute();
    await ageBlob(blobId, "3 days");
    await sweep();
    expect(await blobRow(blobId)).toEqual({ status: "ready" });

    // the share sweep freed it (expired over a week ago)
    await db.updateTable("file_shares").set({ blob_id: null }).where("id", "=", shareId).execute();
    await sweep();
    await deleted(blobId, key);
  });

  it("releases a pending blob older than an hour with no file, and keeps a recent one", async () => {
    const old = randomUUID();
    const recent = randomUUID();
    for (const id of [old, recent]) {
      await db
        .insertInto("blobs")
        .values({
          id,
          org_id: orgId,
          sha256: null,
          size: 3,
          etag: null,
          object_key: `blobs/${id}`,
          status: "pending",
        })
        .execute();
    }
    await store().put(`blobs/${old}`, new TextEncoder().encode("abc"), {
      contentType: "text/plain",
      size: 3,
    });
    await ageBlob(old, "2 hours");
    await ageBlob(recent, "20 minutes");
    const r = await sweep();
    expect(r.pendingReleased).toBeGreaterThanOrEqual(1);
    await deleted(old, `blobs/${old}`);
    expect(await blobRow(recent)).toEqual({ status: "pending" });
  });

  it("skips a blob another transaction holds while pointing a reference at it", async () => {
    const { blobId } = await orphanBlob("being referenced", "25 hours");
    await raw.transaction().execute(async (trx) => {
      // what BlobsService.lockReady takes before inserting a reference
      await sql`SELECT id FROM capybara.blobs WHERE id = ${blobId} FOR SHARE`.execute(trx);
      await sweep();
    });
    expect(await blobRow(blobId)).toEqual({ status: "ready" });
  });

  it("leaves unhashed blobs alone until the catch-up copy settled", async () => {
    const { blobId } = await orphanBlob("migrated, copy pending", "3 days");
    const hashed = await orphanBlob("hashed, copy pending", "3 days");
    await db
      .updateTable("blobs")
      .set({ sha256: "a".repeat(64) })
      .where("id", "=", hashed.blobId)
      .execute();
    await db
      .deleteFrom("deployment_settings")
      .where("key", "=", FILE_LIBRARY_COPY_SETTLED)
      .execute();
    try {
      await sweep();
      expect(await blobRow(blobId)).toEqual({ status: "ready" });
      await deleted(hashed.blobId, hashed.key);
    } finally {
      expect(await k.app.get(FileLibraryBackfill).run()).toBe("copied");
    }
    await sweep();
    expect((await blobRow(blobId))?.status).not.toBe("ready");
  });

  it("restores a stale deleting blob a file still points at, readable again", async () => {
    const { fileId, blobId } = await seeded("stuck deleting");
    await ageBlob(blobId, "3 days");
    // as file_library_copy can leave it: deleting, yet referenced (the deletion job refused it)
    await db.updateTable("blobs").set({ status: "deleting" }).where("id", "=", blobId).execute();
    const r = await sweep();
    expect(r.deletingRestored).toBeGreaterThanOrEqual(1);
    expect(await blobRow(blobId)).toEqual({ status: "ready" });
    const blob = await db
      .selectFrom("blobs")
      .select(["id", "object_key", "size", "etag"])
      .where("id", "=", blobId)
      .executeTakeFirstOrThrow();
    const opened = await k.app.get(BlobsService).open(orgId, {
      id: blob.id,
      objectKey: blob.object_key,
      size: Number(blob.size),
      etag: blob.etag,
    });
    expect(await new Response(opened?.body).text()).toBe("stuck deleting");
    expect(await blobOf(fileId)).toBe(blobId);
  });

  it("marks a stale deleting blob gone when a file points at it but its object is gone", async () => {
    const { fileId, blobId } = await seeded("deleted under a reference");
    await store().delete(await blobKeyOf(db, fileId));
    await ageBlob(blobId, "3 days");
    await db.updateTable("blobs").set({ status: "deleting" }).where("id", "=", blobId).execute();
    await sweep();
    expect(await blobRow(blobId)).toEqual({ status: "gone" });
  });

  it("owes the deletion of a stale unreferenced deleting blob again, and the worker deletes it", async () => {
    const { blobId, key } = await orphanBlob("deletion lost", "3 days");
    // its deletion job ran out of attempts (removed); nothing else owes it
    await db.updateTable("blobs").set({ status: "deleting" }).where("id", "=", blobId).execute();
    const r = await sweep();
    expect(r.deletionsReowed).toBeGreaterThanOrEqual(1);
    await deleted(blobId, key);
  });

  it("never restores a blob whose deletion claimed it, even when a reference appears afterwards", async () => {
    const { fileId, blobId } = await seeded("claimed then referenced");
    await ageBlob(blobId, "3 days");
    await db
      .updateTable("files")
      .set({ blob_id: null, status: "deleted" })
      .where("id", "=", fileId)
      .execute();
    await db.updateTable("blobs").set({ status: "deleting" }).where("id", "=", blobId).execute();
    // the deletion claims it (its object is about to go) ...
    const key = await k.app.get(BlobObjects).claimUnreferenced({ orgId, blobId });
    expect(key).not.toBeNull();
    expect(await blobRow(blobId)).toEqual({ status: "gone" });
    // ... and a reference appears without the ready gate (as file_library_copy can do)
    await db.updateTable("files").set({ blob_id: blobId }).where("id", "=", fileId).execute();
    await sweep();
    expect(await blobRow(blobId)).toEqual({ status: "gone" });
  });

  it("leaves a stale deleting blob whose object check fails for the next sweep, and goes on", async () => {
    const failing = await seeded("storage down");
    const other = await seeded("storage fine");
    const failingKey = await blobKeyOf(db, failing.fileId);
    for (const b of [failing.blobId, other.blobId]) {
      await ageBlob(b, "3 days");
      await db.updateTable("blobs").set({ status: "deleting" }).where("id", "=", b).execute();
    }
    const storage = k.app.get(StorageService);
    const original = storage.kernel.bind(storage);
    const spy = vi.spyOn(storage, "kernel").mockImplementation((org) => {
      const s = original(org);
      return {
        ...s,
        head: async (key) => {
          if (key === failingKey) throw new Error("storage unavailable");
          return s.head(key);
        },
      };
    });
    try {
      await sweep();
    } finally {
      spy.mockRestore();
    }
    expect(await blobRow(failing.blobId)).toEqual({ status: "deleting" });
    expect(await blobRow(other.blobId)).toEqual({ status: "ready" });
    await sweep();
    expect(await blobRow(failing.blobId)).toEqual({ status: "ready" });
  });
});
