import { randomUUID } from "node:crypto";
import type { ObjectStore } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { ShareLiveness } from "../../src/shares/liveness.js";
import { ShareObjects, shareRefreshLockKey } from "../../src/shares/share-objects.js";
import { SharesService } from "../../src/shares/shares.service.js";
import { ShareSweepJob } from "../../src/shares/sweep.job.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { accountsFor } from "../helpers/identity.js";
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
 * File sharing spec §2, two replicas: a snapshot is written before its row (intent first), a
 * snapshot deletion delivered twice is harmless, and a share created on one replica is revoked on
 * the other. §9: the daily share sweep runs once per tick across replicas.
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
let ownerId: string;
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
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
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
  return artifactId;
}

const create = (req: Req, fileId: string) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/files/${fileId}/shares`,
    payload: { audience: "internal", expiresInDays: null },
  });

const shareKeys = async () => (await store(a).list("shares/")).items.map((o) => o.key);

describe("shares on two replicas", () => {
  it("the snapshot is stored before its row; a failed insert leaves the object and no row", async () => {
    const storage = a.app.get(StorageService);
    const kernel = storage.kernel.bind(storage);
    /** For every snapshot put: whether a row for that share existed when the put began. */
    const puts: { key: string; rowExisted: boolean }[] = [];
    const spy = vi.spyOn(storage, "kernel").mockImplementation((org: string) => {
      const s = kernel(org);
      return {
        ...s,
        put: async (key, body, opts) => {
          const m = /^shares\/([0-9a-f-]{36})\/\d+$/.exec(key);
          if (m) {
            const row = await db
              .selectFrom("file_shares")
              .select("id")
              .where("id", "=", m[1] as string)
              .executeTakeFirst();
            puts.push({ key, rowExisted: row !== undefined });
          }
          return s.put(key, body, opts);
        },
      };
    });
    try {
      const fileId = await deliver("one");
      const r = await create(ownerA, fileId);
      expect(r.statusCode, r.body).toBe(201);
      const id = (r.json() as { share: { id: string } }).share.id;
      expect(puts).toEqual([{ key: `shares/${id}/1`, rowExisted: false }]);
      expect(
        await db.selectFrom("file_shares").select("id").where("id", "=", id).execute(),
      ).toEqual([{ id }]);

      // the insert fails: the snapshot is an orphan (the daily sweep frees it), no row is left
      await sql`CREATE FUNCTION capybara.test_refuse_share() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`.execute(raw);
      await sql`CREATE TRIGGER test_refuse_share BEFORE INSERT ON capybara.file_shares
        FOR EACH ROW EXECUTE FUNCTION capybara.test_refuse_share()`.execute(raw);
      try {
        const before = new Set(await shareKeys());
        const failed = await create(ownerA, fileId);
        expect(failed.statusCode).toBe(500);
        const orphans = (await shareKeys()).filter((k) => !before.has(k));
        expect(orphans).toHaveLength(1);
        const orphanId = (orphans[0] as string).split("/")[1] as string;
        expect(
          await db.selectFrom("file_shares").select("id").where("id", "=", orphanId).execute(),
        ).toEqual([]);
        expect(puts.at(-1)).toEqual({ key: orphans[0], rowExisted: false });
      } finally {
        await sql`DROP TRIGGER test_refuse_share ON capybara.file_shares`.execute(raw);
        await sql`DROP FUNCTION capybara.test_refuse_share()`.execute(raw);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("a snapshot deletion delivered twice (once per replica) deletes once and succeeds twice", async () => {
    const r = await create(ownerA, await deliver("two"));
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as { share: { id: string } }).share.id;
    // an earlier generation's snapshot, as a refresh leaves behind
    await store(a).put(`shares/${id}/7`, Buffer.from("old"), { contentType: "text/plain" });
    const data = { orgId, shareId: id, generation: 7, objectKey: `shares/${id}/7` };
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
      // the live generation is never deleted, whatever a job says
      await b.app
        .get(ShareObjects)
        .deleteObject({ orgId, shareId: id, generation: 1, objectKey: `shares/${id}/1` });
      expect(await store(a).head(`shares/${id}/1`)).not.toBeNull();
      expect(deletes).toEqual([`shares/${id}/7`]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("a share created on replica A is revoked on replica B; its snapshot is freed", async () => {
    const r = await create(ownerA, await deliver("three"));
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as { share: { id: string } }).share.id;
    const del = await ownerB({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${id}` });
    expect(del.statusCode).toBe(204);
    const row = await db
      .selectFrom("file_shares")
      .select(["revoke_reason", "revoked_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.revoke_reason).toBe("creator");
    expect(row.revoked_at).not.toBeNull();
    await expect.poll(() => store(b).head(`shares/${id}/1`), { timeout: 30_000 }).toBeNull();
    // listed as revoked on A
    const listed = await ownerA({ method: "GET", url: `/api/v1/orgs/${orgId}/shares` });
    expect(
      (listed.json() as { shares: { id: string; state: string }[] }).shares.find((s) => s.id === id)
        ?.state,
    ).toBe("revoked");
  });

  it("a share created on A is refreshed on B: the new generation is served, the old one freed", async () => {
    const r = await create(ownerA, await deliver("v1"));
    const id = (r.json() as { share: { id: string; code: string } }).share.id;
    await deliver("v2!");
    const refreshed = await ownerB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/shares/${id}/refresh`,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect((refreshed.json() as { share: { generation: number } }).share.generation).toBe(2);
    const live = await a.app.get(ShareLiveness).byId(id);
    expect(live).toMatchObject({ generation: 2, objectKey: `shares/${id}/2`, size: 3 });
    await expect.poll(() => store(a).head(`shares/${id}/1`), { timeout: 30_000 }).toBeNull();
  });

  it("concurrent refreshes of one share on both replicas: one moves it, the other finds nothing newer", async () => {
    const r = await create(ownerA, await deliver("c1"));
    const id = (r.json() as { share: { id: string } }).share.id;
    await deliver("c2-newer");
    const url = `/api/v1/orgs/${orgId}/shares/${id}/refresh`;
    const results = await Promise.all([
      ownerA({ method: "POST", url }),
      ownerB({ method: "POST", url }),
    ]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 410]);
    const row = await db
      .selectFrom("file_shares")
      .select(["generation", "size", "object_key"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ generation: 2, size: "8", object_key: `shares/${id}/2` });
    const got = await store(b).get(`shares/${id}/2`);
    expect(got && Buffer.from(await new Response(got.body).arrayBuffer()).toString()).toBe(
      "c2-newer",
    );
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

/**
 * Makes every replica's object listing report `ages` (ms before now) for the given keys: S3 sets
 * an object's time when it is written, so an old object is simulated in the listing the sweep reads.
 */
function listedAges(
  ages: Map<string, number>,
  opts: {
    /** `head` reports the same ages (a key not written again since the listing). */
    head?: boolean;
    /** Runs after each listing, before the sweep sees it (a write racing the sweep). */
    afterList?: (store: ObjectStore) => Promise<void>;
  } = {},
) {
  const aged = <T extends { key: string; lastModified?: string }>(i: T): T => {
    const age = ages.get(i.key);
    return age === undefined ? i : { ...i, lastModified: new Date(Date.now() - age).toISOString() };
  };
  return [a, b].map((k) => {
    const storage = k.app.get(StorageService);
    const kernel = storage.kernel.bind(storage);
    return vi.spyOn(storage, "kernel").mockImplementation((org: string): ObjectStore => {
      const s = kernel(org);
      return {
        ...s,
        list: async (prefix, o) => {
          const page = await s.list(prefix, o);
          await opts.afterList?.(s);
          return { ...page, items: page.items.map(aged) };
        },
        ...(opts.head && {
          head: async (key: string) => {
            const h = await s.head(key);
            return h && aged(h);
          },
        }),
      };
    });
  });
}

describe("the daily share sweep on two replicas", () => {
  const MINUTE = 60_000;
  const exists = async (key: string) => (await store(a).head(key)) !== null;
  const put = (key: string) =>
    store(a).put(key, Buffer.from("x"), { contentType: "text/plain", size: 1 });
  const shareRow = (id: string) =>
    db.selectFrom("file_shares").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  const shareOf = async (text: string) => {
    const r = await create(ownerA, await deliver(text));
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { share: { id: string } }).share.id;
  };

  it("runs once per tick; frees orphans older than an hour and old snapshots, keeps the rest", async () => {
    const live = await shareOf("live");
    const revoked = await shareOf("revoked");
    const expired = await shareOf("expired");
    const recent = await shareOf("recent");
    // revoked eight days ago, its owed deletion lost: the sweep is the backstop
    await sql`UPDATE capybara.file_shares SET revoked_at = now() - interval '8 days',
      revoke_reason = 'creator' WHERE id = ${revoked}`.execute(raw);
    // expired eight days ago (an expiry owes nothing: the sweep frees it)
    await sql`UPDATE capybara.file_shares SET expires_at = now() - interval '8 days'
      WHERE id = ${expired}`.execute(raw);
    // expired two days ago: still within the week its snapshot is kept
    await sql`UPDATE capybara.file_shares SET expires_at = now() - interval '2 days'
      WHERE id = ${recent}`.execute(raw);

    const oldOrphan = `shares/${randomUUID()}/1`;
    const youngOrphan = `shares/${randomUUID()}/1`;
    // a refresh that died between its copy and its commit: the row still names generation 1
    const deadRefresh = `shares/${live}/2`;
    await Promise.all([put(oldOrphan), put(youngOrphan), put(deadRefresh)]);
    const spies = listedAges(
      new Map([
        [oldOrphan, 120 * MINUTE],
        [youngOrphan, 10 * MINUTE],
        [deadRefresh, 120 * MINUTE],
        // as old as the orphans: only its row keeps it
        [`shares/${live}/1`, 120 * MINUTE],
        [`shares/${recent}/1`, 120 * MINUTE],
      ]),
      { head: true },
    );
    const runs = [a, b].map((k) => vi.spyOn(k.app.get(ShareSweepJob), "runOnce"));
    try {
      // both replicas' schedulers fire the same tick: one runs it
      await Promise.all([a.app.get(ShareSweepJob).sweep(), b.app.get(ShareSweepJob).sweep()]);
      expect(runs.reduce((n, x) => n + x.mock.calls.length, 0)).toBe(1);
    } finally {
      for (const x of [...spies, ...runs]) x.mockRestore();
    }

    expect(await exists(oldOrphan)).toBe(false);
    expect(await exists(deadRefresh)).toBe(false);
    expect(await exists(youngOrphan)).toBe(true);
    expect(await exists(`shares/${live}/1`)).toBe(true);
    expect(await shareRow(live)).toMatchObject({
      object_key: `shares/${live}/1`,
      revoked_at: null,
    });
    expect(await exists(`shares/${recent}/1`)).toBe(true);
    expect((await shareRow(recent)).object_key).toBe(`shares/${recent}/1`);

    expect(await exists(`shares/${revoked}/1`)).toBe(false);
    expect(await shareRow(revoked)).toMatchObject({ object_key: null, revoke_reason: "creator" });
    expect(await exists(`shares/${expired}/1`)).toBe(false);
    expect(await shareRow(expired)).toMatchObject({ object_key: null, revoked_at: null });
  });

  it("never undoes a retried refresh writing the same generation again; a held refresh lock skips the key", async () => {
    const id = await shareOf("r1");
    const newer = await deliver("r2-newer");
    const next = `shares/${id}/2`;
    const ages = new Map([[next, 120 * MINUTE]]);
    const sweep = () => b.app.get(ShareSweepJob).runOnce();

    // a refresh whose copy failed left generation 2 behind and owes nothing
    await put(next);
    // a refresh holding the lock (mid-copy): the key is skipped, the next run sees it
    const held = await a.app.get(LockService).acquire(shareRefreshLockKey(id), {
      ttlMs: 30_000,
      waitMs: 0,
    });
    expect(held).toBeDefined();
    let spies = listedAges(ages, { head: true });
    try {
      await sweep();
      expect(await exists(next)).toBe(true);
      await held?.release();
      await sweep();
      expect(await exists(next)).toBe(false);
    } finally {
      for (const x of spies) x.mockRestore();
    }

    // again; this time the retried refresh writes the key anew between the listing and the delete
    await put(next);
    spies = listedAges(ages, {
      afterList: async (s) => {
        await s.put(next, Buffer.from("r2-newer"), { contentType: "text/plain", size: 8 });
      },
    });
    try {
      await sweep();
    } finally {
      for (const x of spies) x.mockRestore();
    }
    expect(await exists(next)).toBe(true);
    // the refresh commits: the share serves generation 2, whose object is there
    const moved = await a.app
      .get(SharesService)
      .commitRefresh(
        { orgId, accountId: ownerId, shareId: id, from: 1 },
        { fileId: newer, name: "r.txt", contentType: "text/plain", size: 8, objectKey: next },
        {},
      );
    expect(moved).toBe(true);
    const live = await a.app.get(ShareLiveness).byId(id);
    expect(live).toMatchObject({ generation: 2, objectKey: next });
    const got = await store(a).get(next);
    expect(got && Buffer.from(await new Response(got.body).arrayBuffer()).toString()).toBe(
      "r2-newer",
    );
  });
});
