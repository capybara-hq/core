import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  defineExtension,
  type ExtensionManifest,
  ExtensionPermissionError,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conversationTopic } from "../../src/conversations/event-log.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { createExtensionContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
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

const mf = (over: Partial<ExtensionManifest> = {}) =>
  defineExtension({
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
  it("声明的 view 可注册 view 与 action；未声明的 id（含 embed）抛 ExtensionPermissionError；重复抛错", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    ctx.ui.view("tasks", view);
    ctx.ui.action("tasks", action);
    expect(() => ctx.ui.view("tasks", view)).toThrow(/duplicate/);
    expect(() => ctx.ui.action("tasks", action)).toThrow(/duplicate/);
    expect(() => ctx.ui.view("nope", view)).toThrow(ExtensionPermissionError);
    expect(() => ctx.ui.view("board", view)).toThrow(/permissions\.ui\.views board/);
    expect(() => ctx.ui.action("nope", action)).toThrow(ExtensionPermissionError);
    expect([...ctx.uiViews.keys()]).toEqual(["tasks"]);
    expect([...ctx.uiActions.keys()]).toEqual(["tasks"]);
    await ctx.close();
  });

  it("setup 结束后（sealTools）再注册抛错", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    ctx.sealTools();
    expect(() => ctx.ui.view("tasks", view)).toThrow(/only allowed during setup/);
    expect(() => ctx.ui.action("tasks", action)).toThrow(/only allowed during setup/);
    await ctx.close();
  });
});

