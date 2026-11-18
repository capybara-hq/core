import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { REDIS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";
import type { PreviewProbeState } from "../fixtures/plugins/preview-fake/index.js";
import { truncateTables } from "../helpers/db.js";
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
 * File sharing spec §7: previewers on a share page. The share embed-token route mints a
 * share-scoped token (`scope: "share"`) that verifies only for a `file.preview` contribution while
 * the share is live at the same generation and the extension is enabled in the share's org, and is
 * never valid for `/api`; a view previewer renders the snapshot with `source: "share"`, and one that
 * needs the conversation declines it.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const PREVIEW_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/preview-fake/index.ts", import.meta.url),
);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const probe = (): PreviewProbeState => {
  const g = globalThis as { __previewProbe?: PreviewProbeState };
  g.__previewProbe ??= { aborted: 0 };
  return g.__previewProbe;
};

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
        extensions: [MODEL_FAKE, OBJECT_STORE, PREVIEW_FAKE],
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
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const aliceId = (await accounts.createLocal({ login: "alice", password: PW, displayName: "A" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  alice = await session(k, "alice");
  conv = await createConv(alice, orgId, await createAgent(owner, orgId));
  await setEnabled(true);
  delete probe().last;
  delete probe().read;
});

const setEnabled = async (enabled: boolean) => {
  const r = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/preview-fake`,
    payload: { enabled },
  });
  expect(r.statusCode, r.body).toBe(200);
};

/** Stores an object and logs its `artifact_created` (as `Deliver` would). */
async function deliver(name: string, body: Buffer | string, contentType: string): Promise<string> {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  await k.app
    .get(StorageService)
    .kernel(orgId)
    .put(objectKey, bytes, { contentType, size: bytes.byteLength });
  await k.app.get(EventLog).append(conv, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name,
        contentType,
        size: bytes.byteLength,
        objectKey,
        sourcePath: `/workspace/${name}`,
        callId: `call-${artifactId}`,
      },
    },
  ]);
  return artifactId;
}

interface Created {
  id: string;
  code: string;
}

async function share(fileId: string, audience: "internal" | "external" = "external") {
  if (audience === "external") {
    await sql`INSERT INTO capybara.deployment_settings (key, value) VALUES ('externalSharing', '"allow"'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
    await sql`UPDATE capybara.orgs SET settings = settings || '{"externalSharing":"on"}'::jsonb
      WHERE id = ${orgId}`.execute(raw);
  }
  const r = await alice({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/files/${fileId}/shares`,
    payload: { audience, expiresInDays: audience === "external" ? 7 : null },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { share: Created }).share;
}

const base = (code: string) => `/api/v1/s/${code}`;
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

/** An anonymous POST of the share embed-token route (with the CSRF header every public POST needs). */
const mint = (code: string, previewer: string, csrf = true) =>
  k.http.inject({
    method: "POST",
    url: `${base(code)}/embed-token/preview-fake/${previewer}`,
    remoteAddress: "203.0.113.7",
    headers: csrf ? { "x-capybara-csrf": "1" } : {},
  });

type Minted = { token: string; src: string; expiresIn: number };

/** `ctx.ui.verifyEmbedToken` inside the extension. */
const verify = async (token: string) => {
  const r = await k.http.inject({
    method: "GET",
    url: "/plugins/preview-fake/ui/verify",
    headers: { "x-token": token },
  });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { claims: unknown }).claims;
};

/** The extension's `embed` route with the token as Bearer. */
const claimsRoute = (token: string) =>
  k.http.inject({
    method: "GET",
    url: "/plugins/preview-fake/ui/claims",
    headers: { authorization: `Bearer ${token}` },
  });

const payloadOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

describe("share embed tokens", () => {
  it("the embed-token route mints a share-scoped token for the file.preview embed", async () => {
    const s = await share(await deliver("a.docx", "PK docx", DOCX));
    // a public POST needs the CSRF header
    const noCsrf = await mint(s.code, "docx-page", false);
    expect(noCsrf.statusCode).toBe(403);
    expect(errCode(noCsrf)).toBe("auth.csrf");
    const r = await mint(s.code, "docx-page");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    const body = r.json() as Minted;
    expect(Object.keys(body).sort()).toEqual(["expiresIn", "src", "token"]);
    expect(body.src).toBe("/plugin-ui/preview-fake/docx");
    expect(body.expiresIn).toBe(300);
    const payload = payloadOf(body.token);
    expect(payload).toEqual({
      plugin: "preview-fake",
      scope: "share",
      orgId,
      shareId: s.id,
      generation: 1,
      contribution: "docx-embed",
      exp: expect.any(Number),
    });
    expect(await verify(body.token)).toEqual(payload);
    // the extension sees an org call for the share's org, with no account or role
    const caller = await claimsRoute(body.token);
    expect(caller.statusCode, caller.body).toBe(200);
    expect(caller.json()).toEqual({
      access: "embed",
      scope: "share",
      orgId,
      shareId: s.id,
      contribution: "docx-embed",
      exp: payload.exp,
      config: {},
    });
  });

  it("a view previewer, a previewer that does not take the file, or an unknown one: 404 ui.not_found", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX));
    for (const id of ["docx", "decline", "nope"]) {
      const r = await mint(s.code, id);
      expect(r.statusCode, id).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
    // an unknown code: the share answer
    const unknown = await mint("ZZZZZZZZZZ", "docx-page");
    expect(unknown.statusCode).toBe(404);
    expect(errCode(unknown)).toBe("share.not_found");
  });

  it("an internal share mints only for a member's session", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX), "internal");
    const anon = await mint(s.code, "docx-page");
    expect(anon.statusCode).toBe(401);
    expect(errCode(anon)).toBe("share.sign_in_required");
    const r = await alice({
      method: "POST",
      url: `${base(s.code)}/embed-token/preview-fake/docx-page`,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(payloadOf((r.json() as Minted).token)).toMatchObject({ scope: "share", shareId: s.id });
  });

  it("a share token never verifies for another slot's contribution", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX));
    const { token } = k.app.get(EmbedTokens).issue({
      plugin: "preview-fake",
      scope: "share",
      orgId,
      shareId: s.id,
      generation: 1,
      contribution: "panel-embed",
    });
    expect(await verify(token)).toBeNull();
    expect((await claimsRoute(token)).statusCode).toBe(401);
    // the same share, the file.preview contribution: valid
    const ok = k.app.get(EmbedTokens).issue({
      plugin: "preview-fake",
      scope: "share",
      orgId,
      shareId: s.id,
      generation: 1,
      contribution: "docx-embed",
    });
    expect(await verify(ok.token)).not.toBeNull();
    // another org's id with this share: not live there
    const otherOrg = k.app.get(EmbedTokens).issue({
      plugin: "preview-fake",
      scope: "share",
      orgId: randomUUID(),
      shareId: s.id,
      generation: 1,
      contribution: "docx-embed",
    });
    expect(await verify(otherOrg.token)).toBeNull();
  });

  it("after a revoke the token stops: verify null, the embed route 401", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX));
    const { token } = (await mint(s.code, "docx-page")).json() as Minted;
    expect((await claimsRoute(token)).statusCode).toBe(200);
    const del = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/shares/${s.id}` });
    expect(del.statusCode).toBe(204);
    expect(await verify(token)).toBeNull();
    const r = await claimsRoute(token);
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
  });

  it("after a refresh (generation 2) the old token stops and a new one works", async () => {
    const s = await share(await deliver("a.docx", "PK one", DOCX));
    const { token: old } = (await mint(s.code, "docx-page")).json() as Minted;
    await deliver("a.docx", "PK two", DOCX);
    const ref = await alice({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/shares/${s.id}/refresh`,
    });
    expect(ref.statusCode, ref.body).toBe(200);
    expect(await verify(old)).toBeNull();
    expect((await claimsRoute(old)).statusCode).toBe(401);
    const { token: fresh } = (await mint(s.code, "docx-page")).json() as Minted;
    expect(payloadOf(fresh)).toMatchObject({ generation: 2 });
    expect(await verify(fresh)).toMatchObject({ generation: 2 });
  });

  it("with the extension disabled in the org the token stops; enabled again it works", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX));
    const { token } = (await mint(s.code, "docx-page")).json() as Minted;
    await setEnabled(false);
    expect(await verify(token)).toBeNull();
    expect((await claimsRoute(token)).statusCode).toBe(401);
    // and none is minted while it is off
    expect((await mint(s.code, "docx-page")).statusCode).toBe(404);
    await setEnabled(true);
    expect(await verify(token)).not.toBeNull();
  });

  it("a share token is never valid for /api", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX));
    const { token } = (await mint(s.code, "docx-page")).json() as Minted;
    const r = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
  });
});

describe("share view previewers", () => {
  it("the metadata lists the org's previewers that take the snapshot", async () => {
    const docx = await share(await deliver("a.docx", "PK", DOCX));
    const meta = await k.http.inject({ method: "GET", url: base(docx.code) });
    expect(meta.statusCode, meta.body).toBe(200);
    const body = meta.json() as { render: string; previewers: { id: string; kind: string }[] };
    expect(body.render).toBe("previewers");
    expect(body.previewers.map((p) => [p.id, p.kind])).toEqual([
      ["docx", "view"],
      ["docx-page", "embed"],
    ]);
    await setEnabled(false);
    const off = (await k.http.inject({ method: "GET", url: base(docx.code) })).json() as {
      previewers: unknown[];
    };
    expect(off.previewers).toEqual([]);
  });

  it("a view previewer renders the snapshot with source share", async () => {
    const s = await share(await deliver("a.docx", "PK docx bytes", DOCX));
    const r = await k.http.inject({
      method: "GET",
      url: `${base(s.code)}/previews/preview-fake/docx?locale=zh`,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.json()).toEqual({
      view: { blocks: [{ type: "text", markdown: "13 PK docx bytes" }] },
    });
    expect(probe().last).toEqual({
      source: "share",
      orgId,
      shareId: s.id,
      locale: "zh",
      config: {},
      file: { id: s.id, name: "a.docx", contentType: DOCX, size: 13 },
    });
    // the grant ends with the render
    await expect(probe().read?.()).rejects.toThrow(/expired/);
  });

  it("a previewer that needs the conversation declines a share: 502 ui.render_failed", async () => {
    const s = await share(await deliver("a.decl", "x", "application/octet-stream"));
    const r = await k.http.inject({
      method: "GET",
      url: `${base(s.code)}/previews/preview-fake/decline`,
    });
    expect(r.statusCode).toBe(502);
    expect(errCode(r)).toBe("ui.render_failed");
  });

  it("an embed previewer or one that does not take the file: 404 ui.not_found; a bad code 404", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX));
    for (const id of ["docx-page", "hang", "nope"]) {
      const r = await k.http.inject({
        method: "GET",
        url: `${base(s.code)}/previews/preview-fake/${id}`,
      });
      expect(r.statusCode, id).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
    const unknown = await k.http.inject({
      method: "GET",
      url: `${base("ZZZZZZZZZZ")}/previews/preview-fake/docx`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(errCode(unknown)).toBe("share.not_found");
  });

  it("an internal share's preview needs a member's session", async () => {
    const s = await share(await deliver("a.docx", "PK", DOCX), "internal");
    const url = `${base(s.code)}/previews/preview-fake/docx`;
    const anon = await k.http.inject({ method: "GET", url });
    expect(anon.statusCode).toBe(401);
    expect(errCode(anon)).toBe("share.sign_in_required");
    const r = await alice({ method: "GET", url });
    expect(r.statusCode, r.body).toBe(200);
  });
});
