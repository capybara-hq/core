import { afterEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { KernelHttpApp } from "../../src/http/app.js";
import { createLogger } from "../../src/log.js";
import { testHttpApp } from "../helpers/http-app.js";

const apps: KernelHttpApp[] = [];

async function app(replicaId?: string): Promise<KernelHttpApp> {
  const log = createLogger("error", { write: () => {} });
  const a = await testHttpApp({
    log,
    servePlugins: true,
    ...(replicaId !== undefined && { replicaId }),
  });
  apps.push(a);
  return a;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("http.replicaId → x-capybara-replica 响应头", () => {
  it("设置时每个响应（健康检查、404、插件路由）都带该头", async () => {
    const a = await app("r-1");
    a.mountPlugins([
      { method: "GET", path: "/plugins/p/x", handler: async () => Response.json({ ok: true }) },
    ]);
    for (const url of ["/healthz", "/nope", "/plugins/p/x"]) {
      const r = await a.inject({ method: "GET", url });
      expect(r.headers["x-capybara-replica"], url).toBe("r-1");
    }
  });

  it("未设置时不带该头", async () => {
    const a = await app();
    const r = await a.inject({ method: "GET", url: "/healthz" });
    expect(r.headers["x-capybara-replica"]).toBeUndefined();
  });

  it("配置：可选；只允许短的安全字符", () => {
    const base = {
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32).toString("base64"),
    };
    expect(KernelConfigSchema.parse(base).http.replicaId).toBeUndefined();
    expect(KernelConfigSchema.parse({ ...base, http: { replicaId: "0" } }).http.replicaId).toBe(
      "0",
    );
    // CAPYBARA_HTTP__REPLICA_ID=0 经 JSON 解析成数字
    expect(KernelConfigSchema.parse({ ...base, http: { replicaId: 0 } }).http.replicaId).toBe(0);
    expect(() => KernelConfigSchema.parse({ ...base, http: { replicaId: "a\r\nb" } })).toThrow();
    expect(() => KernelConfigSchema.parse({ ...base, http: { replicaId: "" } })).toThrow();
  });
});
