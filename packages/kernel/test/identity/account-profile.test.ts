import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountAvatarsService } from "../../src/identity/account-avatars.service.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
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
let ada: Req;
let sam: Req;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.account_avatar_uploads, capybara.api_tokens, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  adaId = (await accounts.createLocal({ login: "ada", password: PW, displayName: "A" })).id;
  samId = (await accounts.createLocal({ login: "sam", password: PW, displayName: "S" })).id;
  await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "Root",
    superAdmin: true,
  });
  ada = await session(k, "ada");
  sam = await session(k, "sam");
});

interface Created {
  uploadId: string;
  expiresAt: string;
  upload: {
    method: "PUT" | "POST";
    url: string;
    headers: Record<string, string>;
    fields?: Record<string, string>;
  };
}
interface AccountJson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  avatarSource: { kind: string; source?: string } | null;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const code = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;
const accountOf = (res: { json(): unknown }) => (res.json() as { account: AccountJson }).account;

async function putToStore(c: Created, bytes: Uint8Array, contentType: string): Promise<void> {
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
    form.append("file", new Blob([Buffer.from(bytes)], { type: contentType }));
    res = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  }
  expect(res.status, await res.clone().text()).toBeLessThan(300);
}

const requestUpload = (req: Req, payload: Record<string, unknown>) =>
  req({ method: "POST", url: "/api/v1/me/avatar/uploads", payload });

const patchProfile = (req: Req, payload: Record<string, unknown>) =>
  req({ method: "PATCH", url: "/api/v1/me/profile", payload });

/** Registers and uploads `bytes` as a PNG; returns the upload id. */
async function uploadPng(req: Req, bytes: Uint8Array = PNG): Promise<string> {
  const res = await requestUpload(req, { contentType: "image/png", size: bytes.byteLength });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json() as Created;
  await putToStore(c, bytes, "image/png");
  return c.uploadId;
}

const uploadRow = (id: string) =>
  db
    .selectFrom("account_avatar_uploads")
    .select([
      "id",
      "status",
      "storage_key",
      "expires_at",
      sql<boolean>`expires_at <= now()`.as("expired"),
    ])
    .where("id", "=", id)
    .executeTakeFirst();

const storedAvatar = async (id: string) =>
  (await db.selectFrom("accounts").select("avatar").where("id", "=", id).executeTakeFirstOrThrow())
    .avatar;

const profileAudits = () =>
  db
    .selectFrom("audit_events")
    .select(["actor_account_id", "actor_token_id", "target", "detail"])
    .where("action", "=", "account.profile_updated")
    .orderBy("id")
    .execute();

const avatarPrefix = (id: string) => `/api/v1/accounts/${id}/avatar?v=`;