describe("ctx.ui.invalidate", () => {
  it("带 conversationId → 内核主题 conv.<id>；不带 → org-ui.<orgId>；消息为 {kind:'ui', plugin, contribution}", async () => {
    const c = await seed();
    const conv = await conversation(c);
    const kernelBus = createBus(redis, sub, "kernel", quiet);
    const got: { topic: string; m: unknown }[] = [];
    const un1 = await kernelBus.subscribe(conversationTopic(conv), (m) =>
      got.push({ topic: "conv", m }),
    );
    const un2 = await kernelBus.subscribe(orgUiTopic(c.orgId), (m) =>
      got.push({ topic: "org", m }),
    );
    const ctx = createExtensionContext(deps, mf(), {});
    await ctx.ui.invalidate({ orgId: c.orgId, conversationId: conv, contribution: "tasks" });
    await ctx.ui.invalidate({ orgId: c.orgId, contribution: "board" });
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

  it("插件未在该组织启用、对话不属于该组织或不存在 → 不发刷新（只记 debug），不抛错", async () => {
    const c = await seed();
    const conv = await conversation(c);
    const off = await seed("member", false);
    const offConv = await conversation(off);
    const debug: string[] = [];
    const log = { ...quiet, debug: (msg: string) => debug.push(msg) };
    const kernelBus = createBus(redis, sub, "kernel", quiet);
    const got: unknown[] = [];
    const uns = await Promise.all(
      [conversationTopic(conv), conversationTopic(offConv), orgUiTopic(off.orgId)].map((t) =>
        kernelBus.subscribe(t, (m) => got.push({ t, m })),
      ),
    );
    const ctx = createExtensionContext({ ...deps, log }, mf(), {});
    await ctx.ui.invalidate({ orgId: off.orgId, contribution: "board" });
    await ctx.ui.invalidate({ orgId: off.orgId, conversationId: offConv, contribution: "tasks" });
    // 别的组织的对话、不存在的对话
    await ctx.ui.invalidate({ orgId: c.orgId, conversationId: offConv, contribution: "tasks" });
    await ctx.ui.invalidate({ orgId: c.orgId, conversationId: CONV, contribution: "tasks" });
    expect(debug).toHaveLength(4);
    // 之后一条合法的刷新照常到达，且是唯一一条
    await ctx.ui.invalidate({ orgId: c.orgId, conversationId: conv, contribution: "tasks" });
    await waitFor(async () => got.length >= 1, 5000, "valid ui message");
    expect(got).toEqual([
      { t: conversationTopic(conv), m: expect.objectContaining({ kind: "ui" }) },
    ]);
    for (const un of uns) await un();
    await ctx.close();
  });

  it("清单里没有的贡献、缺 orgId、conversationId 不是 UUID → 抛错", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
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

  /** 真实的组织、账号、成员关系与启用记录（invalidate / verifyEmbedToken 各用一条查询核对它们）。 */
  const seed = async (role: "owner" | "admin" | "member" | "guest" = "member", enabled = true) => {
    const n = randomUUID();
    const orgId = `o-${n}`;
    const accountId = `a-${n}`;
    await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'a')`.execute(
      deps.db,
    );
    await sql`INSERT INTO capybara.orgs (id, slug, name) VALUES (${orgId}, ${orgId}, 'o')`.execute(
      deps.db,
    );
    await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
      VALUES (${orgId}, ${accountId}, ${role})`.execute(deps.db);
    await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
      VALUES ('ui-test', ${orgId}, ${enabled})`.execute(deps.db);
    return { orgId, accountId };
  };
  /** 该组织里的一个对话（连带一个 agent）。 */
  const conversation = async (c: { orgId: string; accountId: string }) => {
    const id = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${`ag-${id}`}, ${c.orgId}, ${c.accountId}, 'org', 1)`.execute(deps.db);
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${id}, ${c.orgId}, ${`ag-${id}`}, ${c.accountId})`.execute(deps.db);
    return id;
  };
  const issue = (
    c: { orgId: string; accountId: string },
    over: { plugin?: string; contribution?: string; role?: "member" | "guest" } = {},
    ring = deps.keyring,
  ) =>
    new EmbedTokens(ring).issue({
      plugin: over.plugin ?? "ui-test",
      orgId: c.orgId,
      accountId: c.accountId,
      contribution: over.contribution ?? "board",
      role: over.role ?? "member",
    }).token;

  it("verifyEmbedToken：同一主密钥签给本插件的令牌通过；签给别的插件、别的主密钥、乱写的一律 null", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    const c = await seed();
    expect(await ctx.ui.verifyEmbedToken(issue(c))).toEqual(
      expect.objectContaining({ plugin: "ui-test", ...c, role: "member" }),
    );
    expect(await ctx.ui.verifyEmbedToken(issue(c, { plugin: "other" }))).toBeNull();
    const foreign = issue(c, {}, createKeyring(Buffer.alloc(32, 9), []));
    expect(await ctx.ui.verifyEmbedToken(foreign)).toBeNull();
    expect(await ctx.ui.verifyEmbedToken("x")).toBeNull();
    await ctx.close();
  });

  it("verifyEmbedToken：插件此刻未在令牌的组织启用 → null（每次都查，不缓存）", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    const c = await seed();
    const token = issue(c);
    const setEnabled = (on: boolean) =>
      sql`UPDATE capybara.extension_org_configs SET enabled = ${on} WHERE org_id = ${c.orgId}`.execute(
        deps.db,
      );
    expect(await ctx.ui.verifyEmbedToken(token)).not.toBeNull();
    await setEnabled(false);
    expect(await ctx.ui.verifyEmbedToken(token)).toBeNull();
    await setEnabled(true);
    expect(await ctx.ui.verifyEmbedToken(token)).not.toBeNull();
    await ctx.close();
  });

  it("verifyEmbedToken：已离开组织、账号停用、组织已删除 → null", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    const offboarded = await seed();
    const t1 = issue(offboarded);
    expect(await ctx.ui.verifyEmbedToken(t1)).not.toBeNull();
    await sql`DELETE FROM capybara.memberships WHERE org_id = ${offboarded.orgId}`.execute(deps.db);
    expect(await ctx.ui.verifyEmbedToken(t1)).toBeNull();

    const disabled = await seed();
    const t2 = issue(disabled);
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${disabled.accountId}`.execute(
      deps.db,
    );
    expect(await ctx.ui.verifyEmbedToken(t2)).toBeNull();

    const deleted = await seed();
    const t3 = issue(deleted);
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${deleted.orgId}`.execute(
      deps.db,
    );
    expect(await ctx.ui.verifyEmbedToken(t3)).toBeNull();
    await ctx.close();
  });

  it("verifyEmbedToken：返回当前角色；被降为 guest 后组织页面的令牌失效，对话位置的照常", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    const c = await seed("admin");
    const page = issue(c);
    const conv = issue(c, { contribution: "tasks" });
    expect(await ctx.ui.verifyEmbedToken(page)).toMatchObject({ role: "admin" });
    await sql`UPDATE capybara.memberships SET role = 'guest' WHERE org_id = ${c.orgId}`.execute(
      deps.db,
    );
    expect(await ctx.ui.verifyEmbedToken(page)).toBeNull();
    expect(await ctx.ui.verifyEmbedToken(conv)).toMatchObject({ role: "guest" });
    await ctx.close();
  });
});
