import { createHash } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { BLOB_SWEEP_CRON, BLOB_SWEEP_JOB, BlobSweepJob } from "../../src/files/blob-sweep.job.js";
import {
  FILE_LIBRARY_KICKOFF_JOB,
  FILE_LIBRARY_KICKOFF_PERIOD_MS,
  FileLibraryHashJob,
  FileLibraryKickoffJob,
} from "../../src/files/hash-job.js";
import { FileLibraryBackfill } from "../../src/files/library-backfill.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { scheduledTick } from "../../src/infra/schedule/cron-tick.js";
import { intervalTick, LockedIntervalScheduler } from "../../src/infra/schedule/locked-interval.js";
import { ScheduledRuns } from "../../src/infra/schedule/scheduled-runs.js";
import { createLogger } from "../../src/log.js";
import { accountsFor } from "../helpers/identity.js";
import { seedLibraryFile } from "../helpers/library-files.js";
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
 * File library spec §7 and §9 on two replicas (real S3, so recorded etags are checked): the daily
 * blob sweep and the hourly hashing kickoff each run once per tick; sweeps that do run on both at
 * once release every unreferenced blob once (one owed deletion each) and delete each expired
 * deleted file once; hashing batches of one org on
 * both replicas run one chain (the org's lock), and the same blob hashed on both settles once.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let a: TestKernel;
let b: TestKernel;
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const cfg = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, OBJECT_STORE],
      extensionConfig: {
        "fake-object-store": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      },
    },
  );
  // owed maintenance jobs stay in the outbox, so the test counts them
  const opts = {
    logger: createLogger("error", { write: () => {} }),
    overrides: [{ provide: OUTBOX_DISPATCH_FAILS, useValue: (_queue: string) => true }] as const,
  };
  a = await startKernel(cfg, opts);
  b = await startKernel(cfg, opts);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrgWithProviders(a, await session(a, "owner"));
  expect(await a.app.get(FileLibraryBackfill).run()).toBe("copied");
});

afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A ready file on a migrated blob of its own (key `attachments/<fileId>`, no sha256). */
async function migrated(text: string): Promise<{ fileId: string; blobId: string }> {
  const fileId = await seedLibraryFile(
    a.app,
    orgId,
    ownerId,
    { name: "a.txt", contentType: "text/plain", bytes: enc(text) },
    { status: "ready", key: (id) => `attachments/${id}` },
  );
  const row = await db
    .selectFrom("files")
    .select("blob_id")
    .where("id", "=", fileId)
    .executeTakeFirstOrThrow();
  return { fileId, blobId: row.blob_id as string };
}

/** Blobs that nothing refers to, older than a day. */
async function orphans(n: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { fileId, blobId } = await migrated(`${tag} ${i}\n`);
    await db.deleteFrom("files").where("id", "=", fileId).execute();
    ids.push(blobId);
  }
  await sql`UPDATE capybara.blobs SET created_at = now() - interval '2 days'
    WHERE id IN (${sql.join(ids)})`.execute(raw);
  return ids;
}

const owedDeletes = async (ids: string[]) =>
  (
    await db
      .selectFrom("outbox")
      .select("job_id")
      .where(
        "job_id",
        "in",
        ids.map((id) => `blob-delete-${id}`),
      )
      .execute()
  ).length;

const statuses = async (ids: string[]) =>
  (await db.selectFrom("blobs").select("status").where("id", "in", ids).execute()).map(
    (r) => r.status,
  );

/**
 * Stops both replicas' own timers of a job and waits out a run one of them may have started, then
 * clears the current tick's marker, so the two calls of the test are the tick's only takers.
 */
async function quiet(stop: (k: TestKernel) => void, marker: string): Promise<void> {
  for (const k of [a, b]) stop(k);
  for (const k of [a, b]) {
    const scheduled = k.app.get(ScheduledRuns);
    await expect.poll(() => scheduled.inFlightCount, { timeout: 30_000 }).toBe(0);
  }
  const locks = a.app.get(LockService);
  const holder = await locks.holderOf(marker);
  if (holder !== null) await locks.releaseIf(marker, holder);
}

