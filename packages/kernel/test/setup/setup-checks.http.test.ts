import { randomUUID } from "node:crypto";
import {
  type FakeChannelServer,
  fakeExtensionEntry,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { REDIS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { SETUP_CHECK_TIMEOUT } from "../../src/setup/setup-checks.service.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { seedFakeImGuideItem } from "../helpers/setup-guides.js";

// Setup guide checks (spec 2026-11-09-setup-guides-v2-design.md §10, plan task 10): the routes
// read cached states and run one check of the rendered guide through fake-im's fixture checks,
// with the cache, the cooldown, the time limit, redaction (response, Redis, logs), the kernel's
// reasons, authorization and the rate limit.

const FAKE_IM = fakeExtensionEntry("fake-im");
const SECRET = "app-secret-7d1e9b40c2";
const DEPLOY_SECRET = "deploy-client-secret-58a2";
/** 8 characters: redacted, and `[REDACTED]` (10) pushes a 300-character reason over the limit. */
const SHORT_TOKEN = "tok-1234";
const TIMEOUT_MS = 300;

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let im: FakeChannelServer;
let owner: Req;
let member: Req;
let stranger: Req;
let orgId: string;
let otherOrgId: string;
let agentId: string;
let itemId: string;
let ownerId: string;
let memberId: string;
const lines: string[] = [];

type State = {
  status: string;
  reason?: { en: string; zh?: string };
  fix?: { en: string; zh?: string };
  checkedAt?: string;
  cooldownUntil?: string;
};

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        // no gateway: connections hold no long connection here
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, FAKE_IM],
        extensionConfig: {
          "fake-im": { platformUrl: im.url, clientId: "c1", clientSecret: DEPLOY_SECRET },
        },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
      },
    ),
    {
      env: {},
      logger: createLogger("warn", { write: (l) => lines.push(l) }),
      overrides: [{ provide: SETUP_CHECK_TIMEOUT, useValue: TIMEOUT_MS }],
    },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  const accounts = accountsFor(db);
  const o = await accounts.createLocal({ login: "owner", password: PW, displayName: "O" });
  ownerId = o.id;
  const m = await accounts.createLocal({ login: "member", password: PW, displayName: "M" });
  memberId = m.id;
  await accounts.createLocal({ login: "stranger", password: PW, displayName: "S" });
  owner = await session(k, "owner");
  member = await session(k, "member");
  stranger = await session(k, "stranger");
  orgId = await createOrg(owner);
  otherOrgId = await createOrg(stranger, "Globex");
  agentId = await createAgent(owner, orgId);
  await testMembers(db).add(orgId, m.id, "member", o.id);
  for (const [req, org] of [
    [owner, orgId],
    [stranger, otherOrgId],
  ] as const) {
    const en = await req({
      method: "PUT",
      url: `/api/v1/orgs/${org}/extensions/fake-im`,
      payload: { enabled: true, config: { url: im.book(org).url } },
    });
    expect(en.statusCode, en.body).toBe(200);
  }
  itemId = await seedFakeImGuideItem(db);
});

afterAll(async () => {
  await k?.close();
  await im?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  // every test starts with an empty check cache and a fresh rate limit
  const keys = [
    ...(await redis.keys("capk:setup-check*")),
    ...(await redis.keys("throttler:*setup-check")),
    ...(await redis.keys("capk:setup-check-rate:*")),
  ];
  if (keys.length > 0) await redis.del(...keys);
  im.checks.length = 0;
  lines.length = 0;
});

