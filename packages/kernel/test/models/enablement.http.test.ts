import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { ModelPurposesService } from "../../src/models/purposes.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE, MODEL_FAKE_B } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Model platform spec B §5.3: models disabled by the platform (super admin) and by an org (org
 * admin). A disabled model leaves the org's model list, agent save and the switch plan refuse it,
 * a run whose model was disabled after the agent was saved falls back (or ends
 * `run.model_unavailable`), and the write lists the agents and purposes still pointing at it.
 * Chat callers never resolve an embedding model. An `@1` provider is not usable in an org with its
 * own config copy, and a copy's list failure does not mark the platform's list as failed.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

const FAKE_1 = { provider: "model-fake", model: "fake-1" };
const FAKE_2 = { provider: "model-fake", model: "fake-2" };
const FAKE_EMBED = { provider: "model-fake", model: "fake-embed" };
const PLUGINS = ["model-fake", "model-v1-copy", "model-copy-fail"];

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let ent: Req;
let owner: Req;
let admin: Req;
let alice: Req;
let org1: string;
let org2: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [
          MODEL_FAKE,
          MODEL_FAKE_B,
          fixture("model-v1-copy"),
          fixture("model-copy-fail"),
        ],
        extensionConfig: {
          "model-fake": {
            models: [
              { id: "fake-1" },
              { id: "fake-2" },
              { id: "fake-embed", kind: "embedding", dimensions: [4], maxBatch: 4 },
            ],
          },
        },
      },
    ),
  );
}, 180_000);
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function ok(req: Req, method: "PUT" | "POST", url: string, payload: unknown) {
  const res = await req({ method, url, payload: payload as Record<string, unknown> });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res;
}

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.model_disabled, capybara.model_purpose_mappings, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  for (const pattern of ["cache:*", "capk:models-failed:*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
  const accounts = accountsFor(db);
  await accounts.createLocal({ login: "ent", password: PW, displayName: "E", superAdmin: true });
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  const adminId = await mk("admin");
  const aliceId = await mk("alice");
  ent = await session(k, "ent");
  owner = await session(k, "owner");
  org1 = await createOrg(owner, "One");
  org2 = await createOrg(owner, "Two");
  for (const org of [org1, org2]) {
    for (const plugin of PLUGINS) {
      await ok(owner, "PUT", `/api/v1/orgs/${org}/extensions/${plugin}`, { enabled: true });
    }
  }
  await testMembers(db).add(org1, adminId, "admin", ownerId);
  await testMembers(db).add(org1, aliceId, "member", ownerId);
  admin = await session(k, "admin");
  alice = await session(k, "alice");
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type ModelView = { id: string; kind: string; disabled?: boolean };
type ProviderView = { provider: string; status?: string; models: ModelView[] };

async function models(req: Req, orgId: string, query = ""): Promise<ProviderView[]> {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/models${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { providers: ProviderView[] }).providers;
}
const fakeIds = async (req: Req, orgId: string, query = "") =>
  (await models(req, orgId, query))
    .find((p) => p.provider === "model-fake")
    ?.models.map((m) => m.id);

async function catalog(req: Req, orgId: string): Promise<ProviderView[]> {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/models/catalog` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { providers: ProviderView[] }).providers;
}

const orgDisable = (req: Req, orgId: string, provider: string, list: string[]) =>
  req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/models/${provider}/disabled`,
    payload: { models: list },
  });
const platformDisable = (provider: string, list: string[]) =>
  ent({
    method: "PUT",
    url: `/api/v1/admin/models/${provider}/disabled`,
    payload: { models: list },
  });

type Affected = {
  affected: {
    agents: { id: string; name: string; orgId: string }[];
    purposes: { purpose: string; orgId: string | null }[];
  };
};

async function agent(
  req: Req,
  orgId: string,
  name: string,
  model: unknown,
  fallback: unknown = null,
): Promise<{ statusCode: number; id: string | undefined; code: string | undefined }> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: { name, instructions: "Be helpful.", model, fallback, tools: [] },
      visibility: "org",
    },
  });
  return {
    statusCode: res.statusCode,
    id: (res.json() as { agent?: { id: string } }).agent?.id,
    code: errCode(res),
  };
}
async function agentId(req: Req, orgId: string, name: string, model: unknown, fallback?: unknown) {
  const a = await agent(req, orgId, name, model, fallback);
  expect(a.statusCode, a.code).toBe(201);
  return a.id as string;
}

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

