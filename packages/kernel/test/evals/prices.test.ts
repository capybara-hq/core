import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { PricesService, priceKey } from "../../src/models/prices.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let adminId: string;
let admin: Req;
let user: Req;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
}, 120_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.model_prices, capybara.deployment_settings, capybara.audit_events, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  adminId = (
    await accounts.createLocal({
      login: "admin",
      password: PW,
      displayName: "A",
      enterpriseAdmin: true,
    })
  ).id;
  await accounts.createLocal({ login: "user", password: PW, displayName: "U" });
  admin = await session(k, "admin");
  user = await session(k, "user");
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const M1 = {
  provider: "anthropic",
  model: "claude-x",
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: null,
};

describe("/api/v1/admin/model-prices", () => {
  it("PUT 后 GET 能读到；再 PUT 覆盖；price: null 删除；币种来自部署设置", async () => {
    const empty = await admin({ method: "GET", url: "/api/v1/admin/model-prices" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ prices: [], currency: "USD" });

    const put = await admin({ method: "PUT", url: "/api/v1/admin/model-prices", payload: M1 });
    expect(put.statusCode, put.body).toBe(200);
    expect((put.json() as { prices: unknown[] }).prices).toEqual([M1]);

    const m2 = { ...M1, model: "claude-y", inputPerMTok: 0.25, cacheReadPerMTok: null };
    await admin({ method: "PUT", url: "/api/v1/admin/model-prices", payload: m2 });
    const updated = { ...M1, outputPerMTok: 12.5 };
    await admin({ method: "PUT", url: "/api/v1/admin/model-prices", payload: updated });
    const got = await admin({ method: "GET", url: "/api/v1/admin/model-prices" });
    expect(got.json()).toEqual({ prices: [updated, m2], currency: "USD" });

    const del = await admin({
      method: "PUT",
      url: "/api/v1/admin/model-prices",
      payload: { provider: "anthropic", model: "claude-x", price: null },
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { prices: unknown[] }).prices).toEqual([m2]);

    // 币种 = 部署设置 priceCurrency
    const cur = await admin({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { priceCurrency: "CNY" },
    });
    expect(cur.statusCode, cur.body).toBe(200);
    expect((cur.json() as { priceCurrency: string }).priceCurrency).toBe("CNY");
    const after = await admin({ method: "GET", url: "/api/v1/admin/model-prices" });
    expect((after.json() as { currency: string }).currency).toBe("CNY");

    // 审计
    const actions = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id", "target"])
      .where("action", "like", "model_price.%")
      .orderBy("id")
      .execute();
    expect(actions.map((a) => a.action)).toEqual([
      "model_price.updated",
      "model_price.updated",
      "model_price.updated",
      "model_price.deleted",
    ]);
    expect(actions.every((a) => a.actor_account_id === adminId)).toBe(true);

    // 服务层：table() 按 provider + model 取价
    const table = await k.app.get(PricesService).table();
    expect(table.get(priceKey("anthropic", "claude-y"))).toEqual(m2);
    expect(table.get(priceKey("anthropic", "claude-x"))).toBeUndefined();
  });

  it("非企业管理员 403；未登录 401", async () => {
    for (const req of [
      () => user({ method: "GET", url: "/api/v1/admin/model-prices" }),
      () => user({ method: "PUT", url: "/api/v1/admin/model-prices", payload: M1 }),
    ]) {
      const res = await req();
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe("forbidden");
    }
    const anon = await k.http.inject({ method: "GET", url: "/api/v1/admin/model-prices" });
    expect(anon.statusCode).toBe(401);
    expect(await db.selectFrom("model_prices").select("model").execute()).toEqual([]);
  });

  it("校验：价格 ≥ 0 且 ≤ 1e6，字段齐全；币种为三位大写字母", async () => {
    for (const payload of [
      { ...M1, inputPerMTok: -1 },
      { ...M1, outputPerMTok: 1e6 + 1 },
      { ...M1, cacheReadPerMTok: -0.1 },
      { ...M1, cacheWritePerMTok: "1" },
      { ...M1, provider: "" },
      { provider: "a", model: "b" },
      { provider: "a", model: "b", price: 3 },
      { ...M1, extra: true },
    ]) {
      const res = await admin({ method: "PUT", url: "/api/v1/admin/model-prices", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const edge = await admin({
      method: "PUT",
      url: "/api/v1/admin/model-prices",
      payload: { ...M1, inputPerMTok: 0, outputPerMTok: 1e6 },
    });
    expect(edge.statusCode).toBe(200);
    for (const priceCurrency of ["usd", "US", "EURO", 1]) {
      const res = await admin({
        method: "PUT",
        url: "/api/v1/admin/settings",
        payload: { priceCurrency },
      });
      expect(res.statusCode, String(priceCurrency)).toBe(400);
    }
  });

  it("写入时复核企业管理员身份（已被撤销 → forbidden）", async () => {
    await db
      .updateTable("accounts")
      .set({ is_enterprise_admin: false })
      .where("id", "=", adminId)
      .execute();
    await expect(k.app.get(PricesService).put(M1, adminId)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
