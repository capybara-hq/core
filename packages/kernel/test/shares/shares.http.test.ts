import { randomUUID } from "node:crypto";
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
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { ShareLiveness } from "../../src/shares/liveness.js";
import { revokeSharesIn } from "../../src/shares/revoke.js";
import { SHARE_CODE_RE } from "../../src/shares/share-code.js";
import { ShareObjects } from "../../src/shares/share-objects.js";
import { SharesService } from "../../src/shares/shares.service.js";
import { RETAIN_DAYS, ShareSweepJob } from "../../src/shares/sweep.job.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { giveUploadAvatar, UPLOAD_AVATAR_URL } from "../helpers/avatar.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import {
  blobKeyOf,
  markFileDeleted,
  migrateLegacyFiles,
  seedLibraryFile,
} from "../helpers/library-files.js";
import { testMembers } from "../helpers/members.js";
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
 * File sharing spec §1, §2, §9, §10 and file library spec §6: creating, refreshing, revoking and
 * listing shares of a conversation file or a library file (the share points at the file's blob:
 * nothing is copied), and their lifecycle: deleting the conversation or the file, or offboarding
 * the creator, revokes them in the same transaction; the other causes stop them through the live
 * check until the daily sweep revokes them; the sweep lets go of old shares' blobs.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        // The share view's absolute link is built from it (the trailing slash is dropped).
        http: { port: 0, publicUrl: "https://share.example.com/" },
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
    { logger: createLogger("error", { write: () => {} }) },
  );
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let owner: Req;
let alice: Req;
let bob: Req;
let ownerId: string;
let aliceId: string;
let orgId: string;
let agentId: string;
let conv: string;

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.deployment_settings, capybara.audit_events, capybara.outbox",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  aliceId = (await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" })).id;
  const bobId = (await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" })).id;
  owner = asUser(k.http, cookieJar());
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  alice = await session(k, "alice");
  bob = await session(k, "bob");
  agentId = await createAgent(owner, orgId);
  conv = await createConv(alice, orgId, agentId);
});

const store = () => k.app.get(StorageService).kernel(orgId);

async function readObject(key: string): Promise<string | null> {
  const got = await store().get(key);
  if (!got) return null;
  return Buffer.from(await new Response(got.body).arrayBuffer()).toString("utf8");
}

/** Stores an object and logs its `artifact_created` (as `Deliver` would). */
async function deliver(name: string, text: string, sourcePath = `/workspace/${name}`, c = conv) {
  const artifactId = randomUUID();
  const objectKey = `artifacts/${c}/${artifactId}`;
  const bytes = Buffer.from(text);
  await store().put(objectKey, bytes, { contentType: "text/html", size: bytes.byteLength });
  await k.app.get(EventLog).append(c, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name,
        contentType: "text/html",
        size: bytes.byteLength,
        objectKey,
        sourcePath,
        callId: `call-${artifactId}`,
      },
    },
  ]);
  // logged the way deliveries were before the file library, then migrated (0188)
  await migrateLegacyFiles(db);
  return { artifactId, objectKey };
}

/** Stores an object and writes a ready chat attachment row bound to the conversation. */
async function attach(name: string, text: string): Promise<string> {
  const id = randomUUID();
  const objectKey = `attachments/${id}`;
  const bytes = Buffer.from(text);
  await store().put(objectKey, bytes, { contentType: "text/plain", size: bytes.byteLength });
  const etag = (await store().head(objectKey))?.etag ?? null;
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      conversation_id: conv,
      account_id: aliceId,
      name,
      content_type: "text/plain",
      size: bytes.byteLength,
      object_key: objectKey,
      status: "ready",
      purpose: "chat",
      etag,
    })
    .execute();
  await migrateLegacyFiles(db);
  return id;
}

async function platformSharing(value: "allow" | "deny", maxDays?: number) {
  await sql`INSERT INTO capybara.deployment_settings (key, value) VALUES ('externalSharing', ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
  if (maxDays !== undefined) {
    await sql`INSERT INTO capybara.deployment_settings (key, value) VALUES ('shareMaxExpiryDays', ${JSON.stringify(maxDays)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
  }
}
async function orgSharing(value: "on" | "off") {
  await sql`UPDATE capybara.orgs SET settings = settings || ${JSON.stringify({ externalSharing: value })}::jsonb
    WHERE id = ${orgId}`.execute(raw);
}

interface ShareView {
  id: string;
  code: string;
  audience: "internal" | "external";
  conversationId: string | null;
  fileId: string;
  sourcePath: string | null;
  name: string;
  contentType: string;
  size: number;
  generation: number;
  createdBy: { id: string; displayName: string; avatarUrl: string | null };
  createdAt: string;
  expiresAt: string | null;
  lastOpenedAt: string | null;
  state: "live" | "expired" | "revoked" | "suspended";
  revokedAt: string | null;
  revokeReason: string | null;
  newerVersion: boolean;
}

const sharesUrl = (fileId: string, c = conv) =>
  `/api/v1/orgs/${orgId}/conversations/${c}/files/${fileId}/shares`;
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

async function share(
  fileId: string,
  body: { audience: "internal" | "external"; expiresInDays: 1 | 7 | 30 | null } = {
    audience: "internal",
    expiresInDays: null,
  },
): Promise<ShareView> {
  const r = await alice({ method: "POST", url: sharesUrl(fileId), payload: body });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { share: ShareView }).share;
}

