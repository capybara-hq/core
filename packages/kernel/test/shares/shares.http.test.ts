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
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance.js";
import { ShareLiveness } from "../../src/shares/liveness.js";
import { SHARE_CODE_RE } from "../../src/shares/share-code.js";
import { shareObjectDeleteJobId } from "../../src/shares/share-objects.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
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
 * File sharing spec §1, §2, §9, §10: creating, refreshing, revoking and listing shares of a
 * conversation file (a snapshot copied under `shares/<id>/<generation>`).
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
/** While true, the outbox's adds to the maintenance queue fail (the owed row stays). */
let failMaintenance = false;

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
let alice: Req;
let bob: Req;
let ownerId: string;
let aliceId: string;
let orgId: string;
let conv: string;

beforeEach(async () => {
  failMaintenance = false;
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
  const agentId = await createAgent(owner, orgId);
  conv = await createConv(alice, orgId, agentId);
});

const store = () => k.app.get(StorageService).kernel(orgId);

async function readObject(key: string): Promise<string | null> {
  const got = await store().get(key);
  if (!got) return null;
  return Buffer.from(await new Response(got.body).arrayBuffer()).toString("utf8");
}

/** Stores an object and logs its `artifact_created` (as `Deliver` would). */
async function deliver(name: string, text: string, sourcePath = `/workspace/${name}`) {
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  const bytes = Buffer.from(text);
  await store().put(objectKey, bytes, { contentType: "text/html", size: bytes.byteLength });
  await k.app.get(EventLog).append(conv, [
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
  conversationId: string;
  fileId: string;
  sourcePath: string | null;
  name: string;
  contentType: string;
  size: number;
  generation: number;
  createdBy: { id: string; displayName: string };
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
const owedDeletes = (jobId: string) =>
  db.selectFrom("outbox").selectAll().where("job_id", "=", jobId).execute();

describe("creating a share", () => {
  it("the owner shares a delivered file internally, never expiring: a snapshot, a row, an audit", async () => {
    const { artifactId } = await deliver("report.html", "<h1>v1</h1>");
    const s = await share(artifactId);
    expect(s.code).toMatch(SHARE_CODE_RE);
    expect(s).toMatchObject({
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
    expect(await readObject(`shares/${s.id}/1`)).toBe("<h1>v1</h1>");
    const row = await shareRow(s.id);
    expect(row).toMatchObject({
      org_id: orgId,
      created_by: aliceId,
      object_key: `shares/${s.id}/1`,
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
    expect(await readObject(`shares/${s.id}/1`)).toBe("hello");
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
    // nothing was copied for the refused attempts
    const keys = (await store().list("shares/")).items.map((o) => o.key);
    expect(keys).toEqual([`shares/${s.id}/1`]);
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
  it("a newer version is offered, then copied as generation 2 under the same code; the old snapshot is owed for deletion", async () => {
    const v1 = await deliver("r.html", "one");
    const s = await share(v1.artifactId);
    const v2 = await deliver("r.html", "two!", "/workspace/r.html");
    const listed = await alice({ method: "GET", url: sharesUrl(v2.artifactId) });
    expect(listed.statusCode).toBe(200);
    const shares = (listed.json() as { shares: ShareView[] }).shares;
    expect(shares.map((x) => [x.id, x.newerVersion])).toEqual([[s.id, true]]);

    failMaintenance = true;
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
    expect(await readObject(`shares/${s.id}/2`)).toBe("two!");
    const owed = await owedDeletes(shareObjectDeleteJobId(s.id, 1));
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      queue: MAINTENANCE_QUEUE_NAME,
      job_name: "share-object-delete",
      org_id: orgId,
    });
    expect(owed[0]?.data).toEqual({
      orgId,
      shareId: s.id,
      generation: 1,
      objectKey: `shares/${s.id}/1`,
    });
    const audits = await auditsOf("share.refreshed");
    expect(audits.map((a) => a.detail)).toEqual([{ shareId: s.id, generation: 2 }]);

    failMaintenance = false;
    await sql`UPDATE capybara.outbox SET next_attempt_at = now()`.execute(raw);
    await drainOutbox(k.app, { jobId: shareObjectDeleteJobId(s.id, 1) });
    await expect.poll(() => readObject(`shares/${s.id}/1`), { timeout: 20_000 }).toBeNull();
    expect(await readObject(`shares/${s.id}/2`)).toBe("two!");
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
    expect(await readObject(`shares/${s.id}/2`)).toBe("two");
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
  it("an org admin revokes a member's share: 204, reason admin, the snapshot owed for deletion; twice is one audit", async () => {
    const v1 = await deliver("r.html", "one");
    const s = await share(v1.artifactId);
    failMaintenance = true;
    const del = () => owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${s.id}` });
    let r = await del();
    expect(r.statusCode, r.body).toBe(204);
    const row = await shareRow(s.id);
    expect(row).toMatchObject({ revoke_reason: "admin", revoked_by: ownerId });
    expect(row.revoked_at).not.toBeNull();
    expect(await owedDeletes(shareObjectDeleteJobId(s.id, 1))).toHaveLength(1);
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

    failMaintenance = false;
    await sql`UPDATE capybara.outbox SET next_attempt_at = now()`.execute(raw);
    await drainOutbox(k.app, { jobId: shareObjectDeleteJobId(s.id, 1) });
    await expect.poll(() => readObject(`shares/${s.id}/1`), { timeout: 20_000 }).toBeNull();
    // the freed snapshot's key is cleared on the kept row
    await expect
      .poll(async () => (await shareRow(s.id)).object_key, { timeout: 20_000 })
      .toBeNull();
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
      objectKey: `shares/${s.id}/1`,
      generation: 1,
      expiresAt: null,
    });
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
