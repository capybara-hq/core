import { fileURLToPath } from "node:url";
import { ToolError, type ToolResult } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { ExtensionPointDefaults } from "../../src/extensions/point-defaults.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { DirectorySync } from "../../src/orgs/directory-sync.js";
import { fetchPage } from "../../src/tools/builtins/web/fetch.js";
import { webSearchTool } from "../../src/tools/builtins/web/search.js";
import { type OrgCall, orgCalls } from "../fixtures/plugins/orgcalls/index.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Layering spec A §6: every call the kernel makes for an org carries the extension's effective
 * config for that org (`config`), and an org whose effective config is not valid gets no call.
 * `orgcalls` records what each callback received. Org A follows the platform, org B keeps a copy
 * (`baseUrl` "org-b"), org C's copy lost its secret (not valid: "needs configuration"), and org D's
 * copy sets `baseUrl` "off", which the provider's `configured()` refuses.
 */

const ORGCALLS = fileURLToPath(new URL("../fixtures/plugins/orgcalls/index.ts", import.meta.url));
const PLATFORM_URL = "https://platform.example";
const PK = "pk-Zx81platform";
const NONE_REASON =
  "No web search provider is enabled in this organization; ask an org admin to enable one.";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgA: string;
let orgB: string;
let orgC: string;
let orgD: string;

const platformCfg = { baseUrl: PLATFORM_URL, apiKey: "set" };
const copyB = { baseUrl: "org-b", apiKey: "set" };

async function copy(orgId: string, values: Record<string, unknown>): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/orgcalls/overrides`,
    payload: { values },
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, ORGCALLS],
        extensionConfig: { orgcalls: { baseUrl: PLATFORM_URL, apiKey: PK } },
      },
    ),
  );
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  [orgA, orgB, orgC, orgD] = [
    await createOrg(owner, "Alpha"),
    await createOrg(owner, "Beta"),
    await createOrg(owner, "Gamma"),
    await createOrg(owner, "Delta"),
  ];
  for (const org of [orgA, orgB, orgC, orgD]) {
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${org}/extensions/orgcalls`,
      payload: { enabled: true },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  await copy(orgB, { baseUrl: "org-b", apiKey: "ok-b-Qw72org" });
  await copy(orgC, { baseUrl: "org-c", apiKey: "ok-c-Lm55org" });
  await copy(orgD, { baseUrl: "off", apiKey: "ok-d-Rt66org" });
  // org C's copy loses its own secret: the copy no longer validates (it never takes the platform's)
  await raw
    .deleteFrom("capybara.secrets" as never)
    .where("org_id" as never, "=", orgC as never)
    .where("key" as never, "like", "plugin-override:orgcalls:%" as never)
    .execute();
  await k.app.get(EffectiveConfigs).invalidate(orgC, "orgcalls");
  expect((await k.app.get(EffectiveConfigs).get(orgC, "orgcalls")).ok).toBe(false);
  expect((await k.app.get(EffectiveConfigs).get(orgB, "orgcalls")).ok).toBe(true);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** The calls recorded since `from` (an index into `orgCalls()`). */
const since = (from: number, site?: string): OrgCall[] =>
  orgCalls()
    .slice(from)
    .filter((c) => site === undefined || c.site === site);

const textOf = (r: unknown): string => {
  const c = (r as ToolResult).content[0];
  return c?.type === "text" ? c.text : "";
};

describe("web-search@1 and web-fetch@1 (point resolution)", () => {
  const tool = () =>
    webSearchTool({
      points: k.app.get(ExtensionPointDefaults),
      config: k.app.get(KernelConfigService),
    });
  const ctx = (orgId: string) => ({
    orgId,
    accountId: ownerId,
    agentId: "g",
    conversationId: "c",
    callId: "call",
    signal: new AbortController().signal,
  });

  it("search gets the effective config: the platform's for A, the copy's for B", async () => {
    const from = orgCalls().length;
    expect(textOf(await tool().run({ query: "q" }, ctx(orgA)))).toContain(
      JSON.stringify(platformCfg),
    );
    expect(textOf(await tool().run({ query: "q" }, ctx(orgB)))).toContain(JSON.stringify(copyB));
    expect(since(from, "web-search").map((c) => c.config)).toEqual([platformCfg, copyB]);
  });

  it("a provider whose effective config is not valid in the org is not a candidate there", async () => {
    const from = orgCalls().length;
    expect(await tool().unavailable?.({ orgId: orgC } as never)).toBe(NONE_REASON);
    await expect(tool().run({ query: "q" }, ctx(orgC))).rejects.toEqual(new ToolError(NONE_REASON));
    expect(since(from)).toEqual([]);
  });

  it("configured() receives the effective config too (D's copy switches the provider off)", async () => {
    expect(await tool().unavailable?.({ orgId: orgD } as never)).toBe(NONE_REASON);
    expect(await tool().unavailable?.({ orgId: orgB } as never)).toBeNull();
  });

  it("fetch gets the effective config", async () => {
    const deps = {
      points: k.app.get(ExtensionPointDefaults),
      config: k.app.get(KernelConfigService),
      cache: { get: async () => null, set: async () => {} },
    };
    const page = await fetchPage(deps, ctx(orgB), "https://example.com/");
    expect(page).toMatchObject({ kind: "page" });
    expect(page.kind === "page" && page.page.markdown).toBe(`config ${JSON.stringify(copyB)}`);
    await expect(fetchPage(deps, ctx(orgC), "https://example.com/")).rejects.toBeInstanceOf(
      ToolError,
    );
  });
});

