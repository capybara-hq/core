import { randomUUID } from "node:crypto";
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
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { scheduledTick } from "../../src/infra/schedule/cron-tick.js";
import { ScheduledRuns } from "../../src/infra/schedule/scheduled-runs.js";
import { createLogger } from "../../src/log.js";
import { ShareLiveness } from "../../src/shares/liveness.js";
import { ShareObjects } from "../../src/shares/share-objects.js";
import { SHARE_SWEEP_CRON, SHARE_SWEEP_JOB, ShareSweepJob } from "../../src/shares/sweep.job.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { accountsFor } from "../helpers/identity.js";
import { migrateLegacyFiles } from "../helpers/library-files.js";
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
 * File sharing spec §2 and file library spec §6, two replicas: a share points at its file's blob
 * (nothing copied), locked `ready` in the inserting transaction, so a blob a deletion claims is
 * never pointed at; a legacy snapshot deletion delivered twice is harmless and never deletes a
 * blob's key; a share created on one replica is revoked or refreshed on the other. §9: the daily
 * share sweep runs once per tick across replicas and lets go of old shares' blobs.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let a: TestKernel;
let b: TestKernel;
let ownerA: Req;
let ownerB: Req;
let orgId: string;
let conv: string;

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
  const quiet = { logger: createLogger("error", { write: () => {} }) };
  a = await startKernel(cfg, quiet);
  b = await startKernel(cfg, quiet);
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  ownerA = await session(a, "owner");
  ownerB = await session(b, "owner");
  orgId = await createOrgWithProviders(a, ownerA);
  conv = await createConv(ownerA, orgId, await createAgent(ownerA, orgId));
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

const store = (k: TestKernel) => k.app.get(StorageService).kernel(orgId);

async function deliver(text: string): Promise<string> {
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  const bytes = Buffer.from(text);
  await store(a).put(objectKey, bytes, { contentType: "text/plain", size: bytes.byteLength });
  await a.app.get(EventLog).append(conv, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name: "r.txt",
        contentType: "text/plain",
        size: bytes.byteLength,
        objectKey,
        sourcePath: "/workspace/r.txt",
        callId: `call-${artifactId}`,
      },
    },
  ]);
  // logged the way deliveries were before the file library, then migrated (0189)
  await migrateLegacyFiles(db);
  return artifactId;
}

