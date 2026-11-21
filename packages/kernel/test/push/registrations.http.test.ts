import { randomUUID } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import { PushRegistrationsService } from "../../src/push/registrations.service.js";
import { PushTokenStore } from "../../src/push/token-store.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, type CookieJar, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { PW, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Push registrations under `/api/v1/me` (mobile app spec §9.3, plan decisions 3 and 5): sealed
 * tokens that never leave the store, the upsert that moves a token between accounts, the cap per
 * account, and registrations following the session that posted them.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let alice: Account;
let bob: Account;
let admin: Account;
/** Every log record the kernel wrote, as JSON lines. */
const lines: string[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [fakeExtensionEntry("fake-push")],
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("debug", { write: (l) => lines.push(l) }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.audit_events");
  await redis.flushdb();
  admin = await accounts.createLocal({
    login: "admin",
    password: PW,
    displayName: "Admin",
    superAdmin: true,
  });
  alice = await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" });
  bob = await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" });
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type Req = ReturnType<typeof asUser>;

async function signIn(loginName: string, jar: CookieJar = cookieJar()): Promise<Req> {
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: loginName, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

const newToken = () => `fcm-${randomUUID()}-${randomUUID()}`;

const bodyOf = (token: string, over: Record<string, unknown> = {}) => ({
  platform: "android",
  appId: "com.example.app",
  provider: "fake-push",
  token,
  locale: "zh",
  deviceName: "Pixel 9",
  ...over,
});

const post = (req: Req, payload: object) =>
  req({ method: "POST", url: "/api/v1/me/push-registrations", payload });

async function register(req: Req, token: string, over: Record<string, unknown> = {}) {
  const res = await post(req, bodyOf(token, over));
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

type View = { id: string; current: boolean; deviceName: string; lastSeenAt: string };
const list = async (req: Req): Promise<View[]> => {
  const res = await req({ method: "GET", url: "/api/v1/me/push-registrations" });
  expect(res.statusCode).toBe(200);
  return (res.json() as { items: View[] }).items;
};

const rowOf = (id: string) =>
  db.selectFrom("push_registrations").selectAll().where("id", "=", id).executeTakeFirst();

const rowOrThrow = (id: string) =>
  db.selectFrom("push_registrations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const idsOf = async (accountId: string) =>
  (
    await db
      .selectFrom("push_registrations")
      .select("id")
      .where("account_id", "=", accountId)
      .orderBy("id")
      .execute()
  ).map((r) => r.id);

const auditsOf = (action: string) =>
  db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

describe("authentication", () => {
  it("refuses an anonymous caller (401) and a personal token (403 auth.session_required)", async () => {
    const anon = await k.http.inject({
      method: "POST",
      url: "/api/v1/me/push-registrations",
      headers: { "x-capybara-csrf": "1" },
      payload: bodyOf(newToken()),
    });
    expect(anon.statusCode).toBe(401);
    const { token } = await apiTokensFor(db).createPersonal(alice.id, { name: "ci" });
    const headers = { authorization: `Bearer ${token}` };
    for (const [method, url] of [
      ["POST", "/api/v1/me/push-registrations"],
      ["GET", "/api/v1/me/push-registrations"],
      ["DELETE", `/api/v1/me/push-registrations/${randomUUID()}`],
    ] as const) {
      const res = await k.http.inject({
        method,
        url,
        headers,
        ...(method === "POST" && { payload: bodyOf(newToken()) }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errCode(res)).toBe("auth.session_required");
    }
  });
});

describe("POST /api/v1/me/push-registrations", () => {
  it("answers 201 { id }, seals the token, and never shows it in an answer, a log line or the audit", async () => {
    lines.length = 0;
    const req = await signIn("alice");
    const token = newToken();
    const res = await post(req, bodyOf(token));
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json() as object)).toEqual(["id"]);
    const { id } = res.json() as { id: string };
    expect(res.body).not.toContain(token);

    const row = await rowOf(id);
    expect(row).toMatchObject({
      account_id: alice.id,
      platform: "android",
      app_id: "com.example.app",
      provider: "fake-push",
      locale: "zh",
      device_name: "Pixel 9",
      token_hash: PushTokenStore.hash(token),
    });
    expect(row?.session_id).not.toBeNull();
    expect(Buffer.from(row?.token_ciphertext as Uint8Array).includes(Buffer.from(token))).toBe(
      false,
    );
    expect(k.app.get(PushTokenStore).open(row as NonNullable<typeof row>)).toBe(token);

    const listed = await req({ method: "GET", url: "/api/v1/me/push-registrations" });
    expect(listed.body).not.toContain(token);
    expect(listed.json()).toEqual({
      items: [
        {
          id,
          platform: "android",
          appId: "com.example.app",
          provider: "fake-push",
          deviceName: "Pixel 9",
          locale: "zh",
          createdAt: expect.any(String),
          lastSeenAt: expect.any(String),
          current: true,
        },
      ],
    });
    // forAccounts reads rows without opening a token
    const rows = await k.app.get(PushRegistrationsService).forAccounts([alice.id]);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(JSON.stringify(rows)).not.toContain(token);

    const audits = await auditsOf("push.registered");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_account_id: alice.id, target: id });
    expect(audits[0]?.detail).toEqual({
      registrationId: id,
      platform: "android",
      appId: "com.example.app",
      provider: "fake-push",
      deviceName: "Pixel 9",
    });
    expect(JSON.stringify(await db.selectFrom("audit_events").selectAll().execute())).not.toContain(
      token,
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("refuses a provider that is not loaded or does not cover the app id (422 push.provider_unavailable)", async () => {
    lines.length = 0;
    const req = await signIn("alice");
    const token = newToken();
    for (const over of [{ provider: "nope" }, { appId: "com.other" }]) {
      const res = await post(req, bodyOf(token, over));
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe("push.provider_unavailable");
      expect(res.body).not.toContain(token);
    }
    expect(await idsOf(alice.id)).toEqual([]);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("validates the body (400 validation_failed) without echoing the token", async () => {
    const req = await signIn("alice");
    for (const payload of [
      bodyOf("x".repeat(4097)),
      bodyOf(newToken(), { platform: "web" }),
      bodyOf(newToken(), { deviceName: "" }),
      bodyOf(newToken(), { deviceName: "a\u0007b" }),
      bodyOf(newToken(), { appId: ".starts-with-dot" }),
      bodyOf(newToken(), { provider: "Fake-Push" }),
      bodyOf(newToken(), { locale: "fr" }),
      { ...bodyOf(newToken()), extra: 1 },
    ]) {
      const res = await post(req, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
      expect(res.body).not.toContain(payload.token as string);
    }
    // the bounds themselves are accepted
    await register(req, "y".repeat(4096), { deviceName: "d".repeat(64) });
  });

  it("the same token posted again keeps the id, moves last_seen_at and audits once", async () => {
    const req = await signIn("alice");
    const token = newToken();
    const id = await register(req, token);
    await db
      .updateTable("push_registrations")
      .set({ last_seen_at: sql<Date>`now() - interval '3 days'` })
      .where("id", "=", id)
      .execute();
    const before = await rowOrThrow(id);
    expect(
      await register(req, token, { platform: "ios", locale: "en", deviceName: "Pixel 10" }),
    ).toBe(id);
    const after = await rowOrThrow(id);
    expect(after.last_seen_at.getTime()).toBeGreaterThan(before.last_seen_at.getTime());
    expect(after).toMatchObject({ platform: "ios", locale: "en", device_name: "Pixel 10" });
    // the sealed token still opens under the same id
    expect(k.app.get(PushTokenStore).open(after)).toBe(token);
    expect(await auditsOf("push.registered")).toHaveLength(1);
  });

  it("account B posting A's token takes the registration: A no longer lists it, B lists it as current", async () => {
    const a = await signIn("alice");
    const b = await signIn("bob");
    const token = newToken();
    const id = await register(a, token);
    expect((await list(a)).map((v) => v.id)).toEqual([id]);

    expect(await register(b, token, { deviceName: "Bob's phone" })).toBe(id);
    expect(await list(a)).toEqual([]);
    const seen = await list(b);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, current: true, deviceName: "Bob's phone" });
    const row = await rowOf(id);
    expect(row?.account_id).toBe(bob.id);
    const bobSession = await db
      .selectFrom("sessions")
      .select("id")
      .where("account_id", "=", bob.id)
      .executeTakeFirstOrThrow();
    expect(row?.session_id).toBe(bobSession.id);
    expect(k.app.get(PushTokenStore).open(row as NonNullable<typeof row>)).toBe(token);
    // A's events no longer reach the phone
    const svc = k.app.get(PushRegistrationsService);
    expect(await svc.forAccounts([alice.id])).toEqual([]);
    expect((await svc.forAccounts([bob.id])).map((r) => r.id)).toEqual([id]);
    // the reassignment is audited for B
    const audits = await auditsOf("push.registered");
    expect(audits.map((x) => x.actor_account_id)).toEqual([alice.id, bob.id]);
  });

  it("a registration from another session of the same account is listed but not current", async () => {
    const one = await signIn("alice");
    const two = await signIn("alice");
    const first = await register(one, newToken(), { deviceName: "One" });
    const second = await register(two, newToken(), { deviceName: "Two" });
    const seen = await list(one);
    // newest last_seen_at first
    expect(seen.map((v) => [v.id, v.current])).toEqual([
      [second, false],
      [first, true],
    ]);
  });

  it("the 21st registration of an account deletes the least recently seen", async () => {
    const req = await signIn("alice");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await register(req, newToken()));
    const oldest = ids[7] as string;
    await db
      .updateTable("push_registrations")
      .set({ last_seen_at: sql<Date>`now() - interval '10 days'` })
      .where("id", "=", oldest)
      .execute();
    const newest = await register(req, newToken());
    const left = await idsOf(alice.id);
    expect(left).toHaveLength(20);
    expect(left).not.toContain(oldest);
    expect(left).toContain(newest);
  });
});

describe("eviction under concurrent locks", () => {
  it("skips a row another transaction holds instead of waiting for it", async () => {
    const req = await signIn("alice");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await register(req, newToken()));
    const held = ids[3] as string;
    await db
      .updateTable("push_registrations")
      .set({ last_seen_at: sql<Date>`now() - interval '10 days'` })
      .where("id", "=", held)
      .execute();
    // another transaction (a revoke deleting it, say) holds the least recently seen row
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = raw.transaction().execute(async (t) => {
      await sql`select id from capybara.push_registrations where id = ${held} for update`.execute(
        t,
      );
      locked();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await isLocked;
    try {
      // answers without waiting for the holder; the held row is not evicted and not counted
      await register(req, newToken());
    } finally {
      release();
      await holder;
    }
    const left = await idsOf(alice.id);
    expect(left).toContain(held);
    expect(left).toHaveLength(21);
  });
});

describe("DELETE /api/v1/me/push-registrations/:id", () => {
  it("another account's id is 404 push.registration_not_found; the owner's is 204 and audited", async () => {
    const a = await signIn("alice");
    const b = await signIn("bob");
    const id = await register(b, newToken());
    const foreign = await a({ method: "DELETE", url: `/api/v1/me/push-registrations/${id}` });
    expect(foreign.statusCode).toBe(404);
    expect(errCode(foreign)).toBe("push.registration_not_found");
    const missing = await a({
      method: "DELETE",
      url: `/api/v1/me/push-registrations/${randomUUID()}`,
    });
    expect(errCode(missing)).toBe("push.registration_not_found");
    expect(await rowOf(id)).toBeDefined();

    const own = await b({ method: "DELETE", url: `/api/v1/me/push-registrations/${id}` });
    expect(own.statusCode).toBe(204);
    expect(await rowOf(id)).toBeUndefined();
    const audits = await auditsOf("push.unregistered");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_account_id: bob.id, target: id });
    expect(audits[0]?.detail).toEqual({ registrationId: id, reason: "person" });
  });
});

describe("registrations follow their session", () => {
  it("logout deletes the registrations of that session only", async () => {
    const one = await signIn("alice");
    const two = await signIn("alice");
    const gone = await register(one, newToken());
    const kept = await register(two, newToken());
    expect((await one({ method: "POST", url: "/api/v1/auth/logout" })).statusCode).toBe(204);
    expect(await idsOf(alice.id)).toEqual([kept]);
    expect(await rowOf(gone)).toBeUndefined();
    // revocation writes no person audit entry
    expect(await auditsOf("push.unregistered")).toEqual([]);
  });

  it("a password change deletes the other sessions' registrations and keeps the current one's", async () => {
    const one = await signIn("alice");
    const two = await signIn("alice");
    const kept = await register(one, newToken());
    await register(two, newToken());
    await register(two, newToken());
    const res = await one({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: { currentPassword: PW, newPassword: "another long password" },
    });
    expect(res.statusCode).toBe(204);
    expect(await idsOf(alice.id)).toEqual([kept]);
  });

  it("disabling the account deletes all its registrations; deleting the account cascades", async () => {
    const one = await signIn("alice");
    const two = await signIn("alice");
    await register(one, newToken());
    await register(two, newToken());
    const b = await signIn("bob");
    const bobs = await register(b, newToken());
    const su = await signIn("admin");
    const res = await su({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${alice.id}`,
      payload: { status: "disabled" },
    });
    expect(res.statusCode).toBe(200);
    expect(await idsOf(alice.id)).toEqual([]);

    await db.deleteFrom("accounts").where("id", "=", bob.id).execute();
    expect(await rowOf(bobs)).toBeUndefined();
    expect(admin.id).toBeDefined();
  });

  it("removing a person from an org revokes their sessions and deletes their registrations", async () => {
    const owner = await signIn("alice");
    const org = await owner({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
    expect(org.statusCode).toBe(201);
    const orgId = (org.json() as { org: { id: string } }).org.id;
    await db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: bob.id, role: "member" })
      .execute();
    const b = await signIn("bob");
    await register(b, newToken());
    const kept = await register(owner, newToken());
    const res = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${bob.id}` });
    expect(res.statusCode).toBe(204);
    expect(await idsOf(bob.id)).toEqual([]);
    expect(await idsOf(alice.id)).toEqual([kept]);
  });

  it("a revoked session cannot register, even past the auth guard (the row is locked and re-read)", async () => {
    await signIn("alice");
    const sid = (
      await db
        .selectFrom("sessions")
        .select("id")
        .where("account_id", "=", alice.id)
        .executeTakeFirstOrThrow()
    ).id;
    // revoked between the guard's check and the write: the service re-reads the session row
    await db
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", sid)
      .execute();
    const svc = k.app.get(PushRegistrationsService);
    await expect(
      svc.register(alice.id, sid, bodyOf(newToken()) as Parameters<typeof svc.register>[2]),
    ).rejects.toMatchObject({ code: "auth.session_revoked" });
    expect(await idsOf(alice.id)).toEqual([]);
  });
});