/** Creates a channel connection through the API (fake-im verifies it); returns its id. */
async function connection(
  o: { req?: Req; org?: string; webhookToken?: string; agent?: string } = {},
): Promise<string> {
  const r = await (o.req ?? owner)({
    method: "POST",
    url: `/api/v1/orgs/${o.org ?? orgId}/channels`,
    payload: {
      plugin: "fake-im",
      name: "Bot",
      agentId: o.agent ?? agentId,
      config: {
        platformUrl: im.url,
        appId: "cli_checks",
        appSecret: SECRET,
        ...(o.webhookToken !== undefined && { webhookToken: o.webhookToken }),
      },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { channel: { id: string } }).channel.id;
}

const guideBase = (org = orgId) => `/api/v1/orgs/${org}/catalog/${itemId}/guides/fake-im-app`;

async function states(
  connectionId: string | undefined,
  o: { req?: Req; mode?: string } = {},
): Promise<{ statusCode: number; body: string; json(): unknown }> {
  const q = new URLSearchParams();
  if (connectionId !== undefined) q.set("connectionId", connectionId);
  if (o.mode !== undefined) q.set("mode", o.mode);
  return (o.req ?? owner)({ method: "GET", url: `${guideBase()}/checks?${q}` });
}

const run = (
  checkId: string,
  body: Record<string, unknown>,
  req: Req = owner,
): Promise<{ statusCode: number; body: string; json(): unknown }> =>
  req({ method: "POST", url: `${guideBase()}/checks/${checkId}/run`, payload: body });

async function runOk(checkId: string, body: Record<string, unknown>): Promise<State> {
  const r = await run(checkId, body);
  expect(r.statusCode, r.body).toBe(200);
  const result = (r.json() as { result: State }).result;
  // only the fixed fields leave the kernel
  for (const key of Object.keys(result)) {
    expect(["status", "reason", "fix", "checkedAt", "cooldownUntil"]).toContain(key);
  }
  return result;
}

/** Every cached check value in Redis, as text. */
async function cachedValues(): Promise<string> {
  const keys = (await redis.keys("capk:setup-check:*")).filter((key) => !key.endsWith(":cooldown"));
  return keys.length === 0 ? "" : (await redis.mget(...keys)).join("\n");
}

describe("setup checks: reading and running", () => {
  it("GET checks never runs and answers not_run for every check of the rendered guide", async () => {
    const id = await connection();
    const r = await states(id);
    expect(r.statusCode, r.body).toBe(200);
    const results = (r.json() as { results: Record<string, State> }).results;
    expect(Object.keys(results).sort()).toEqual(
      [
        "echo-secret",
        "hang",
        "ignore-signal",
        "long",
        "missing",
        "pad-to-limit",
        "pass",
        "proxy",
        "throw",
      ].sort(),
    );
    expect(Object.values(results).every((s) => s.status === "not_run")).toBe(true);
    // the webhook mode has its own checks
    const w = await states(id, { mode: "webhook" });
    expect(Object.keys((w.json() as { results: object }).results)).toEqual(["fail"]);
    expect(im.checks).toHaveLength(0);
  });

  it("run returns ok and caches: a second run without force makes no call", async () => {
    const id = await connection();
    const first = await runOk("proxy", { connectionId: id });
    expect(first).toMatchObject({ status: "ok", reason: { en: "The fake platform answered." } });
    expect(first.checkedAt).toBeDefined();
    expect(first.cooldownUntil).toBeDefined();
    const second = await runOk("proxy", { connectionId: id });
    expect(second.status).toBe("ok");
    expect(second.checkedAt).toBe(first.checkedAt);
    expect(im.checks).toHaveLength(1);
    expect(im.checks[0]).toMatchObject({ check: "proxy", connectionId: id, pid: process.pid });
    // the cached state is what GET answers now
    const r = (await states(id)).json() as { results: Record<string, State> };
    expect(r.results.proxy).toMatchObject({ status: "ok", checkedAt: first.checkedAt });
    expect(r.results.pass?.status).toBe("not_run");
    // a failing check carries its reason and fix
    const fail = await runOk("fail", { connectionId: id, mode: "webhook" });
    expect(fail).toMatchObject({
      status: "failing",
      reason: { en: "The fake platform refused the app." },
      fix: { en: "Create the app again and copy the new secret." },
    });
  });

  it("config change invalidates the cache", async () => {
    const id = await connection();
    await runOk("proxy", { connectionId: id });
    const p = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${id}`,
      payload: {
        config: { platformUrl: im.url, appId: "cli_checks", appSecret: `${SECRET}-rotated` },
      },
    });
    expect(p.statusCode, p.body).toBe(200);
    expect(
      ((await states(id)).json() as { results: Record<string, State> }).results.proxy?.status,
    ).toBe("not_run");
    await runOk("proxy", { connectionId: id });
    expect(im.checks).toHaveLength(2);
  });

  it("force respects the 10 s cooldown", async () => {
    const id = await connection();
    const first = await runOk("proxy", { connectionId: id });
    const forced = await runOk("proxy", { connectionId: id, force: true });
    expect(forced.status).toBe("ok");
    expect(forced.checkedAt).toBe(first.checkedAt);
    expect(Date.parse(forced.cooldownUntil ?? "")).toBeGreaterThan(Date.now());
    expect(im.checks).toHaveLength(1);
    // once the cooldown is gone, force reruns
    await redis.del(...(await redis.keys("capk:setup-check:*:cooldown")));
    await runOk("proxy", { connectionId: id, force: true });
    expect(im.checks).toHaveLength(2);
  });

  it('timeout yields unknown "The check timed out", also for a check that ignores its signal', async () => {
    const id = await connection();
    for (const check of ["hang", "ignore-signal"]) {
      const started = Date.now();
      const s = await runOk(check, { connectionId: id });
      expect(s).toMatchObject({ status: "unknown", reason: { en: "The check timed out." } });
      expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 3_000);
    }
    // the lock was released: running again does not answer running
    const again = await runOk("hang", { connectionId: id, force: true });
    expect(again.status).toBe("unknown");
    expect(lines.some((l) => l.includes("setup check timed out"))).toBe(true);
  });

  it("throw / invalid result yield unknown and log redacted", async () => {
    const id = await connection();
    const thrown = await runOk("throw", { connectionId: id });
    expect(thrown).toMatchObject({
      status: "unknown",
      reason: { en: "The check failed to run; retry later." },
    });
    const long = await runOk("long", { connectionId: id });
    expect(long.status).toBe("unknown");
    expect(long.reason?.en).toMatch(/invalid result/);
    const failed = lines.find((l) => l.includes("setup check failed"));
    expect(failed).toBeDefined();
    expect(failed).toContain("[REDACTED]");
    expect(lines.some((l) => l.includes("setup check result invalid"))).toBe(true);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("redacts target secrets from results, cache and logs", async () => {
    const id = await connection();
    const r = await run("echo-secret", { connectionId: id });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(SECRET);
    const s = (r.json() as { result: State }).result;
    expect(s).toMatchObject({
      status: "failing",
      reason: { en: "The platform refused [REDACTED].", zh: "平台拒绝了 [REDACTED]。" },
      fix: { en: "Replace [REDACTED] with a new secret (login client [REDACTED])." },
    });
    expect(r.body).not.toContain(DEPLOY_SECRET);
    const cached = await cachedValues();
    expect(cached).toContain("[REDACTED]");
    expect(cached).not.toContain(SECRET);
    expect(cached).not.toContain(DEPLOY_SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("a reason at the limit that redaction lengthens is invalid (pad-to-limit)", async () => {
    const id = await connection({ webhookToken: SHORT_TOKEN });
    const r = await run("pad-to-limit", { connectionId: id });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(SHORT_TOKEN);
    expect((r.json() as { result: State }).result.status).toBe("unknown");
    expect(lines.some((l) => l.includes("invalid after redaction"))).toBe(true);
    expect(await cachedValues()).not.toContain(SHORT_TOKEN);
    expect(lines.join("\n")).not.toContain(SHORT_TOKEN);
  });

  it("extension disabled in org / needsConfig / unregistered id yield unknown with the kernel reason", async () => {
    const id = await connection();
    const missing = await runOk("missing", { connectionId: id });
    expect(missing).toEqual({
      status: "unknown",
      reason: {
        en: "This check needs a newer version of the plugin.",
        zh: "这项检查需要更新版本的插件。",
      },
    });
    // not loaded on this replica: that, not "a newer version", is the reason
    const registry = k.app.get(ExtensionRegistry);
    const current = registry.current.bind(registry);
    const unloaded = vi
      .spyOn(registry, "current")
      .mockImplementation((name: string) => (name === "fake-im" ? undefined : current(name)));
    try {
      for (const check of ["missing", "proxy"]) {
        const s = await runOk(check, { connectionId: id });
        expect(s.status).toBe("unknown");
        expect(s.reason?.en).toBe(
          "The fake-im plugin is not running on this server right now; retry later.",
        );
      }
    } finally {
      unloaded.mockRestore();
    }
    const spy = vi
      .spyOn(k.app.get(EffectiveConfigs), "get")
      .mockResolvedValue({ ok: false, issues: [] });
    try {
      const needs = await runOk("proxy", { connectionId: id });
      expect(needs.status).toBe("unknown");
      expect(needs.reason?.en).toMatch(/needs configuration in this organization/);
    } finally {
      spy.mockRestore();
    }
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-im`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    try {
      const disabled = await runOk("proxy", { connectionId: id });
      expect(disabled.status).toBe("unknown");
      expect(disabled.reason?.en).toMatch(/not enabled in this organization/);
    } finally {
      const on = await owner({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/fake-im`,
        payload: { enabled: true, config: { url: im.book(orgId).url } },
      });
      expect(on.statusCode, on.body).toBe(200);
    }
    expect(im.checks).toHaveLength(0);
    // kernel answers are not cached
    expect(await cachedValues()).toBe("");
  });

  it("check not in the guide for this mode -> 404; no target -> 400; member -> 403; another org's connection -> 404", async () => {
    const id = await connection();
    const notIn = await run("fail", { connectionId: id, mode: "long_connection" });
    expect(notIn.statusCode).toBe(404);
    expect(errCode(notIn)).toBe("catalog.check_not_found");
    const unknownId = await run("nope", { connectionId: id });
    expect(errCode(unknownId)).toBe("catalog.check_not_found");
    const noTarget = await run("pass", {});
    expect(noTarget.statusCode).toBe(400);
    expect(errCode(noTarget)).toBe("validation_failed");
    expect(noTarget.body).toContain("checks need a saved connection");
    const noTargetGet = await states(undefined);
    expect(noTargetGet.statusCode).toBe(400);
    const asMember = await run("pass", { connectionId: id }, member);
    expect(asMember.statusCode).toBe(403);
    expect((await states(id, { req: member })).statusCode).toBe(403);
    const otherAgent = await createAgent(stranger, otherOrgId);
    const theirs = await connection({ req: stranger, org: otherOrgId, agent: otherAgent });
    const cross = await run("proxy", { connectionId: theirs });
    expect(cross.statusCode).toBe(404);
    expect(errCode(cross)).toBe("channel.not_found");
    expect((await states(theirs)).statusCode).toBe(404);
    // nobody outside the org reaches this org's guide
    const outsider = await stranger({
      method: "POST",
      url: `${guideBase()}/checks/pass/run`,
      payload: { connectionId: id },
    });
    expect(outsider.statusCode).toBe(404);
    expect(im.checks).toHaveLength(0);
  });

  it("throttle: the 31st run in a minute is 429", async () => {
    const id = await connection();
    for (let i = 0; i < 30; i++) {
      const r = await run("pass", { connectionId: id });
      expect(r.statusCode, r.body).toBe(200);
    }
    const over = await run("pass", { connectionId: id });
    expect(over.statusCode).toBe(429);
    expect(errCode(over)).toBe("rate_limited");
    // reading the states is not limited
    expect((await states(id)).statusCode).toBe(200);
  });

  it('Redis down: run answers unknown "checks are temporarily unavailable"; the guide still renders', async () => {
    const id = await connection();
    const client = k.app.get<Redis>(REDIS);
    const realGet = client.get.bind(client);
    const realMget = client.mget.bind(client);
    const down = () => Promise.reject(new Error("Connection is closed."));
    const getSpy = vi
      .spyOn(client, "get")
      .mockImplementation(((key: string) =>
        key.startsWith("capk:setup-check") ? down() : realGet(key)) as never);
    const mgetSpy = vi
      .spyOn(client, "mget")
      .mockImplementation(((...keys: string[]) =>
        keys.some((key) => String(key).startsWith("capk:setup-check"))
          ? down()
          : realMget(...keys)) as never);
    try {
      const s = await runOk("proxy", { connectionId: id });
      expect(s).toMatchObject({
        status: "unknown",
        reason: { en: "Checks are temporarily unavailable; retry later." },
      });
      const r = (await states(id)).json() as { results: Record<string, State> };
      expect(r.results.proxy?.reason?.en).toBe("Checks are temporarily unavailable; retry later.");
      const guide = await owner({ method: "GET", url: `${guideBase()}?connectionId=${id}` });
      expect(guide.statusCode, guide.body).toBe(200);
    } finally {
      getSpy.mockRestore();
      mgetSpy.mockRestore();
    }
    expect(im.checks).toHaveLength(0);
  });

  it("a crashed replica's semaphore slots free themselves; eight live ones answer running", async () => {
    const id = await connection();
    const slots = `capk:setup-check-org:${orgId}`;
    // eight holders whose slots expired (a replica that died mid-run): pruned on the next take
    const past = Date.now() - 1_000;
    await redis.zadd(slots, ...Array.from({ length: 8 }, (_, i) => [past, `dead-${i}`]).flat());
    await redis.pexpire(slots, 60_000);
    expect((await runOk("proxy", { connectionId: id })).status).toBe("ok");
    // eight live holders: the run is refused (running) and nothing is called
    const future = Date.now() + 60_000;
    await redis.zadd(slots, ...Array.from({ length: 8 }, (_, i) => [future, `live-${i}`]).flat());
    expect((await runOk("pass", { connectionId: id })).status).toBe("running");
    expect(im.checks).toHaveLength(1);
    await redis.del(slots);
  });

  it("org config secrets cannot be read: the check is not run (fail closed)", async () => {
    const id = await connection();
    const spy = vi
      .spyOn(k.app.get(OrgExtensionConfigs), "get")
      .mockRejectedValue(new Error("decrypt failed"));
    try {
      const s = await runOk("proxy", { connectionId: id });
      expect(s).toMatchObject({
        status: "unknown",
        reason: { en: "Checks are temporarily unavailable; retry later." },
      });
    } finally {
      spy.mockRestore();
    }
    expect(im.checks).toHaveLength(0);
    expect(await cachedValues()).toBe("");
  });

  it("a platform deployment config change invalidates the cache (the loaded config hash)", async () => {
    const id = await connection();
    await runOk("proxy", { connectionId: id });
    const registry = k.app.get(ExtensionRegistry);
    const current = registry.current.bind(registry);
    const spy = vi.spyOn(registry, "current").mockImplementation((name: string) => {
      const inst = current(name);
      if (name !== "fake-im" || inst === undefined) return inst;
      return new Proxy(inst, {
        get: (t, prop) => (prop === "configHash" ? "changed-config-hash" : Reflect.get(t, prop, t)),
      });
    });
    try {
      const r = (await states(id)).json() as { results: Record<string, State> };
      expect(r.results.proxy?.status).toBe("not_run");
      await runOk("proxy", { connectionId: id });
    } finally {
      spy.mockRestore();
    }
    expect(im.checks).toHaveLength(2);
  });
});

describe("setup checks: Platform operations", () => {
  const ctxOf = (accountId: string): OperationContext => ({
    orgId,
    actorAccountId: accountId,
    agentId,
    conversationId: randomUUID(),
    runId: randomUUID(),
    signal: new AbortController().signal,
  });
  const op = (id: string) => {
    const o = k.app.get(PlatformOperations).get(id);
    if (o === null) throw new Error(`no operation ${id}`);
    return o;
  };
  const callOp = (id: string, input: unknown, accountId = ownerId) => {
    const o = op(id);
    return o.run(o.input.parse(input), ctxOf(accountId)) as Promise<Record<string, unknown>>;
  };
  const base = () => ({ itemId, guideId: "fake-im-app" });

  it("setup.status and setup.check are read-class and return only the fixed, redacted fields", async () => {
    expect(op("setup.status").confirm).toBe("read");
    expect(op("setup.check").confirm).toBe("read");
    const id = await connection();
    const out = await callOp("setup.check", {
      ...base(),
      checkId: "echo-secret",
      connectionId: id,
    });
    expect(Object.keys(out)).toEqual(["result"]);
    const result = out.result as State;
    for (const key of Object.keys(result)) {
      expect(["status", "reason", "fix", "checkedAt", "cooldownUntil"]).toContain(key);
    }
    expect(result.status).toBe("failing");
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(DEPLOY_SECRET);
    const st = await callOp("setup.status", { ...base(), connectionId: id });
    expect(Object.keys(st)).toEqual(["results"]);
    const echo = (st.results as Record<string, State>)["echo-secret"];
    expect(echo?.status).toBe("failing");
    expect(JSON.stringify(st)).not.toContain(SECRET);
  });

  it("setup.check shares the 30 runs a minute per account with the HTTP route", async () => {
    const id = await connection();
    for (let i = 0; i < 30; i++) {
      const out = await callOp("setup.check", { ...base(), checkId: "pass", connectionId: id });
      expect((out.result as State).status).toBe("ok");
    }
    await expect(
      callOp("setup.check", { ...base(), checkId: "pass", connectionId: id }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // the HTTP route counts against the same budget
    const over = await run("pass", { connectionId: id });
    expect(over.statusCode).toBe(429);
    expect(errCode(over)).toBe("rate_limited");
    // reading the states is not limited
    expect(Object.keys(await callOp("setup.status", { ...base(), connectionId: id }))).toEqual([
      "results",
    ]);
  });

  it("HTTP runs count against setup.check: 30 HTTP runs leave no Platform run", async () => {
    const id = await connection();
    for (let i = 0; i < 30; i++) {
      const r = await run("pass", { connectionId: id });
      expect(r.statusCode, r.body).toBe(200);
    }
    await expect(
      callOp("setup.check", { ...base(), checkId: "pass", connectionId: id }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("the per-account counter is a Redis key with a TTL, keyed by the account", async () => {
    const id = await connection();
    await callOp("setup.check", { ...base(), checkId: "pass", connectionId: id });
    const keys = await redis.keys("capk:setup-check-rate:*");
    expect(keys).toEqual([`capk:setup-check-rate:${ownerId}`]);
    const ttl = await redis.pttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it("setup.guides lists the channel guide with its connections, check counts and pages", async () => {
    expect(op("setup.guides").confirm).toBe("read");
    const id = await connection();
    await callOp("setup.check", { ...base(), checkId: "pass", connectionId: id });
    const out = await callOp("setup.guides", {});
    const guides = out.guides as {
      itemId: string;
      guideId: string;
      place: string;
      audience: string;
      title: string;
      targets: {
        kind: string;
        id: string;
        drift: unknown;
        checks: Record<string, number> | null;
        webPath: string;
      }[];
    }[];
    expect(guides).toHaveLength(1);
    const g = guides[0];
    expect(g).toMatchObject({
      itemId,
      guideId: "fake-im-app",
      place: "channel-connection",
      audience: "admin",
      title: "Create the fake IM app",
    });
    const t = g?.targets.find((x) => x.id === id);
    expect(t).toMatchObject({
      kind: "channel-connection",
      drift: null,
      webPath: `/channels/${id}`,
    });
    // the long connection mode has nine checks; `pass` ran
    expect(t?.checks).toEqual({ ok: 1, failing: 0, unknown: 0, running: 0, notRun: 8 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // the HTTP route answers the same list
    const r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/setup-guides` });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { guides: unknown[] }).guides).toEqual(guides);
  });

  it("setup.guides shows a member no channel guide (only org admins set channels up)", async () => {
    await connection();
    expect(await callOp("setup.guides", {}, memberId)).toEqual({ guides: [] });
    const r = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/setup-guides` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ guides: [] });
  });

  it("setup.read returns the guide as Markdown with check lines, the page and no secret", async () => {
    expect(op("setup.read").confirm).toBe("read");
    const id = await connection();
    const out = await callOp("setup.read", { ...base(), connectionId: id });
    const guide = out.guide as {
      markdown: string;
      mode: string | null;
      modes: string[];
      checks: { id: string }[];
      target: unknown;
      webPath: string;
      handover: string;
    };
    expect(guide.markdown.startsWith("# Create the fake IM app\n")).toBe(true);
    expect(guide.markdown).toContain("```yaml\nsocket: true\n```");
    expect(guide.markdown).toContain("- [check pass] The platform accepts the app");
    expect(guide.markdown).not.toContain("webhook: true");
    expect(guide.mode).toBe("long_connection");
    expect(guide.modes).toEqual(["long_connection", "webhook"]);
    expect(guide.target).toEqual({ kind: "channel-connection", id });
    expect(guide.webPath).toBe(`/channels/${id}`);
    expect(guide.handover).toContain(`/channels/${id}`);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(DEPLOY_SECRET);
    const webhook = await callOp("setup.read", { ...base(), connectionId: id, mode: "webhook" });
    expect((webhook.guide as { markdown: string }).markdown).toContain(
      "- [check fail] The platform refuses the app",
    );
    // a member may not read the admin guide
    await expect(
      callOp("setup.read", { ...base(), connectionId: id }, memberId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("setup.guides and setup.read stay inside the org", async () => {
    const mine = await connection();
    const otherAgent = await createAgent(stranger, otherOrgId);
    const theirs = await connection({ req: stranger, org: otherOrgId, agent: otherAgent });
    const out = await callOp("setup.guides", {});
    const ids = (out.guides as { targets: { id: string }[] }[]).flatMap((g) =>
      g.targets.map((t) => t.id),
    );
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    // another org's connection is not found, not rendered
    await expect(callOp("setup.read", { ...base(), connectionId: theirs })).rejects.toMatchObject({
      code: "channel.not_found",
    });
    // the other org's admin lists only their own connections, over HTTP too
    const r = await stranger({ method: "GET", url: `/api/v1/orgs/${otherOrgId}/setup-guides` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain(mine);
    expect(r.body).toContain(theirs);
    // and nobody outside the org lists its guides
    const outsider = await stranger({ method: "GET", url: `/api/v1/orgs/${orgId}/setup-guides` });
    expect(outsider.statusCode).toBe(404);
  });
});
