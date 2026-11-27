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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ATTACHMENT_EXTENSIONS } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  blobDeleteJobId,
  FILE_STAGING_DELETE_JOB,
  fileStagingDeleteJobId,
} from "../../src/files/blob-objects.js";
import { BlobsService } from "../../src/files/blobs.service.js";
import { FileDraftCleanupJob } from "../../src/files/draft-cleanup.job.js";
import { LibraryFilesService } from "../../src/files/library-files.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
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
 * File library uploads (file library spec §3, §4 "Sending"): create (instant path for the
 * caller's own bytes, a presigned form otherwise), finalize (checks, sha256 over the whole object,
 * the blob rule), discard, the draft cleanup and attaching files to a message.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const TEXT = Buffer.from("name,qty\napple,3\n");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
/** While true, the outbox's adds to the maintenance queue fail (the owed row stays in PG). */
let failMaintenance = true;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
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
    ),
    {
      logger: createLogger("error", { write: () => {} }),
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failMaintenance && queue === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let owner: Req;
let other: Req;
let third: Req;
let ownerId: string;
let otherId: string;
let thirdId: string;
let orgId: string;

beforeEach(async () => {
  failMaintenance = true;
  await truncateTables(
    db,
    "capybara.conversation_files, capybara.files, capybara.blobs, capybara.outbox, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "Other" })).id;
  thirdId = (await accounts.createLocal({ login: "third", password: PW, displayName: "Third" })).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  await testMembers(db).add(orgId, thirdId, "member", ownerId);
  other = await session(k, "other");
  third = await session(k, "third");
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface Created {
  file: { id: string; name: string; contentType: string; size: number; status: string };
  upload: {
    method: "PUT" | "POST";
    url: string;
    headers: Record<string, string>;
    fields?: Record<string, string>;
  } | null;
  expiresAt: string | null;
}

type Purpose = "composer" | "library";

const createRaw = (req: Req, payload: Record<string, unknown>) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/files`, payload });

async function create(
  req: Req,
  name: string,
  contentType: string,
  bytes: Uint8Array,
  purpose: Purpose = "composer",
): Promise<Created> {
  const res = await createRaw(req, {
    name,
    contentType,
    size: bytes.byteLength,
    sha256: sha(bytes),
    purpose,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Created;
}

/** Sends bytes with the presigned form (POST: the fields first, the file last). */
async function upload(c: Created, bytes: Uint8Array, contentType: string): Promise<Response> {
  const u = c.upload;
  if (!u) throw new Error("no upload form");
  if (u.method === "PUT") {
    return fetch(u.url, { method: "PUT", headers: u.headers, body: Buffer.from(bytes) });
  }
  const form = new FormData();
  for (const [key, v] of Object.entries(u.fields ?? {})) form.append(key, v);
  form.append("file", new Blob([Buffer.from(bytes)], { type: contentType }));
  return fetch(u.url, { method: "POST", headers: u.headers, body: form });
}

const finalize = (req: Req, id: string, sha256: string, purpose: Purpose = "composer") =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/files/${id}/finalize`,
    payload: { sha256, purpose },
  });

/** Creates, uploads and finalizes a file; returns its id. */
async function ready(
  req: Req,
  name: string,
  contentType: string,
  bytes: Uint8Array,
  purpose: Purpose = "composer",
): Promise<string> {
  const c = await create(req, name, contentType, bytes, purpose);
  expect(c.upload).not.toBeNull();
  const up = await upload(c, bytes, contentType);
  expect(up.status, await up.clone().text()).toBeLessThan(300);
  const f = await finalize(req, c.file.id, sha(bytes), purpose);
  expect(f.statusCode, f.body).toBe(200);
  expect(f.json()).toEqual({
    id: c.file.id,
    name,
    contentType,
    size: bytes.byteLength,
    status: purpose === "composer" ? "draft" : "ready",
  });
  return c.file.id;
}

const fileRow = (id: string) =>
  db
    .selectFrom("files")
    .selectAll()
    .select(sql<boolean>`expires_at IS NOT NULL AND expires_at <= now()`.as("expired"))
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
const blobRow = (id: string) =>
  db
    .selectFrom("blobs")
    .selectAll()
    .select(sql<boolean>`dedup_after <= now()`.as("shareable"))
    .where("id", "=", id)
    .executeTakeFirst();
const owed = (jobId: string) =>
  db.selectFrom("outbox").selectAll().where("job_id", "=", jobId).execute();
const store = () => k.app.get(StorageService).kernel(orgId);

/** Makes the owed rows due now and delivers them (the maintenance queue runs them). */
async function deliverOwed(jobId: string): Promise<void> {
  failMaintenance = false;
  await sql`UPDATE capybara.outbox SET next_attempt_at = now(), run_at = NULL`.execute(raw);
  await drainOutbox(k.app, { jobId });
}

/** Moves a file's upload form far into the past (its owed deletions run at once). */
const ageForm = (id: string) =>
  sql`UPDATE capybara.files SET created_at = now() - interval '1 hour' WHERE id = ${id}`.execute(
    raw,
  );

describe("limits and admission", () => {
  it("GET /files/limits for members; a stranger's org is 404", async () => {
    const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/files/limits` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      extensions: [...DEFAULT_ATTACHMENT_EXTENSIONS],
      maxBytes: 20_971_520,
      imageMaxBytes: 5_242_880,
      maxPerMessage: 10,
      requestMediaBytes: 20_971_520,
      available: true,
    });
    expect((res.json() as { types: string[] }).types).toContain("image/png");
    const stranger = await createOrgWithProviders(k, other, "Elsewhere");
    const denied = await owner({ method: "GET", url: `/api/v1/orgs/${stranger}/files/limits` });
    expect(denied.statusCode).toBe(404);
  });

  it("refuses a type, a size, a name or a hash it cannot take", async () => {
    const base = { name: "a.pdf", contentType: "application/pdf", size: 10, sha256: sha(TEXT) };
    const bad = await createRaw(owner, {
      ...base,
      contentType: "application/vnd.ms-excel",
      purpose: "composer",
    });
    expect(bad.statusCode).toBe(415);
    expect(bad.json().error.code).toBe("file.type_not_allowed");
    const big = await createRaw(owner, {
      ...base,
      size: 20 * 1024 * 1024 + 1,
      purpose: "composer",
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("file.too_large");
    const bigImg = await createRaw(owner, {
      ...base,
      contentType: "image/png",
      size: 5 * 1024 * 1024 + 1,
      purpose: "composer",
    });
    expect(bigImg.statusCode).toBe(413);
    const ctl = await createRaw(owner, { ...base, name: "a\u0007.pdf", purpose: "composer" });
    expect(ctl.statusCode).toBe(400);
    const hash = await createRaw(owner, { ...base, sha256: "XYZ", purpose: "composer" });
    expect(hash.statusCode).toBe(400);
    const purpose = await createRaw(owner, { ...base, purpose: "chat" });
    expect(purpose.statusCode).toBe(400);
  });

  it("caps an account's unfinished uploads and drafts at 50; another account is not affected", async () => {
    await db
      .insertInto("files")
      .values(
        Array.from({ length: 50 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          org_id: orgId,
          account_id: ownerId,
          name: `p${i}.png`,
          content_type: "image/png",
          size: 1,
          origin: "upload" as const,
          status: "uploading" as const,
          expires_at: sql<Date>`now() + interval '1 hour'`,
        })),
      )
      .execute();
    const body = {
      name: "a.png",
      contentType: "image/png",
      size: PNG.length,
      sha256: sha(PNG),
      purpose: "composer",
    };
    const res = await createRaw(owner, body);
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error.code).toBe("file.too_many_pending");
    expect((await createRaw(other, body)).statusCode).toBe(201);
  });
});

describe("upload and finalize", () => {
  it("a composer upload becomes a draft on a blob adopting its staging object; finalize is idempotent and the uploader's only", async () => {
    const c = await create(owner, "cat.png", "image/png", PNG);
    expect(c.file).toEqual({
      id: c.file.id,
      name: "cat.png",
      contentType: "image/png",
      size: PNG.length,
      status: "uploading",
    });
    expect(Date.parse(c.expiresAt ?? "") - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await fileRow(c.file.id)).status).toBe("uploading");
    expect((await upload(c, PNG, "image/png")).status).toBeLessThan(300);
    // someone else cannot finalize it
    const theirs = await finalize(other, c.file.id, sha(PNG));
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json().error.code).toBe("file.not_found");
    expect((await finalize(owner, c.file.id, sha(PNG))).statusCode).toBe(200);
    const f = await fileRow(c.file.id);
    expect(f).toMatchObject({ status: "draft", expired: false });
    expect(f.expires_at).not.toBeNull();
    const b = await blobRow(f.blob_id as string);
    expect(b).toMatchObject({
      sha256: sha(PNG),
      size: String(PNG.length),
      object_key: `uploads/${c.file.id}`,
      status: "ready",
      shareable: false,
    });
    expect(b?.etag).not.toBeNull();
    // finalizing again answers the same file
    const again = await finalize(owner, c.file.id, sha(PNG));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: c.file.id, status: "draft" });
    expect(await owed(fileStagingDeleteJobId(c.file.id))).toEqual([]);
  });

  it("a library upload is ready at once", async () => {
    const id = await ready(owner, "notes.txt", "text/plain", TEXT, "library");
    expect(await fileRow(id)).toMatchObject({ status: "ready", expires_at: null });
  });

  it("finalize: not uploaded → 409; a smaller object → 409; a non-PNG → 415", async () => {
    const c = await create(owner, "a.png", "image/png", PNG);
    const early = await finalize(owner, c.file.id, sha(PNG));
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("file.not_ready");
    expect((await upload(c, PNG.subarray(0, PNG.length - 4), "image/png")).status).toBeLessThan(
      300,
    );
    const small = await finalize(owner, c.file.id, sha(PNG));
    expect(small.statusCode).toBe(409);
    expect(small.json().error.code).toBe("file.not_ready");
    expect(await store().head(`uploads/${c.file.id}`)).toBeNull();

    const fake = Buffer.from("definitely not a png");
    const c3 = await create(owner, "c.png", "image/png", fake);
    expect((await upload(c3, fake, "image/png")).status).toBeLessThan(300);
    const sniff = await finalize(owner, c3.file.id, sha(fake));
    expect(sniff.statusCode).toBe(415);
    expect(sniff.json().error.code).toBe("file.type_not_allowed");
  });

  it("a hash other than declared deletes the staging object and expires the upload", async () => {
    const c = await create(owner, "notes.txt", "text/plain", TEXT);
    const swapped = Buffer.from(TEXT);
    swapped[0] = "N".charCodeAt(0);
    expect((await upload(c, swapped, "text/plain")).status).toBeLessThan(300);
    const res = await finalize(owner, c.file.id, sha(TEXT));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("file.hash_mismatch");
    expect(await store().head(`uploads/${c.file.id}`)).toBeNull();
    expect(await fileRow(c.file.id)).toMatchObject({
      status: "uploading",
      blob_id: null,
      expired: true,
    });
    expect(await db.selectFrom("blobs").select("id").execute()).toEqual([]);
  });

  it("the same account's bytes are not uploaded again: the new file is created on that blob", async () => {
    const first = await ready(owner, "cat.png", "image/png", PNG);
    const blobId = (await fileRow(first)).blob_id;
    const again = await create(owner, "cat copy.png", "image/png", PNG);
    expect(again.upload).toBeNull();
    expect(again.expiresAt).toBeNull();
    expect(again.file).toMatchObject({ name: "cat copy.png", status: "draft" });
    expect(await fileRow(again.file.id)).toMatchObject({ blob_id: blobId, status: "draft" });
    const lib = await create(owner, "cat.png", "image/png", PNG, "library");
    expect(lib.upload).toBeNull();
    expect(await fileRow(lib.file.id)).toMatchObject({ blob_id: blobId, status: "ready" });
    // another declared type of the same bytes is uploaded and checked like any upload
    const typed = await createRaw(owner, {
      name: "cat.txt",
      contentType: "text/plain",
      size: PNG.length,
      sha256: sha(PNG),
      purpose: "composer",
    });
    expect((typed.json() as Created).upload).not.toBeNull();
  });

  it("another account's bytes: the caller always uploads, sees the same keys, and gets a blob of its own while the first form may still be used", async () => {
    const mine = await ready(owner, "cat.png", "image/png", PNG);
    const winner = (await fileRow(mine)).blob_id as string;
    const c = await create(other, "cat.png", "image/png", PNG);
    expect(c.upload).not.toBeNull();
    expect(Object.keys(c).sort()).toEqual(["expiresAt", "file", "upload"]);
    expect(Object.keys(c.file).sort()).toEqual(["contentType", "id", "name", "size", "status"]);
    expect((await upload(c, PNG, "image/png")).status).toBeLessThan(300);
    const res = await finalize(other, c.file.id, sha(PNG));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: c.file.id,
      name: "cat.png",
      contentType: "image/png",
      size: PNG.length,
      status: "draft",
    });
    const theirs = await fileRow(c.file.id);
    expect(theirs.blob_id).not.toBe(winner);
    // the contested hash: its own staging object, unhashed until the hashing job merges it
    expect(await blobRow(theirs.blob_id as string)).toMatchObject({
      sha256: null,
      object_key: `uploads/${c.file.id}`,
      status: "ready",
    });
    expect(await owed(fileStagingDeleteJobId(c.file.id))).toEqual([]);

    // once the winner's form has expired, another account's upload resolves to it
    await sql`UPDATE capybara.blobs SET dedup_after = now() - interval '1 second' WHERE id = ${winner}`.execute(
      raw,
    );
    const c3 = await create(third, "cat.png", "image/png", PNG);
    expect(c3.upload).not.toBeNull();
    expect((await upload(c3, PNG, "image/png")).status).toBeLessThan(300);
    expect((await finalize(third, c3.file.id, sha(PNG))).statusCode).toBe(200);
    expect((await fileRow(c3.file.id)).blob_id).toBe(winner);
    const rows = await owed(fileStagingDeleteJobId(c3.file.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue: MAINTENANCE_QUEUE_NAME,
      job_name: FILE_STAGING_DELETE_JOB,
      org_id: orgId,
    });
    expect(rows[0]?.data).toEqual({
      orgId,
      fileId: c3.file.id,
      objectKey: `uploads/${c3.file.id}`,
    });
    await deliverOwed(fileStagingDeleteJobId(c3.file.id));
    await expect.poll(() => store().head(`uploads/${c3.file.id}`), { timeout: 20_000 }).toBeNull();
    // the adopted staging objects stay
    expect(await store().head(`uploads/${mine}`)).not.toBeNull();
    expect(await store().head(`uploads/${c.file.id}`)).not.toBeNull();
  });

  it("bytes written again through the same form after finalize read as gone", async () => {
    const c = await create(owner, "re.png", "image/png", PNG);
    expect((await upload(c, PNG, "image/png")).status).toBeLessThan(300);
    expect((await finalize(owner, c.file.id, sha(PNG))).statusCode).toBe(200);
    const blobId = (await fileRow(c.file.id)).blob_id as string;
    const b = await blobRow(blobId);
    const ref = {
      id: blobId,
      objectKey: b?.object_key as string,
      size: Number(b?.size),
      etag: b?.etag ?? null,
    };
    const blobs = k.app.get(BlobsService);
    expect(await blobs.head(orgId, ref)).not.toBeNull();
    const evil = Buffer.from(PNG);
    evil[evil.length - 1] = (evil[evil.length - 1] as number) ^ 0xff;
    expect((await upload(c, evil, "image/png")).status).toBeLessThan(300);
    expect(await blobs.head(orgId, ref)).toBeNull();
    expect(await blobs.open(orgId, ref)).toBeNull();
  });
});

describe("discard and the draft cleanup", () => {
  it("discarding a draft releases its own blob; the owed deletion removes the object and the row", async () => {
    const id = await ready(owner, "cat.png", "image/png", PNG);
    const blobId = (await fileRow(id)).blob_id as string;
    await ageForm(id);
    const res = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/files/${id}/draft` });
    expect(res.statusCode, res.body).toBe(204);
    expect(await fileRow(id)).toMatchObject({ status: "deleted", blob_id: null });
    expect((await blobRow(blobId))?.status).toBe("deleting");
    expect(await owed(blobDeleteJobId(blobId))).toHaveLength(1);
    // a second discard, or someone else's, finds nothing
    const again = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/files/${id}/draft` });
    expect(again.statusCode).toBe(404);
    await deliverOwed(blobDeleteJobId(blobId));
    await expect.poll(() => blobRow(blobId), { timeout: 20_000 }).toBeUndefined();
    expect(await store().head(`uploads/${id}`)).toBeNull();
  });

  it("a draft sharing its blob with another file leaves the blob; another account cannot discard", async () => {
    const first = await ready(owner, "cat.png", "image/png", PNG);
    const blobId = (await fileRow(first)).blob_id as string;
    const copy = await create(owner, "copy.png", "image/png", PNG);
    const theirs = await other({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/files/${copy.file.id}/draft`,
    });
    expect(theirs.statusCode).toBe(404);
    await ageForm(first);
    const res = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/files/${first}/draft`,
    });
    expect(res.statusCode).toBe(204);
    expect((await blobRow(blobId))?.status).toBe("ready");
    expect(await owed(blobDeleteJobId(blobId))).toEqual([]);
  });

  it("the cleanup deletes expired uploads and drafts and owes their staging objects' deletion", async () => {
    const pending = await create(owner, "p.txt", "text/plain", TEXT);
    expect((await upload(pending, TEXT, "text/plain")).status).toBeLessThan(300);
    const draft = await ready(owner, "d.png", "image/png", PNG);
    const draftBlob = (await fileRow(draft)).blob_id as string;
    const kept = await ready(owner, "k.txt", "text/plain", Buffer.from("kept\n"));
    await sql`UPDATE capybara.files SET expires_at = now() - interval '1 minute',
      created_at = now() - interval '25 hours' WHERE id IN (${pending.file.id}, ${draft})`.execute(
      raw,
    );
    expect(await k.app.get(FileDraftCleanupJob).runOnce()).toBe(2);
    expect((await fileRow(pending.file.id)).status).toBe("deleted");
    expect((await fileRow(draft)).status).toBe("deleted");
    expect((await fileRow(kept)).status).toBe("draft");
    expect(await owed(fileStagingDeleteJobId(pending.file.id))).toHaveLength(1);
    expect(await owed(blobDeleteJobId(draftBlob))).toHaveLength(1);
    await deliverOwed(fileStagingDeleteJobId(pending.file.id));
    await deliverOwed(blobDeleteJobId(draftBlob));
    await expect
      .poll(() => store().head(`uploads/${pending.file.id}`), { timeout: 20_000 })
      .toBeNull();
    await expect.poll(() => blobRow(draftBlob), { timeout: 20_000 }).toBeUndefined();
    expect(await store().head(`uploads/${kept}`)).not.toBeNull();
    // nothing left to do
    expect(await k.app.get(FileDraftCleanupJob).runOnce()).toBe(0);
  });
});

describe("attaching files to a message", () => {
  const attach = (convId: string, accountId: string, ids: string[], firstSeq?: number) =>
    k.app
      .get(TransactionHost)
      .run(() =>
        k.app.get(LibraryFilesService).attachForMessage(orgId, convId, accountId, ids, firstSeq),
      );

  it("one file attaches in two conversations; drafts become ready; the blocks reference the file", async () => {
    const agentId = await createAgent(owner, orgId);
    const conv1 = await createConv(owner, orgId, agentId);
    const conv2 = await createConv(owner, orgId, agentId);
    const img = await ready(owner, "cat.png", "image/png", PNG);
    const txt = await ready(owner, "notes.txt", "text/plain", TEXT, "library");
    const blocks = await attach(conv1, ownerId, [img, txt], 3);
    expect(blocks).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        source: { kind: "ref", fileId: img },
        name: "cat.png",
        size: PNG.length,
      },
      {
        type: "document",
        mediaType: "text/plain",
        source: { kind: "ref", fileId: txt },
        name: "notes.txt",
        size: TEXT.length,
      },
    ]);
    expect(await fileRow(img)).toMatchObject({
      status: "ready",
      expires_at: null,
      source_conversation_id: conv1,
    });
    // a library file is not "first sent" anywhere: it keeps no source conversation
    expect((await fileRow(txt)).source_conversation_id).toBeNull();
    expect(await attach(conv2, ownerId, [img])).toHaveLength(1);
    // attaching again in the same conversation keeps the first reference
    expect(await attach(conv1, ownerId, [img], 9)).toHaveLength(1);
    const refs = await db
      .selectFrom("conversation_files")
      .select(["conversation_id", "role", "first_seq"])
      .where("file_id", "=", img)
      .orderBy("first_seq")
      .execute();
    expect(refs).toEqual(
      expect.arrayContaining([
        { conversation_id: conv1, role: "attached", first_seq: "3" },
        { conversation_id: conv2, role: "attached", first_seq: null },
      ]),
    );
    expect(refs).toHaveLength(2);
    expect((await fileRow(img)).source_conversation_id).toBe(conv1);
  });

  it("refuses another account's, an uploading, an expired or a deleted file; too many or duplicates", async () => {
    const agentId = await createAgent(owner, orgId);
    const conv = await createConv(owner, orgId, agentId);
    const theirs = await ready(other, "o.png", "image/png", PNG);
    await expect(attach(conv, ownerId, [theirs])).rejects.toMatchObject({
      code: "file.not_found",
      details: [expect.objectContaining({ path: "files", fileId: theirs })],
    });
    const pending = await create(owner, "p.txt", "text/plain", TEXT);
    await expect(attach(conv, ownerId, [pending.file.id])).rejects.toMatchObject({
      code: "file.not_ready",
      details: [expect.objectContaining({ path: "files", fileId: pending.file.id })],
    });
    const stale = await ready(owner, "s.png", "image/png", PNG);
    await sql`UPDATE capybara.files SET expires_at = now() - interval '1 second' WHERE id = ${stale}`.execute(
      raw,
    );
    await expect(attach(conv, ownerId, [stale])).rejects.toMatchObject({ code: "file.not_found" });
    const gone = await ready(owner, "g.txt", "text/plain", Buffer.from("gone\n"));
    await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/files/${gone}/draft` });
    await expect(attach(conv, ownerId, [gone])).rejects.toMatchObject({ code: "file.not_found" });
    const fresh = await ready(owner, "f.txt", "text/plain", Buffer.from("fresh\n"));
    await expect(attach(conv, ownerId, Array(11).fill(fresh))).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(attach(conv, ownerId, [fresh, fresh])).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(await db.selectFrom("conversation_files").select("file_id").execute()).toEqual([]);
    // outside a transaction it refuses to run at all
    await expect(
      k.app.get(LibraryFilesService).attachForMessage(orgId, conv, ownerId, [fresh]),
    ).rejects.toThrow();
  });
});
