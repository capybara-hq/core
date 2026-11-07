import { fileURLToPath } from "node:url";
import { type ExtensionContext, ModelError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ModelEmbeddings } from "../../src/models/embeddings.js";
import { ModelUsageJobs } from "../../src/runtime/usage-report.js";
import { embedConsumer } from "../fixtures/plugins/embed-consumer/index.js";
import { embedProbe } from "../fixtures/plugins/model-embed-probe/index.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * `ctx.models` for embeddings (model platform spec B §5.4): only purposes the extension declared
 * with `kind: "embedding"`; the org's effective target, enabled there; batches split by the model's
 * `maxBatch`; each result checked; one `model_usage` row per call, reported through `usage.report`.
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const PURPOSE = "embed-consumer.memory";
const PROBE = { model: { provider: "model-embed-probe", model: "probe-embed" }, params: {} };
const FAKE_EMBED = { model: { provider: "model-fake", model: "fake-embed" }, params: {} };

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let owner: Req;
let orgId: string;

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
        extensions: [MODEL_FAKE, fx("model-embed-probe"), fx("embed-consumer"), fx("usage-b")],
        extensionConfig: {
          "model-fake": { models: [{ id: "fake-1" }, { id: "fake-embed", kind: "embedding" }] },
        },
        models: { embedTimeoutMs: 1500 },
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
}, 120_000);

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.model_usage, capybara.model_disabled, capybara.model_purpose_mappings, capybara.extension_org_configs",
  );
  const cached = await redis.keys("cache:capk:model-disabled:*");
  if (cached.length > 0) await redis.del(...cached);
  await enableExtensions(raw, orgId, "embed-consumer", "usage-b");
  const s = embedProbe();
  s.calls = [];
  s.signals = [];
  s.wrongDimension = false;
  s.hang = false;
  s.aborted = 0;
});

const ctx = (): ExtensionContext => {
  const c = embedConsumer().ctx;
  if (!c) throw new Error("embed-consumer is not set up");
  return c;
};

