import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { PushPreferencesService } from "../../src/push/preferences.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { PW, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Push preferences under `/api/v1/me` (mobile app spec §9.4): four category switches, on unless
 * switched off, readable and writable with a session or a personal token, and through the
 * Platform tool as the person's own personal write.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let accounts: AccountsService;
let alice: Account;
let bob: Account;

const ALL_ON = { waiting: true, replies: true, tasks: true, schedules: true };

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  accounts = accountsFor(db);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts");
  alice = await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" });
  bob = await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" });
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

async function signIn(loginName: string) {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: loginName, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

const URL = "/api/v1/me/push-preferences";

const ctxOf = (accountId: string): OperationContext => ({
  orgId: randomUUID(),
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

describe("GET / PUT /api/v1/me/push-preferences", () => {
  it("answers every category on by default", async () => {
    const req = await signIn("alice");
    const res = await req({ method: "GET", url: URL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ALL_ON);
  });

  it("a partial PUT switches one category and answers the full object; it persists", async () => {
    const req = await signIn("alice");
    const res = await req({ method: "PUT", url: URL, payload: { replies: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...ALL_ON, replies: false });
    expect((await req({ method: "GET", url: URL })).json()).toEqual({ ...ALL_ON, replies: false });
    // switched back on
    await req({ method: "PUT", url: URL, payload: { replies: true, tasks: false } });
    expect((await req({ method: "GET", url: URL })).json()).toEqual({ ...ALL_ON, tasks: false });
    // only the caller's own switches
    expect(await k.app.get(PushPreferencesService).get(bob.id)).toEqual(ALL_ON);
  });

  it("refuses an empty, unknown or non-boolean body (400 validation_failed)", async () => {
    const req = await signIn("alice");
    for (const payload of [{}, { other: true }, { replies: "no" }, { replies: null }]) {
      const res = await req({ method: "PUT", url: URL, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
  });

  it("accepts a personal token for both routes", async () => {
    const { token } = await apiTokensFor(db).createPersonal(alice.id, { name: "ci" });
    const headers = { authorization: `Bearer ${token}` };
    const put = await k.http.inject({
      method: "PUT",
      url: URL,
      headers,
      payload: { schedules: false },
    });
    expect(put.statusCode).toBe(200);
    const get = await k.http.inject({ method: "GET", url: URL, headers });
    expect(get.json()).toEqual({ ...ALL_ON, schedules: false });
    expect((await k.http.inject({ method: "GET", url: URL })).statusCode).toBe(401);
  });

  it("enabledFor omits the accounts that switched the category off", async () => {
    const svc = k.app.get(PushPreferencesService);
    await svc.set(alice.id, { replies: false });
    expect([...(await svc.enabledFor([alice.id, bob.id], "replies"))]).toEqual([bob.id]);
    expect([...(await svc.enabledFor([alice.id, bob.id], "waiting"))].sort()).toEqual(
      [alice.id, bob.id].sort(),
    );
    expect([...(await svc.enabledFor([], "tasks"))]).toEqual([]);
  });
});

describe("Platform operations", () => {
  it("platform.push-preferences reads the actor's switches", async () => {
    const o = op("platform.push-preferences");
    expect(o.confirm).toBe("read");
    expect(o.mirrors).toEqual(["GET /api/v1/me/push-preferences"]);
    await k.app.get(PushPreferencesService).set(alice.id, { waiting: false });
    expect(await o.run(o.input.parse({}), ctxOf(alice.id))).toEqual({ ...ALL_ON, waiting: false });
  });

  it("platform.set-push-preferences asks once (personal, rememberable), names each switch and writes", async () => {
    const o = op("platform.set-push-preferences");
    expect(o.confirm).toBe("personal");
    expect(o.rememberable).toBeUndefined();
    expect(o.mirrors).toEqual(["PUT /api/v1/me/push-preferences"]);
    expect(o.input.safeParse({}).success).toBe(false);
    expect(o.input.safeParse({ replies: false, extra: 1 }).success).toBe(false);
    const input = o.input.parse({ replies: false, schedules: true });
    const c = ctxOf(alice.id);
    expect(await o.summary?.(input, c)).toEqual({
      zh: "关闭「智能体回复」通知；开启「定时任务」通知",
      en: 'Turn off "Agent replies" notifications; Turn on "Scheduled tasks" notifications',
    });
    expect(await o.run(input, c)).toEqual({ ...ALL_ON, replies: false });
    expect(await k.app.get(PushPreferencesService).get(alice.id)).toEqual({
      ...ALL_ON,
      replies: false,
    });
    expect(await k.app.get(PushPreferencesService).get(bob.id)).toEqual(ALL_ON);
  });
});
