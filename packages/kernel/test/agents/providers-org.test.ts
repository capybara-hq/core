import { fileURLToPath } from "node:url";
import type { ModelRequest, ModelStreamEvent } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { type ProviderCall, recordingProviderHost } from "../helpers/provider-capture.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { providerRegistryFor } from "../helpers/runtime.js";

/**
 * Model platform spec B §5.5 and §5.1: model provider calls are org-bound (the org id and the
 * provider's effective config there), lists are cached per effective config, and each list is
 * validated per model. Orgs A and C follow the platform; org B keeps its own copy of model-fake
 * (`models: [b-only]`) and of model-org-key (its own key). model-org-key is installed without a
 * platform key, so following orgs need configuration; model-odd lists one valid chat model, a
 * model of an unknown kind and two invalid entries.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let k: TestKernel;
let redis: Redis;
let owner: Req;
let orgA: string;
let orgB: string;
let orgC: string;
const calls: ProviderCall[] = [];
const warns: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
let registry: ProviderRegistry;

async function put(url: string, payload: Record<string, unknown>): Promise<void> {
  const res = await owner({ method: "PUT", url, payload });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fixture("model-odd"), fixture("model-org-key")],
        extensionConfig: { "model-fake": { models: [{ id: "fake-1" }, { id: "fake-2" }] } },
      },
    ),
  );
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(kernelDb(raw)).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  [orgA, orgB, orgC] = [
    await createOrg(owner, "Alpha"),
    await createOrg(owner, "Beta"),
    await createOrg(owner, "Gamma"),
  ];
  for (const org of [orgA, orgB, orgC]) {
    for (const plugin of ["model-fake", "model-odd", "model-org-key"]) {
      await put(`/api/v1/orgs/${org}/extensions/${plugin}`, { enabled: true });
    }
  }
  await put(`/api/v1/orgs/${orgB}/extensions/model-fake/overrides`, {
    values: { models: [{ id: "b-only" }] },
  });
  await put(`/api/v1/orgs/${orgB}/extensions/model-org-key/overrides`, {
    values: { apiKey: "ok-b-1234" },
  });
  redis = new Redis(rd.url);
  registry = providerRegistryFor(
    recordingProviderHost(k.app.get(ExtensionRegistry), calls),
    redis,
    {
      warn: (msg: string, fields?: Record<string, unknown>) => {
        warns.push({ msg, fields });
      },
    },
    { effective: k.app.get(EffectiveConfigs) },
  );
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await redis.flushdb();
  calls.length = 0;
  warns.length = 0;
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

const idsOf = async (reg: ProviderRegistry, orgId: string, provider: string) =>
  (await reg.list(orgId)).find((p) => p.provider === provider)?.models.map((m) => m.id);

const req = (model: string): ModelRequest => ({
  model,
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "echo:hi" }] }],
  tools: [],
  maxOutputTokens: 100,
  params: {},
});

const drain = async (it: AsyncIterable<ModelStreamEvent>) => {
  for await (const _ of it);
};

const modelsOf = (c: ProviderCall | undefined) =>
  (c?.opts.config as { models?: { id: string }[] } | undefined)?.models?.map((m) => m.id);

describe("org-bound model provider calls", () => {
  it("each org lists with its effective config: following orgs see the platform's models, a copy its own", async () => {
    expect(await idsOf(registry, orgA, "model-fake")).toEqual(["fake-1", "fake-2"]);
    expect(await idsOf(registry, orgB, "model-fake")).toEqual(["b-only"]);
    const lists = calls.filter((c) => c.site === "listModels" && c.plugin === "model-fake");
    expect(lists.map((c) => [c.opts.orgId, modelsOf(c)])).toEqual([
      [orgA, ["fake-1", "fake-2"]],
      [orgB, ["b-only"]],
    ]);
  });

  it("a stream call carries the org id and the org's effective config", async () => {
    const b = await registry.resolve(orgB, { provider: "model-fake", model: "b-only" });
    await drain(b.provider.stream(req("b-only"), { signal: new AbortController().signal }));
    const streamB = calls.find((c) => c.site === "stream");
    expect(streamB?.opts.orgId).toBe(orgB);
    expect(modelsOf(streamB)).toEqual(["b-only"]);
    calls.length = 0;
    const a = await registry.resolve(orgA, { provider: "model-fake", model: "fake-1" });
    await drain(a.provider.stream(req("fake-1"), { signal: new AbortController().signal }));
    const streamA = calls.find((c) => c.site === "stream");
    expect(streamA?.opts.orgId).toBe(orgA);
    expect(modelsOf(streamA)).toEqual(["fake-1", "fake-2"]);
    // the bound provider carries no config of its own (nothing to log or serialise)
    expect(JSON.stringify(b.provider)).toBe("{}");
  });

  it("a model only in another org's list does not resolve", async () => {
    expect(await codeOf(registry.resolve(orgA, { provider: "model-fake", model: "b-only" }))).toBe(
      "agent.model_unavailable",
    );
    expect(await codeOf(registry.resolve(orgB, { provider: "model-fake", model: "fake-1" }))).toBe(
      "agent.model_unavailable",
    );
  });

  it("following orgs share the platform's cached list; an org's copy gets its own key", async () => {
    const entry = k.app
      .get(ExtensionRegistry)
      .list("model-provider")
      .find((p) => p.plugin === "model-fake");
    const platformKey = `cache:capk:models:model-fake:v2:f2:${entry?.version}:${entry?.configHash}`;
    await registry.list(orgA);
    await registry.list(orgC);
    expect(await redis.keys("cache:capk:models:model-fake:*")).toEqual([platformKey]);
    expect(calls.filter((c) => c.site === "listModels" && c.plugin === "model-fake")).toHaveLength(
      1,
    );
    await registry.list(orgB);
    const keys = await redis.keys("cache:capk:models:model-fake:*");
    expect(keys).toHaveLength(2);
    const keyB = keys.find((x) => x !== platformKey) as string;
    expect(keyB).toMatch(/^cache:capk:models:model-fake:v2:f2:[^:]+:[0-9a-f]{16}$/);
    // no config text (and no org id) in the key
    expect(keyB).not.toContain("b-only");
    expect(keyB).not.toContain(orgB);
  });

  it("a provider needing configuration in an org offers no models there and resolves to agent.model_unavailable", async () => {
    expect((await registry.list(orgA)).map((p) => p.provider)).not.toContain("model-org-key");
    expect(
      await codeOf(registry.resolve(orgA, { provider: "model-org-key", model: "key-9" })),
    ).toBe("agent.model_unavailable");
    expect(calls.filter((c) => c.plugin === "model-org-key")).toEqual([]);
    // org B entered its own key: the provider lists with it
    expect(await idsOf(registry, orgB, "model-org-key")).toEqual(["key-9"]);
    const r = await registry.resolve(orgB, { provider: "model-org-key", model: "key-9" });
    expect(r.info.kind).toBe("chat");
    const status = (await registry.listWithStatus(orgA)).find(
      (p) => p.provider === "model-org-key",
    );
    expect(status?.status).toBe("error");
    expect(status?.error).toMatch(/needs configuration in this organization/);
  });

  it("the admin view lists with the platform config; a provider the platform left without its key is org_configured", async () => {
    const view = await registry.listWithStatus();
    expect(view.map((p) => [p.provider, p.status, p.models.map((m) => m.id)])).toEqual([
      ["model-fake", "ok", ["fake-1", "fake-2"]],
      ["model-odd", "ok", ["odd-chat", "odd-hologram"]],
      ["model-org-key", "org_configured", []],
    ]);
    const lists = calls.filter((c) => c.site === "listModels" && c.plugin === "model-fake");
    expect(lists.map((c) => [c.opts.orgId, modelsOf(c)])).toEqual([
      [undefined, ["fake-1", "fake-2"]],
    ]);
    expect(calls.filter((c) => c.plugin === "model-org-key")).toEqual([]);
  });

  it("platformInfo resolves in the platform view and refuses a provider each org configures", async () => {
    expect((await registry.platformInfo({ provider: "model-fake", model: "fake-2" })).id).toBe(
      "fake-2",
    );
    expect(await codeOf(registry.platformInfo({ provider: "model-org-key", model: "key-9" }))).toBe(
      "agent.model_unavailable",
    );
  });

  it("the kernel's own registry is org-bound too", async () => {
    const own = k.app.get(ProviderRegistry);
    expect(await idsOf(own, orgB, "model-fake")).toEqual(["b-only"]);
    expect(await idsOf(own, orgA, "model-fake")).toEqual(["fake-1", "fake-2"]);
    expect(await own.hasProvider(orgA)).toBe(true);
  });
});

describe("per-model list validation", () => {
  it("drops only the invalid entries (one warn each) and lists an unknown kind as other", async () => {
    const odd = (await registry.list(orgA)).find((p) => p.provider === "model-odd");
    expect(odd?.models.map((m) => [m.id, m.kind])).toEqual([
      ["odd-chat", "chat"],
      ["odd-hologram", "other"],
    ]);
    const dropped = warns.filter((w) => w.msg === "model dropped from the provider's list");
    expect(dropped.map((w) => [w.fields?.provider, w.fields?.model, w.fields?.problem])).toEqual([
      ["model-odd", "odd-bad-params", "invalid parameter declarations"],
      ["model-odd", "odd-embed", "an embedding model without embedding info"],
    ]);
    // the list is read again (cache expired): the same drops are not warned again
    for (const key of await redis.keys("cache:capk:models:model-odd:*")) await redis.del(key);
    await registry.list(orgA);
    expect(warns.filter((w) => w.msg === "model dropped from the provider's list")).toHaveLength(2);
  });

  it("only chat and embedding models resolve: other and dropped models are agent.model_unavailable", async () => {
    const r = await registry.resolve(orgA, { provider: "model-odd", model: "odd-chat" });
    expect(r.info.kind).toBe("chat");
    for (const model of ["odd-hologram", "odd-bad-params", "odd-embed"]) {
      expect(await codeOf(registry.resolve(orgA, { provider: "model-odd", model }))).toBe(
        "agent.model_unavailable",
      );
    }
  });
});
