import { randomUUID } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { REDIS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";
import { ShareOpenService } from "../../src/shares/share-open.service.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrg,
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * File sharing spec §3: the public share routes `/api/v1/s/:code` (metadata, content, text,
 * inline, html redirect): one answer for every refusal, internal shares need a member's web
 * session of the share's org, exact content headers, the `share-open` throttler (misses count,
 * live hits are refunded) and the `share.opened` audit at most once per share and viewer per
 * 10 minutes.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const MiB = 1024 * 1024;

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
let carol: Req;
let ownerId: string;
let aliceId: string;
let orgId: string;
let conv: string;

/** Deletes the share throttler counters and the open dedupe markers left by earlier tests. */
async function clearShareKeys(): Promise<void> {
  const redis = k.app.get<Redis>(REDIS);
  for (const pattern of ["throttler:{cred:share-open}*", "capk:share-opened:*"]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  }
}

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.deployment_settings, capybara.audit_events, capybara.outbox",
  );
  await clearShareKeys();
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  aliceId = (await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" })).id;
  await accounts.createLocal({ login: "carol", password: PW, displayName: "Carol" });
  owner = asUser(k.http, cookieJar());
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  alice = await session(k, "alice");
  // carol is a member of no org that shares anything
  carol = await session(k, "carol");
  const agentId = await createAgent(owner, orgId);
  conv = await createConv(alice, orgId, agentId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const store = () => k.app.get(StorageService).kernel(orgId);

/** Stores an object and logs its `artifact_created` (as `Deliver` would). */
async function deliver(name: string, bytes: Buffer | string, contentType = "text/html") {
  const body = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  await store().put(objectKey, body, { contentType, size: body.byteLength });
  await k.app.get(EventLog).append(conv, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name,
        contentType,
        size: body.byteLength,
        objectKey,
        sourcePath: `/workspace/${name}`,
        callId: `call-${artifactId}`,
      },
    },
  ]);
  return artifactId;
}

async function allowExternal() {
  await sql`INSERT INTO capybara.deployment_settings (key, value) VALUES ('externalSharing', '"allow"'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
  await orgSharing("on");
}
async function orgSharing(value: "on" | "off") {
  await sql`UPDATE capybara.orgs SET settings = settings || ${JSON.stringify({ externalSharing: value })}::jsonb
    WHERE id = ${orgId}`.execute(raw);
}

interface Created {
  id: string;
  code: string;
}

async function share(fileId: string, audience: "internal" | "external"): Promise<Created> {
  if (audience === "external") await allowExternal();
  const r = await alice({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/files/${fileId}/shares`,
    payload: { audience, expiresInDays: audience === "external" ? 7 : null },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { share: Created }).share;
}

const base = (code: string) => `/api/v1/s/${code}`;
/** An anonymous request from one client address. */
const anon = (url: string, ip = "203.0.113.1") =>
  k.http.inject({ method: "GET", url, remoteAddress: ip });
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;
const opened = () =>
  db
    .selectFrom("audit_events")
    .selectAll()
    .where("action", "=", "share.opened")
    .orderBy("at")
    .execute();

