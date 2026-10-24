import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { PW, waitFor } from "../helpers/runs.js";

const DEPLOYCFG = fileURLToPath(new URL("../fixtures/plugins/deploycfg/index.ts", import.meta.url));

type Json = Record<string, unknown>;
interface State {
  setups: number;
  generation: number;
  config: { endpoint: string; greeting: string; poolSize: number; limits: { burst: number } };
  tokenSet: boolean;
}

/**
 * 部署级插件配置的双副本验收（T15，C10）：两个独立进程的副本共享 PG / Redis。
 * 1. 必填字段缺失：两个副本都照常启动，插件待配置；在副本 0 补上后两个副本都不重启地加载；
 * 2. 在副本 1 改 hot 字段：两个副本的 `ctx.config` 都读到新值，setup 次数不变；
 * 3. 在副本 0 改非 hot 字段：两个副本都重新加载（setup 次数各 +1）。
 */
describe("部署级插件配置双副本", { timeout: 120_000 }, () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  const jar = new Map<string, string>();

  async function at(i: 0 | 1, method: string, path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text === "" ? {} : (JSON.parse(text) as Json);
    } catch {
      json = { text };
    }
    return { status: res.status, json };
  }
  const state = async (i: 0 | 1): Promise<State | number> => {
    const r = await at(i, "GET", "/plugins/deploycfg/state");
    return r.status === 200 ? (r.json as unknown as State) : r.status;
  };
  const both = async (pred: (s: State) => boolean) => {
    const [a, b] = [await state(0), await state(1)];
    return typeof a === "object" && typeof b === "object" && pred(a) && pred(b) ? [a, b] : false;
  };
  const put = async (i: 0 | 1, values: Json) => {
    const r = await at(i, "PUT", "/api/v1/admin/extensions/deploycfg/config", { values });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json;
  };

  beforeAll(async () => {
    [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
    h = await createDualReplicaHarness({
      extensions: [DEPLOYCFG],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      // endpoint 必填但没配：两个副本都待配置
      extensionConfig: {},
      config: { auth: { cookieSecure: false }, extensionHost: { reconcileIntervalSeconds: 2 } },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    await new AccountsService(db).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      enterpriseAdmin: true,
    });
    const r = await at(0, "POST", "/api/v1/auth/login", { login: "root", password: PW });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
  }, 120_000);

  it("1. 必填字段缺失时两个副本都待配置；补上后两个副本都不重启地加载", async () => {
    expect(await state(0)).toBe(503);
    expect(await state(1)).toBe(503);
    const rows = await db
      .selectFrom("extension_replica_status")
      .select(["state", "reason"])
      .where("plugin", "=", "deploycfg")
      .execute();
    expect(rows).toEqual([
      { state: "pending", reason: "config" },
      { state: "pending", reason: "config" },
    ]);
    await put(0, { endpoint: "https://one.example", token: "dual-secret-Xq7" });
    const [a, b] = (await waitFor(
      () => both((s) => s.config.endpoint === "https://one.example"),
      20_000,
      "both replicas loaded",
      100,
    )) as State[];
    expect(a?.setups).toBe(1);
    expect(b?.setups).toBe(1);
    expect(a?.tokenSet && b?.tokenSet).toBe(true);
  });

  it("2. 改 hot 字段：另一个副本的 ctx.config 读到新值，两边都不重新 setup", async () => {
    await put(1, { greeting: "hola", "limits.burst": 7 });
    const [a, b] = (await waitFor(
      () => both((s) => s.config.greeting === "hola" && s.config.limits.burst === 7),
      20_000,
      "hot value on both replicas",
      100,
    )) as State[];
    expect([a?.setups, b?.setups]).toEqual([1, 1]);
    expect([a?.generation, b?.generation]).toEqual([1, 1]);
  });

  it("3. 改非 hot 字段：两个副本都重新加载（setup 次数各 +1）", async () => {
    await put(0, { poolSize: 4 });
    const [a, b] = (await waitFor(
      () => both((s) => s.config.poolSize === 4),
      20_000,
      "reloaded on both replicas",
      100,
    )) as State[];
    expect([a?.setups, b?.setups]).toEqual([2, 2]);
    expect([a?.generation, b?.generation]).toEqual([2, 2]);
    expect(a?.config.greeting).toBe("hola");
  });
});