const shareRow = (id: string) =>
  db.selectFrom("file_shares").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const auditsOf = (action: string) =>
  db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();
/** Every outbox row owed for a share snapshot (shares on blobs owe none). */
const owedShareDeletes = () =>
  db.selectFrom("outbox").selectAll().where("job_name", "=", "share-object-delete").execute();
/** The object keys under `shares/` (no share writes there any more). */
const shareKeys = async () => (await store().list("shares/")).items.map((o) => o.key);
/** The blob a file points at. */
const blobOf = async (fileId: string) =>
  (
    await db
      .selectFrom("files")
      .select("blob_id")
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow()
  ).blob_id;

describe("creating a share", () => {
  it("the owner shares a delivered file internally, never expiring: a row on its blob, an audit", async () => {
    const { artifactId } = await deliver("report.html", "<h1>v1</h1>");
    const s = await share(artifactId);
    expect(s.code).toMatch(SHARE_CODE_RE);
    expect(s).toMatchObject({
      url: `https://share.example.com/s/${s.code}`,
      audience: "internal",
      conversationId: conv,
      fileId: artifactId,
      sourcePath: "/workspace/report.html",
      name: "report.html",
      contentType: "text/html",
      size: 11,
      generation: 1,
      createdBy: { id: aliceId, displayName: "Alice" },
      expiresAt: null,
      lastOpenedAt: null,
      state: "live",
      revokedAt: null,
      revokeReason: null,
      newerVersion: false,
    });
    // nothing is copied: the row points at the file's blob
    expect(await shareKeys()).toEqual([]);
    const row = await shareRow(s.id);
    expect(row).toMatchObject({
      org_id: orgId,
      created_by: aliceId,
      conversation_id: conv,
      source_file_id: artifactId,
      blob_id: await blobOf(artifactId),
      object_key: null,
      generation: 1,
      size: "11",
    });
    const audits = await auditsOf("share.created");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_account_id: aliceId, org_id: orgId, target: s.id });
    expect(audits[0]?.detail).toEqual({ shareId: s.id, audience: "internal" });
  });

  it("an uploaded file is shared too (no source path)", async () => {
    const id = await attach("notes.txt", "hello");
    const s = await share(id);
    expect(s).toMatchObject({ fileId: id, sourcePath: null, name: "notes.txt", size: 5 });
    expect((await shareRow(s.id)).blob_id).toBe(await blobOf(id));
    expect(await shareKeys()).toEqual([]);
  });

  it("refuses a member who does not own the conversation, a guest of no session and bad input", async () => {
    const { artifactId } = await deliver("a.html", "x");
    const r = await bob({
      method: "POST",
      url: sharesUrl(artifactId),
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("conversation.not_found");
    const anon = await k.http.inject({
      method: "POST",
      url: sharesUrl(artifactId),
      headers: { "x-capybara-csrf": "1" },
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(anon.statusCode).toBe(401);
    const bad = await alice({
      method: "POST",
      url: sharesUrl(artifactId),
      payload: { audience: "internal", expiresInDays: 3 },
    });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");
    const unknown = await alice({
      method: "POST",
      url: sharesUrl(randomUUID()),
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(unknown.statusCode).toBe(404);
    expect(errCode(unknown)).toBe("conversation.artifact_not_found");
  });

  it("external sharing needs both switches and a bounded expiry; the policy block says why", async () => {
    const { artifactId } = await deliver("a.html", "x");
    const policy = async () => {
      const r = await alice({ method: "GET", url: sharesUrl(artifactId) });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { policy: { external: string; maxExpiryDays: number } }).policy;
    };
    const external = (expiresInDays: 1 | 7 | 30 | null) =>
      alice({
        method: "POST",
        url: sharesUrl(artifactId),
        payload: { audience: "external", expiresInDays },
      });

    expect(await policy()).toEqual({ external: "platform_denied", maxExpiryDays: 30 });
    let r = await external(7);
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe("share.external_not_allowed");
    // the org's switch alone is not enough
    await orgSharing("on");
    r = await external(7);
    expect(errCode(r)).toBe("share.external_not_allowed");

    await orgSharing("off");
    await platformSharing("allow");
    expect((await policy()).external).toBe("org_off");
    r = await external(7);
    expect(errCode(r)).toBe("share.external_not_allowed");

    await orgSharing("on");
    expect(await policy()).toEqual({ external: "allowed", maxExpiryDays: 30 });
    r = await external(null);
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe("share.expiry_too_long");
    await platformSharing("allow", 7);
    expect((await policy()).maxExpiryDays).toBe(7);
    r = await external(30);
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe("share.expiry_too_long");
    r = await external(7);
    expect(r.statusCode, r.body).toBe(201);
    const s = (r.json() as { share: ShareView }).share;
    expect(s.audience).toBe("external");
    const days = (Date.parse(s.expiresAt as string) - Date.parse(s.createdAt)) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    // one row for the accepted attempt, nothing copied
    expect((await db.selectFrom("file_shares").select("id").execute()).map((x) => x.id)).toEqual([
      s.id,
    ]);
    expect(await shareKeys()).toEqual([]);
  });

  it("a removed delivered file and an upload whose object changed are unavailable (410)", async () => {
    const gone = await deliver("gone.html", "x");
    await store().delete(gone.objectKey);
    let r = await alice({
      method: "POST",
      url: sharesUrl(gone.artifactId),
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(r.statusCode).toBe(410);
    expect(errCode(r)).toBe("share.file_unavailable");

    const up = await attach("u.txt", "aaaa");
    await store().put(`attachments/${up}`, Buffer.from("bbbb"), {
      contentType: "text/plain",
      size: 4,
    });
    r = await alice({
      method: "POST",
      url: sharesUrl(up),
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(r.statusCode).toBe(410);
    expect(errCode(r)).toBe("share.file_unavailable");
    expect(await db.selectFrom("file_shares").select("id").execute()).toEqual([]);
  });

  it("the files list marks a file with a live share of its source path or upload", async () => {
    const shared = await deliver("s.html", "x");
    await deliver("plain.html", "y");
    const up = await attach("u.txt", "z");
    await attach("other.txt", "w");
    await share(shared.artifactId);
    await share(up);
    const r = await alice({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/files`,
    });
    expect(r.statusCode).toBe(200);
    const files = (r.json() as { files: { name: string; shared: boolean }[] }).files;
    expect(Object.fromEntries(files.map((f) => [f.name, f.shared]))).toEqual({
      "s.html": true,
      "plain.html": false,
      "u.txt": true,
      "other.txt": false,
    });
  });
});

describe("refreshing a share", () => {
  it("a newer version is offered, then the share points at it as generation 2 under the same code; nothing is copied or owed", async () => {
    const v1 = await deliver("r.html", "one");
    const s = await share(v1.artifactId);
    const v2 = await deliver("r.html", "two!", "/workspace/r.html");
    const listed = await alice({ method: "GET", url: sharesUrl(v2.artifactId) });
    expect(listed.statusCode).toBe(200);
    const shares = (listed.json() as { shares: ShareView[] }).shares;
    expect(shares.map((x) => [x.id, x.newerVersion])).toEqual([[s.id, true]]);

    const r = await alice({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh` });
    expect(r.statusCode, r.body).toBe(200);
    const after = (r.json() as { share: ShareView }).share;
    expect(after).toMatchObject({
      id: s.id,
      code: s.code,
      generation: 2,
      fileId: v2.artifactId,
      size: 4,
      newerVersion: false,
    });
    expect(await shareRow(s.id)).toMatchObject({
      generation: 2,
      file_id: v2.artifactId,
      source_file_id: v2.artifactId,
      blob_id: await blobOf(v2.artifactId),
    });
    expect(await shareKeys()).toEqual([]);
    expect(await owedShareDeletes()).toEqual([]);
    // the previous version's bytes are its file's, untouched
    expect(await readObject(v1.objectKey)).toBe("one");
    const audits = await auditsOf("share.refreshed");
    expect(audits.map((a) => a.detail)).toEqual([{ shareId: s.id, generation: 2 }]);
  });

  it("skips a newest version whose object is gone; with nothing newer it is 410", async () => {
    const v1 = await deliver("r.html", "one");
    const s = await share(v1.artifactId);
    const v2 = await deliver("r.html", "two");
    const v3 = await deliver("r.html", "three");
    await store().delete(v3.objectKey);
    let r = await alice({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh` });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { share: ShareView }).share).toMatchObject({
      fileId: v2.artifactId,
      generation: 2,
    });
    expect((await shareRow(s.id)).blob_id).toBe(await blobOf(v2.artifactId));
    r = await alice({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh` });
    expect(r.statusCode).toBe(410);
    expect(errCode(r)).toBe("share.file_unavailable");
  });

  it("only the creator refreshes; an upload share cannot be refreshed; unknown ids are 404", async () => {
    const v1 = await deliver("r.html", "one");
    const s = await share(v1.artifactId);
    await deliver("r.html", "two");
    let r = await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh` });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("share.not_found");
    r = await alice({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/shares/${randomUUID()}/refresh`,
    });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("share.not_found");
    const up = await share(await attach("u.txt", "z"));
    r = await alice({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${up.id}/refresh` });
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe("validation_failed");
  });
});

describe("revoking a share", () => {
  it("an org admin revokes a member's share: 204, reason admin, nothing owed; twice is one audit", async () => {
    const v1 = await deliver("r.html", "one");
    const s = await share(v1.artifactId);
    const del = () => owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${s.id}` });
    let r = await del();
    expect(r.statusCode, r.body).toBe(204);
    const row = await shareRow(s.id);
    expect(row).toMatchObject({ revoke_reason: "admin", revoked_by: ownerId });
    expect(row.revoked_at).not.toBeNull();
    expect(await owedShareDeletes()).toEqual([]);
    r = await del();
    expect(r.statusCode).toBe(204);
    const audits = await auditsOf("share.revoked");
    expect(audits.map((a) => a.detail)).toEqual([{ shareId: s.id, reason: "admin" }]);
    // the share lists as revoked and refreshing it is refused
    const listed = await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/shares?scope=mine` });
    expect((listed.json() as { shares: ShareView[] }).shares).toMatchObject([
      { id: s.id, state: "revoked", revokeReason: "admin" },
    ]);
    r = await alice({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh` });
    expect(errCode(r)).toBe("share.not_found");
    // the bytes are the file's: still there, and the row keeps its blob until the sweep frees it
    expect(await readObject(v1.objectKey)).toBe("one");
    expect((await shareRow(s.id)).blob_id).toBe(await blobOf(v1.artifactId));
  });

  it("the creator revokes with reason creator; another member gets 404", async () => {
    const s = await share((await deliver("r.html", "one")).artifactId);
    let r = await bob({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${s.id}` });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("share.not_found");
    r = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${s.id}` });
    expect(r.statusCode).toBe(204);
    expect((await shareRow(s.id)).revoke_reason).toBe("creator");
    r = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${randomUUID()}` });
    expect(r.statusCode).toBe(404);
  });
});

describe("listing shares", () => {
  it("names the creator's avatar URL: null without an upload, the upload's URL with one", async () => {
    const s = await share((await deliver("r.html", "one")).artifactId);
    expect(s.createdBy.avatarUrl).toBeNull();
    await giveUploadAvatar(db, aliceId);
    const r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/shares?scope=all` });
    const [listed] = (r.json() as { shares: ShareView[] }).shares;
    expect(listed?.createdBy.avatarUrl).toEqual(
      expect.stringContaining(UPLOAD_AVATAR_URL(aliceId)),
    );
  });

  it("mine for any member, all only for org admins", async () => {
    const s = await share((await deliver("r.html", "one")).artifactId);
    let r = await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/shares?scope=all` });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe("forbidden");
    r = await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/shares` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { shares: ShareView[] }).shares.map((x) => x.id)).toEqual([s.id]);
    r = await bob({ method: "GET", url: `/api/v1/orgs/${orgId}/shares?scope=mine` });
    expect((r.json() as { shares: ShareView[] }).shares).toEqual([]);
    r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/shares?scope=all` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { shares: ShareView[] }).shares.map((x) => x.id)).toEqual([s.id]);
    r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/shares?scope=nope` });
    expect(r.statusCode).toBe(400);
  });

  it("an external share reads suspended while the switch is off, live again when it is back on", async () => {
    await platformSharing("allow");
    await orgSharing("on");
    await share((await deliver("r.html", "one")).artifactId, {
      audience: "external",
      expiresInDays: 1,
    });
    const state = async () =>
      (
        (await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/shares` })).json() as {
          shares: ShareView[];
        }
      ).shares[0]?.state;
    expect(await state()).toBe("live");
    await orgSharing("off");
    expect(await state()).toBe("suspended");
    await orgSharing("on");
    expect(await state()).toBe("live");
    await sql`UPDATE capybara.file_shares SET expires_at = now() - interval '1 minute'`.execute(
      raw,
    );
    expect(await state()).toBe("expired");
  });
});

describe("liveness (one query for the open routes)", () => {
  it("a live share by code and by id; revoked, expired, switch off and a creator who lost access are not", async () => {
    const live = k.app.get(ShareLiveness);
    const s = await share((await deliver("r.html", "one")).artifactId);
    const got = await live.byCode(s.code);
    expect(got).toMatchObject({
      id: s.id,
      orgId,
      code: s.code,
      audience: "internal",
      conversationId: conv,
      createdBy: aliceId,
      createdByName: "Alice",
      name: "r.html",
      contentType: "text/html",
      size: 3,
      generation: 1,
      expiresAt: null,
    });
    expect(got?.blob.id).toBe((await shareRow(s.id)).blob_id);
    expect(await live.byId(s.id)).toMatchObject({ code: s.code });
    expect(await live.byId(s.id, 1)).not.toBeNull();
    expect(await live.byId(s.id, 2)).toBeNull();
    expect(await live.byCode("AAAAAAAAAA")).toBeNull();
    expect(await live.byCode("not a code")).toBeNull();

    // the creator's account is disabled: the link stops at once, and works again after
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${aliceId}`.execute(raw);
    expect(await live.byCode(s.code)).toBeNull();
    await sql`UPDATE capybara.accounts SET status = 'active' WHERE id = ${aliceId}`.execute(raw);
    // the conversation is deleted
    await sql`UPDATE capybara.conversations SET deleted_at = now() WHERE id = ${conv}`.execute(raw);
    expect(await live.byCode(s.code)).toBeNull();
    await sql`UPDATE capybara.conversations SET deleted_at = NULL WHERE id = ${conv}`.execute(raw);
    // the org is deleted
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${orgId}`.execute(raw);
    expect(await live.byCode(s.code)).toBeNull();
    await sql`UPDATE capybara.orgs SET deleted_at = NULL WHERE id = ${orgId}`.execute(raw);
    expect(await live.byCode(s.code)).not.toBeNull();

    // external: needs both switches at open time
    await platformSharing("allow");
    await orgSharing("on");
    const ext = await share((await deliver("e.html", "two")).artifactId, {
      audience: "external",
      expiresInDays: 1,
    });
    expect(await live.byCode(ext.code)).not.toBeNull();
    await platformSharing("deny");
    expect(await live.byCode(ext.code)).toBeNull();
    await platformSharing("allow");
    await sql`UPDATE capybara.file_shares SET expires_at = now() - interval '1 second' WHERE id = ${ext.id}`.execute(
      raw,
    );
    expect(await live.byCode(ext.code)).toBeNull();

    const del = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${s.id}` });
    expect(del.statusCode).toBe(204);
    expect(await live.byCode(s.code)).toBeNull();
  });
});