type Ev = ConversationEvent;
const ofType = (events: Ev[], type: string) => events.filter((e) => e.type === type);

describe("the org's disabled list", () => {
  it("an org admin disables fake-2: the org's list lacks it, the catalog flags it, the response lists what uses it", async () => {
    const onMain = await agentId(owner, org1, "Main", FAKE_2);
    const onFallback = await agentId(owner, org1, "Fallback", FAKE_1, FAKE_2);
    await agentId(owner, org1, "Other", FAKE_1);
    const elsewhere = await agentId(owner, org2, "Elsewhere", FAKE_2);
    await ok(admin, "PUT", `/api/v1/orgs/${org1}/model-purposes/title`, {
      target: { model: FAKE_2 },
    });
    await ok(ent, "PUT", "/api/v1/admin/model-purposes/web_fetch", { target: { model: FAKE_2 } });
    // org 2's override of web_fetch: that default is not what org 2 uses
    await ok(owner, "PUT", `/api/v1/orgs/${org2}/model-purposes/web_fetch`, {
      target: { model: FAKE_1 },
    });

    expect(await fakeIds(admin, org1)).toEqual(["fake-1", "fake-2", "fake-embed"]);
    const res = await orgDisable(admin, org1, "model-fake", ["fake-2"]);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Affected;
    expect(body.affected.agents.map((a) => [a.id, a.name, a.orgId]).sort()).toEqual(
      [
        [onMain, "Main", org1],
        [onFallback, "Fallback", org1],
      ].sort(),
    );
    expect(body.affected.agents.map((a) => a.id)).not.toContain(elsewhere);
    expect(body.affected.purposes).toEqual([
      { purpose: "title", orgId: org1 },
      { purpose: "web_fetch", orgId: null },
    ]);

    expect(await fakeIds(alice, org1)).toEqual(["fake-1", "fake-embed"]);
    expect(await fakeIds(owner, org2)).toEqual(["fake-1", "fake-2", "fake-embed"]);
    const cat = (await catalog(admin, org1)).find((p) => p.provider === "model-fake");
    expect(cat?.status).toBe("ok");
    expect(cat?.models.map((m) => [m.id, m.disabled])).toEqual([
      ["fake-1", false],
      ["fake-2", true],
      ["fake-embed", false],
    ]);
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "org_id", "target", "detail"])
      .where("action", "in", ["model.disabled_set", "org.model_disabled_set"])
      .execute();
    expect(audit).toEqual([
      {
        action: "org.model_disabled_set",
        org_id: org1,
        target: "model-fake",
        detail: { scope: "org", disabled: ["fake-2"], enabled: [] },
      },
    ]);

    // the same list again changes nothing and lists nothing new
    const again = (await orgDisable(admin, org1, "model-fake", ["fake-2"])).json() as Affected;
    expect(again.affected).toEqual({ agents: [], purposes: [] });
    // an id the provider does not list is kept harmlessly
    expect((await orgDisable(admin, org1, "model-fake", ["fake-2", "nope"])).statusCode).toBe(200);
    expect(await fakeIds(admin, org1)).toEqual(["fake-1", "fake-embed"]);

    // enabling again: back in the list
    expect((await orgDisable(admin, org1, "model-fake", [])).statusCode).toBe(200);
    expect(await fakeIds(admin, org1)).toEqual(["fake-1", "fake-2", "fake-embed"]);
  });

  it("only org admins: a member's PUT and catalog are 403; an unknown provider is 404", async () => {
    const res = await orgDisable(alice, org1, "model-fake", ["fake-2"]);
    expect(res.statusCode).toBe(403);
    expect(
      (await alice({ method: "GET", url: `/api/v1/orgs/${org1}/models/catalog` })).statusCode,
    ).toBe(403);
    const unknown = await orgDisable(admin, org1, "no-such-provider", ["x"]);
    expect(unknown.statusCode).toBe(404);
    expect(errCode(unknown)).toBe("model.provider_not_found");
    const bad = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${org1}/models/model-fake/disabled`,
      payload: { models: "fake-2" },
    });
    expect(bad.statusCode).toBe(400);
    expect(await fakeIds(admin, org1)).toEqual(["fake-1", "fake-2", "fake-embed"]);
  });
});

describe("the platform's disabled list", () => {
  it("the super admin disables fake-1: no org sees it, not even in the catalog; the admin view flags it", async () => {
    const a1 = await agentId(owner, org1, "A1", FAKE_1);
    const a2 = await agentId(owner, org2, "A2", FAKE_2, FAKE_1);
    const res = await platformDisable("model-fake", ["fake-1"]);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as Affected).affected.agents.map((a) => [a.id, a.orgId]).sort()).toEqual(
      [
        [a1, org1],
        [a2, org2],
      ].sort(),
    );
    for (const org of [org1, org2]) {
      expect(await fakeIds(owner, org)).toEqual(["fake-2", "fake-embed"]);
      const cat = (await catalog(owner, org)).find((p) => p.provider === "model-fake");
      expect(cat?.models.map((m) => m.id)).toEqual(["fake-2", "fake-embed"]);
    }
    const view = await ent({ method: "GET", url: "/api/v1/admin/models" });
    const fake = (view.json() as { providers: ProviderView[] }).providers.find(
      (p) => p.provider === "model-fake",
    );
    expect(fake?.models.map((m) => [m.id, m.disabled])).toEqual([
      ["fake-1", true],
      ["fake-2", false],
      ["fake-embed", false],
    ]);
    // an org's disabled list does not show in the platform view
    expect((await orgDisable(admin, org1, "model-fake", ["fake-2"])).statusCode).toBe(200);
    const view2 = await ent({ method: "GET", url: "/api/v1/admin/models" });
    expect(
      (view2.json() as { providers: ProviderView[] }).providers
        .find((p) => p.provider === "model-fake")
        ?.models.map((m) => m.disabled),
    ).toEqual([true, false, false]);
    // only the super admin
    const denied = await owner({
      method: "PUT",
      url: "/api/v1/admin/models/model-fake/disabled",
      payload: { models: [] },
    });
    expect(denied.statusCode).toBe(403);
    // a deployment default cannot be set to a platform-disabled model
    const def = await ent({
      method: "PUT",
      url: "/api/v1/admin/model-purposes/title",
      payload: { target: { model: FAKE_1 } },
    });
    expect(def.statusCode).toBe(400);
    expect(errCode(def)).toBe("validation_failed");
  });
});

describe("kinds", () => {
  it("?kind= filters the org's list", async () => {
    expect(await fakeIds(owner, org1, "?kind=embedding")).toEqual(["fake-embed"]);
    expect(await fakeIds(owner, org1, "?kind=chat")).toEqual(["fake-1", "fake-2"]);
    const embeddings = await models(owner, org1, "?kind=embedding");
    expect(embeddings.find((p) => p.provider === "model-copy-fail")?.models).toEqual([]);
    const bad = await owner({ method: "GET", url: `/api/v1/orgs/${org1}/models?kind=bogus` });
    expect(bad.statusCode).toBe(400);
  });

  it("chat callers never resolve an embedding model; an embedding caller does", async () => {
    const registry = k.app.get(ProviderRegistry);
    expect(await codeOf(registry.resolve(org1, FAKE_EMBED))).toBe("agent.model_unavailable");
    const r = await registry.resolve(org1, FAKE_EMBED, { kind: "embedding" });
    expect(r.info.kind).toBe("embedding");
    expect(typeof r.provider.embed).toBe("function");
    expect(await codeOf(registry.resolve(org1, FAKE_1, { kind: "embedding" }))).toBe(
      "agent.model_unavailable",
    );
  });
});

describe("agent save", () => {
  it("main and fallback must be enabled chat models in the org", async () => {
    const embed = await agent(owner, org1, "E", FAKE_EMBED);
    expect([embed.statusCode, embed.code]).toEqual([400, "agent.model_unavailable"]);
    const embedFallback = await agent(owner, org1, "EF", FAKE_1, FAKE_EMBED);
    expect([embedFallback.statusCode, embedFallback.code]).toEqual([
      400,
      "agent.model_unavailable",
    ]);
    expect((await orgDisable(admin, org1, "model-fake", ["fake-2"])).statusCode).toBe(200);
    for (const [model, fallback] of [
      [FAKE_2, null],
      [FAKE_1, FAKE_2],
    ] as const) {
      const a = await agent(owner, org1, "D", model, fallback);
      expect([a.statusCode, a.code]).toEqual([400, "agent.model_unavailable"]);
    }
    // the other org is not affected
    expect((await agent(owner, org2, "Fine", FAKE_2)).statusCode).toBe(201);
  });
});

describe("runs and the switch plan", { timeout: 60_000 }, () => {
  it("a model disabled after the agent was saved: the step falls back to the enabled fallback", async () => {
    const id = await agentId(owner, org1, "Saved", FAKE_2, FAKE_1);
    expect((await orgDisable(admin, org1, "model-fake", ["fake-2"])).statusCode).toBe(200);
    const conv = await createConv(owner, org1, id);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${org1}/conversations/${conv}/messages`,
      payload: { text: "echo:hello" },
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "run_finished")).toHaveLength(1);
    // attempt 1 (fake-2) failed to resolve, so it wrote no model_call; no same-model retry
    const calls = ofType(events, "model_call") as Extract<Ev, { type: "model_call" }>[];
    expect(calls.map((c) => [c.payload.attempt, c.payload.model, c.payload.fallback])).toEqual([
      [2, "fake-1", true],
    ]);
  });

  it("without a fallback the run ends run.model_unavailable", async () => {
    const id = await agentId(owner, org1, "Saved", FAKE_2);
    expect((await platformDisable("model-fake", ["fake-2"])).statusCode).toBe(200);
    const conv = await createConv(owner, org1, id);
    await ok(owner, "POST", `/api/v1/orgs/${org1}/conversations/${conv}/messages`, {
      text: "echo:hello",
    });
    await waitForTerminal(db, conv, 1, 20_000);
    const failed = ofType(await eventsOf(db, conv), "run_failed")[0] as Extract<
      Ev,
      { type: "run_failed" }
    >;
    expect(failed.payload.error.code).toBe("run.model_unavailable");
  });

  it("a run whose model's provider is not configured in the org ends run.model_unavailable", async () => {
    const id = await agentId(owner, org1, "V1", { provider: "model-v1-copy", model: "v1-a" });
    // the org keeps its own copy: an @1 provider cannot honour it, so it needs configuration here
    await ok(owner, "PUT", `/api/v1/orgs/${org1}/extensions/model-v1-copy/overrides`, {
      values: { label: "mine" },
    });
    const conv = await createConv(owner, org1, id);
    await ok(owner, "POST", `/api/v1/orgs/${org1}/conversations/${conv}/messages`, {
      text: "echo:hello",
    });
    await waitForTerminal(db, conv, 1, 20_000);
    const failed = ofType(await eventsOf(db, conv), "run_failed")[0] as Extract<
      Ev,
      { type: "run_failed" }
    >;
    expect(failed.payload.error.code).toBe("run.model_unavailable");
  });

  it("the switch plan refuses a disabled model and an embedding model", async () => {
    const id = await agentId(owner, org1, "Switch", FAKE_1);
    const conv = await createConv(owner, org1, id);
    expect((await orgDisable(admin, org1, "model-fake", ["fake-2"])).statusCode).toBe(200);
    for (const model of [FAKE_2, FAKE_EMBED]) {
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${org1}/conversations/${conv}/messages`,
        payload: { text: "echo:x", model },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(errCode(res)).toBe("agent.model_unavailable");
    }
  });
});

describe("a provider the org turned off (spec A §8)", { timeout: 60_000 }, () => {
  const B1 = { provider: "model-fake-b", model: "b-1" };
  const switchB = (orgId: string, enabled: boolean) =>
    ok(owner, "PUT", `/api/v1/orgs/${orgId}/extensions/model-fake-b`, { enabled });
  const bIds = async (orgId: string) =>
    (await models(owner, orgId))
      .find((p) => p.provider === "model-fake-b")
      ?.models.map((m) => m.id);
  const runOnce = async (orgId: string, agent: string) => {
    const conv = await createConv(owner, orgId, agent);
    await ok(owner, "POST", `/api/v1/orgs/${orgId}/conversations/${conv}/messages`, {
      text: "echo:hello",
    });
    await waitForTerminal(db, conv, 1, 20_000);
    return eventsOf(db, conv);
  };

  it("a provider never switched in an org stays usable", async () => {
    expect(await bIds(org1)).toEqual(["b-1", "b-2"]);
    expect(await bIds(org2)).toEqual(["b-1", "b-2"]);
  });

  it("switched off in org 1: absent from its list, catalog and purposes; runs fall back or fail; org 2 keeps it", async () => {
    const withFallback = await agentId(owner, org1, "B fb", B1, FAKE_1);
    const without = await agentId(owner, org1, "B only", B1);
    await ok(admin, "PUT", `/api/v1/orgs/${org1}/model-purposes/title`, { target: { model: B1 } });
    await switchB(org1, false);

    expect(await bIds(org1)).toBeUndefined();
    expect(await bIds(org2)).toEqual(["b-1", "b-2"]);
    const cat = (await catalog(admin, org1)).find((p) => p.provider === "model-fake-b");
    expect(cat?.status).toBe("error");
    expect(cat?.models).toEqual([]);
    const registry = k.app.get(ProviderRegistry);
    expect(await codeOf(registry.resolve(org1, B1))).toBe("agent.model_unavailable");
    expect((await registry.resolve(org2, B1)).info.id).toBe("b-1");
    await expect(k.app.get(ModelPurposesService).resolve(org1, "title")).rejects.toMatchObject({
      code: "model.unconfigured",
    });
    // saving an agent on it is refused in org 1 only
    expect((await agent(owner, org1, "New", B1)).code).toBe("agent.model_unavailable");
    expect((await agent(owner, org2, "New", B1)).statusCode).toBe(201);

    const fb = await runOnce(org1, withFallback);
    expect(ofType(fb, "run_finished")).toHaveLength(1);
    expect(
      (ofType(fb, "model_call") as Extract<Ev, { type: "model_call" }>[]).map((c) => [
        c.payload.model,
        c.payload.fallback,
      ]),
    ).toEqual([["fake-1", true]]);
    const failed = ofType(await runOnce(org1, without), "run_failed")[0] as Extract<
      Ev,
      { type: "run_failed" }
    >;
    expect(failed.payload.error.code).toBe("run.model_unavailable");

    // switched on again: usable again
    await switchB(org1, true);
    expect(await bIds(org1)).toEqual(["b-1", "b-2"]);
  });
});

describe("org config copies", () => {
  it("an @1 provider is absent in an org with its own copy and resolves to agent.model_unavailable there", async () => {
    await ok(owner, "PUT", `/api/v1/orgs/${org1}/extensions/model-v1-copy/overrides`, {
      values: { label: "mine" },
    });
    const registry = k.app.get(ProviderRegistry);
    const v1 = { provider: "model-v1-copy", model: "v1-a" };
    expect((await registry.list(org1)).map((p) => p.provider)).not.toContain("model-v1-copy");
    expect(await codeOf(registry.resolve(org1, v1))).toBe("agent.model_unavailable");
    // org 2 follows the platform: the @1 provider is usable there
    expect(
      (await registry.list(org2))
        .find((p) => p.provider === "model-v1-copy")
        ?.models.map((m) => m.id),
    ).toEqual(["v1-a"]);
    expect((await registry.resolve(org2, v1)).info.id).toBe("v1-a");
  });

  it("a copy's list failure does not mark the platform's (or a following org's) list as failed", async () => {
    await ok(owner, "PUT", `/api/v1/orgs/${org1}/extensions/model-copy-fail/overrides`, {
      values: { fail: true },
    });
    const registry = k.app.get(ProviderRegistry);
    const status = (await registry.listWithStatus(org1)).find(
      (p) => p.provider === "model-copy-fail",
    );
    expect(status?.status).toBe("error");
    const entry = k.app
      .get(ExtensionRegistry)
      .list("model-provider")
      .find((p) => p.plugin === "model-copy-fail");
    const platformMarker = `capk:models-failed:model-copy-fail:v2:${entry?.version}:${entry?.configHash}`;
    const markers = await redis.keys("capk:models-failed:model-copy-fail:*");
    expect(markers).toHaveLength(1);
    expect(markers).not.toContain(platformMarker);
    expect(
      (await registry.list(org2))
        .find((p) => p.provider === "model-copy-fail")
        ?.models.map((m) => m.id),
    ).toEqual(["cf-1"]);
    expect(
      (await registry.listWithStatus()).find((p) => p.provider === "model-copy-fail")?.status,
    ).toBe("ok");
  });
});