async function map(target: unknown): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/${encodeURIComponent(PURPOSE)}`,
    payload: { target },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

async function seenB(id: string): Promise<number> {
  const res = await owner({ method: "GET", url: `/plugins/usage-b/seen?eventId=${id}` });
  return (res.json() as { calls: number }).calls;
}

describe("ctx.models.embed", { timeout: 60_000 }, () => {
  it("splits the input by the model's maxBatch and returns the vectors in input order", async () => {
    await map(PROBE);
    const out = await ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(10) });
    expect(embedProbe().calls.map((c) => c.input)).toEqual([
      ["t0", "t1", "t2", "t3"],
      ["t4", "t5", "t6", "t7"],
      ["t8", "t9"],
    ]);
    expect(embedProbe().calls.every((c) => c.model === "probe-embed")).toBe(true);
    expect(embedProbe().signals).toEqual([true, true, true]);
    expect(out.model).toEqual({ provider: "model-embed-probe", id: "probe-embed" });
    expect(out.dimensions).toBe(8);
    expect(out.vectors).toHaveLength(10);
    expect(out.vectors.map((v) => v[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(out.vectors.every((v) => v.length === 8)).toBe(true);
  });

  it("passes dimensions and inputType through, and refuses dimensions the model lacks", async () => {
    await map(PROBE);
    const out = await ctx().models.embed({
      orgId,
      purpose: PURPOSE,
      input: ["t1"],
      dimensions: 16,
      inputType: "query",
    });
    expect(out.dimensions).toBe(16);
    expect(out.vectors[0]).toHaveLength(16);
    expect(embedProbe().calls[0]).toMatchObject({ dimensions: 16, inputType: "query" });
    const e = await rejection(
      ctx().models.embed({ orgId, purpose: PURPOSE, input: ["t1"], dimensions: 5 }),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("validation_failed");
  });

  it("works with model-fake's embedding model at its default dimension", async () => {
    await map(FAKE_EMBED);
    const out = await ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(10) });
    expect(out.vectors).toHaveLength(10);
    expect(out.dimensions).toBe(8);
    expect(out.vectors.every((v) => v.length === 8)).toBe(true);
  });

  it("a purpose the extension did not declare is refused", async () => {
    await map(PROBE);
    for (const purpose of ["embed-consumer.other", "eval", "model-eval.summarize"]) {
      const e = await rejection(ctx().models.embed({ orgId, purpose, input: ["t1"] }));
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("model.purpose_unknown");
      const d = await rejection(ctx().models.describe({ orgId, purpose }));
      expect((d as ApiError).code).toBe("model.purpose_unknown");
    }
    expect(embedProbe().calls).toEqual([]);
  });

  it("an unmapped purpose, or one mapped to a model disabled in the org, is unconfigured", async () => {
    const unmapped = await rejection(ctx().models.embed({ orgId, purpose: PURPOSE, input: ["x"] }));
    expect((unmapped as ApiError).code).toBe("model.unconfigured");
    await map(PROBE);
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/models/model-embed-probe/disabled`,
      payload: { models: ["probe-embed"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const e = await rejection(ctx().models.embed({ orgId, purpose: PURPOSE, input: ["t1"] }));
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("model.unconfigured");
    expect(await ctx().models.describe({ orgId, purpose: PURPOSE })).toBeNull();
    expect(embedProbe().calls).toEqual([]);
  });

  it("an org that did not enable the extension cannot be embedded for", async () => {
    await map(PROBE);
    await truncateTables(raw, "capybara.extension_org_configs");
    const e = await rejection(ctx().models.embed({ orgId, purpose: PURPOSE, input: ["t1"] }));
    expect((e as ApiError).code).toBe("extension.not_enabled");
    expect(embedProbe().calls).toEqual([]);
  });

  it("a result of the wrong dimension is a server ModelError; the answered batch is recorded", async () => {
    await map(PROBE);
    embedProbe().wrongDimension = true;
    const e = await rejection(ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(6) }));
    expect(e).toBeInstanceOf(ModelError);
    expect((e as ModelError).kind).toBe("server");
    expect((e as ModelError).message).toContain("dimension 3, expected 8");
    // the first batch (4 inputs) was answered and billed; the second was never sent
    expect(embedProbe().calls).toHaveLength(1);
    const rows = await db.selectFrom("model_usage").select("input_tokens").execute();
    expect(rows).toEqual([{ input_tokens: 4 }]);
  });

  it("a call refused before any provider answer records nothing", async () => {
    await map(PROBE);
    const e = await rejection(
      ctx().models.embed({ orgId, purpose: PURPOSE, input: ["t1"], dimensions: 99 }),
    );
    expect((e as ApiError).code).toBe("validation_failed");
    expect(await db.selectFrom("model_usage").selectAll().execute()).toEqual([]);
  });

  it("writes one model_usage row per call with the summed tokens and reports it", async () => {
    await map(PROBE);
    await ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(10) });
    const rows = await db.selectFrom("model_usage").selectAll().execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      org_id: orgId,
      extension: "embed-consumer",
      purpose: PURPOSE,
      provider: "model-embed-probe",
      model: "probe-embed",
      input_tokens: 10,
    });
    // usage-b subscribes to usage.report and is enabled in the org: delivered once, then marked
    await waitFor(async () => (await seenB(row?.id as string)) === 1, 15_000, "delivery");
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("model_usage")
            .select("reported_at")
            .where("id", "=", row?.id as string)
            .executeTakeFirst()
        )?.reported_at != null,
      10_000,
      "reported_at",
    );
  });
});