describe("account avatar uploads", () => {
  it("registers a pending PNG upload with an expiry", async () => {
    const res = await requestUpload(ada, { contentType: "image/png", size: 1000 });
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as Created;
    expect(c.upload.url).toContain(new URL(s3.endpoint).host);
    expect(c.expiresAt).toBeTruthy();
    const row = await db
      .selectFrom("account_avatar_uploads")
      .selectAll()
      .where("id", "=", c.uploadId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      account_id: adaId,
      status: "pending",
      content_type: "image/png",
      storage_key: `account-avatars/${adaId}/${c.uploadId}`,
    });
    expect(row.expires_at).not.toBeNull();
    expect(row.expires_at?.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it("refuses a GIF, an upload over 2 MB, and an 11th pending upload", async () => {
    const gif = await requestUpload(ada, { contentType: "image/gif", size: 10 });
    expect(gif.statusCode).toBe(415);
    expect(code(gif)).toBe("attachment.type_not_allowed");

    const big = await requestUpload(ada, { contentType: "image/png", size: 2 * 1024 * 1024 + 1 });
    expect(big.statusCode).toBe(413);
    expect(code(big)).toBe("attachment.too_large");

    for (let i = 0; i < 10; i++) {
      const ok = await requestUpload(ada, { contentType: "image/webp", size: 10 });
      expect(ok.statusCode, ok.body).toBe(201);
    }
    const eleventh = await requestUpload(ada, { contentType: "image/png", size: 10 });
    expect(eleventh.statusCode).toBe(429);
    expect(code(eleventh)).toBe("attachment.too_many_pending");
  });

  it("without an object store the upload is 503 and a name-only change still works", async () => {
    // the one kernel of this file has a store: its provider reads as absent for this test
    const off = vi.spyOn(k.app.get(StorageService), "available", "get").mockReturnValue(false);
    try {
      const res = await requestUpload(ada, { contentType: "image/png", size: 10 });
      expect(res.statusCode).toBe(503);
      expect(code(res)).toBe("storage.unavailable");
      const named = await patchProfile(ada, { displayName: "Ada" });
      expect(named.statusCode, named.body).toBe(200);
      expect(accountOf(named).displayName).toBe("Ada");
    } finally {
      off.mockRestore();
    }
  });
});

describe("PATCH /me/profile", () => {
  it("sets an uploaded avatar: bound row, avatarUrl, an audit row without image data", async () => {
    const uploadId = await uploadPng(ada);
    const res = await patchProfile(ada, { avatar: { kind: "upload", uploadId } });
    expect(res.statusCode, res.body).toBe(200);
    const account = accountOf(res);
    expect(account.avatarUrl?.startsWith(avatarPrefix(adaId))).toBe(true);
    expect(account.avatarSource).toEqual({ kind: "upload" });
    expect(await uploadRow(uploadId)).toMatchObject({ status: "ready", expires_at: null });
    expect(await storedAvatar(adaId)).toEqual({ kind: "upload", uploadId });
    const audits = await profileAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_account_id: adaId,
      actor_token_id: null,
      target: adaId,
      detail: { avatar: "upload" },
    });
    expect(Object.keys(audits[0]?.detail as object)).toEqual(["avatar"]);

    // /me carries the same avatar
    const me = await ada({ method: "GET", url: "/api/v1/me" });
    expect(accountOf(me).avatarUrl).toBe(account.avatarUrl);
  });

  it("refuses bytes that are not the declared image and keeps the avatar", async () => {
    const junk = new Uint8Array(PNG.byteLength).fill(0x41);
    const uploadId = await uploadPng(ada, junk);
    const res = await patchProfile(ada, { avatar: { kind: "upload", uploadId } });
    expect(res.statusCode).toBe(415);
    expect(code(res)).toBe("attachment.type_not_allowed");
    expect(await storedAvatar(adaId)).toBeNull();
    expect(await profileAudits()).toHaveLength(0);
    // the rejected object is deleted
    const row = await uploadRow(uploadId);
    expect(row?.status).toBe("pending");
    expect(
      await k.app
        .get(StorageService)
        .deployment()
        .head(row?.storage_key ?? ""),
    ).toBeNull();
  });

  it("another account's upload is not found", async () => {
    const uploadId = await uploadPng(ada);
    const res = await patchProfile(sam, { avatar: { kind: "upload", uploadId } });
    expect(res.statusCode).toBe(404);
    expect(code(res)).toBe("attachment.not_found");
    expect(await storedAvatar(samId)).toBeNull();
  });

  it("replacing the avatar expires the previous upload", async () => {
    const first = await uploadPng(ada);
    expect(
      (await patchProfile(ada, { avatar: { kind: "upload", uploadId: first } })).statusCode,
    ).toBe(200);
    const second = await uploadPng(ada);
    const res = await patchProfile(ada, { avatar: { kind: "upload", uploadId: second } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await uploadRow(first))?.expired).toBe(true);
    expect(await uploadRow(second)).toMatchObject({ status: "ready", expires_at: null });
    expect(await storedAvatar(adaId)).toEqual({ kind: "upload", uploadId: second });
  });

  it("avatar null removes it; avatarUrl falls back to an SSO https avatar, else null", async () => {
    const uploadId = await uploadPng(ada);
    await patchProfile(ada, { avatar: { kind: "upload", uploadId } });
    const res = await patchProfile(ada, { avatar: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(accountOf(res).avatarUrl).toBeNull();
    expect(accountOf(res).avatarSource).toBeNull();
    expect(await storedAvatar(adaId)).toBeNull();
    expect((await uploadRow(uploadId))?.expired).toBe(true);
    expect((await profileAudits()).at(-1)?.detail).toEqual({ avatar: "removed" });

    await db
      .insertInto("identities")
      .values({
        source: "lark:t1",
        external_id: "ou_ada",
        account_id: adaId,
        email: null,
        profile: JSON.stringify({ avatarUrl: "https://img.example.com/ada.png" }),
        linked_via: "sso",
        updated_at: new Date(),
      })
      .execute();
    const me = accountOf(await ada({ method: "GET", url: "/api/v1/me" }));
    expect(me.avatarUrl?.startsWith(avatarPrefix(adaId))).toBe(true);
    expect(me.avatarSource).toEqual({ kind: "identity", source: "lark:t1" });
  });

  it("trims the name and refuses a changed name over 64 code points", async () => {
    const res = await patchProfile(ada, { displayName: "  Ada  " });
    expect(res.statusCode, res.body).toBe(200);
    expect(accountOf(res).displayName).toBe("Ada");
    expect((await profileAudits()).at(-1)?.detail).toEqual({ displayName: "Ada" });

    // 64 code points pass even when some are outside the BMP
    const sixtyFour = `${"😀".repeat(4)}${"a".repeat(60)}`;
    expect((await patchProfile(ada, { displayName: sixtyFour })).statusCode).toBe(200);
    const long = await patchProfile(ada, { displayName: "a".repeat(65) });
    expect(long.statusCode).toBe(400);
    expect(code(long)).toBe("account.display_name_too_long");
  });

  it("an older name over 64 chars may stay: avatar-only or the same name, on both PATCH routes", async () => {
    const old = "n".repeat(80);
    await db.updateTable("accounts").set({ display_name: old }).where("id", "=", adaId).execute();

    expect((await patchProfile(ada, { avatar: null })).statusCode).toBe(200);
    const same = await patchProfile(ada, { displayName: ` ${old} ` });
    expect(same.statusCode, same.body).toBe(200);
    expect(accountOf(same).displayName).toBe(old);
    const changed = await patchProfile(ada, { displayName: `${old}x` });
    expect(changed.statusCode).toBe(400);
    expect(code(changed)).toBe("account.display_name_too_long");

    const root = await session(k, "root");
    const adminPatch = (payload: Record<string, unknown>) =>
      root({ method: "PATCH", url: `/api/v1/admin/accounts/${adaId}`, payload });
    expect((await adminPatch({ status: "active" })).statusCode).toBe(200);
    const adminSame = await adminPatch({ displayName: old });
    expect(adminSame.statusCode, adminSame.body).toBe(200);
    const adminLong = await adminPatch({ displayName: "b".repeat(65) });
    expect(adminLong.statusCode).toBe(400);
    expect(code(adminLong)).toBe("account.display_name_too_long");
    const adminOk = await adminPatch({ displayName: "  Ada Lovelace " });
    expect(adminOk.statusCode, adminOk.body).toBe(200);
    expect(accountOf(adminOk).displayName).toBe("Ada Lovelace");
  });

  it("an empty body changes nothing and writes no audit row", async () => {
    const res = await patchProfile(ada, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(accountOf(res).displayName).toBe("A");
    expect(await profileAudits()).toHaveLength(0);
  });

  it("a personal token may change the profile; a service token is refused", async () => {
    const { token, record } = await apiTokensFor(db).createPersonal(adaId, { name: "cli" });
    const pat = await k.http.inject({
      method: "PATCH",
      url: "/api/v1/me/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Ada" },
    });
    expect(pat.statusCode, pat.body).toBe(200);
    expect((await profileAudits()).at(-1)).toMatchObject({
      actor_account_id: adaId,
      actor_token_id: record.id,
    });

    const orgId = await createOrg(ada);
    const svc = await apiTokensFor(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: adaId,
    });
    const refused = await k.http.inject({
      method: "PATCH",
      url: "/api/v1/me/profile",
      headers: { authorization: `Bearer ${svc.token}` },
      payload: { displayName: "Bot" },
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe("account avatar cleanup", () => {
  it("deletes an expired unbound upload and its object, and keeps the bound one", async () => {
    const bound = await uploadPng(ada);
    await patchProfile(ada, { avatar: { kind: "upload", uploadId: bound } });
    const stale = await uploadPng(ada);
    await db
      .updateTable("account_avatar_uploads")
      .set({ expires_at: sql<Date>`now() - interval '1 hour'` })
      .where("id", "=", stale)
      .execute();
    const staleKey = (await uploadRow(stale))?.storage_key ?? "";
    const store = k.app.get(StorageService).deployment();
    expect(await store.head(staleKey)).not.toBeNull();

    const n = await k.app.get(AccountAvatarsService).deleteExpired();
    expect(n).toBe(1);
    expect(await uploadRow(stale)).toBeUndefined();
    expect(await store.head(staleKey)).toBeNull();
    const kept = await uploadRow(bound);
    expect(kept?.expires_at).toBeNull();
    expect(await store.head(kept?.storage_key ?? "")).not.toBeNull();
    expect(await k.app.get(AccountAvatarsService).objectUrl(adaId, bound)).toMatch(/^https?:/);
  });

  it("prepare never revives an expired upload, pending or ready", async () => {
    const avatars = k.app.get(AccountAvatarsService);
    const pending = await uploadPng(ada);
    const ready = await uploadPng(ada);
    await avatars.prepare(adaId, ready);
    await db
      .updateTable("account_avatar_uploads")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
      .where("id", "in", [pending, ready])
      .execute();
    for (const uploadId of [pending, ready]) {
      const res = await patchProfile(ada, { avatar: { kind: "upload", uploadId } });
      expect(res.statusCode).toBe(404);
      expect(code(res)).toBe("attachment.not_found");
      await expect(avatars.prepare(adaId, uploadId)).rejects.toMatchObject({
        code: "attachment.not_found",
      });
      expect((await uploadRow(uploadId))?.expired).toBe(true);
    }
    expect(await storedAvatar(adaId)).toBeNull();
    // the cleanup then removes both
    expect(await avatars.deleteExpired()).toBe(2);
    expect(await uploadRow(pending)).toBeUndefined();
    expect(await uploadRow(ready)).toBeUndefined();
  });

  it("deleting the account removes its upload rows", async () => {
    await db.insertInto("accounts").values({ id: "acc-gone", display_name: "Gone" }).execute();
    await db
      .insertInto("account_avatar_uploads")
      .values({
        id: "up-gone",
        account_id: "acc-gone",
        storage_key: "account-avatars/acc-gone/up-gone",
        content_type: "image/png",
        size: 10,
      })
      .execute();
    await db.deleteFrom("accounts").where("id", "=", "acc-gone").execute();
    expect(await uploadRow("up-gone")).toBeUndefined();
  });
});
