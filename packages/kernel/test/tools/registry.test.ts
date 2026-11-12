import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { createLogger } from "../../src/log.js";
import { parseOrgSettings } from "../../src/orgs/settings.service.js";
import { toolSearchTool } from "../../src/tools/builtins/tool-search.js";
import { OrgToolSwitches } from "../../src/tools/org-tool-switches.js";
import {
  canonicalJson,
  DISPLAY_ONLY_SPEC_FIELDS,
  specHash,
  ToolRegistry,
} from "../../src/tools/registry.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, orgSettingsFor } from "../helpers/identity.js";
import {
  enableConnectorExtensions,
  enableExtensions,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { kernelDbFor } from "../helpers/tools.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const ORGLEVELS = fileURLToPath(new URL("../fixtures/plugins/orglevels/index.ts", import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let registry: ToolRegistry;
let req: ReturnType<typeof asUser>;
let orgId: string;

const PW = "correct horse battery";
const log = createLogger("error", { write: () => {} });

const askUser = {
  spec: {
    name: "AskUserQuestion",
    description: "Ask the user a question.",
    inputSchema: { type: "object" },
  },
  defaultPolicy: "allow" as const,
  run: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [MEM_CONNECTOR, ORGLEVELS],
      // the platform leaves the overridable `apiKey` empty: a following org must configure it
      extensionConfig: { orglevels: { host: "h", baseUrl: "https://platform.example" } },
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: log },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  registry = new ToolRegistry(
    kernelDbFor(db),
    k.app.get(ExtensionHost),
    k.app.get(ExtensionHost),
    { list: () => [askUser] },
    k.app.get(EffectiveConfigs),
    k.app.get(OrgToolSwitches),
  );
}, 120_000);
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  memState().servers = {
    open: {
      tools: [
        {
          name: "read",
          description: "Read.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "write", description: "Write.", inputSchema: { type: "object" } },
        { name: "drop", description: "Drop.", inputSchema: { type: "object" } },
      ],
    },
  };
  req = asUser(k.http, cookieJar());
  expect(
    (
      await req({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { login: "owner", password: PW },
      })
    ).statusCode,
  ).toBe(200);
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
});