describe("directory@1", () => {
  it("listMembers gets the effective config; an org needing configuration is skipped", async () => {
    const sync = k.app.get(DirectorySync);
    const from = orgCalls().length;
    expect(await sync.sync(orgA, "orgcalls")).toMatchObject({ status: "synced" });
    expect(await sync.sync(orgB, "orgcalls")).toMatchObject({ status: "synced" });
    expect(since(from, "directory").map((c) => c.config)).toEqual([platformCfg, copyB]);
    expect(await sync.sync(orgC, "orgcalls")).toEqual({
      status: "skipped",
      reason: "needs_config",
    });
    await expect(sync.request(orgC, "orgcalls", ownerId)).rejects.toMatchObject({
      code: "extension.needs_config",
    });
    expect(await sync.enqueue(orgC, "orgcalls")).toBeUndefined();
    expect((await sync.scan()).map((t) => t.orgId).sort()).toEqual([orgA, orgB, orgD].sort());
    // the scan's jobs run on this replica's worker: never one with org C's (invalid) copy
    await waitFor(async () => since(from, "directory").length >= 5, 10_000, "scan jobs");
    expect(since(from, "directory").map((c) => (c.config as { baseUrl: string }).baseUrl)).toEqual(
      expect.not.arrayContaining(["org-c"]),
    );
  });
});

describe("extension UI", () => {
  const ui = (orgId: string) => `/api/v1/orgs/${orgId}/ui`;

  it("render and action get the effective config; the block fails alone where it is not valid", async () => {
    const from = orgCalls().length;
    const view = await owner({ method: "GET", url: `${ui(orgB)}/views/orgcalls/page` });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.body).toContain(JSON.stringify(JSON.stringify(copyB)).slice(1, -1));
    const act = await owner({
      method: "POST",
      url: `${ui(orgA)}/actions/orgcalls/page`,
      payload: { actionId: "go" },
    });
    expect(act.statusCode, act.body).toBe(200);
    const uiCalls = () => since(from).filter((c) => c.site.startsWith("ui."));
    expect(uiCalls().map((c) => [c.site, c.config])).toEqual([
      ["ui.render", copyB],
      ["ui.action", platformCfg],
    ]);
    for (const [method, url, payload] of [
      ["GET", `${ui(orgC)}/views/orgcalls/page`, undefined],
      ["POST", `${ui(orgC)}/actions/orgcalls/page`, { actionId: "go" }],
    ] as const) {
      const res = await owner({ method, url, ...(payload && { payload }) });
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe("extension.needs_config");
    }
    expect(uiCalls()).toHaveLength(2);
  });
});

describe("tools and hooks in a run", { timeout: 60_000 }, () => {
  async function agentIn(orgId: string): Promise<string> {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Prober",
          instructions: "Use tools.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "orgcalls", name: "probe" }]),
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { agent: { id: string } }).agent.id;
  }

  async function turn(orgId: string): Promise<ConversationEvent[]> {
    const conv = await createConv(owner, orgId, await agentIn(orgId));
    await postMessage(owner, orgId, conv, "check the settings");
    await waitForTerminal(db, conv, 1, 20_000);
    return eventsOf(db, conv);
  }

  const of = (from: number, orgId: string, site: string) =>
    since(from, site).filter((c) => c.orgId === orgId);

  it("the tool and every hook get the org's effective config", async () => {
    const from = orgCalls().length;
    const eventsB = await turn(orgB);
    expect(eventsB.some((e) => e.type === "hook_denied")).toBe(false);
    expect(of(from, orgB, "tool").map((c) => c.config)).toEqual([copyB]);
    expect(of(from, orgB, "model.request:policy")[0]?.config).toEqual(copyB);
    await waitFor(async () => of(from, orgB, "model.request:observe").length > 0, 10_000, "obs");
    expect(of(from, orgB, "model.request:observe")[0]?.config).toEqual(copyB);
    await waitFor(async () => of(from, orgB, "usage.report").length > 0, 20_000, "usage");
    expect(of(from, orgB, "usage.report")[0]?.config).toEqual(copyB);
    await turn(orgA);
    expect(of(from, orgA, "tool").map((c) => c.config)).toEqual([platformCfg]);
    expect(of(from, orgA, "model.request:policy")[0]?.config).toEqual(platformCfg);
  });

  it("where the config is not valid the policy hook denies and no hook runs", async () => {
    const from = orgCalls().length;
    const events = await turn(orgC);
    const denied = events.find((e) => e.type === "hook_denied");
    expect(denied?.payload).toMatchObject({
      mount: "model.request",
      plugin: "orgcalls",
      cause: "hook_error",
    });
    const audit = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "hook.denied")
      .where("org_id", "=", orgC)
      .executeTakeFirst();
    expect(audit?.detail).toMatchObject({ needsConfig: true });
    await new Promise((res) => setTimeout(res, 200));
    expect(since(from).filter((c) => c.orgId === orgC)).toEqual([]);
  });
});
