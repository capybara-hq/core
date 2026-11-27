import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { BlobObjects } from "../../src/files/blob-objects.js";
import { BlobsService } from "../../src/files/blobs.service.js";
import { FileLibraryHashJob, FileLibraryKickoffJob, HASH_BATCH } from "../../src/files/hash-job.js";
import {
  BACKFILL_DELAY_MS,
  FILE_LIBRARY_BACKFILL_JOB,
  FILE_LIBRARY_COPY_SETTLED,
  FILE_LIBRARY_MIGRATION,
  FileLibraryBackfill,
} from "../../src/files/library-backfill.js";
import { ReferencedFiles } from "../../src/files/referenced-files.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { accountsFor } from "../helpers/identity.js";
import { seedAttachedFile, seedLibraryFile } from "../helpers/library-files.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Plan amendment K9: old replicas may still write chat attachments the old way after migration
 * 0189 copied the data, so a one-off catch-up job (`file-library-backfill`, owed at the worker
 * start, deferred half an hour) copies from an hour before 0188 was applied, once (the settled
 * marker); more than a week after the migration it records a skip and copies nothing.
 *
 * File library spec §9 step 2: the hashing job fills the sha256 of migrated blobs and merges
 * duplicates (files and shares repointed to the holder, the duplicate `deleting` with its deletion
 * owed; a file keeps the reference it was first stored under); a missing object makes the blob
 * `gone` (its files render the placeholder), and so does an object whose size or etag no longer
 * matches its row. Nothing merges before the catch-up copy settled. The hourly kickoff owes the
 * dispatcher, which the worker runs through every batch of the org.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
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
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const store = () => k.app.get(StorageService).kernel(orgId);
const hashing = () => k.app.get(FileLibraryHashJob);
const batch = () => hashing().runOrgBatch({ orgId, after: null });

/** A ready file on a migrated blob of its own (key `attachments/<fileId>`, no sha256). */
const migrated = (text: string) =>
  seedLibraryFile(
    k.app,
    orgId,
    ownerId,
    { name: "a.txt", contentType: "text/plain", bytes: enc(text) },
    { status: "ready", key: (id) => `attachments/${id}` },
  );

const fileRow = (id: string) =>
  db
    .selectFrom("files")
    .select(["blob_id", "ref_key"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const blobRow = (id: string) =>
  db
    .selectFrom("blobs")
    .select(["status", "sha256", "object_key"])
    .where("id", "=", id)
    .executeTakeFirst();

/**
 * When the owed maintenance job `jobId` is due (ms): from its outbox row, else from BullMQ, where
 * the relay moves a deferred row within seconds (checked in that order, so a move in between is
 * still found).
 */
async function dueAt(jobId: string): Promise<number> {
  const row = await db
    .selectFrom("outbox")
    .select("run_at")
    .where("job_id", "=", jobId)
    .executeTakeFirst();
  if (row) return (row.run_at as Date | null)?.getTime() ?? 0;
  const job = await k.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE_NAME)).getJob(jobId);
  if (!job) throw new Error(`${jobId} is not owed`);
  return job.timestamp + (job.opts.delay ?? 0);
}

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
      name: "a.txt",
      content_type: "text/plain",
      size: 1,
      blob_id: blobId,
    })
    .execute();
  return id;
}

const backfill = () => k.app.get(FileLibraryBackfill);

/** A chat attachment sent in the conversation, written the old way (no library file). */
async function legacyAttachment(conv: string, text: string): Promise<string> {
  const id = randomUUID();
  const key = `attachments/${id}`;
  const bytes = enc(text);
  await store().put(key, bytes, { contentType: "text/plain", size: bytes.byteLength });
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      conversation_id: conv,
      account_id: ownerId,
      name: "old.txt",
      content_type: "text/plain",
      size: bytes.byteLength,
      object_key: key,
      status: "ready",
      etag: null,
      pages: null,
      purpose: "chat",
    })
    .execute();
  return id;
}

const fileStatus = async (id: string) =>
  (await db.selectFrom("files").select("status").where("id", "=", id).executeTakeFirst())?.status;

