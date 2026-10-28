import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { evalModelState, resetEvalModel } from "../fixtures/plugins/model-eval/index.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE_B } from "../helpers/model-plugins.js";
import { createOrg, PW, type Req, runConfig, session, startKernel } from "../helpers/runs.js";

/**
 * `GET /api/v1/admin/models`（T18）：每个模型供应商一项（状态、模型），外加价格表与币种。
 * 某个供应商列模型失败时只把它标为 `error`，其余照常返回。只给企业管理员。
 */

const MODEL_EVAL = fileURLToPath(
  new URL("../fixtures/plugins/model-eval/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: Kernel;
let ent: Req;
let owner: Req;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api"], extensions: [MODEL_FAKE_B, MODEL_EVAL] },
    ),
  );
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.model_prices, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.deployment_settings, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  // 模型列表缓存在 Redis：每条用例从头列
  const keys = await redis.keys("capk:models:*");
  if (keys.length > 0) await redis.del(...keys);
  resetEvalModel();
  const accounts = accountsFor(db);
  await accounts.createLocal({
    login: "ent",
    password: PW,
    displayName: "E",
    enterpriseAdmin: true,
  });
  await accounts.createLocal({ login: "owner", password: PW, displayName: "O" });
  ent = await session(k, "ent");
  owner = await session(k, "owner");
  await createOrg(owner);
});

interface ProviderView {
  provider: string;
  plugin: string;
  status: "ok" | "error";
  error?: string;
  models: { id: string; contextWindow: number; capabilities: Record<string, boolean> }[];
}

async function get(req: Req) {
  return req({ method: "GET", url: "/api/v1/admin/models" });
}

describe("GET /admin/models", () => {
  it("供应商、模型（能力与上下文长度）、价格与币种", async () => {
    await ent({
      method: "PUT",
      url: "/api/v1/admin/model-prices",
      payload: {
        provider: "model-eval",
        model: "eval-1",
        inputPerMTok: 1.5,
        outputPerMTok: 6,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
    });
    await ent({ method: "PUT", url: "/api/v1/admin/settings", payload: { priceCurrency: "CNY" } });
    const res = await get(ent);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { providers: ProviderView[]; prices: unknown[]; currency: string };
    expect(body.providers.map((p) => [p.provider, p.plugin, p.status])).toEqual([
      ["model-fake-b", "model-fake-b", "ok"],
      ["model-eval", "model-eval", "ok"],
    ]);
    const evalP = body.providers[1] as ProviderView;
    expect(evalP).not.toHaveProperty("error");
    expect(evalP.models.map((m) => m.id)).toEqual(["eval-1", "eval-2", "eval-v", "eval-j"]);
    expect(evalP.models[2]).toMatchObject({
      contextWindow: 32_000,
      capabilities: { vision: true },
    });
    expect(body.prices).toEqual([
      {
        provider: "model-eval",
        model: "eval-1",
        inputPerMTok: 1.5,
        outputPerMTok: 6,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
    ]);
    expect(body.currency).toBe("CNY");
  });

  it("某个供应商列模型失败：它标为 error，其余照常", async () => {
    evalModelState().listFails = true;
    const res = await get(ent);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { providers: ProviderView[]; currency: string };
    expect(body.providers).toHaveLength(2);
    const [b, e] = body.providers as [ProviderView, ProviderView];
    expect(b).toMatchObject({ provider: "model-fake-b", status: "ok" });
    expect(b.models.map((m) => m.id)).toEqual(["b-1", "b-2"]);
    expect(e).toMatchObject({
      provider: "model-eval",
      plugin: "model-eval",
      status: "error",
      models: [],
    });
    expect(typeof e.error).toBe("string");
    // 只给内核自己的说明，不透出上游错误原文
    expect(e.error).not.toContain("upstream down");
    expect(body.currency).toBe("USD");
  });

  it("非企业管理员 403，未登录 401", async () => {
    expect((await get(owner)).statusCode).toBe(403);
    const anon = await k.http.inject({ method: "GET", url: "/api/v1/admin/models" });
    expect(anon.statusCode).toBe(401);
  });
});
