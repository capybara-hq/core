import { createHash } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { BlobObjects, FILE_STAGING_DELETE_JOB } from "../../src/files/blob-objects.js";
import { FileDraftCleanupJob } from "../../src/files/draft-cleanup.job.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * File library spec §3 (with its builder amendment) on two replicas: identical uploads finalized
 * at the same moment on different replicas each copy their bytes to a kernel-owned blob, and the
 * hash's lock settles which copy holds the hash; the outcome is the same for one account or two.
 * Also: the draft cleanup, a discard racing a reuse, and a blob deletion delivered twice.
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
let aliceA: Req;
let aliceB: Req;
let bobB: Req;

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
  const accounts = accountsFor(db);
  const alice = await accounts.createLocal({ login: "alice", password: PW, displayName: "A" });
  const bob = await accounts.createLocal({ login: "bob", password: PW, displayName: "B" });
  aliceA = await session(a, "alice");
  aliceB = await session(b, "alice");
  bobB = await session(b, "bob");
  orgId = await createOrgWithProviders(a, aliceA);
  await testMembers(db).add(orgId, bob.id, "member", alice.id);
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Creates and uploads a composer file; returns its id (not finalized). */
async function staged(req: Req, bytes: Buffer): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/files`,
    payload: {
      name: "report.txt",
      contentType: "text/plain",
      size: bytes.length,
      sha256: sha(bytes),
      purpose: "composer",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json() as {
    file: { id: string };
    upload: { url: string; headers: Record<string, string>; fields?: Record<string, string> };
  };
  const form = new FormData();
  for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "text/plain" }));
  const up = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  expect(up.status, await up.clone().text()).toBeLessThan(300);
  return c.file.id;
}

const finalize = (req: Req, id: string) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/files/${id}/finalize` });