describe("ctx.models.embed: time limits, aborts, the usage enqueue", { timeout: 60_000 }, () => {
  it("a batch over models.embedTimeoutMs is aborted and fails with a timeout ModelError", async () => {
    await map(PROBE);
    embedProbe().hang = true;
    const started = Date.now();
    const e = await rejection(ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(6) }));
    expect(e).toBeInstanceOf(ModelError);
    expect((e as ModelError).kind).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    // the provider's call was aborted, the second batch never sent, nothing answered: no row
    expect(embedProbe().aborted).toBe(1);
    expect(embedProbe().calls).toHaveLength(1);
    expect(await db.selectFrom("model_usage").selectAll().execute()).toEqual([]);
  });

  it("the request's own signal aborts the call mid-way: later batches are not sent", async () => {
    await map(PROBE);
    embedProbe().hang = true;
    const ac = new AbortController();
    const call = ctx().models.embed({
      orgId,
      purpose: PURPOSE,
      input: texts(10),
      signal: ac.signal,
    });
    await waitFor(async () => embedProbe().calls.length === 1, 5_000, "first batch sent");
    ac.abort(new Error("tool call aborted"));
    const e = await rejection(call);
    expect((e as Error).message).toBe("tool call aborted");
    expect(embedProbe().aborted).toBe(1);
    expect(embedProbe().calls).toHaveLength(1);
  });

  it("an aborted request signal refuses the call before any batch", async () => {
    await map(PROBE);
    const ac = new AbortController();
    ac.abort(new Error("gone"));
    const e = await rejection(
      ctx().models.embed({ orgId, purpose: PURPOSE, input: ["t1"], signal: ac.signal }),
    );
    expect((e as Error).message).toBe("gone");
    expect(embedProbe().calls).toEqual([]);
  });

  it("embed does not wait for the usage enqueue (a hanging or failing enqueue)", async () => {
    await map(PROBE);
    const jobs = k.app.get(ModelUsageJobs);
    const original = jobs.enqueue;
    let reached = 0;
    try {
      jobs.enqueue = () => {
        reached++;
        return new Promise<void>(() => {}); // never settles (Redis unreachable)
      };
      const out = await Promise.race([
        ctx().models.embed({ orgId, purpose: PURPOSE, input: ["t1"] }),
        new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 3_000)),
      ]);
      expect(out).not.toBe("stuck");
      jobs.enqueue = async () => {
        reached++;
        throw new Error("redis down");
      };
      await ctx().models.embed({ orgId, purpose: PURPOSE, input: ["t2"] });
      await waitFor(async () => reached === 2, 5_000, "both enqueues attempted");
    } finally {
      jobs.enqueue = original;
    }
    expect(await db.selectFrom("model_usage").selectAll().execute()).toHaveLength(2);
  });
});

describe("ctx.models.describe", { timeout: 60_000 }, () => {
  it("returns the effective target with its embedding info, null when unmapped", async () => {
    expect(await ctx().models.describe({ orgId, purpose: PURPOSE })).toBeNull();
    await map(PROBE);
    expect(await ctx().models.describe({ orgId, purpose: PURPOSE })).toEqual({
      provider: "model-embed-probe",
      id: "probe-embed",
      kind: "embedding",
      embedding: { dimensions: [8, 16], defaultDimensions: 8, maxInputTokens: 512, maxBatch: 4 },
    });
  });

  it("the extension's tool reaches ctx.models with its call's org", async () => {
    await map(PROBE);
    const inst = k.app.get(ExtensionHost).current("embed-consumer");
    const tool = inst?.tools.find((t) => t.spec.name === "remember");
    if (!tool) throw new Error("remember is not registered");
    const out = await tool.handler(
      { texts: ["t1", "t2"] },
      {
        orgId,
        accountId: "a",
        agentId: "g",
        conversationId: "c",
        callId: "x",
        signal: new AbortController().signal,
      },
    );
    const [block] = (out as { content: { type: "text"; text: string }[] }).content;
    expect(JSON.parse(block?.text ?? "")).toEqual({
      model: expect.objectContaining({ provider: "model-embed-probe", id: "probe-embed" }),
      count: 2,
      dimensions: 8,
    });
  });
});

describe("permissions.models", () => {
  it("the broker refuses a purpose of another kind declared by the same extension", async () => {
    const broker = k.app.get(ModelEmbeddings);
    const e = await rejection(
      broker.embed(
        "embed-consumer",
        [{ purpose: PURPOSE, kind: "chat", label: { zh: "x", en: "x" } }],
        { orgId, purpose: PURPOSE, input: ["t1"] },
        new AbortController().signal,
      ),
    );
    expect((e as ApiError).code).toBe("model.purpose_unknown");
  });
});
