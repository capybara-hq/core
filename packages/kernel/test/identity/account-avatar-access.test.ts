import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountAvatarsService } from "../../src/identity/account-avatars.service.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * GET /api/v1/accounts/:accountId/avatar (account profile spec §5.3): who may read a person's image.
 * Every refusal answers exactly like an unknown account or a person without an image (404).
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  const urls = { pg: pgc.url, redis: rd.url };
  k = await startKernel(
    runConfig(urls, {
      roles: ["api", "worker"],
      extensions: [OBJECT_STORE, MODEL_FAKE],
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
    }),
  );
});
afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let adaId: string;
let samId: string;
let gusId: string;
let ada: Req;
let sam: Req;
let gus: Req;
let eve: Req;
let root: Req;
/** The org ada owns; sam is a member, gus a guest. */
let sharedOrg: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.account_avatar_uploads, capybara.api_tokens, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  adaId = (await accounts.createLocal({ login: "ada", password: PW, displayName: "Ada" })).id;
  samId = (await accounts.createLocal({ login: "sam", password: PW, displayName: "Sam" })).id;
  gusId = (await accounts.createLocal({ login: "gus", password: PW, displayName: "Gus" })).id;
  await accounts.createLocal({ login: "eve", password: PW, displayName: "Eve" });
  await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "Root",
    superAdmin: true,
  });
  ada = await session(k, "ada");
  sam = await session(k, "sam");
  gus = await session(k, "gus");
  eve = await session(k, "eve");
  root = await session(k, "root");
  sharedOrg = await createOrg(ada);
  await testMembers(db).add(sharedOrg, samId, "member", adaId);
  await testMembers(db).add(sharedOrg, gusId, "guest", adaId);
  // eve is a member of another org only
  await createOrg(eve, "Other");
});

