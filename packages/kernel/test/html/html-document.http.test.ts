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
import { htmlDocumentCsp } from "../../src/html/csp.js";
import { HTML_TOKEN_CLOCK, HtmlTokens } from "../../src/html/html-token.js";
import { createLogger } from "../../src/log.js";
import { HTML_CDN_ALLOWLIST_DEFAULT } from "../../src/shares/settings.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
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
 * File sharing spec §4: the HTML document token (`POST …/files/:fileId/html-token`, owner only)
 * and the public document route (`GET /api/v1/html/:token`): exact headers, live re-checks, the
 * size limit, the charset, uploads and share tokens.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const MiB = 1024 * 1024;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
/** Added to `Date.now()` by the HTML token clock. */
let clockOffsetMs = 0;

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
      overrides: [{ provide: HTML_TOKEN_CLOCK, useValue: () => Date.now() + clockOffsetMs }],
    },
  );
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let alice: Req;
let bob: Req;
let aliceId: string;
let orgId: string;
let conv: string;

beforeEach(async () => {
  clockOffsetMs = 0;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.deployment_settings, capybara.audit_events, capybara.outbox",
  );
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  aliceId = (await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" })).id;
  const bobId = (await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" })).id;
  const owner = asUser(k.http, cookieJar());
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

/** Stores an object and logs its `artifact_created` (as `Deliver` would). */
async function deliver(
  name: string,
  bytes: Buffer,
  opts: { contentType?: string; size?: number; sourcePath?: string } = {},
): Promise<string> {
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  const contentType = opts.contentType ?? "text/html";
  await store().put(objectKey, bytes, { contentType, size: bytes.byteLength });
  await k.app.get(EventLog).append(conv, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name,
        contentType,
        size: opts.size ?? bytes.byteLength,
        objectKey,
        sourcePath: opts.sourcePath ?? `/workspace/${name}`,
        callId: `call-${artifactId}`,
      },
    },
  ]);
  return artifactId;
}

/** Stores an object and writes a ready chat attachment row bound to the conversation. */
async function attach(name: string, bytes: Buffer): Promise<{ id: string; objectKey: string }> {
  const id = randomUUID();
  const objectKey = `attachments/${id}`;
  await store().put(objectKey, bytes, { contentType: "text/html", size: bytes.byteLength });
  const etag = (await store().head(objectKey))?.etag ?? null;
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      conversation_id: conv,
      account_id: aliceId,
      name,
      content_type: "text/html",
      size: bytes.byteLength,
      object_key: objectKey,
      status: "ready",
      purpose: "chat",
      etag,
    })
    .execute();
  return { id, objectKey };
}

const tokenUrl = (fileId: string) =>
  `/api/v1/orgs/${orgId}/conversations/${conv}/files/${fileId}/html-token`;
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