describe("blob sweep and hashing on two replicas", () => {
  it("the daily sweep runs once per tick across replicas", async () => {
    const ids = await orphans(3, "swept once");
    await quiet(
      (k) => k.app.get(SchedulerRegistry).deleteCronJob(BLOB_SWEEP_JOB),
      `cron:${BLOB_SWEEP_JOB}:${scheduledTick(BLOB_SWEEP_CRON, Date.now()).tick}`,
    );
    const runs = [a, b].map((k) => vi.spyOn(k.app.get(BlobSweepJob), "runOnce"));
    try {
      await Promise.all([a.app.get(BlobSweepJob).sweep(), b.app.get(BlobSweepJob).sweep()]);
      expect(runs.reduce((n, x) => n + x.mock.calls.length, 0)).toBe(1);
    } finally {
      for (const x of runs) x.mockRestore();
    }
    expect(await statuses(ids)).toEqual(["deleting", "deleting", "deleting"]);
    expect(await owedDeletes(ids)).toBe(3);
  });

  it("sweeps running on both replicas at once release each blob once", async () => {
    const ids = await orphans(6, "swept twice");
    const [r1, r2] = await Promise.all([
      a.app.get(BlobSweepJob).runOnce(),
      b.app.get(BlobSweepJob).runOnce(),
    ]);
    expect(r1.blobsReleased + r2.blobsReleased).toBe(ids.length);
    expect(await statuses(ids)).toEqual(ids.map(() => "deleting"));
    expect(await owedDeletes(ids)).toBe(ids.length);
  });

  it("deleted files past the retention, swept on both replicas at once, go once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await migrated(`deleted long ago ${i}\n`)).fileId);
    await sql`UPDATE capybara.files SET status = 'deleted', deleted_at = now() - interval '40 days'
      WHERE id IN (${sql.join(ids)})`.execute(raw);
    const [r1, r2] = await Promise.all([
      a.app.get(BlobSweepJob).runOnce(),
      b.app.get(BlobSweepJob).runOnce(),
    ]);
    expect(r1.filesDeleted + r2.filesDeleted).toBe(ids.length);
    expect(await db.selectFrom("files").select("id").where("id", "in", ids).execute()).toEqual([]);
  });

  it("the hashing kickoff runs once per tick across replicas", async () => {
    await migrated("kicked off once\n");
    await quiet(
      (k) => k.app.get(LockedIntervalScheduler).stop(FILE_LIBRARY_KICKOFF_JOB),
      `cron:${FILE_LIBRARY_KICKOFF_JOB}:${intervalTick(FILE_LIBRARY_KICKOFF_PERIOD_MS, Date.now()).tick}`,
    );
    const runs = [a, b].map((k) => vi.spyOn(k.app.get(FileLibraryKickoffJob), "runOnce"));
    try {
      await Promise.all([
        a.app.get(FileLibraryKickoffJob).tick(),
        b.app.get(FileLibraryKickoffJob).tick(),
      ]);
      expect(runs.reduce((n, x) => n + x.mock.calls.length, 0)).toBe(1);
    } finally {
      for (const x of runs) x.mockRestore();
    }
    const owed = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_id", "=", "file-library-hash")
      .execute();
    expect(owed).toHaveLength(1);
  });

  it("one org's batches on both replicas at once: one chain hashes, duplicates merge once", async () => {
    const text = "merged on two replicas\n";
    const one = await migrated(text);
    const two = await migrated(text);
    const [r1, r2] = await Promise.all([
      a.app.get(FileLibraryHashJob).runOrgBatch({ orgId, after: null }),
      b.app.get(FileLibraryHashJob).runOrgBatch({ orgId, after: null }),
    ]);
    // the org's lock: whichever came second found it held (or came after the first finished and
    // found nothing left to merge)
    expect((r1.outcomes.merged ?? 0) + (r2.outcomes.merged ?? 0)).toBe(1);
    const rows = await db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blob_id")
      .select(["blobs.id", "blobs.sha256", "blobs.status"])
      .where("files.id", "in", [one.fileId, two.fileId])
      .execute();
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(rows[0]).toMatchObject({ sha256: sha(text), status: "ready" });
    const loser = [one.blobId, two.blobId].find((id) => id !== rows[0]?.id) as string;
    expect(await statuses([loser])).toEqual(["deleting"]);
    expect(await owedDeletes([loser])).toBe(1);
  });

  it("the same blob hashed on both replicas at once settles once", async () => {
    const text = "hashed on two replicas\n";
    const first = await migrated(text);
    const second = await migrated(text);
    const rowOf = async (id: string) =>
      db
        .selectFrom("blobs")
        .select(["id", "object_key", "size", "etag"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    const [r1, r2] = [await rowOf(first.blobId), await rowOf(second.blobId)];
    const outcomes = await Promise.all([
      a.app.get(FileLibraryHashJob).hashOne(orgId, r1),
      b.app.get(FileLibraryHashJob).hashOne(orgId, r1),
      a.app.get(FileLibraryHashJob).hashOne(orgId, r2),
      b.app.get(FileLibraryHashJob).hashOne(orgId, r2),
    ]);
    expect(outcomes.filter((o) => o === "hashed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "merged")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(2);
    const held = await db
      .selectFrom("blobs")
      .select("id")
      .where("org_id", "=", orgId)
      .where("sha256", "=", sha(text))
      .execute();
    expect(held).toHaveLength(1);
  });
});