describe("Platform operations (spec §10)", () => {
  const ctxOf = (accountId: string): OperationContext => ({
    orgId,
    actorAccountId: accountId,
    agentId: randomUUID(),
    conversationId: randomUUID(),
    runId: randomUUID(),
    signal: new AbortController().signal,
  });
  const op = (id: string) => {
    const o = k.app.get(PlatformOperations).get(id);
    if (o === null) throw new Error(`no operation ${id}`);
    return o;
  };
  const run = (id: string, input: unknown, ctx: OperationContext) => {
    const o = op(id);
    return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
      throw toToolError(e, (code) => nextStepFor(o.errors, code, "member"));
    });
  };

  it("conversations.list-shares lists mine; scope all is refused to a member", async () => {
    const s = await share((await deliver("r.html", "one")).artifactId);
    const mine = (await run("conversations.list-shares", {}, ctxOf(aliceId))) as {
      items: { id: string; name: string; state: string; audience: string }[];
      total: number;
    };
    expect(mine.total).toBe(1);
    expect(mine.items[0]).toMatchObject({
      id: s.id,
      name: "r.html",
      state: "live",
      audience: "internal",
    });
    await expect(
      run("conversations.list-shares", { scope: "all" }, ctxOf(aliceId)),
    ).rejects.toThrow(/org admins/);
    const all = (await run("conversations.list-shares", { scope: "all" }, ctxOf(ownerId))) as {
      items: { id: string }[];
    };
    expect(all.items.map((i) => i.id)).toEqual([s.id]);
    const ownerMine = (await run("conversations.list-shares", {}, ctxOf(ownerId))) as {
      items: unknown[];
    };
    expect(ownerMine.items).toEqual([]);
  });

  it("conversations.revoke-share revokes (an org admin here), asked every time, audited as the tool's", async () => {
    const s = await share((await deliver("r.html", "one")).artifactId);
    const o = op("conversations.revoke-share");
    expect(o.confirm).toBe("org");
    const card = await o.summary?.(o.input.parse({ shareId: s.id }), ctxOf(ownerId));
    expect(card?.en).toBe('Revoke the shared link to "r.html"');
    expect(await run("conversations.revoke-share", { shareId: s.id }, ctxOf(ownerId))).toEqual({
      revoked: true,
      shareId: s.id,
    });
    expect(await shareRow(s.id)).toMatchObject({ revoke_reason: "admin", revoked_by: ownerId });
    const audits = await auditsOf("share.revoked");
    expect(audits.map((a) => a.detail)).toEqual([
      expect.objectContaining({
        shareId: s.id,
        reason: "admin",
        via: "agent",
        operation: "conversations.revoke-share",
      }),
    ]);
    // another member's attempt is refused as not found
    const other = await share((await deliver("o.html", "two")).artifactId);
    const bobId = (
      await db
        .selectFrom("accounts")
        .select("id")
        .where("display_name", "=", "Bob")
        .executeTakeFirstOrThrow()
    ).id;
    await expect(
      run("conversations.revoke-share", { shareId: other.id }, ctxOf(bobId)),
    ).rejects.toThrow(/Share not found/);
  });
});