describe("metadata", () => {
  it("an external share opens anonymously: who shared it, render html, public headers", async () => {
    const s = await share(await deliver("report.html", "<h1>hi</h1>"), "external");
    const r = await anon(base(s.code));
    expect(r.statusCode, r.body).toBe(200);
    const meta = r.json() as Record<string, unknown>;
    expect(meta).toMatchObject({
      name: "report.html",
      contentType: "text/html",
      size: 11,
      sharedBy: "Alice",
      audience: "external",
      previewable: "text",
      render: "html",
      previewers: [],
    });
    expect(typeof meta.expiresAt).toBe("string");
    expect(r.headers["x-robots-tag"]).toBe("noindex");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("render: previewers for a built-in kind, download for anything else", async () => {
    const png = await share(
      await deliver("a.png", Buffer.from([1, 2, 3]), "image/png"),
      "internal",
    );
    const bin = await share(
      await deliver("a.bin", Buffer.from([0, 1]), "application/octet-stream"),
      "internal",
    );
    const m1 = (await alice({ method: "GET", url: base(png.code) })).json();
    expect(m1).toMatchObject({ previewable: "image", render: "previewers" });
    const m2 = (await alice({ method: "GET", url: base(bin.code) })).json();
    expect(m2).toMatchObject({ previewable: null, render: "download", expiresAt: null });
  });

  it("HTML over 20 MiB is not rendered: render download", async () => {
    const s = await share(await deliver("big.html", "<p>big</p>"), "internal");
    await sql`UPDATE capybara.file_shares SET size = ${20 * MiB + 1} WHERE id = ${s.id}`.execute(
      raw,
    );
    const m = (await alice({ method: "GET", url: base(s.code) })).json();
    expect(m).toMatchObject({ render: "download", previewers: [] });
    await sql`UPDATE capybara.file_shares SET size = ${20 * MiB} WHERE id = ${s.id}`.execute(raw);
    const at = (await owner({ method: "GET", url: base(s.code) })).json();
    expect(at).toMatchObject({ render: "html" });
  });

  it("unknown, malformed, revoked and expired codes: one 404 answer with identical bodies", async () => {
    const revoked = await share(await deliver("a.html", "a"), "internal");
    const del = await alice({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/shares/${revoked.id}`,
    });
    expect(del.statusCode).toBe(204);
    const expired = await share(await deliver("b.html", "b"), "external");
    await sql`UPDATE capybara.file_shares SET expires_at = now() - interval '1 minute'
      WHERE id = ${expired.id}`.execute(raw);
    const answers = await Promise.all(
      ["ZZZZZZZZZZ", "bad!", revoked.code, expired.code].map((c) => anon(base(c))),
    );
    for (const r of answers) {
      expect(r.statusCode).toBe(404);
      expect(errCode(r)).toBe("share.not_found");
      expect(r.headers["x-robots-tag"]).toBe("noindex");
    }
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);
  });

  it("an internal share: anonymous → 401, a non-member's session → the same 404 as unknown", async () => {
    const s = await share(await deliver("a.html", "a"), "internal");
    const a = await anon(base(s.code));
    expect(a.statusCode).toBe(401);
    expect(errCode(a)).toBe("share.sign_in_required");
    const n = await carol({ method: "GET", url: base(s.code) });
    expect(n.statusCode).toBe(404);
    expect(n.body).toBe((await anon(base("ZZZZZZZZZZ"))).body);
  });

  it("an internal share opens for a member whose current org is another org", async () => {
    const s = await share(await deliver("a.html", "a"), "internal");
    const other = await createOrg(owner, "Other");
    const put = await owner({
      method: "PUT",
      url: "/api/v1/me/current-org",
      payload: { orgId: other },
    });
    expect(put.statusCode, put.body).toBe(204);
    const r = await owner({ method: "GET", url: base(s.code) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ audience: "internal", sharedBy: "Alice" });
  });

  it("an internal share refuses a personal API token (a web session is required)", async () => {
    const s = await share(await deliver("a.html", "a"), "internal");
    const t = await alice({
      method: "POST",
      url: "/api/v1/me/tokens",
      payload: { name: "t" },
    });
    expect(t.statusCode, t.body).toBe(201);
    const token = (t.json() as { token: string }).token;
    const r = await k.http.inject({
      method: "GET",
      url: base(s.code),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("share.sign_in_required");
  });

  it("an external share stops when the org switches external sharing off", async () => {
    const s = await share(await deliver("a.html", "a"), "external");
    expect((await anon(base(s.code))).statusCode).toBe(200);
    await orgSharing("off");
    const r = await anon(base(s.code));
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("share.not_found");
  });
});

describe("content, text, inline", () => {
  it("/content: exact headers, octet-stream, the snapshot's bytes", async () => {
    const s = await share(await deliver("report.html", "<script>x</script>"), "external");
    const r = await anon(`${base(s.code)}/content`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("<script>x</script>");
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["x-robots-tag"]).toBe("noindex");
    expect(r.headers["content-length"]).toBe("18");
    expect(r.headers["content-disposition"]).toBeUndefined();
  });

  it("/content?download=1: attachment with an RFC 5987 name and an ASCII fallback", async () => {
    const s = await share(await deliver('季度报告 "Q3".html', "x"), "external");
    const r = await anon(`${base(s.code)}/content?download=1`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toBe(
      `attachment; filename="____ _Q3_.html"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A%20%22Q3%22.html`,
    );
  });

  it("/text: a text file as text/plain with its original type; a binary file → 400", async () => {
    const t = await share(await deliver("notes.md", "# héllo world", "text/markdown"), "external");
    const r = await anon(`${base(t.code)}/text?limit=8`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["x-content-original-type"]).toBe("text/markdown");
    expect(r.headers["x-content-truncated"]).toBe("true");
    expect(r.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    // "# h" + "é" (2 bytes) + "llo" = 8 bytes
    expect(r.body).toBe("# héllo");
    const whole = await anon(`${base(t.code)}/text`);
    expect(whole.body).toBe("# héllo world");
    expect(whole.headers["x-content-truncated"]).toBeUndefined();

    const b = await share(
      await deliver("a.bin", Buffer.from([0, 1, 2]), "application/octet-stream"),
      "external",
    );
    const bad = await anon(`${base(b.code)}/text`);
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("conversation.artifact_not_previewable");
    const nul = await share(
      await deliver("n.txt", Buffer.from([65, 0, 66]), "text/plain"),
      "external",
    );
    expect(errCode(await anon(`${base(nul.code)}/text`))).toBe(
      "conversation.artifact_not_previewable",
    );
  });

  it("/inline: a bitmap with its type and the sandbox headers; an SVG → 404", async () => {
    const png = await share(
      await deliver("a.png", Buffer.from([137, 80, 78, 71]), "image/png"),
      "external",
    );
    const r = await anon(`${base(png.code)}/inline`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.rawPayload).toEqual(Buffer.from([137, 80, 78, 71]));
    const svg = await share(await deliver("a.svg", "<svg/>", "image/svg+xml"), "external");
    const s = await anon(`${base(svg.code)}/inline`);
    expect(s.statusCode).toBe(404);
    expect(errCode(s)).toBe("share.not_found");
  });

  it("/content of an internal share needs a member's session too", async () => {
    const s = await share(await deliver("a.html", "a"), "internal");
    expect((await anon(`${base(s.code)}/content`)).statusCode).toBe(401);
    expect((await carol({ method: "GET", url: `${base(s.code)}/content` })).statusCode).toBe(404);
    expect((await alice({ method: "GET", url: `${base(s.code)}/content` })).statusCode).toBe(200);
  });

  it("/content streams: a store failing mid-body has already sent the status and headers", async () => {
    const s = await share(await deliver("big.bin", "x", "application/octet-stream"), "external");
    const storage = k.app.get(StorageService);
    const real = storage.kernel.bind(storage);
    const size = 300 * MiB;
    vi.spyOn(storage, "kernel").mockImplementation((org: string) => {
      const inner = real(org);
      return {
        ...inner,
        get: async () => {
          // 4 MiB in 64 KiB chunks, then the store fails: far less than the announced size
          let chunks = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(c) {
              if (chunks++ < 64) c.enqueue(new Uint8Array(64 * 1024));
              else c.error(new Error("store failed mid-stream"));
            },
          });
          return {
            head: { key: "k", size, contentType: "application/octet-stream" },
            body,
          };
        },
      } as ReturnType<StorageService["kernel"]>;
    });
    // over a real socket: the response's status and headers arrive before the body fails; a
    // service that buffered the object would have failed before answering (500)
    const r = await fetch(`http://127.0.0.1:${k.port}${base(s.code)}/content`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe(String(size));
    await expect(r.arrayBuffer()).rejects.toThrow();
  });
});

describe("html", () => {
  it("/html redirects to a document token whose GET returns the HTML document", async () => {
    const s = await share(await deliver("report.html", "<p>shared</p>"), "external");
    const r = await anon(`${base(s.code)}/html`);
    expect(r.statusCode).toBe(302);
    expect(r.headers["cache-control"]).toBe("no-store");
    const loc = String(r.headers.location);
    expect(loc).toMatch(/^\/api\/v1\/html\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const doc = await anon(loc);
    expect(doc.statusCode).toBe(200);
    expect(doc.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(doc.body).toBe("<p>shared</p>");
  });

  it("/html of an internal share never mints a token without a member's session", async () => {
    const s = await share(await deliver("report.html", "<p>x</p>"), "internal");
    const a = await anon(`${base(s.code)}/html`);
    expect(a.statusCode).toBe(401);
    expect(a.headers.location).toBeUndefined();
    const c = await carol({ method: "GET", url: `${base(s.code)}/html` });
    expect(c.statusCode).toBe(404);
    expect(c.headers.location).toBeUndefined();
    const m = await alice({ method: "GET", url: `${base(s.code)}/html` });
    expect(m.statusCode).toBe(302);
  });

  it("/html of a file that is not HTML → 400 not previewable", async () => {
    const s = await share(await deliver("a.txt", "x", "text/plain"), "external");
    const r = await anon(`${base(s.code)}/html`);
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe("conversation.artifact_not_previewable");
  });
});

describe("share-open throttler", () => {
  it("31 misses from one address: the 31st is 429 with retry-after; another address still gets 404", async () => {
    for (let i = 0; i < 30; i++) {
      const r = await anon(base("ZZZZZZZZZZ"), "198.51.100.7");
      expect(r.statusCode).toBe(404);
    }
    const r = await anon(base("ZZZZZZZZZZ"), "198.51.100.7");
    expect(r.statusCode).toBe(429);
    expect(errCode(r)).toBe("rate_limited");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    // malformed codes are misses as well, and the limit holds on every share route
    expect((await anon(`${base("bad!")}/content`, "198.51.100.7")).statusCode).toBe(429);
    const other = await anon(base("ZZZZZZZZZZ"), "198.51.100.8");
    expect(other.statusCode).toBe(404);
  });

  it("successful opens are refunded: 40 live opens leave the full budget of misses", async () => {
    const s = await share(await deliver("a.html", "a"), "external");
    for (let i = 0; i < 40; i++) {
      expect((await anon(base(s.code), "198.51.100.9")).statusCode).toBe(200);
    }
    for (let i = 0; i < 30; i++) {
      expect((await anon(base("ZZZZZZZZZZ"), "198.51.100.9")).statusCode).toBe(404);
    }
    expect((await anon(base("ZZZZZZZZZZ"), "198.51.100.9")).statusCode).toBe(429);
  });
});

describe("share.opened", () => {
  it("audited once per viewer per 10 minutes, per address for anonymous viewers; last opened set", async () => {
    const s = await share(await deliver("a.html", "a"), "external");
    expect((await anon(base(s.code), "192.0.2.1")).statusCode).toBe(200);
    expect((await anon(base(s.code), "192.0.2.1")).statusCode).toBe(200);
    // content reads are not opens
    expect((await anon(`${base(s.code)}/content`, "192.0.2.1")).statusCode).toBe(200);
    expect(await opened()).toHaveLength(1);
    expect((await anon(base(s.code), "192.0.2.2")).statusCode).toBe(200);
    const rows = await opened();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_account_id: null, org_id: orgId, target: s.id });
    expect(rows[0]?.detail).toEqual({ shareId: s.id, audience: "external" });
    const row = await db
      .selectFrom("file_shares")
      .select("last_opened_at")
      .where("id", "=", s.id)
      .executeTakeFirstOrThrow();
    expect(row.last_opened_at).not.toBeNull();
  });

  it("an internal open is audited with the member's account, once for two opens", async () => {
    const s = await share(await deliver("a.html", "a"), "internal");
    expect((await owner({ method: "GET", url: base(s.code) })).statusCode).toBe(200);
    expect((await owner({ method: "GET", url: base(s.code) })).statusCode).toBe(200);
    const rows = await opened();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_account_id: ownerId, target: s.id });
    expect(rows[0]?.detail).toEqual({ shareId: s.id, audience: "internal" });
  });

  it("a failed open audit gives the dedupe marker back: the next open is audited", async () => {
    const s = await share(await deliver("a.html", "a"), "external");
    const svc = k.app.get(ShareOpenService);
    vi.spyOn(svc, "recordOpen").mockRejectedValueOnce(new Error("audit write failed"));
    expect((await anon(base(s.code), "192.0.2.5")).statusCode).toBe(500);
    expect(await opened()).toHaveLength(0);
    expect((await anon(base(s.code), "192.0.2.5")).statusCode).toBe(200);
    expect(await opened()).toHaveLength(1);
  });

  it("refused opens are not audited", async () => {
    const s = await share(await deliver("a.html", "a"), "internal");
    await anon(base(s.code));
    await carol({ method: "GET", url: base(s.code) });
    expect(await opened()).toHaveLength(0);
  });
});