const discard = (req: Req, id: string) =>
  req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/files/${id}/draft` });

/** The files' blobs, the blobs holding the hash, and the staging deletions owed for the files. */
async function outcome(ids: string[], bytes: Buffer) {
  const files = await db
    .selectFrom("files")
    .select(["id", "status", "blob_id"])
    .where("id", "in", ids)
    .execute();
  const hashed = await db
    .selectFrom("blobs")
    .select(["id", "object_key"])
    .where("org_id", "=", orgId)
    .where("sha256", "=", sha(bytes))
    .execute();
  const owed = await db
    .selectFrom("outbox")
    .select("job_id")
    .where("job_name", "=", FILE_STAGING_DELETE_JOB)
    .where(
      "job_id",
      "in",
      ids.map((id) => `file-staging-delete-${id}`),
    )
    .execute();
  return { files, hashed, owed };
}

/**
 * Two files finalized with the same bytes: one ready blob holds the hash at a kernel-owned key and
 * both files point at it; the other copy is `deleting` with its deletion owed; both staging
 * objects' deletions are owed.
 */
async function sameAfterFinalize(ids: string[], bytes: Buffer, before: string[]): Promise<void> {
  const { files, hashed, owed } = await outcome(ids, bytes);
  expect(files.map((f) => f.status)).toEqual(["draft", "draft"]);
  expect(hashed).toHaveLength(1);
  expect(hashed[0]?.object_key).toBe(`blobs/${hashed[0]?.id}`);
  expect(files.map((f) => f.blob_id)).toEqual([hashed[0]?.id, hashed[0]?.id]);
  expect(owed).toHaveLength(2);
  await expectOneExtraCopy(before, hashed[0]?.id as string);
}

/** Every blob id of the org. */
const blobIds = async () =>
  (await db.selectFrom("blobs").select("id").where("org_id", "=", orgId).execute()).map(
    (r) => r.id,
  );

/** Of the blobs made since `before`: the holder and one other copy, `deleting` and owed. */
async function expectOneExtraCopy(before: string[], holder: string): Promise<void> {
  const made = (await blobIds()).filter((id) => !before.includes(id));
  expect(made).toHaveLength(2);
  expect(made).toContain(holder);
  const extra = made.find((id) => id !== holder) as string;
  const row = await db
    .selectFrom("blobs")
    .select("status")
    .where("id", "=", extra)
    .executeTakeFirstOrThrow();
  expect(row.status).toBe("deleting");
  const owedDelete = await db
    .selectFrom("outbox")
    .select("job_id")
    .where("job_id", "=", `blob-delete-${extra}`)
    .execute();
  expect(owedDelete).toHaveLength(1);
}

describe("concurrent finalizes on two replicas", () => {
  it("two accounts: one ready blob holds the hash, both files point at it, the extra copy is owed", async () => {
    const bytes = Buffer.from("quarterly numbers, two accounts\n");
    const [one, two] = await Promise.all([staged(aliceA, bytes), staged(bobB, bytes)]);
    const before = await blobIds();
    const [r1, r2] = await Promise.all([finalize(aliceA, one), finalize(bobB, two)]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r1.json()).toMatchObject({ status: "draft" });
    expect(r2.json()).toMatchObject({ status: "draft" });
    await sameAfterFinalize([one, two], bytes, before);
  });

  it("one account: the same outcome as two", async () => {
    const bytes = Buffer.from("quarterly numbers, one account\n");
    const [one, two] = await Promise.all([staged(aliceA, bytes), staged(aliceB, bytes)]);
    const before = await blobIds();
    const [r1, r2] = await Promise.all([finalize(aliceA, one), finalize(aliceB, two)]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    await sameAfterFinalize([one, two], bytes, before);
  });

  it("the same upload finalized on both replicas at once: one blob holds it, the same answer", async () => {
    const bytes = Buffer.from("finalized twice\n");
    const id = await staged(aliceA, bytes);
    const before = await blobIds();
    const [r1, r2] = await Promise.all([finalize(aliceA, id), finalize(aliceB, id)]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    const { files, hashed, owed } = await outcome([id], bytes);
    expect(hashed).toHaveLength(1);
    expect(files).toEqual([{ id, status: "draft", blob_id: hashed[0]?.id }]);
    // the staging object once; the losing finalize's copy is released
    expect(owed).toHaveLength(1);
    await expectOneExtraCopy(before, hashed[0]?.id as string);
  });

  it("the draft cleanup on both replicas at once expires each file once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await staged(aliceA, Buffer.from(`expiring ${i}\n`)));
    await sql`UPDATE capybara.files SET expires_at = now() - interval '1 minute',
      created_at = now() - interval '25 hours' WHERE id IN (${sql.join(ids)})`.execute(raw);
    const [n1, n2] = await Promise.all([
      a.app.get(FileDraftCleanupJob).runOnce(),
      b.app.get(FileDraftCleanupJob).runOnce(),
    ]);
    expect(n1 + n2).toBe(ids.length);
    const { files, owed } = await outcome(ids, Buffer.from(""));
    expect(files.every((f) => f.status === "deleted")).toBe(true);
    expect(owed).toHaveLength(ids.length);
  });

  it("a discard racing the same account's instant upload never leaves a file on a deleting blob", async () => {
    const bytes = Buffer.from("discard versus reuse\n");
    const id = await staged(aliceA, bytes);
    expect((await finalize(aliceA, id)).statusCode).toBe(200);
    await sql`UPDATE capybara.files SET created_at = now() - interval '1 hour' WHERE id = ${id}`.execute(
      raw,
    );
    const [gone, again] = await Promise.all([
      discard(aliceA, id),
      aliceB({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/files`,
        payload: {
          name: "again.txt",
          contentType: "text/plain",
          size: bytes.length,
          sha256: sha(bytes),
          purpose: "composer",
        },
      }),
    ]);
    expect(gone.statusCode, gone.body).toBe(204);
    expect(again.statusCode, again.body).toBe(201);
    const onDeleting = await db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blob_id")
      .select("files.id")
      .where("blobs.status", "<>", "ready")
      .execute();
    expect(onDeleting).toEqual([]);
    const created = again.json() as { file: { id: string }; upload: unknown };
    const reused = await db
      .selectFrom("files")
      .select("blob_id")
      .where("id", "=", created.file.id)
      .executeTakeFirstOrThrow();
    // either the reuse came first (the blob stays) or the discard did (the caller uploads)
    expect(created.upload === null).toBe(reused.blob_id !== null);
  });

  it("a blob deletion delivered on both replicas at once is harmless", async () => {
    const bytes = Buffer.from("deleted twice\n");
    const id = await staged(aliceA, bytes);
    expect((await finalize(aliceA, id)).statusCode).toBe(200);
    const blobId = (
      await db.selectFrom("files").select("blob_id").where("id", "=", id).executeTakeFirstOrThrow()
    ).blob_id as string;
    await sql`UPDATE capybara.files SET created_at = now() - interval '1 hour' WHERE id = ${id}`.execute(
      raw,
    );
    expect((await discard(aliceA, id)).statusCode).toBe(204);
    const data = { orgId, blobId };
    await Promise.all([
      a.app.get(BlobObjects).deleteBlob(data),
      b.app.get(BlobObjects).deleteBlob(data),
    ]);
    expect(
      await db.selectFrom("blobs").select("id").where("id", "=", blobId).executeTakeFirst(),
    ).toBeUndefined();
  });
});