/** A share made by `as` (internal never expiring, or external for 7 days). */
async function shareAs(
  as: Req,
  fileId: string,
  opts: { conv?: string; audience?: "internal" | "external" } = {},
): Promise<ShareView> {
  const audience = opts.audience ?? "internal";
  const r = await as({
    method: "POST",
    url: sharesUrl(fileId, opts.conv ?? conv),
    payload: { audience, expiresInDays: audience === "external" ? 7 : null },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { share: ShareView }).share;
}

/** Whether the share opens now (the check every open route makes). */
const opens = async (code: string) => (await k.app.get(ShareLiveness).byCode(code)) !== null;

describe("revokes that come with a lifecycle event", () => {
  it("deleting the conversation revokes its shares in the same transaction, owing nothing", async () => {
    const s = await shareAs(alice, (await deliver("a.html", "one")).artifactId);
    expect(await opens(s.code)).toBe(true);

    // the revoke fails: the deletion fails with it (one transaction)
    await sql`CREATE FUNCTION capybara.test_refuse_share_update() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`.execute(raw);
    await sql`CREATE TRIGGER test_refuse_share_update BEFORE UPDATE ON capybara.file_shares
      FOR EACH ROW EXECUTE FUNCTION capybara.test_refuse_share_update()`.execute(raw);
    try {
      const r = await alice({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
      });
      expect(r.statusCode).toBe(500);
    } finally {
      await sql`DROP TRIGGER test_refuse_share_update ON capybara.file_shares`.execute(raw);
      await sql`DROP FUNCTION capybara.test_refuse_share_update()`.execute(raw);
    }
    const kept = await db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(kept.deleted_at).toBeNull();
    expect(await opens(s.code)).toBe(true);

    const r = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/conversations/${conv}` });
    expect(r.statusCode, r.body).toBe(204);
    expect(await opens(s.code)).toBe(false);
    const row = await shareRow(s.id);
    expect(row).toMatchObject({ revoke_reason: "conversation_deleted", revoked_by: null });
    expect(row.revoked_at).not.toBeNull();
    expect(await owedShareDeletes()).toEqual([]);
  });

  it("removing a member revokes their shares, not another member's", async () => {
    const mine = await shareAs(alice, (await deliver("a.html", "one")).artifactId);
    const bobConv = await createConv(bob, orgId, agentId);
    const theirs = await shareAs(
      bob,
      (await deliver("b.html", "two", undefined, bobConv)).artifactId,
      {
        conv: bobConv,
      },
    );
    const r = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${aliceId}` });
    expect(r.statusCode, r.body).toBe(204);
    expect(await opens(mine.code)).toBe(false);
    expect(await shareRow(mine.id)).toMatchObject({ revoke_reason: "member_offboarded" });
    expect(await owedShareDeletes()).toEqual([]);
    const offboarded = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "org.member.offboarded")
      .executeTakeFirstOrThrow();
    expect(offboarded.detail).toMatchObject({ sharesRevoked: 1 });
    // bob's share is untouched
    expect(await opens(theirs.code)).toBe(true);
    expect(await shareRow(theirs.id)).toMatchObject({ revoked_at: null, revoke_reason: null });
  });
});