// the hashing tests below need the copy settled: this block runs first
describe("file library catch-up copy", () => {
  it("is owed at the worker start, half an hour later, while it has not settled", async () => {
    expect(await backfill().settled()).toBe(false);
    expect(await dueAt(FILE_LIBRARY_BACKFILL_JOB)).toBeGreaterThan(
      Date.now() + BACKFILL_DELAY_MS - 5 * 60_000,
    );
  });

  it("copies what old replicas wrote after the migration, once", async () => {
    const conv = await createConv(owner, orgId, await createAgent(owner, orgId));
    const id = await legacyAttachment(conv, "written by an old replica\n");
    expect(await fileStatus(id)).toBeUndefined();
    expect(await backfill().run()).toBe("copied");
    expect(await fileStatus(id)).toBe("ready");
    const ref = await db
      .selectFrom("conversation_files")
      .select("role")
      .where("file_id", "=", id)
      .where("conversation_id", "=", conv)
      .executeTakeFirst();
    expect(ref).toEqual({ role: "attached" });
    expect(await backfill().settled()).toBe(true);

    // settled: a later delivery of the job copies nothing, and nothing more is owed
    const later = await legacyAttachment(conv, "written after the catch-up\n");
    expect(await backfill().run()).toBe("settled");
    expect(await fileStatus(later)).toBeUndefined();
    expect(await backfill().ensureOwed()).toBe(false);
    expect((await k.app.get(FileLibraryKickoffJob).runOnce()).backfillOwed).toBe(false);
  });
});

