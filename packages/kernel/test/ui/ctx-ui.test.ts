import { fileURLToPath } from "node:url";
import { definePlugin, type PluginManifest, PluginPermissionError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conversationTopic } from "../../src/conversations/event-log.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { createPluginContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";
import { orgUiTopic } from "../../src/ui/registry.js";
import { waitFor } from "../helpers/runs.js";

/** `ctx.ui`：view / action 只能在 setup 期间按 permissions.ui.views 注册；invalidate 经内核 bus 发刷新。 */

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
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
}, 120_000);
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await deps?.db.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});

const mf = (over: Partial<PluginManifest> = {}) =>
  definePlugin({
    name: "ui-test",
    version: "0.1.0",
    sdk: "^0.1.0",
    provides: [],
    ui: [
      { id: "tasks", title: { zh: "任务", en: "Tasks" }, place: "conversation", kind: "view" },
      {
        id: "board",
        title: { zh: "看板", en: "Board" },
        place: "page",
        kind: "embed",
        path: "/ui/board",
      },
    ],
    permissions: {
      http: [{ method: "GET", path: "/ui/board" }],
      ui: { views: ["tasks"], embeds: ["board"] },
    },
    setup() {},
    ...over,
  });

const view = async () => ({ blocks: [] });
const CONV = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const action = async () => ({ toast: { zh: "好", en: "OK" } });

describe("ctx.ui 注册", () => {
  it("声明的 view 可注册 view 与 action；未声明的 id（含 embed）抛 PluginPermissionError；重复抛错", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    ctx.ui.view("tasks", view);
    ctx.ui.action("tasks", action);
    expect(() => ctx.ui.view("tasks", view)).toThrow(/duplicate/);
    expect(() => ctx.ui.action("tasks", action)).toThrow(/duplicate/);
    expect(() => ctx.ui.view("nope", view)).toThrow(PluginPermissionError);
    expect(() => ctx.ui.view("board", view)).toThrow(/permissions\.ui\.views board/);
    expect(() => ctx.ui.action("nope", action)).toThrow(PluginPermissionError);
    expect([...ctx.uiViews.keys()]).toEqual(["tasks"]);
    expect([...ctx.uiActions.keys()]).toEqual(["tasks"]);
    await ctx.close();
  });

  it("setup 结束后（sealTools）再注册抛错", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    ctx.sealTools();
    expect(() => ctx.ui.view("tasks", view)).toThrow(/only allowed during setup/);
    expect(() => ctx.ui.action("tasks", action)).toThrow(/only allowed during setup/);
    await ctx.close();
  });
});

describe("ctx.ui.invalidate", () => {
  it("带 conversationId → 内核主题 conv.<id>；不带 → org-ui.<orgId>；消息为 {kind:'ui', plugin, contribution}", async () => {
    const kernelBus = createBus(redis, sub, "kernel", quiet);
    const got: { topic: string; m: unknown }[] = [];
    const un1 = await kernelBus.subscribe(conversationTopic(CONV), (m) =>
      got.push({ topic: "conv", m }),
    );
    const un2 = await kernelBus.subscribe(orgUiTopic("o-1"), (m) => got.push({ topic: "org", m }));
    const ctx = createPluginContext(deps, mf(), {});
    await ctx.ui.invalidate({ orgId: "o-1", conversationId: CONV, contribution: "tasks" });
    await ctx.ui.invalidate({ orgId: "o-1", contribution: "board" });
    await waitFor(async () => got.length === 2, 5000, "two ui messages");
    expect(got).toEqual([
      { topic: "conv", m: { kind: "ui", plugin: "ui-test", contribution: "tasks" } },
      { topic: "org", m: { kind: "ui", plugin: "ui-test", contribution: "board" } },
    ]);
    expect(orgUiTopic("o-1")).toBe("org-ui.o-1");
    await un1();
    await un2();
    await ctx.close();
  });

  it("清单里没有的贡献、缺 orgId、conversationId 不是 UUID → 抛错", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    await expect(ctx.ui.invalidate({ orgId: "o", contribution: "nope" })).rejects.toThrow(
      /not a ui contribution/,
    );
    await expect(ctx.ui.invalidate({ orgId: "", contribution: "tasks" } as never)).rejects.toThrow(
      /orgId/,
    );
    await expect(
      ctx.ui.invalidate({ orgId: "o", conversationId: "c-1", contribution: "tasks" }),
    ).rejects.toThrow(/conversationId must be a UUID/);
    await ctx.close();
  });

  it("verifyEmbedToken：同一主密钥签给本插件的令牌通过；签给别的插件、别的主密钥、乱写的一律 null", async () => {
    const ctx = createPluginContext(deps, mf(), {});
    const claims = { orgId: "o1", accountId: "a1", contribution: "board" };
    const mine = new EmbedTokens(deps.keyring).issue({ plugin: "ui-test", ...claims }).token;
    expect(await ctx.ui.verifyEmbedToken(mine)).toEqual(
      expect.objectContaining({ plugin: "ui-test", orgId: "o1", accountId: "a1" }),
    );
    const theirs = new EmbedTokens(deps.keyring).issue({ plugin: "other", ...claims }).token;
    expect(await ctx.ui.verifyEmbedToken(theirs)).toBeNull();
    const foreign = new EmbedTokens(createKeyring(Buffer.alloc(32, 9), [])).issue({
      plugin: "ui-test",
      ...claims,
    }).token;
    expect(await ctx.ui.verifyEmbedToken(foreign)).toBeNull();
    expect(await ctx.ui.verifyEmbedToken("x")).toBeNull();
    await ctx.close();
  });
});