describe("causes the live check covers", () => {
  it("a disabled creator's share stops at once without a revoke, and opens again when re-enabled", async () => {
    const s = await shareAs(alice, (await deliver("a.html", "one")).artifactId);
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${aliceId}`.execute(raw);
    expect(await opens(s.code)).toBe(false);
    expect((await shareRow(s.id)).revoked_at).toBeNull();
    await sql`UPDATE capybara.accounts SET status = 'active' WHERE id = ${aliceId}`.execute(raw);
    expect(await opens(s.code)).toBe(true);
  });

  it("an external share stops while the org switch is off and opens again when it is on", async () => {
    await platformSharing("allow");
    await orgSharing("on");
    const s = await shareAs(alice, (await deliver("a.html", "one")).artifactId, {
      audience: "external",
    });
    expect(await opens(s.code)).toBe(true);
    await orgSharing("off");
    expect(await opens(s.code)).toBe(false);
    // the switch is no lost access: the sweep leaves it alone
    await k.app.get(ShareSweepJob).runOnce();
    expect((await shareRow(s.id)).revoked_at).toBeNull();
    await orgSharing("on");
    expect(await opens(s.code)).toBe(true);
  });
});

describe("the daily sweep", () => {
  it("revokes a share whose agent was deleted (creator_lost_access); live shares stay", async () => {
    const lost = await shareAs(alice, (await deliver("a.html", "one")).artifactId);
    const otherAgent = await createAgent(owner, orgId);
    const bobConv = await createConv(bob, orgId, otherAgent);
    const live = await shareAs(
      bob,
      (await deliver("b.html", "two", undefined, bobConv)).artifactId,
      {
        conv: bobConv,
      },
    );
    const r = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    expect(r.statusCode, r.body).toBeLessThan(300);
    // stopped at once by the live check, still unrevoked until the sweep
    expect(await opens(lost.code)).toBe(false);
    expect((await shareRow(lost.id)).revoked_at).toBeNull();

    const swept = await k.app.get(ShareSweepJob).runOnce();
    expect(swept.revoked).toBe(1);
    expect(await shareRow(lost.id)).toMatchObject({
      revoke_reason: "creator_lost_access",
      revoked_by: null,
    });
    expect(await owedShareDeletes()).toEqual([]);
    expect(await opens(live.code)).toBe(true);
    expect((await shareRow(live.id)).revoked_at).toBeNull();
    // a second run finds nothing to do
    expect((await k.app.get(ShareSweepJob).runOnce()).revoked).toBe(0);
  });
});

const fileSharesUrl = (fileId: string) => `/api/v1/orgs/${orgId}/files/${fileId}/shares`;

/** A ready library file of alice's (an upload made on the Files page). */
const libraryFile = (name: string, text: string, accountId = aliceId) =>
  seedLibraryFile(
    k.app,
    orgId,
    accountId,
    { name, contentType: "text/plain", bytes: Buffer.from(text) },
    { status: "ready" },
  );

/** Shares a library file as alice (internal, never expiring). */
async function shareFile(fileId: string, as: Req = alice): Promise<ShareView> {
  const r = await as({
    method: "POST",
    url: fileSharesUrl(fileId),
    payload: { audience: "internal", expiresInDays: null },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { share: ShareView }).share;
}

/** The public content route of a share, as a signed-in member (internal shares need one). */
const openContent = (code: string, as: Req = alice) =>
  as({ method: "GET", url: `/api/v1/s/${code}/content` });

describe("shares of library files", () => {
  it("a library file is shared without a conversation: the row points at its blob, nothing is copied", async () => {
    const id = await libraryFile("lib.txt", "library bytes");
    const s = await shareFile(id);
    expect(s).toMatchObject({
      conversationId: null,
      fileId: id,
      sourcePath: null,
      name: "lib.txt",
      size: 13,
      generation: 1,
      state: "live",
    });
    expect(await shareRow(s.id)).toMatchObject({
      conversation_id: null,
      source_file_id: id,
      blob_id: await blobOf(id),
      object_key: null,
    });
    expect(await shareKeys()).toEqual([]);
    const opened = await openContent(s.code, bob);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.body).toBe("library bytes");

    const listed = await alice({ method: "GET", url: fileSharesUrl(id) });
    expect(listed.statusCode, listed.body).toBe(200);
    expect((listed.json() as { shares: ShareView[] }).shares.map((x) => x.id)).toEqual([s.id]);
    // the personal list shows it too
    const mine = await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/shares` });
    expect((mine.json() as { shares: ShareView[] }).shares.map((x) => x.id)).toEqual([s.id]);
    // bytes replaced under the blob's key are not the snapshot: never served
    await store().put(await blobKeyOf(db, id), Buffer.from("other bytes!!!"), {
      contentType: "text/plain",
      size: 14,
    });
    const replaced = await openContent(s.code, bob);
    expect(replaced.statusCode).toBe(404);
    expect(errCode(replaced)).toBe("share.not_found");
  });

  it("only the file's owner shares or lists it, and only while it is ready with its bytes stored", async () => {
    const id = await libraryFile("lib.txt", "x");
    for (const r of [
      await bob({
        method: "POST",
        url: fileSharesUrl(id),
        payload: { audience: "internal", expiresInDays: null },
      }),
      await bob({ method: "GET", url: fileSharesUrl(id) }),
      await alice({ method: "GET", url: fileSharesUrl(randomUUID()) }),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(errCode(r)).toBe("file.not_found");
    }
    const draft = await seedLibraryFile(k.app, orgId, aliceId, {
      name: "d.txt",
      contentType: "text/plain",
      bytes: Buffer.from("d"),
    });
    let r = await alice({
      method: "POST",
      url: fileSharesUrl(draft),
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(errCode(r)).toBe("file.not_found");
    const gone = await libraryFile("gone.txt", "g");
    await store().delete(await blobKeyOf(db, gone));
    r = await alice({
      method: "POST",
      url: fileSharesUrl(gone),
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(r.statusCode).toBe(410);
    expect(errCode(r)).toBe("share.file_unavailable");
    expect(await db.selectFrom("file_shares").select("id").execute()).toEqual([]);
  });

  it("deleting the file stops its shares at once and revokes them (file_deleted), from the library or a conversation", async () => {
    const lib = await libraryFile("lib.txt", "x");
    const libShare = await shareFile(lib);
    const { artifactId } = await deliver("a.html", "one");
    const convShare = await share(artifactId);
    const otherShare = await share((await deliver("b.html", "two")).artifactId);
    expect(await opens(libShare.code)).toBe(true);
    expect(await opens(convShare.code)).toBe(true);

    // the file deleted: the live check refuses its shares even before the revoke lands
    await markFileDeleted(db, lib);
    expect(await opens(libShare.code)).toBe(false);
    await markFileDeleted(db, artifactId);
    expect(await opens(convShare.code)).toBe(false);

    // what deleting a file does in its transaction (the Files page's DELETE)
    const n = await db
      .transaction()
      .execute((trx) =>
        revokeSharesIn(
          trx,
          { add: async () => true },
          { fileIds: [lib, artifactId] },
          "file_deleted",
        ),
      );
    expect(n).toBe(2);
    for (const s of [libShare, convShare]) {
      expect(await shareRow(s.id)).toMatchObject({
        revoke_reason: "file_deleted",
        revoked_by: null,
      });
      const r = await openContent(s.code);
      expect(r.statusCode).toBe(404);
      expect(errCode(r)).toBe("share.not_found");
    }
    expect(await owedShareDeletes()).toEqual([]);
    // another file's share is untouched
    expect(await opens(otherShare.code)).toBe(true);
    expect((await shareRow(otherShare.id)).revoked_at).toBeNull();
  });

  it("update to latest repoints a library share of a delivered file at the newer version", async () => {
    const v1 = await deliver("r.html", "one");
    const s = await shareFile(v1.artifactId);
    expect(s).toMatchObject({ conversationId: null, sourcePath: "/workspace/r.html" });
    const v2 = await deliver("r.html", "two!");
    const listed = await alice({ method: "GET", url: fileSharesUrl(v1.artifactId) });
    expect((listed.json() as { shares: ShareView[] }).shares).toMatchObject([
      { id: s.id, newerVersion: true },
    ]);
    const r = await alice({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh` });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { share: ShareView }).share).toMatchObject({
      generation: 2,
      fileId: v2.artifactId,
      size: 4,
      newerVersion: false,
    });
    expect(await shareRow(s.id)).toMatchObject({
      source_file_id: v2.artifactId,
      blob_id: await blobOf(v2.artifactId),
    });
    expect((await openContent(s.code)).body).toBe("two!");
    expect(await shareKeys()).toEqual([]);

    // an upload has no versions
    const up = await shareFile(await libraryFile("u.txt", "u"));
    const refused = await alice({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/shares/${up.id}/refresh`,
    });
    expect(refused.statusCode).toBe(400);
    expect(errCode(refused)).toBe("validation_failed");
  });

  it("the anonymous guest cannot share, from the library or a conversation", async () => {
    const guestId = (
      await accountsFor(db).createLocal({ login: "guest", password: PW, displayName: "Guest" })
    ).id;
    await testMembers(db).add(orgId, guestId, "member", ownerId);
    await db
      .insertInto("org_anonymous_accounts")
      .values({ org_id: orgId, account_id: guestId })
      .execute();
    const guest = await session(k, "guest");
    const id = await libraryFile("g.txt", "g", guestId);
    const body = { audience: "internal", expiresInDays: null };
    for (const url of [fileSharesUrl(id), sharesUrl(randomUUID())]) {
      const r = await guest({ method: "POST", url, payload: body });
      expect(r.statusCode, r.body).toBe(409);
      expect(errCode(r)).toBe("member.anonymous_guest");
    }
    await expect(
      k.app
        .get(SharesService)
        .createForFile(orgId, guestId, id, { audience: "internal", expiresInDays: null }),
    ).rejects.toMatchObject({ code: "member.anonymous_guest" });
    expect(await db.selectFrom("file_shares").select("id").execute()).toEqual([]);
  });

  it("a share migrated from a snapshot (object_key and blob_id both set) serves through its blob", async () => {
    const { artifactId } = await deliver("m.html", "migrated");
    // a share written the old way: its own copy under shares/<id>/1, named by object_key
    const id = randomUUID();
    const code = "Mig1rated0";
    const key = `shares/${id}/1`;
    await store().put(key, Buffer.from("snapshot"), { contentType: "text/html", size: 8 });
    await db
      .insertInto("file_shares")
      .values({
        id,
        org_id: orgId,
        code,
        conversation_id: conv,
        file_id: artifactId,
        source_path: "/workspace/m.html",
        created_by: aliceId,
        audience: "internal",
        name: "m.html",
        content_type: "text/html",
        size: 8,
        object_key: key,
      })
      .execute();
    await migrateLegacyFiles(db);
    const row = await shareRow(id);
    expect(row.blob_id).not.toBeNull();
    expect(row.object_key).toBe(key);
    const r = await openContent(code);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toBe("snapshot");

    // revoked, then a deletion owed before the deploy arrives: the key is a blob's, so it stays
    const del = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${id}` });
    expect(del.statusCode).toBe(204);
    await k.app
      .get(ShareObjects)
      .deleteObject({ orgId, shareId: id, generation: 1, objectKey: key });
    expect(await readObject(key)).toBe("snapshot");
    expect((await shareRow(id)).object_key).toBe(key);
  });
});

describe("the daily sweep frees old shares' blobs", () => {
  it("a share revoked or expired more than the retention ago lets go of its blob; recent ones keep it", async () => {
    const oldRevoked = await shareFile(await libraryFile("a.txt", "a"));
    const oldExpired = await shareFile(await libraryFile("b.txt", "b"));
    const recent = await shareFile(await libraryFile("c.txt", "c"));
    const live = await shareFile(await libraryFile("d.txt", "d"));
    const ago = `${RETAIN_DAYS + 1} days`;
    await sql`UPDATE capybara.file_shares SET revoked_at = now() - ${ago}::interval,
      revoke_reason = 'creator' WHERE id = ${oldRevoked.id}`.execute(raw);
    await sql`UPDATE capybara.file_shares SET expires_at = now() - ${ago}::interval
      WHERE id = ${oldExpired.id}`.execute(raw);
    await sql`UPDATE capybara.file_shares SET revoked_at = now() - interval '1 day',
      revoke_reason = 'creator' WHERE id = ${recent.id}`.execute(raw);

    const swept = await k.app.get(ShareSweepJob).runOnce();
    expect(swept).toEqual({ revoked: 0, freed: 2 });
    expect((await shareRow(oldRevoked.id)).blob_id).toBeNull();
    expect((await shareRow(oldExpired.id)).blob_id).toBeNull();
    expect((await shareRow(recent.id)).blob_id).not.toBeNull();
    expect((await shareRow(live.id)).blob_id).not.toBeNull();
    expect(await opens(live.code)).toBe(true);
    // the bytes are the files': the share sweep deletes nothing
    expect(await readObject(await blobKeyOf(db, oldRevoked.fileId))).toBe("a");
    expect((await k.app.get(ShareSweepJob).runOnce()).freed).toBe(0);
  });
});