async function mint(fileId: string, as: Req = alice): Promise<string> {
  const r = await as({ method: "POST", url: tokenUrl(fileId) });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { path: string; expiresIn: number };
  expect(body.expiresIn).toBe(300);
  expect(body.path).toMatch(/^\/api\/v1\/html\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  return body.path;
}

/** Loads a document path with no credentials (as the sandboxed frame does). */
const load = (path: string) => k.http.inject({ method: "GET", url: path });

const expectNotFound = (r: Awaited<ReturnType<typeof load>>) => {
  expect(r.statusCode, r.body).toBe(404);
  expect(errCode(r)).toBe("not_found");
  expect(r.headers["content-type"]).not.toMatch(/text\/html/);
};

async function setAllowlist(origins: string[]) {
  await sql`INSERT INTO capybara.deployment_settings (key, value) VALUES ('htmlRenderCdnAllowlist', ${JSON.stringify(origins)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
}

describe("the document token and route", () => {
  it("the owner's token loads the stored bytes with every spec §4 header", async () => {
    const html = Buffer.from("<!doctype html><h1>Report</h1><script>1</script>");
    const id = await deliver("report.html", html);
    const r = await load(await mint(id));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.rawPayload.equals(html)).toBe(true);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["content-security-policy"]).toBe(htmlDocumentCsp(HTML_CDN_ALLOWLIST_DEFAULT));
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["x-robots-tag"]).toBe("noindex");
    expect(r.headers["content-length"]).toBe(String(html.byteLength));
  });

  it("a token loads more than once within its lifetime (reloads, the Rendered toggle)", async () => {
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const path = await mint(id);
    expect((await load(path)).statusCode).toBe(200);
    expect((await load(path)).statusCode).toBe(200);
  });

  it("the CDN allowlist is read at every load", async () => {
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const path = await mint(id);
    await setAllowlist(["https://cdn.example.com"]);
    const r = await load(path);
    expect(r.headers["content-security-policy"]).toBe(htmlDocumentCsp(["https://cdn.example.com"]));
    expect(r.headers["content-security-policy"]).not.toContain("cdn.jsdelivr.net");
    // an invalid stored value reads as the default
    await setAllowlist(["http://insecure.example.com"]);
    expect((await load(path)).headers["content-security-policy"]).toBe(
      htmlDocumentCsp(HTML_CDN_ALLOWLIST_DEFAULT),
    );
  });

  it("keeps the stored charset; the bytes are served as stored (GBK)", async () => {
    const gbk = Buffer.concat([
      Buffer.from("<p>"),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from("</p>"),
    ]);
    const id = await deliver("report.html", gbk, { contentType: "text/html; charset=GBK" });
    const r = await load(await mint(id));
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=gbk");
    expect(r.rawPayload.equals(gbk)).toBe(true);
  });

  it("a .htm name renders whatever its stored type", async () => {
    const id = await deliver("page.htm", Buffer.from("<p>x</p>"), {
      contentType: "application/octet-stream",
    });
    const r = await load(await mint(id));
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("someone who is not the conversation's owner cannot mint: 404", async () => {
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const r = await bob({ method: "POST", url: tokenUrl(id) });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("conversation.not_found");
  });

  it("an unknown file id: 404", async () => {
    const r = await alice({ method: "POST", url: tokenUrl(randomUUID()) });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("conversation.artifact_not_found");
  });

  it("a file that is not HTML: 400 artifact_not_previewable", async () => {
    const id = await deliver("data.csv", Buffer.from("a,b\n1,2\n"), { contentType: "text/csv" });
    const r = await alice({ method: "POST", url: tokenUrl(id) });
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe("conversation.artifact_not_previewable");
  });

  it("HTML over 20 MiB is never rendered: 400 too large", async () => {
    const id = await deliver("big.html", Buffer.from("<p>x</p>"), { size: 21 * MiB });
    const r = await alice({ method: "POST", url: tokenUrl(id) });
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe("conversation.artifact_not_previewable");
    expect((r.json() as { error: { message: string } }).error.message).toMatch(
      /too large to render/,
    );
  });

  it("a stored object over 20 MiB behind a small recorded size is not served", async () => {
    const id = await deliver("big.html", Buffer.alloc(20 * MiB + 1, 0x20), { size: 10 });
    expectNotFound(await load(await mint(id)));
  });

  it("the conversation deleted after minting: 404", async () => {
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const path = await mint(id);
    await sql`UPDATE capybara.conversations SET deleted_at = now() WHERE id = ${conv}`.execute(raw);
    expectNotFound(await load(path));
  });

  it("the owner removed from the org after minting: 404", async () => {
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const path = await mint(id);
    await sql`DELETE FROM capybara.memberships WHERE org_id = ${orgId} AND account_id = ${aliceId}`.execute(
      raw,
    );
    expectNotFound(await load(path));
  });

  it("the object gone after minting: 404", async () => {
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const path = await mint(id);
    await store().delete(`artifacts/${conv}/${id}`);
    expectNotFound(await load(path));
  });

  it("an expired token: 404 (within the skew it still loads)", async () => {
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const path = await mint(id);
    clockOffsetMs = 300_000 + 20_000;
    expect((await load(path)).statusCode).toBe(200);
    clockOffsetMs = 300_000 + 31_000;
    expectNotFound(await load(path));
  });

  it("a malformed or tampered token: 404", async () => {
    expectNotFound(await load("/api/v1/html/nonsense"));
    const id = await deliver("report.html", Buffer.from("<p>x</p>"));
    const path = await mint(id);
    const tampered = `${path.slice(0, -2)}${path.at(-2) === "A" ? "B" : "A"}${path.at(-1)}`;
    expectNotFound(await load(tampered));
  });
});

describe("uploaded HTML", () => {
  it("an attachment id mints and loads; an object changed since finalize is not served", async () => {
    const html = Buffer.from("<p>uploaded</p>");
    const a = await attach("page.html", html);
    const path = await mint(a.id);
    const r = await load(path);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(html)).toBe(true);
    const other = Buffer.from("<p>replaced, longer</p>");
    await store().put(a.objectKey, other, { contentType: "text/html", size: other.byteLength });
    expectNotFound(await load(path));
    const again = await alice({ method: "POST", url: tokenUrl(a.id) });
    expect(again.statusCode).toBe(410);
    expect(errCode(again)).toBe("conversation.artifact_removed");
  });
});

describe("share tokens", () => {
  async function share(fileId: string): Promise<{ id: string; generation: number }> {
    const r = await alice({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/files/${fileId}/shares`,
      payload: { audience: "internal", expiresInDays: null },
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { share: { id: string; generation: number } }).share;
  }
  const sharePath = (shareId: string, generation: number) =>
    `/api/v1/html/${k.app.get(HtmlTokens).issue({ kind: "share", shareId, generation }).token}`;

  it("a live share's generation loads its snapshot; revoked → 404", async () => {
    const html = Buffer.from("<p>shared</p>");
    const s = await share(await deliver("report.html", html));
    const path = sharePath(s.id, s.generation);
    const r = await load(path);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.rawPayload.equals(html)).toBe(true);
    expect(r.headers["content-security-policy"]).toBe(htmlDocumentCsp(HTML_CDN_ALLOWLIST_DEFAULT));
    const del = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${s.id}` });
    expect(del.statusCode).toBe(204);
    expectNotFound(await load(path));
  });

  it("a refreshed share: the old generation's token → 404, the new one loads", async () => {
    const first = await deliver("report.html", Buffer.from("<p>v1</p>"));
    const s = await share(first);
    const old = sharePath(s.id, s.generation);
    await deliver("report.html", Buffer.from("<p>v2</p>"));
    const r = await alice({ method: "POST", url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh` });
    expect(r.statusCode, r.body).toBe(200);
    const next = (r.json() as { share: { generation: number } }).share.generation;
    expectNotFound(await load(old));
    const fresh = await load(sharePath(s.id, next));
    expect(fresh.statusCode).toBe(200);
    expect(fresh.rawPayload.toString()).toBe("<p>v2</p>");
  });

  it("a shared file that is not HTML is not rendered", async () => {
    const s = await share(
      await deliver("data.csv", Buffer.from("a,b"), { contentType: "text/csv" }),
    );
    expectNotFound(await load(sharePath(s.id, s.generation)));
  });
});