async function installConnector(slug: string): Promise<string> {
  await enableConnectorExtensions(k, orgId);
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors`,
    payload: {
      name: slug,
      slug,
      connector: "mem",
      endpoint: { server: "open" },
      auth: { type: "none" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { connector: { id: string } }).connector.id;
}

async function enablePlugin(plugin: string, enabled: boolean): Promise<void> {
  const res = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe("ToolRegistry", () => {
  it("canonicalJson 键排序；specHash 为 16 位十六进制且与键顺序无关", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    const h = specHash({ name: "x", description: "d", inputSchema: { type: "object" } });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(specHash({ inputSchema: { type: "object" }, description: "d", name: "x" })).toBe(h);
  });

  it("specHash leaves out the display-only title and keyArgs", () => {
    expect([...DISPLAY_ONLY_SPEC_FIELDS]).toEqual(["title", "keyArgs"]);
    const s = {
      name: "search",
      description: "Search.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    };
    expect(specHash({ ...s, title: "X", keyArgs: ["q"] })).toBe(specHash(s));
    expect(specHash({ ...s, title: "Y" })).toBe(specHash({ ...s, title: "X" }));
    // Everything else still counts.
    expect(specHash({ ...s, description: "Search!" })).not.toBe(specHash(s));
  });

  it("specHash of a fixed pre-B spec is pinned: display fields leave old fingerprints alone", () => {
    // Computed with the algorithm before UI refresh B. A change to DISPLAY_ONLY_SPEC_FIELDS or
    // canonicalJson that moves it would drop remembered grants and mark eval cases spec-changed.
    const FIXED = {
      name: "search",
      description: "Search documents.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      annotations: { readOnlyHint: true },
    };
    expect(specHash(FIXED)).toBe("6cf0248e7eacad8c");
    expect(specHash({ ...FIXED, title: "Search", keyArgs: ["q"] })).toBe("6cf0248e7eacad8c");
  });

  it("connector(kind) 按 kind 查找；未安装抛错", () => {
    expect(registry.connector("mem").kind).toBe("mem");
    expect(() => registry.connector("nope")).toThrow();
  });

  /** The connector extension's own tools turned off (installConnector enables it). */
  const MEM_OFF = { kind: "plugin" as const, plugin: "mem-connector", tools: "all" as const };
  const ASK_OFF = { kind: "builtin" as const, name: "AskUserQuestion" };

  it("resolves every builtin, every tool of the extensions on in the org and every connector tool", async () => {
    const connectorId = await installConnector("docs");
    const def = { disabledTools: [] };
    await enablePlugin("mem-connector", false);
    const before = await registry.forAgent(orgId, { ...def, source: "web" });
    expect(before.tools.map((t) => t.key)).toEqual([
      "AskUserQuestion",
      "mcp__docs__drop",
      "mcp__docs__read",
      "mcp__docs__write",
    ]);
    // an extension that is off in the org is simply not offered (no reminder)
    expect(before.unavailable).toEqual([]);

    await enablePlugin("mem-connector", true);
    const after = await registry.forAgent(orgId, { ...def, source: "web" });
    expect(after.unavailable).toEqual([]);
    expect(after.tools.map((t) => t.key)).toEqual([
      "AskUserQuestion",
      "plugin__mem-connector__echo",
      "plugin__mem-connector__ask",
      "plugin__mem-connector__wipe",
      "mcp__docs__drop",
      "mcp__docs__read",
      "mcp__docs__write",
    ]);
    const byKey = Object.fromEntries(after.tools.map((t) => [t.key, t]));
    expect(byKey.AskUserQuestion).toMatchObject({
      source: { kind: "builtin", name: "AskUserQuestion" },
      defaultPolicy: "allow",
    });
    expect(byKey["plugin__mem-connector__echo"]).toMatchObject({
      source: { kind: "plugin", plugin: "mem-connector", name: "echo" },
      defaultPolicy: "allow", // readOnlyHint
    });
    // 插件显式声明 defaultPolicy 优先于注解
    expect(byKey["plugin__mem-connector__wipe"]?.defaultPolicy).toBe("allow");
    expect(byKey.mcp__docs__read).toMatchObject({
      source: { kind: "connector", connectorId, name: "read" },
      defaultPolicy: "allow",
    });
    expect(byKey.mcp__docs__write?.defaultPolicy).toBe("ask");
    expect(byKey.mcp__docs__read?.spec.description).toBe("Read.");
    expect(byKey.mcp__docs__read?.specHash).toBe(specHash(byKey.mcp__docs__read?.spec));
    expect(byKey.AskUserQuestion?.specHash).toBe(specHash(askUser.spec));

    // turned off: a builtin, one extension tool, one connector tool
    const off = await registry.forAgent(orgId, {
      source: "web",
      disabledTools: [
        ASK_OFF,
        { kind: "plugin", plugin: "mem-connector", tools: ["wipe", "ask"] },
        { kind: "connector", connectorId, tools: ["drop"] },
      ],
    });
    expect(off.tools.map((t) => t.key)).toEqual([
      "plugin__mem-connector__echo",
      "mcp__docs__read",
      "mcp__docs__write",
    ]);
  });

  it("leaves out disabled, pending and deleted tools and connectors, explaining them in hidden", async () => {
    const connectorId = await installConnector("docs");
    await db
      .updateTable("connector_tools")
      .set({ status: "disabled" })
      .where("connector_id", "=", connectorId)
      .where("name", "=", "write")
      .execute();
    await db
      .updateTable("connector_tools")
      .set({ status: "pending_review" })
      .where("connector_id", "=", connectorId)
      .where("name", "=", "drop")
      .execute();
    await db
      .updateTable("connector_tools")
      .set({ default_policy: "deny" })
      .where("connector_id", "=", connectorId)
      .where("name", "=", "read")
      .execute();

    // only enabled tools; disabled / pending ones never reach `unavailable` (no reminder every
    // step), but `hidden`, for the facts when the model names one (spec 6.3)
    const all = await registry.forAgent(orgId, {
      source: "web",
      disabledTools: [ASK_OFF, MEM_OFF],
    });
    expect(all.tools.map((t) => t.key)).toEqual(["mcp__docs__read"]);
    expect(all.tools[0]?.defaultPolicy).toBe("deny");
    expect(all.unavailable).toEqual([]);
    expect(all.hidden).toEqual([
      { ref: "mcp__docs__drop", reason: "Tool is pending review" },
      { ref: "mcp__docs__write", reason: "Tool is disabled" },
    ]);

    // a tool the agent turned off is not explained: it is its own choice
    const own = await registry.forAgent(orgId, {
      source: "web",
      disabledTools: [ASK_OFF, MEM_OFF, { kind: "connector", connectorId, tools: ["drop"] }],
    });
    expect(own.hidden).toEqual([{ ref: "mcp__docs__write", reason: "Tool is disabled" }]);

    // a disabled connector goes as a whole
    await db
      .updateTable("connectors")
      .set({ status: "disabled" })
      .where("id", "=", connectorId)
      .execute();
    const disabled = await registry.forAgent(orgId, {
      source: "web",
      disabledTools: [ASK_OFF, MEM_OFF],
    });
    expect(disabled.tools).toEqual([]);
    expect(disabled.unavailable).toEqual([]);
    expect(disabled.hidden).toEqual([{ ref: "mcp__docs__*", reason: "App docs is disabled" }]);

    // a deleted one is gone
    const del = await req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}`,
    });
    expect(del.statusCode).toBe(204);
    const deleted = await registry.forAgent(orgId, {
      source: "web",
      disabledTools: [ASK_OFF, MEM_OFF],
    });
    expect(deleted.tools).toEqual([]);
    expect(deleted.hidden).toEqual([]);

    // another org's connector never reaches this org
    const other = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Other" } });
    const otherId = (other.json() as { org: { id: string } }).org.id;
    await installConnector("docs2");
    const cross = await registry.forAgent(otherId, {
      source: "web",
      disabledTools: [ASK_OFF, MEM_OFF],
    });
    expect(cross.tools).toEqual([]);
  });

  it("an extension tool is not offered in an org that must configure the extension (spec A §6)", async () => {
    const def = { disabledTools: [ASK_OFF] };
    await enablePlugin("orglevels", true);
    // following the platform, which leaves the required overridable apiKey empty
    const following = await registry.forAgent(orgId, { ...def, source: "web" });
    expect(following.tools).toEqual([]);
    expect(following.unavailable).toEqual([]);
    expect(following.hidden).toEqual([
      {
        ref: "plugin__orglevels__echo",
        reason: "Plugin orglevels needs configuration in this organization",
      },
    ]);

    // a valid copy of the org's own: the same agent gets the tool
    const saved = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orglevels/overrides`,
      payload: { values: { baseUrl: "https://org.example", apiKey: "ok-Qw72org" } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const copied = await registry.forAgent(orgId, { ...def, source: "web" });
    expect(copied.unavailable).toEqual([]);
    expect(copied.tools.map((t) => t.key)).toEqual(["plugin__orglevels__echo"]);
  });

  it("an extension tool the org turned off is offered to no agent there, and only there (spec A §7)", async () => {
    const def = {
      disabledTools: [
        ASK_OFF,
        { kind: "plugin" as const, plugin: "mem-connector", tools: ["ask"] },
      ],
    };
    await enablePlugin("mem-connector", true);
    const other = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Other" } });
    const otherId = (other.json() as { org: { id: string } }).org.id;
    await enableExtensions(raw, otherId, "mem-connector");
    await db
      .insertInto("org_tool_switches")
      .values({ org_id: orgId, plugin: "mem-connector", tool: "echo", enabled: false })
      .execute();
    const here = await registry.forAgent(orgId, { ...def, source: "web" });
    expect(here.tools.map((t) => t.key)).toEqual(["plugin__mem-connector__wipe"]);
    expect(here.unavailable).toEqual([]);
    expect(here.hidden).toEqual([
      {
        ref: "plugin__mem-connector__echo",
        reason: "Tool plugin__mem-connector__echo is turned off in this organization",
      },
    ]);
    const there = await registry.forAgent(otherId, { ...def, source: "web" });
    expect(there.tools.map((t) => t.key)).toEqual([
      "plugin__mem-connector__echo",
      "plugin__mem-connector__wipe",
    ]);
  });

  it("overlapping entries in disabledTools are harmless", async () => {
    const connectorId = await installConnector("docs");
    const r = await registry.forAgent(orgId, {
      source: "web",
      disabledTools: [
        MEM_OFF,
        { kind: "connector", connectorId, tools: ["read"] },
        { kind: "connector", connectorId, tools: ["read", "drop"] },
      ],
    });
    expect(r.tools.map((t) => t.key)).toEqual(["AskUserQuestion", "mcp__docs__write"]);
    expect(r.unavailable).toEqual([]);
  });
});

describe("组织设置与 ToolSearch 启用条件", () => {
  const baseCfg = KernelConfigSchema.parse({
    db: { url: "postgres://x/y" },
    redis: { url: "redis://x" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
  });
  let thresholds = { searchThresholdTools: 30, searchThresholdTokens: 8000 };
  const cfg = (): KernelConfig => ({ ...baseCfg, tools: { ...baseCfg.tools, ...thresholds } });
  const searchRegistry = () =>
    new ToolRegistry(
      kernelDbFor(db),
      k.app.get(ExtensionHost),
      k.app.get(ExtensionHost),
      { list: () => [askUser, toolSearchTool()] },
      k.app.get(EffectiveConfigs),
      k.app.get(OrgToolSwitches),
      { get: cfg },
    );
  const settingsUrl = () => `/api/v1/orgs/${orgId}/settings`;

  beforeEach(() => {
    thresholds = { searchThresholdTools: 30, searchThresholdTokens: 8000 };
  });

  /** The scheduled-task group the settings read always carries (defaults, spec §9). */
  const SCHEDULED_TASK_DEFAULTS = parseOrgSettings({}).scheduledTasks;

  it("GET 默认 toolSearch=on；PATCH 需 org.update，非法值 400，改动写审计", async () => {
    const got = await req({ method: "GET", url: settingsUrl() });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json()).toEqual({
      settings: {
        toolSearch: "on",
        locale: "en",
        sandboxToolPolicy: "allow",
        platformTool: "on",
        scheduledTasks: SCHEDULED_TASK_DEFAULTS,
      },
      deployment: {
        sandboxEgress: { mode: "allowlist", allowHosts: baseCfg.sandbox.limits.allowHosts },
        sandboxTiers: {
          max: "dev",
          default: "dev",
          allowUnsandboxed: true,
          devHosts: baseCfg.sandbox.limits.devHosts,
        },
      },
      // 组织级沙箱限额只读（C19）：没有超级管理员的覆盖时取部署默认
      sandboxLimits: {
        cpu: baseCfg.sandbox.limits.cpu,
        memoryMb: baseCfg.sandbox.limits.memoryMb,
        source: "deployment",
      },
    });

    const bad = await req({
      method: "PATCH",
      url: settingsUrl(),
      payload: { toolSearch: "maybe" },
    });
    expect(bad.statusCode).toBe(400);
    const extra = await req({ method: "PATCH", url: settingsUrl(), payload: { other: 1 } });
    expect(extra.statusCode).toBe(400);

    const off = await req({ method: "PATCH", url: settingsUrl(), payload: { toolSearch: "off" } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({
      settings: { toolSearch: "off", locale: "en", sandboxToolPolicy: "allow", platformTool: "on" },
    });
    expect((await req({ method: "GET", url: settingsUrl() })).json()).toMatchObject({
      settings: { toolSearch: "off", locale: "en", sandboxToolPolicy: "allow", platformTool: "on" },
    });
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "org.settings_updated")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toEqual({
      before: {
        toolSearch: "on",
        locale: "en",
        sandboxToolPolicy: "allow",
        platformTool: "on",
        scheduledTasks: SCHEDULED_TASK_DEFAULTS,
      },
      after: {
        toolSearch: "off",
        locale: "en",
        sandboxToolPolicy: "allow",
        platformTool: "on",
        scheduledTasks: SCHEDULED_TASK_DEFAULTS,
      },
    });

    // 存量 jsonb 里的未知键保留、非法值按默认读
    await sql`UPDATE capybara.orgs SET settings = '{"toolSearch":"bogus","future":1}'::jsonb
      WHERE id = ${orgId}`.execute(raw);
    expect((await req({ method: "GET", url: settingsUrl() })).json().settings).toEqual({
      toolSearch: "on",
      locale: "en",
      sandboxToolPolicy: "allow",
      platformTool: "on",
      scheduledTasks: SCHEDULED_TASK_DEFAULTS,
    });
    await req({ method: "PATCH", url: settingsUrl(), payload: { toolSearch: "off" } });
    const row = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(row.settings).toEqual({
      toolSearch: "off",
      locale: "en",
      sandboxToolPolicy: "allow",
      platformTool: "on",
      scheduledTasks: SCHEDULED_TASK_DEFAULTS,
      future: 1,
    });

    // the Platform tool's org switch: on / read-only / off, anything else 400
    const badPlatform = await req({
      method: "PATCH",
      url: settingsUrl(),
      payload: { platformTool: "maybe" },
    });
    expect(badPlatform.statusCode).toBe(400);
    const readOnly = await req({
      method: "PATCH",
      url: settingsUrl(),
      payload: { platformTool: "read-only" },
    });
    expect(readOnly.statusCode, readOnly.body).toBe(200);
    expect(readOnly.json().settings.platformTool).toBe("read-only");

    // 成员能读不能改
    await sql`UPDATE capybara.memberships SET role = 'member' WHERE org_id = ${orgId}`.execute(raw);
    const denied = await req({
      method: "PATCH",
      url: settingsUrl(),
      payload: { toolSearch: "on" },
    });
    expect(denied.statusCode).toBe(403);
    expect((await req({ method: "GET", url: settingsUrl() })).statusCode).toBe(200);
  });

  it("sandboxEgress（Ruling M19）：校验主机、无 open、上限 200；null 清除；部署 none 时只能设 none", async () => {
    const patch = (sandboxEgress: unknown) =>
      req({ method: "PATCH", url: settingsUrl(), payload: { sandboxEgress } });
    for (const bad of [
      { mode: "open" },
      { mode: "allowlist", allowHosts: ["10.0.0.1"] },
      { mode: "allowlist", allowHosts: ["localhost"] },
      { mode: "allowlist", allowHosts: ["Example.com"] },
      { mode: "allowlist", allowHosts: ["a.example.com", "a.example.com"] },
      { mode: "allowlist", allowHosts: Array.from({ length: 201 }, (_, i) => `h${i}.example.com`) },
      { mode: "none", extra: 1 },
    ]) {
      const r = await patch(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const ok = await patch({
      mode: "allowlist",
      allowHosts: ["registry.npmjs.org", "*.corp.example.org"],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().settings.sandboxEgress).toEqual({
      mode: "allowlist",
      allowHosts: ["registry.npmjs.org", "*.corp.example.org"],
    });
    // 同值再改是空操作（对象按值比较），不多写审计
    await patch({ mode: "allowlist", allowHosts: ["registry.npmjs.org", "*.corp.example.org"] });
    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "=", "org.settings_updated")
      .execute();
    expect(audits).toHaveLength(1);
    const cleared = await patch(null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().settings).not.toHaveProperty("sandboxEgress");
    const row = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(row.settings).not.toHaveProperty("sandboxEgress");

    // 部署 egress none：组织只能设 none
    const ownerId = (await db.selectFrom("accounts").select("id").executeTakeFirstOrThrow()).id;
    const none = orgSettingsFor(db, () => ({
      sandbox: { ...baseCfg.sandbox, limits: { ...baseCfg.sandbox.limits, egress: "none" } },
    }));
    const err = await none
      .update(orgId, { sandboxEgress: { mode: "allowlist" } }, ownerId)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "org.sandbox_egress_not_allowed" });
    expect(await none.update(orgId, { sandboxEgress: { mode: "none" } }, ownerId)).toMatchObject({
      sandboxEgress: { mode: "none" },
    });
    expect(none.deployment().sandboxEgress).toEqual({
      mode: "none",
      allowHosts: baseCfg.sandbox.limits.allowHosts,
    });
  });

  it("sandboxTier: never above the platform, default at most max, unsandboxed only where the platform allows; null clears; an invalid stored value reads as max strict", async () => {
    const patch = (sandboxTier: unknown) =>
      req({ method: "PATCH", url: settingsUrl(), payload: { sandboxTier } });
    for (const bad of [{ max: "wide" }, { extra: 1 }, { allowUnsandboxed: "yes" }]) {
      const r = await patch(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
    // the platform default max is dev
    for (const bad of [{ max: "open" }, { default: "open" }, { max: "strict", default: "dev" }]) {
      const r = await patch(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error.code).toBe("org.sandbox_tier_not_allowed");
    }
    const ok = await patch({ max: "dev", default: "strict", allowUnsandboxed: false });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().settings.sandboxTier).toEqual({
      max: "dev",
      default: "strict",
      allowUnsandboxed: false,
    });
    const cleared = await patch(null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().settings).not.toHaveProperty("sandboxTier");
    // an empty object is the same as following the platform
    expect((await patch({})).json().settings).not.toHaveProperty("sandboxTier");

    const ownerId = (await db.selectFrom("accounts").select("id").executeTakeFirstOrThrow()).id;
    const open = orgSettingsFor(db, () => ({
      sandbox: {
        ...baseCfg.sandbox,
        tiers: { max: "open", default: "dev", allowUnsandboxed: false },
      },
    }));
    expect(await open.update(orgId, { sandboxTier: { max: "open" } }, ownerId)).toMatchObject({
      sandboxTier: { max: "open" },
    });
    expect(
      await open
        .update(orgId, { sandboxTier: { max: "open", allowUnsandboxed: true } }, ownerId)
        .catch((e: unknown) => e),
    ).toMatchObject({ code: "org.sandbox_tier_not_allowed" });
    expect(open.deployment().sandboxTiers).toMatchObject({
      max: "open",
      default: "dev",
      allowUnsandboxed: false,
    });
    expect(open.sandboxPolicy(await open.get(orgId), null)).toMatchObject({
      tier: "dev",
      ceiling: "open",
      allowUnsandboxed: false,
    });

    // a stored value this version cannot read narrows to strict, never widens
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ sandboxTier: { max: "everything" } }) })
      .where("id", "=", orgId)
      .execute();
    expect((await req({ method: "GET", url: settingsUrl() })).json().settings.sandboxTier).toEqual({
      max: "strict",
    });
    await patch(null);
  });

  it("阈值切换：工具数或定义估算超过阈值才启用并自动加入 ToolSearch；组织关闭后全部直接加载", async () => {
    const connectorId = await installConnector("docs");
    expect(connectorId).toBeTruthy();
    const def = {
      disabledTools: [{ kind: "plugin" as const, plugin: "mem-connector", tools: "all" as const }],
    };
    const r = searchRegistry();
    // 4 个工具，未超过阈值
    const below = await r.forAgent(orgId, { ...def, source: "web" });
    expect(below.toolSearch).toBe(false);
    expect(below.tools.map((t) => t.key)).toEqual([
      "AskUserQuestion",
      "mcp__docs__drop",
      "mcp__docs__read",
      "mcp__docs__write",
    ]);
    expect(below.unavailable).toEqual([]);

    thresholds.searchThresholdTools = 3;
    const byCount = await r.forAgent(orgId, { ...def, source: "web" });
    expect(byCount.toolSearch).toBe(true);
    expect(byCount.tools.map((t) => t.key)).toEqual([
      "AskUserQuestion",
      "mcp__docs__drop",
      "mcp__docs__read",
      "mcp__docs__write",
      "ToolSearch",
    ]);
    expect(byCount.tools.at(-1)).toMatchObject({
      source: { kind: "builtin", name: "ToolSearch" },
      defaultPolicy: "allow",
    });

    thresholds = { searchThresholdTools: 30, searchThresholdTokens: 10 };
    expect((await r.forAgent(orgId, { ...def, source: "web" })).toolSearch).toBe(true);

    const patched = await req({
      method: "PATCH",
      url: settingsUrl(),
      payload: { toolSearch: "off" },
    });
    expect(patched.statusCode).toBe(200);
    const off = await r.forAgent(orgId, { ...def, source: "web" });
    expect(off.toolSearch).toBe(false);
    expect(off.tools.map((t) => t.key)).not.toContain("ToolSearch");
    expect(off.tools).toHaveLength(4);

    // 没有 config 的注册表（旧调用方）从不启用
    expect((await registry.forAgent(orgId, { ...def, source: "web" })).toolSearch).toBe(false);
  });
});
