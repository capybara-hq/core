import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const hosts: ExtensionHost[] = [];
const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  // 宿主读写插件权限快照（内核表）
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  deps = {
    db: createDb(pg.url, 5),
    dbUrl: pg.url,
    redis,
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    runWorkers: false,
    log: quiet,
  };
});
afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  await sub.close();
  redis.disconnect();
  await deps.db.destroy();
  await Promise.all([pg.stop(), rd.stop()]);
});

describe("ctx.tools.register", () => {
  it("收集规则：非法名 / 空描述 / 重复抛错，合法的按序收集；host.tools() 列出", async () => {
    const h = new ExtensionHost(deps, {}, { registry: new ExtensionRegistry(), autoApprove: true });
    hosts.push(h);
    await h.load([fx("tools-probe")]);
    const { errors } = h.get<{ errors: string[] }>("counter@1", "tools-probe");
    expect(errors[0]).toBe("");
    expect(errors[1]).toMatch(/duplicate/);
    expect(errors[2]).toMatch(/name/);
    expect(errors[3]).toMatch(/description/);
    expect(errors[4]).toBe("");
    expect(errors[5]).toMatch(/invalid tool spec: .*keyArgs.*missing/);
    const tools = h.tools();
    expect(tools.map((t) => `${t.plugin}/${t.spec.name}`)).toEqual([
      "tools-probe/echo",
      "tools-probe/second",
    ]);
    expect(await tools[0]?.handler({}, {} as never)).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("setup 完成后注册抛错", async () => {
    const h = new ExtensionHost(deps, {}, { registry: new ExtensionRegistry(), autoApprove: true });
    hosts.push(h);
    await h.load([fx("tools-probe")]);
    const ctx = (globalThis as { __probeCtx?: ExtensionContext }).__probeCtx as ExtensionContext;
    expect(() =>
      ctx.tools.register({ name: "late", description: "Late.", inputSchema: {} }, async () => ({
        content: [],
      })),
    ).toThrow(/setup/);
    expect(h.tools().map((t) => t.spec.name)).not.toContain("late");
  });

  it("没有注册工具的插件不出现在 host.tools()", async () => {
    const h = new ExtensionHost(deps, {}, { registry: new ExtensionRegistry(), autoApprove: true });
    hosts.push(h);
    await h.load([fx("fixture2")]);
    expect(h.tools()).toEqual([]);
  });
});