interface Created {
  uploadId: string;
  upload: {
    method: "PUT" | "POST";
    url: string;
    headers: Record<string, string>;
    fields?: Record<string, string>;
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SSO_URL = "https://img.example.com/ada.png";

async function putToStore(c: Created, bytes: Uint8Array): Promise<void> {
  let res: Response;
  if (c.upload.method === "PUT") {
    res = await fetch(c.upload.url, {
      method: "PUT",
      headers: c.upload.headers,
      body: Buffer.from(bytes),
    });
  } else {
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
    form.append("file", new Blob([Buffer.from(bytes)], { type: "image/png" }));
    res = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  }
  expect(res.status, await res.clone().text()).toBeLessThan(300);
}

/** Uploads a PNG as the caller's avatar and binds it; returns the upload id. */
async function setUploadedAvatar(req: Req): Promise<string> {
  const res = await req({
    method: "POST",
    url: "/api/v1/me/avatar/uploads",
    payload: { contentType: "image/png", size: PNG.byteLength },
  });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json() as Created;
  await putToStore(c, PNG);
  const bound = await req({
    method: "PATCH",
    url: "/api/v1/me/profile",
    payload: { avatar: { kind: "upload", uploadId: c.uploadId } },
  });
  expect(bound.statusCode, bound.body).toBe(200);
  return c.uploadId;
}

async function setSsoAvatar(accountId: string, url: string): Promise<void> {
  await db
    .insertInto("identities")
    .values({
      source: "lark:t1",
      external_id: `ou_${accountId}`,
      account_id: accountId,
      email: null,
      profile: JSON.stringify({ avatarUrl: url }),
      linked_via: "sso",
      updated_at: new Date(),
    })
    .execute();
}

const avatarOf = (req: Req, accountId: string) =>
  req({ method: "GET", url: `/api/v1/accounts/${encodeURIComponent(accountId)}/avatar?v=abc` });

/** The 404 every refusal must answer with: status, body and content type. */
async function expectNotFound(res: Awaited<ReturnType<Req>>): Promise<void> {
  expect(res.statusCode, res.body).toBe(404);
  expect(res.json()).toEqual({
    error: { code: "account.not_found", message: "Account not found" },
  });
  expect(res.headers.location).toBeUndefined();
  expect(res.headers["cache-control"]).toBe("private, no-store");
}

function expectPresigned(res: Awaited<ReturnType<Req>>): string {
  expect(res.statusCode, res.body).toBe(302);
  const location = String(res.headers.location);
  expect(location).toContain(new URL(s3.endpoint).host);
  expect(res.headers["cache-control"]).toBe("private, max-age=60");
  return location;
}

describe("account avatar route: who may read", () => {
  it("the account itself gets a presigned URL that returns the PNG bytes", async () => {
    await setUploadedAvatar(ada);
    const location = expectPresigned(await avatarOf(ada, adaId));
    const img = await fetch(location);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  it("a member and a guest of a shared org are allowed", async () => {
    await setUploadedAvatar(ada);
    expectPresigned(await avatarOf(sam, adaId));
    expectPresigned(await avatarOf(gus, adaId));
    // the other way round too: the guest's own avatar is readable by the owner
    await setSsoAvatar(gusId, "https://img.example.com/gus.png");
    const res = await avatarOf(ada, gusId);
    expect(res.statusCode, res.body).toBe(302);
  });

  it("a member of another org only gets the same 404 as an unknown account", async () => {
    await setUploadedAvatar(ada);
    const refused = await avatarOf(eve, adaId);
    await expectNotFound(refused);
    const unknown = await avatarOf(eve, "no-such-account");
    await expectNotFound(unknown);
    expect(unknown.body).toBe(refused.body);
    expect(unknown.headers["content-type"]).toBe(refused.headers["content-type"]);
    // an allowed reader asking for an unknown account gets the very same answer
    expect((await avatarOf(sam, "no-such-account")).body).toBe(refused.body);
  });

  it("a super admin with no membership is allowed", async () => {
    await setUploadedAvatar(ada);
    expectPresigned(await avatarOf(root, adaId));
  });

  it("after the target leaves the only shared org, 404", async () => {
    await setUploadedAvatar(sam);
    expectPresigned(await avatarOf(gus, samId));
    await db
      .deleteFrom("memberships")
      .where("org_id", "=", sharedOrg)
      .where("account_id", "=", samId)
      .execute();
    await expectNotFound(await avatarOf(gus, samId));
    // the account itself still reads its own image
    expectPresigned(await avatarOf(sam, samId));
  });

  it("a soft-deleted org does not count as shared", async () => {
    await setUploadedAvatar(ada);
    await db
      .updateTable("orgs")
      .set({ deleted_at: new Date() })
      .where("id", "=", sharedOrg)
      .execute();
    await expectNotFound(await avatarOf(sam, adaId));
    await expectNotFound(await avatarOf(gus, adaId));
  });

  it("a service token gets 403, no credentials 401", async () => {
    await setUploadedAvatar(ada);
    const svc = await apiTokensFor(db).createService(sharedOrg, {
      name: "bot",
      role: "admin",
      createdBy: adaId,
    });
    const service = await k.http.inject({
      method: "GET",
      url: `/api/v1/accounts/${adaId}/avatar`,
      headers: { authorization: `Bearer ${svc.token}` },
    });
    expect(service.statusCode).toBe(403);
    expect(service.headers.location).toBeUndefined();

    const anonymous = await k.http.inject({
      method: "GET",
      url: `/api/v1/accounts/${adaId}/avatar`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers.location).toBeUndefined();
  });

  it("an account that must change its password reads its own image, and only its own", async () => {
    await setSsoAvatar(adaId, SSO_URL);
    await setSsoAvatar(samId, "https://img.example.com/sam.png");
    await db
      .updateTable("accounts")
      .set({ must_change_password: true })
      .where("id", "=", samId)
      .execute();
    const own = await avatarOf(sam, samId);
    expect(own.statusCode, own.body).toBe(302);
    expect(own.headers.location).toBe("https://img.example.com/sam.png");
    await expectNotFound(await avatarOf(sam, adaId));
  });

  it("a personal token of an allowed reader works", async () => {
    await setUploadedAvatar(ada);
    const { token } = await apiTokensFor(db).createPersonal(samId, { name: "cli" });
    const res = await k.http.inject({
      method: "GET",
      url: `/api/v1/accounts/${adaId}/avatar`,
      headers: { authorization: `Bearer ${token}` },
    });
    expectPresigned(res);
  });
});

describe("account avatar route: which image", () => {
  it("a person without any image gets 404, even for themselves", async () => {
    await expectNotFound(await avatarOf(ada, adaId));
    await expectNotFound(await avatarOf(sam, adaId));
  });

  it("an SSO https avatar gives a 302 to that exact URL", async () => {
    await setSsoAvatar(adaId, SSO_URL);
    const res = await avatarOf(sam, adaId);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe(SSO_URL);
    expect(res.headers["cache-control"]).toBe("private, max-age=60");
  });

  it("an SSO http: avatar gives 404", async () => {
    await setSsoAvatar(adaId, "http://img.example.com/ada.png");
    await expectNotFound(await avatarOf(sam, adaId));
  });

  it("an own upload wins over the SSO avatar", async () => {
    await setSsoAvatar(adaId, SSO_URL);
    await setUploadedAvatar(ada);
    expectPresigned(await avatarOf(sam, adaId));
  });

  it("a bound upload whose object is gone falls back to the SSO URL, else 404", async () => {
    const uploadId = await setUploadedAvatar(ada);
    await k.app.get(StorageService).deployment().delete(`account-avatars/${adaId}/${uploadId}`);
    await expectNotFound(await avatarOf(sam, adaId));
    await setSsoAvatar(adaId, SSO_URL);
    const res = await avatarOf(sam, adaId);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe(SSO_URL);
  });

  it("an SSO URL holding a line break redirects to its normalized form, never a 500", async () => {
    await setSsoAvatar(adaId, "https://img.example.com/a\r\nda.png");
    const res = await avatarOf(sam, adaId);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe(SSO_URL);
  });

  it("an object store failure falls back to the SSO URL, else 404, never a 500", async () => {
    await setUploadedAvatar(ada);
    const failing = vi
      .spyOn(k.app.get(AccountAvatarsService), "objectUrl")
      .mockRejectedValue(new Error("store down"));
    try {
      await expectNotFound(await avatarOf(sam, adaId));
      await setSsoAvatar(adaId, SSO_URL);
      const res = await avatarOf(sam, adaId);
      expect(res.statusCode, res.body).toBe(302);
      expect(res.headers.location).toBe(SSO_URL);
    } finally {
      failing.mockRestore();
    }
  });

  it("without an object store an upload falls back to the SSO URL, else 404", async () => {
    await setUploadedAvatar(ada);
    // the one kernel of this file has a store: its provider reads as absent for this test
    const off = vi.spyOn(k.app.get(StorageService), "available", "get").mockReturnValue(false);
    try {
      await expectNotFound(await avatarOf(sam, adaId));
      await setSsoAvatar(adaId, SSO_URL);
      const res = await avatarOf(sam, adaId);
      expect(res.statusCode, res.body).toBe(302);
      expect(res.headers.location).toBe(SSO_URL);
    } finally {
      off.mockRestore();
    }
  });
});
