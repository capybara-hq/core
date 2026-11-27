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
 * File library spec §3 on two replicas: identical uploads finalized at the same moment on
 * different replicas resolve through the `(org_id, sha256)` unique index. Two accounts: one blob
 * holds the hash and the other upload keeps its staging object as a blob of its own (no account's
 * file points at bytes another account's form may still overwrite), nothing deleted. One account:
 * both files point at one blob and exactly one staging deletion is owed.
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

const finalize = (req: Req, id: string, bytes: Buffer) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/files/${id}/finalize`,
    payload: { sha256: sha(bytes) },
  });

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

describe("concurrent finalizes on two replicas", () => {
  it("two accounts: one blob holds the hash, the other upload keeps its own; nothing deleted", async () => {
    const bytes = Buffer.from("quarterly numbers, two accounts\n");
    const [one, two] = await Promise.all([staged(aliceA, bytes), staged(bobB, bytes)]);
    const [r1, r2] = await Promise.all([finalize(aliceA, one, bytes), finalize(bobB, two, bytes)]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    // the same answer whichever won
    expect(r1.json()).toMatchObject({ status: "draft" });
    expect(r2.json()).toMatchObject({ status: "draft" });

    const { files, hashed, owed } = await outcome([one, two], bytes);
    expect(files.map((f) => f.status)).toEqual(["draft", "draft"]);
    expect(hashed).toHaveLength(1);
    const winner = files.find((f) => f.blob_id === hashed[0]?.id);
    const loser = files.find((f) => f.blob_id !== hashed[0]?.id);
    expect(winner).toBeDefined();
    expect(loser?.blob_id).toBeTruthy();
    expect(hashed[0]?.object_key).toBe(`uploads/${winner?.id}`);
    const own = await db
      .selectFrom("blobs")
      .select(["sha256", "object_key", "status"])
      .where("id", "=", loser?.blob_id as string)
      .executeTakeFirstOrThrow();
    expect(own).toEqual({ sha256: null, object_key: `uploads/${loser?.id}`, status: "ready" });
    expect(owed).toEqual([]);
  });

  it("one account: both files point at one blob and exactly one staging deletion is owed", async () => {
    const bytes = Buffer.from("quarterly numbers, one account\n");
    const [one, two] = await Promise.all([staged(aliceA, bytes), staged(aliceB, bytes)]);
    const [r1, r2] = await Promise.all([
      finalize(aliceA, one, bytes),
      finalize(aliceB, two, bytes),
    ]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    const { files, hashed, owed } = await outcome([one, two], bytes);
    expect(hashed).toHaveLength(1);
    expect(files.map((f) => f.blob_id)).toEqual([hashed[0]?.id, hashed[0]?.id]);
    expect(owed).toHaveLength(1);
    // the deletion is owed for the upload whose staging object the blob did not adopt
    const adopted = hashed[0]?.object_key.replace("uploads/", "");
    expect(owed[0]?.job_id).toBe(`file-staging-delete-${adopted === one ? two : one}`);
  });

  it("the same upload finalized on both replicas at once: one blob, the same answer, nothing owed", async () => {
    const bytes = Buffer.from("finalized twice\n");
    const id = await staged(aliceA, bytes);
    const [r1, r2] = await Promise.all([finalize(aliceA, id, bytes), finalize(aliceB, id, bytes)]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    const { files, hashed, owed } = await outcome([id], bytes);
    expect(hashed).toHaveLength(1);
    expect(files).toEqual([{ id, status: "draft", blob_id: hashed[0]?.id }]);
    expect(owed).toEqual([]);
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
    expect((await finalize(aliceA, id, bytes)).statusCode).toBe(200);
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
    expect((await finalize(aliceA, id, bytes)).statusCode).toBe(200);
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