const create = (req: Req, fileId: string) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/files/${fileId}/shares`,
    payload: { audience: "internal", expiresInDays: null },
  });

const shareKeys = async () => (await store(a).list("shares/")).items.map((o) => o.key);
const shareRow = (id: string) =>
  db.selectFrom("file_shares").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const blobOf = async (fileId: string) =>
  (
    await db
      .selectFrom("files")
      .select("blob_id")
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow()
  ).blob_id as string;
const text = async (key: string) => {
  const got = await store(a).get(key);
  return got && Buffer.from(await new Response(got.body).arrayBuffer()).toString();
};
const keyOf = async (blobId: string) =>
  (
    await db
      .selectFrom("blobs")
      .select("object_key")
      .where("id", "=", blobId)
      .executeTakeFirstOrThrow()
  ).object_key;

describe("shares on two replicas", () => {
  it("a share writes no object: its row points at the file's blob", async () => {
    const fileId = await deliver("one");
    const r = await create(ownerA, fileId);
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as { share: { id: string } }).share.id;
    expect(await shareRow(id)).toMatchObject({ blob_id: await blobOf(fileId), object_key: null });
    expect(await shareKeys()).toEqual([]);
  });

  it("a create on B waiting on a blob a deletion claims on A's side is refused, leaving no row", async () => {
    const fileId = await deliver("claimed");
    const blobId = await blobOf(fileId);
    const before = (await db.selectFrom("file_shares").select("id").execute()).length;
    let pending: Promise<{ statusCode: number; json(): unknown }> | undefined;
    // the blob sweep's claim: the row locked FOR UPDATE, then `deleting`
    await db.transaction().execute(async (trx) => {
      await sql`SELECT 1 FROM capybara.blobs WHERE id = ${blobId} FOR UPDATE`.execute(trx);
      pending = create(ownerB, fileId);
      // the create read the blob ready before its transaction; its lockReady now waits on the
      // claim (a row lock wait shows as a lock not granted)
      await expect
        .poll(
          async () =>
            Number(
              (
                await sql<{
                  n: string;
                }>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted`.execute(raw)
              ).rows[0]?.n ?? 0,
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      await sql`UPDATE capybara.blobs SET status = 'deleting' WHERE id = ${blobId}`.execute(trx);
    });
    const r = await (pending as Promise<{ statusCode: number; json(): unknown }>);
    expect(r.statusCode).toBe(410);
    expect((r.json() as { error: { code: string } }).error.code).toBe("share.file_unavailable");
    expect((await db.selectFrom("file_shares").select("id").execute()).length).toBe(before);
    await sql`UPDATE capybara.blobs SET status = 'ready' WHERE id = ${blobId}`.execute(raw);
  });

  it("a legacy snapshot deletion delivered twice (once per replica) deletes once; a blob's key never", async () => {
    const r = await create(ownerA, await deliver("two"));
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as { share: { id: string } }).share.id;
    // a generation's snapshot owed for deletion before the deploy
    await store(a).put(`shares/${id}/7`, Buffer.from("old"), { contentType: "text/plain" });
    const data = { orgId, shareId: id, generation: 7, objectKey: `shares/${id}/7` };
    // a snapshot 0189 made a blob (keeping its key), still owed by a row from before the deploy
    await store(a).put(`shares/${id}/1`, Buffer.from("kept"), { contentType: "text/plain" });
    await db
      .insertInto("blobs")
      .values({
        id: randomUUID(),
        org_id: orgId,
        sha256: null,
        size: 4,
        etag: null,
        object_key: `shares/${id}/1`,
        status: "ready",
      })
      .execute();
    const deletes: string[] = [];
    const spies = [a, b].map((k) => {
      const storage = k.app.get(StorageService);
      const kernel = storage.kernel.bind(storage);
      return vi.spyOn(storage, "kernel").mockImplementation((org: string) => {
        const s = kernel(org);
        return {
          ...s,
          delete: async (key: string) => {
            deletes.push(key);
            return s.delete(key);
          },
        };
      });
    });
    try {
      await a.app.get(ShareObjects).deleteObject(data);
      await b.app.get(ShareObjects).deleteObject(data);
      expect(deletes).toEqual([`shares/${id}/7`]);
      expect(await store(a).head(`shares/${id}/7`)).toBeNull();
      await sql`UPDATE capybara.file_shares SET revoked_at = now() WHERE id = ${id}`.execute(raw);
      await b.app
        .get(ShareObjects)
        .deleteObject({ orgId, shareId: id, generation: 1, objectKey: `shares/${id}/1` });
      expect(await text(`shares/${id}/1`)).toBe("kept");
      expect(deletes).toEqual([`shares/${id}/7`]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("a share created on replica A is revoked on replica B: nothing is owed, the bytes stay the file's", async () => {
    const fileId = await deliver("three");
    const r = await create(ownerA, fileId);
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as { share: { id: string } }).share.id;
    const del = await ownerB({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${id}` });
    expect(del.statusCode).toBe(204);
    const row = await shareRow(id);
    expect(row.revoke_reason).toBe("creator");
    expect(row.revoked_at).not.toBeNull();
    expect(
      await db
        .selectFrom("outbox")
        .select("job_id")
        .where("job_name", "=", "share-object-delete")
        .execute(),
    ).toEqual([]);
    expect(await text(await keyOf(await blobOf(fileId)))).toBe("three");
    // listed as revoked on A
    const listed = await ownerA({ method: "GET", url: `/api/v1/orgs/${orgId}/shares` });
    expect(
      (listed.json() as { shares: { id: string; state: string }[] }).shares.find((s) => s.id === id)
        ?.state,
    ).toBe("revoked");
  });

  it("a share created on A is refreshed on B: A serves the new version's blob", async () => {
    const v1 = await deliver("v1");
    const r = await create(ownerA, v1);
    const id = (r.json() as { share: { id: string; code: string } }).share.id;
    const v2 = await deliver("v2!");
    const refreshed = await ownerB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/shares/${id}/refresh`,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect((refreshed.json() as { share: { generation: number } }).share.generation).toBe(2);
    const live = await a.app.get(ShareLiveness).byId(id);
    expect(live).toMatchObject({ generation: 2, size: 3, blob: { id: await blobOf(v2) } });
    expect(await text(await keyOf(await blobOf(v1)))).toBe("v1");
  });

  it("concurrent refreshes of one share on both replicas: one moves it, the other finds nothing newer", async () => {
    const r = await create(ownerA, await deliver("c1"));
    const id = (r.json() as { share: { id: string } }).share.id;
    const newer = await deliver("c2-newer");
    const url = `/api/v1/orgs/${orgId}/shares/${id}/refresh`;
    const results = await Promise.all([
      ownerA({ method: "POST", url }),
      ownerB({ method: "POST", url }),
    ]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 410]);
    const row = await db
      .selectFrom("file_shares")
      .select(["generation", "size", "blob_id", "object_key"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      generation: 2,
      size: "8",
      blob_id: await blobOf(newer),
      object_key: null,
    });
  });

  it("creates on both replicas at once get distinct ids and codes; a revoke on A stops the link on B at once", async () => {
    const fileId = await deliver("both");
    const made = await Promise.all([create(ownerA, fileId), create(ownerB, fileId)]);
    const shares = made.map((x) => {
      expect(x.statusCode, x.body).toBe(201);
      return (x.json() as { share: { id: string; code: string } }).share;
    });
    expect(new Set(shares.map((x) => x.id)).size).toBe(2);
    expect(new Set(shares.map((x) => x.code)).size).toBe(2);
    const first = shares[0] as { id: string; code: string };
    expect(await b.app.get(ShareLiveness).byCode(first.code)).not.toBeNull();
    const del = await ownerA({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${first.id}` });
    expect(del.statusCode).toBe(204);
    expect(await b.app.get(ShareLiveness).byCode(first.code)).toBeNull();
  });
});

describe("the daily share sweep on two replicas", () => {
  const shareOf = async (t: string) => {
    const r = await create(ownerA, await deliver(t));
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { share: { id: string } }).share.id;
  };

  it("runs once per tick; lets go of old shares' blobs, keeps the rest", async () => {
    const live = await shareOf("live");
    const revoked = await shareOf("revoked");
    const expired = await shareOf("expired");
    const recent = await shareOf("recent");
    await sql`UPDATE capybara.file_shares SET revoked_at = now() - interval '8 days',
      revoke_reason = 'creator' WHERE id = ${revoked}`.execute(raw);
    await sql`UPDATE capybara.file_shares SET expires_at = now() - interval '8 days'
      WHERE id = ${expired}`.execute(raw);
    // expired two days ago: still within the week it keeps its blob
    await sql`UPDATE capybara.file_shares SET expires_at = now() - interval '2 days'
      WHERE id = ${recent}`.execute(raw);
    const blobs = new Map(
      await Promise.all(
        [live, revoked, expired, recent].map(
          async (id) => [id, (await shareRow(id)).blob_id as string] as const,
        ),
      ),
    );

    // the replicas' own schedulers fire the same daily tick (03:40): stop them, wait out a run
    // one of them may have started (it holds the run lock, so both calls below would skip), and
    // clear the tick marker it set, so the two calls below are the tick's only takers. A run is
    // tracked from the moment its timer fires, and no new one starts once the jobs are deleted:
    // any moment with no run in flight on a replica is past it.
    for (const k of [a, b]) k.app.get(SchedulerRegistry).deleteCronJob(SHARE_SWEEP_JOB);
    for (const k of [a, b]) {
      const scheduled = k.app.get(ScheduledRuns);
      await expect.poll(() => scheduled.inFlightCount, { timeout: 30_000 }).toBe(0);
    }
    const locks = a.app.get(LockService);
    const marker = `cron:${SHARE_SWEEP_JOB}:${scheduledTick(SHARE_SWEEP_CRON, Date.now()).tick}`;
    const holder = await locks.holderOf(marker);
    if (holder !== null) await locks.releaseIf(marker, holder);
    const runs = [a, b].map((k) => vi.spyOn(k.app.get(ShareSweepJob), "runOnce"));
    try {
      // both replicas' schedulers fire the same tick: one runs it
      await Promise.all([a.app.get(ShareSweepJob).sweep(), b.app.get(ShareSweepJob).sweep()]);
      expect(runs.reduce((n, x) => n + x.mock.calls.length, 0)).toBe(1);
    } finally {
      for (const x of runs) x.mockRestore();
    }

    expect(await shareRow(live)).toMatchObject({ blob_id: blobs.get(live), revoked_at: null });
    expect((await shareRow(recent)).blob_id).toBe(blobs.get(recent));
    expect(await shareRow(revoked)).toMatchObject({ blob_id: null, revoke_reason: "creator" });
    expect(await shareRow(expired)).toMatchObject({ blob_id: null, revoked_at: null });
    // the share sweep deletes no bytes: they are the files' blobs
    expect(await text(await keyOf(blobs.get(revoked) as string))).toBe("revoked");
  });
});