describe("hashing job", () => {
  it("merges two identical migrated objects into one blob, repointing files and shares", async () => {
    const text = "the same quarterly report\n";
    const one = await migrated(text);
    const two = await migrated(text);
    const [b1, b2] = [
      (await fileRow(one)).blob_id as string,
      (await fileRow(two)).blob_id as string,
    ];
    const [holder, duplicate] = b1 < b2 ? [b1, b2] : [b2, b1];
    const dupFile = duplicate === b1 ? one : two;
    const dupKey = (await blobRow(duplicate))?.object_key as string;
    const shareId = await shareOf(duplicate, dupFile);

    const r = await batch();
    expect(r.ran).toBe(true);
    expect(r.outcomes.merged).toBeGreaterThanOrEqual(1);

    expect(await blobRow(holder)).toMatchObject({ status: "ready", sha256: sha(text) });
    expect(await blobRow(duplicate)).toMatchObject({ status: "deleting", sha256: null });
    expect((await fileRow(one)).blob_id).toBe(holder);
    expect((await fileRow(two)).blob_id).toBe(holder);
    // the reference the model saw stays the duplicate's old key
    expect((await fileRow(dupFile)).ref_key).toBe(dupKey);
    const share = await db
      .selectFrom("file_shares")
      .select("blob_id")
      .where("id", "=", shareId)
      .executeTakeFirstOrThrow();
    expect(share.blob_id).toBe(holder);
    // the deletion is owed, deferred past in-flight reads
    expect(await dueAt(`blob-delete-${duplicate}`)).toBeGreaterThan(Date.now() + 30 * 60_000);

    // the owed deletion, delivered: the duplicate's object and row go, the holder's stay
    await k.app.get(BlobObjects).deleteBlob({ orgId, blobId: duplicate });
    expect(await blobRow(duplicate)).toBeUndefined();
    expect(await store().head(dupKey)).toBeNull();
    const kept = await store().get((await blobRow(holder))?.object_key as string);
    expect(await new Response(kept?.body).text()).toBe(text);
  });

  it("merges a migrated blob into a kernel-written ready blob of the same bytes", async () => {
    const text = "delivered earlier, migrated later\n";
    const written = await k.app
      .get(BlobsService)
      .ensureFromBytes(orgId, sha(text), enc(text), { contentType: "text/plain" });
    const file = await migrated(text);
    const before = (await fileRow(file)).blob_id as string;
    await batch();
    expect((await fileRow(file)).blob_id).toBe(written.id);
    expect(await blobRow(before)).toMatchObject({ status: "deleting" });
  });

  it("marks a blob whose object is missing gone: its file renders the placeholder", async () => {
    const agentId = await createAgent(owner, orgId);
    const conv = await createConv(owner, orgId, agentId);
    const file = await seedAttachedFile(
      k.app,
      orgId,
      conv,
      ownerId,
      { name: "lost.txt", contentType: "text/plain", bytes: enc("lost bytes\n") },
      { key: (id) => `attachments/${id}` },
    );
    const blobId = (await fileRow(file)).blob_id as string;
    const live = () =>
      withOrgScope(orgId, () => k.app.get(ReferencedFiles).referenced(orgId, [conv]));
    expect((await live()).map((f) => f.id)).toEqual([file]);
    await store().delete(`attachments/${file}`);

    const r = await batch();
    expect(r.outcomes.gone).toBeGreaterThanOrEqual(1);
    expect(await blobRow(blobId)).toMatchObject({ status: "gone", sha256: null });
    expect(await live()).toEqual([]);
  });

  it("never merges an object replaced after it was recorded: the blob is gone instead", async () => {
    const original = await migrated("abc-original\n");
    const replaced = await migrated("xyz-replaced\n");
    // the etag recorded for the bytes the row describes (the memory store reports none)
    await db
      .updateTable("blobs")
      .set({ etag: '"recorded"' })
      .where("id", "=", (await fileRow(replaced)).blob_id as string)
      .execute();
    // the same size, other bytes (as a staging object written again within its form's lifetime)
    await store().put(`attachments/${replaced}`, enc("abc-original\n"), {
      contentType: "text/plain",
      size: 13,
    });
    await batch();
    expect(await blobRow((await fileRow(original)).blob_id as string)).toMatchObject({
      status: "ready",
      sha256: sha("abc-original\n"),
    });
    const other = (await fileRow(replaced)).blob_id as string;
    expect(await blobRow(other)).toMatchObject({ status: "gone", sha256: null });
  });

  it("marks a blob gone when its object's size differs and no etag was recorded", async () => {
    const file = await migrated("size only check\n");
    const blobId = (await fileRow(file)).blob_id as string;
    await db.updateTable("blobs").set({ etag: null }).where("id", "=", blobId).execute();
    await store().put(`attachments/${file}`, enc("longer bytes than before\n"), {
      contentType: "text/plain",
      size: 25,
    });
    await batch();
    expect(await blobRow(blobId)).toMatchObject({ status: "gone", sha256: null });
  });

  it("merges nothing before the catch-up copy settled", async () => {
    await db
      .deleteFrom("deployment_settings")
      .where("key", "=", FILE_LIBRARY_COPY_SETTLED)
      .execute();
    try {
      const one = await migrated("before the copy settled\n");
      const r = await batch();
      expect(r.ran).toBe(false);
      const blobId = (await fileRow(one)).blob_id as string;
      expect(await blobRow(blobId)).toMatchObject({ status: "ready", sha256: null });
      // the kickoff owes no hashing; the catch-up stays owed (since the worker start), deferred
      expect((await k.app.get(FileLibraryKickoffJob).runOnce()).hashOwed).toBe(false);
      expect(await dueAt("file-library-backfill")).toBeGreaterThan(Date.now() + 20 * 60_000);
    } finally {
      expect(await k.app.get(FileLibraryBackfill).run()).toBe("copied");
    }
  });

  it("the kickoff owes the dispatcher and the worker hashes every batch of the org", async () => {
    const ids: string[] = [];
    for (let i = 0; i < HASH_BATCH + 3; i++) ids.push(await migrated(`chained ${i}\n`));
    const r = await k.app.get(FileLibraryKickoffJob).runOnce();
    expect(r).toEqual({ backfillOwed: false, hashOwed: true });
    const unhashed = async () => {
      const rows = await db
        .selectFrom("files")
        .innerJoin("blobs", "blobs.id", "files.blob_id")
        .select("blobs.sha256")
        .where("files.id", "in", ids)
        .execute();
      return rows.filter((b) => b.sha256 === null).length;
    };
    await expect.poll(unhashed, { timeout: 60_000 }).toBe(0);
    // nothing left to hash: the next kickoff owes nothing
    await expect
      .poll(() => k.app.get(FileLibraryKickoffJob).runOnce(), { timeout: 30_000 })
      .toEqual({ backfillOwed: false, hashOwed: false });
  });
});

// last: it moves the migration's date back
describe("file library catch-up copy outside its window", () => {
  it("records a skip and copies nothing more than a week after the migration", async () => {
    await db
      .deleteFrom("deployment_settings")
      .where("key", "=", FILE_LIBRARY_COPY_SETTLED)
      .execute();
    await sql`UPDATE capybara._migrations SET applied_at = now() - interval '8 days'
      WHERE name = ${FILE_LIBRARY_MIGRATION}`.execute(raw);
    const conv = await createConv(owner, orgId, await createAgent(owner, orgId));
    const id = await legacyAttachment(conv, "too late to copy\n");
    expect(await backfill().run()).toBe("skipped");
    expect(await fileStatus(id)).toBeUndefined();
    expect(await backfill().settled()).toBe(true);
  });
});
