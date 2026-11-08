import { randomUUID } from "node:crypto";
import { defineExtension, secret, staticManifestOf, ToolError } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentsService } from "../../src/agents/agents.service.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { NEEDS_INPUT, OTHER_ORG } from "../../src/platform/ops/plugins.ops.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { platformTool } from "../../src/tools/builtins/platform.js";
import {
  importPlugin,
  importSkill,
  importTemplate,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setScope,
  startOrgEnv,
} from "../catalog/org-env.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, enableExtensions, waitFor } from "../helpers/runs.js";

/**
 * Task 6 of the Platform tool: the plugins, marketplaces, requests, connectors and extensions
 * operations against PG with the real services (spec §6-§7). Operations run by
 * `op.run(input, ctx)`, refusals by `availability()`. Super-admin results never name another org
 * (Review Focus 4): asserted on the JSON string.
 */

let env: OrgEnv;
let ops: PlatformOperations;
let org2: string;
const ORG2_NAME = "Beta Corp";

beforeAll(async () => {
  env = await startOrgEnv();
  ops = env.k.app.get(PlatformOperations);
  org2 = await createOrg(env.root, ORG2_NAME);
}, 240_000);
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetOrgCatalog(env);
  await enableExtensions(env.db, org2, "fake-connector");
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const facts = (role: ActorFacts["role"], over: Partial<ActorFacts> = {}): ActorFacts => ({
  role,
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: "on",
  ...over,
});

const ctxOf = (accountId: string): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});

/** Parses like the tool does, then runs; a service refusal becomes the tool's error. */
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "orgAdmin"));
  });
};

/** The operation's precheck, as the tool's callPolicy runs it before the card. */
const precheck = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};

/** The card summary of a write, as the tool's callPolicy reads it. */
const summarize = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.summary?.(o.input.parse(input), ctx);
};

const failure = async (p: Promise<unknown>): Promise<ToolError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ToolError);
  return e as ToolError;
};

const audits = (action: string) =>
  env.db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

const tokenInput = () => ({ endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } });

describe("registration", () => {
  it("registers every operation of the five domains", () => {
    expect(
      ops
        .all()
        .map((o) => o.id)
        .filter((id) => /^(plugins|marketplaces|requests|connectors|extensions)\./.test(id)),
    ).toEqual([
      "connectors.delete",
      "connectors.get",
      "connectors.list",
      "connectors.refresh",
      "connectors.set-template-enabled",
      "connectors.template-disable-preview",
      "connectors.templates",
      "extensions.list",
      "extensions.pending-permissions",
      "extensions.platform-disable",
      "extensions.platform-enable",
      "extensions.platform-get",
      "extensions.platform-list",
      "extensions.point-availability",
      "extensions.point-defaults",
      "extensions.points",
      "extensions.previewers",
      "extensions.set-point-default",
      "extensions.set-previewers",
      "extensions.set-tool-enabled",
      "extensions.tool-disable-preview",
      "extensions.tools",
      "extensions.uninstall",
      "marketplaces.add",
      "marketplaces.entries",
      "marketplaces.import",
      "marketplaces.list",
      "marketplaces.platform-entries",
      "marketplaces.refresh",
      "marketplaces.remove",
      "marketplaces.update",
      "plugins.component-scope-preview",
      "plugins.component-versions",
      "plugins.components",
      "plugins.delete",
      "plugins.disable-preview",
      "plugins.get",
      "plugins.import-git",
      "plugins.import-npm",
      "plugins.import-review",
      "plugins.installs",
      "plugins.list",
      "plugins.owned-delete",
      "plugins.owned-delete-preview",
      "plugins.platform-get",
      "plugins.platform-list",
      "plugins.scope-preview",
      "plugins.set-component-disabled",
      "plugins.set-component-scope",
      "plugins.set-component-shown",
      "plugins.set-disabled",
      "plugins.set-enabled",
      "plugins.set-scope",
      "plugins.set-shareable",
      "plugins.set-shown",
      "plugins.uninstall",
      "plugins.update",
      "plugins.update-agent-template",
      "plugins.update-preview",
      "plugins.upload-review",
      "plugins.withdraw-upload",
      "requests.create",
      "requests.create-import",
      "requests.list-mine",
      "requests.pending",
      "requests.platform-list",
    ]);
  });
});

describe("super admin operations (Review Focus 4)", () => {
  it("through a shared agent plugins.platform-list is unavailable, naming the private agent", () => {
    const a = availability(
      op("plugins.platform-list"),
      facts("owner", { isSuperAdmin: true, agentPrivateToActor: false }),
    );
    expect(a.ok).toBe(false);
    expect(a.ok ? "" : a.reason).toContain("private agent");
    expect(
      availability(op("plugins.platform-list"), facts("owner", { isSuperAdmin: true })),
    ).toEqual({ ok: true });
  });

  it("plugins.update-preview of a platform plugin gives the admin console's data in full (spec §14.5 item 1)", async () => {
    const item = await seedPlugin(env, { name: "crm", skills: [], templates: { gh: {} } });
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "1.1.0",
      skills: [],
      templates: { gh: { auth: { type: "headers", ownership: "org", names: ["X-Key"] } } },
    });
    const installed = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${org2}/catalog/${item}/install`,
      payload: { connectors: { gh: tokenInput() } },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    const connector = await env.db
      .selectFrom("connectors")
      .select(["id", "name"])
      .where("org_id", "=", org2)
      .executeTakeFirstOrThrow();

    const out = (await run(
      "plugins.update-preview",
      { itemId: item, version: "1.1.0" },
      ctxOf(env.rootId),
    )) as { connectorOrgs: unknown; diffHash: string };
    // a platform plugin: the orgs and their connectors are named, as the admin console names them
    expect(out.connectorOrgs).toMatchObject([
      { orgId: org2, connectors: [{ id: connector.id, name: connector.name }] },
    ]);
    expect(out.diffHash).toMatch(/\S/);

    // the card names the plugin and counts the preview
    const card = await summarize(
      "plugins.update",
      { itemId: item, version: "1.1.0", diffHash: out.diffHash },
      ctxOf(env.rootId),
    );
    expect(card).toEqual({
      zh: "把平台插件「crm」从 1.0.0 更新到 1.1.0：组件 1 个更新、0 个新增、0 个移除，影响 1 个组织",
      en: 'Update platform plugin "crm" from 1.0.0 to 1.1.0: components 1 updated, 0 added, 0 removed; 1 orgs affected',
    });
    expect(JSON.stringify(card)).not.toContain(ORG2_NAME);

    // the update itself: audited as made through the agent
    const done = await run(
      "plugins.update",
      { itemId: item, version: "1.1.0", diffHash: out.diffHash },
      ctxOf(env.rootId),
    );
    expect(done).toBeDefined();
    const [row] = await audits("plugin.platform_updated");
    expect(row?.detail).toMatchObject({ via: "agent", operation: "plugins.update" });
  });

  it("plugins.platform-list and platform-get name a platform plugin's scope orgs", async () => {
    const item = await importSkill(env);
    await setScope(env, item, "named", [org2]);
    const list = await run("plugins.platform-list", {}, ctxOf(env.rootId));
    expect(list).toMatchObject({
      items: [{ id: item, scopeOrgs: [org2] }],
      otherOrgItems: 0,
      next: null,
    });
    const got = await run("plugins.platform-get", { itemId: item }, ctxOf(env.rootId));
    expect(got).toMatchObject({ item: { id: item, scopeOrgs: [org2] } });
  });

  it("another org's own plugin is only counted in platform-list and refused by platform-get and update", async () => {
    const mine = await importSkill(env);
    const theirs = await importSkill(env, { name: "beta-secret-tool" });
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: org2 })
      .where("id", "=", theirs)
      .execute();
    const list = (await run("plugins.platform-list", {}, ctxOf(env.rootId))) as {
      items: { id: string }[];
      otherOrgItems: number;
    };
    expect(list.items.map((i) => i.id)).toEqual([mine]);
    expect(list.otherOrgItems).toBe(1);
    expect(JSON.stringify(list)).not.toContain("beta-secret-tool");
    for (const [id, input] of [
      ["plugins.platform-get", { itemId: theirs }],
      ["plugins.update-preview", { itemId: theirs, version: "1.0.0" }],
      ["plugins.update", { itemId: theirs, version: "1.0.0", diffHash: "0".repeat(64) }],
    ] as const) {
      const e = await failure(run(id, input, ctxOf(env.rootId)));
      expect(e.message).toBe(OTHER_ORG);
      expect(e.message).not.toContain("beta-secret-tool");
    }
  });
});

describe("marketplaces", () => {
  it("marketplaces.add by an org admin is unavailable, naming the super admin", () => {
    const a = availability(op("marketplaces.add"), facts("admin"));
    expect(a.ok).toBe(false);
    expect(a.ok ? "" : a.reason).toContain("super admin");
  });

  it("the super admin adds a source through the private agent; the audit says via agent", async () => {
    const out = (await run(
      "marketplaces.add",
      { name: "Team plugins", url: "https://plugins.example.com/marketplace.json" },
      ctxOf(env.rootId),
    )) as { marketplace: { id: string; name: string } };
    expect(out.marketplace.name).toBe("Team plugins");
    const list = (await run("marketplaces.list", {}, ctxOf(env.rootId))) as {
      items: { id: string }[];
    };
    expect(list.items.map((m) => m.id)).toContain(out.marketplace.id);
    const rows = await audits("marketplace.added");
    expect(rows.find((r) => r.target === out.marketplace.id)?.detail).toMatchObject({
      via: "agent",
      operation: "marketplaces.add",
    });
    await env.db.deleteFrom("marketplaces").where("id", "=", out.marketplace.id).execute();
  });

  it("the precheck refuses a URL that is already a source and an invalid URL, before the card", async () => {
    const c = ctxOf(env.rootId);
    const input = { name: "Team plugins", url: "https://dup.example.com/marketplace.json" };
    expect(await precheck("marketplaces.add", input, c)).toEqual({ ok: true });
    const out = (await run("marketplaces.add", input, c)) as { marketplace: { id: string } };
    expect(await precheck("marketplaces.add", { ...input, name: "Again" }, c)).toMatchObject({
      ok: false,
      code: "marketplace.already_added",
      message: expect.stringContaining(out.marketplace.id),
    });
    expect(
      await precheck("marketplaces.add", { name: "Plain", url: "http://x.example.com/m.json" }, c),
    ).toMatchObject({ ok: false, code: "validation_failed" });
    await env.db.deleteFrom("marketplaces").where("id", "=", out.marketplace.id).execute();
  });
});

describe("plugins in the org", () => {
  it("enabling a plugin that needs connector inputs is refused with the 插件 page pointer", async () => {
    const item = await importTemplate(env);
    const e = await failure(
      run("plugins.set-enabled", { itemId: item, enabled: true }, ctxOf(env.bossId)),
    );
    expect(e.message).toBe(NEEDS_INPUT);
    expect(e.message).toContain("插件 page");
    // known before the card
    expect(
      await precheck("plugins.set-enabled", { itemId: item, enabled: true }, ctxOf(env.bossId)),
    ).toEqual({ ok: false, code: "plugin.needs_input", message: NEEDS_INPUT });
    expect(
      await precheck(
        "plugins.set-enabled",
        { itemId: randomUUID(), enabled: true },
        ctxOf(env.bossId),
      ),
    ).toMatchObject({ ok: false, code: "catalog.item_not_found" });
    const [got] = await env.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("item_id", "=", item)
      .execute();
    expect(got).toBeUndefined();
  });

  it("an org admin enables a no-input optional plugin and it is on; disabling takes the preview's confirm", async () => {
    const item = await importSkill(env);
    expect(availability(op("plugins.set-enabled"), facts("admin"))).toEqual({ ok: true });
    const info = (await run("plugins.get", { itemId: item }, ctxOf(env.memId))) as {
      item: { name: string; displayName: { zh: string; en: string } | null };
    };
    const en = info.item.displayName?.en ?? info.item.name;
    const zh = info.item.displayName?.zh ?? info.item.name;
    // the cards name the plugin, not its id (finding 2)
    expect(
      await summarize("plugins.set-enabled", { itemId: item, enabled: true }, ctxOf(env.bossId)),
    ).toEqual({ zh: `在本组织启用插件「${zh}」`, en: `Enable plugin "${en}" in the org` });
    const on = await run("plugins.set-enabled", { itemId: item, enabled: true }, ctxOf(env.bossId));
    expect(on).toMatchObject({ item: { id: item, state: "on" } });
    const [installed] = await audits("plugin.org_installed");
    expect(installed?.detail).toMatchObject({ via: "agent", operation: "plugins.set-enabled" });

    const listed = (await run("plugins.list", {}, ctxOf(env.memId))) as {
      items: { id: string; state: string }[];
      next: string | null;
    };
    expect(listed.items).toEqual([expect.objectContaining({ id: item, state: "on" })]);
    expect(listed.next).toBeNull();

    // switching off needs confirm (schema), taken from plugins.disable-preview (org admins)
    expect(
      op("plugins.set-enabled").input.safeParse({ itemId: item, enabled: false }).success,
    ).toBe(false);
    expect(availability(op("plugins.disable-preview"), facts("member")).ok).toBe(false);
    const got = await run("plugins.get", { itemId: item }, ctxOf(env.memId));
    expect(got).toMatchObject({ item: { id: item, state: "on" } });
    const preview = (await run("plugins.disable-preview", { itemId: item }, ctxOf(env.bossId))) as {
      preview: { removed: unknown[] };
      confirm: string;
    };
    expect(preview.confirm).toMatch(/\S/);
    expect(preview.preview).toBeTruthy();
    const stale = await failure(
      run(
        "plugins.set-enabled",
        { itemId: item, enabled: false, confirm: "0".repeat(64) },
        ctxOf(env.bossId),
      ),
    );
    expect(stale.message).toContain("plugin.switch_stale");
    // switching off: the card counts what goes and the agents that lose it
    const offCard = await summarize(
      "plugins.set-enabled",
      { itemId: item, enabled: false, confirm: preview.confirm },
      ctxOf(env.bossId),
    );
    expect(offCard?.en).toMatch(
      new RegExp(`^Disable plugin "${en}" in the org: removes \\d+ components; 0 agents use it$`),
    );
    expect(offCard?.zh).toMatch(
      new RegExp(`^在本组织停用插件「${zh}」：移除 \\d+ 个组件，0 个智能体在用$`),
    );
    const off = await run(
      "plugins.set-enabled",
      { itemId: item, enabled: false, confirm: preview.confirm },
      ctxOf(env.bossId),
    );
    expect(off).toMatchObject({ item: { id: item, state: "off" } });
    const [removed] = await audits("plugin.org_uninstalled");
    expect(removed?.detail).toMatchObject({ via: "agent", operation: "plugins.set-enabled" });
  });

  it("a member gets plugins.set-enabled unavailable, and the service refuses a member anyway", async () => {
    const a = availability(op("plugins.set-enabled"), facts("member"));
    expect(a.ok).toBe(false);
    expect(a.ok ? "" : a.reason).toContain("an org admin");
    const item = await importSkill(env);
    const e = await failure(
      run("plugins.set-enabled", { itemId: item, enabled: true }, ctxOf(env.memId)),
    );
    expect(e.message).toContain("forbidden");
  });

  it("a plugin the super admin stopped gives each role its own next step", () => {
    const errors = op("plugins.set-enabled").errors;
    expect(nextStepFor(errors, "plugin.disabled", "superAdmin")).toContain("admin console");
    expect(nextStepFor(errors, "plugin.disabled", "orgAdmin")).toContain("ask them");
    const member = nextStepFor(errors, "plugin.disabled", "member");
    expect(member).toContain("org admin");
    expect(member).not.toContain("admin console");
  });
});

describe("requests", () => {
  it("a member creates an enable request and requests.list-mine shows it", async () => {
    const item = await importSkill(env);
    expect(availability(op("requests.create"), facts("member"))).toEqual({ ok: true });
    const out = (await run(
      "requests.create",
      { itemId: item, kind: "enable", note: "For the weekly report." },
      ctxOf(env.memId),
    )) as { request: { id: string; status: string } };
    expect(out.request.status).toBe("pending");
    const mine = (await run("requests.list-mine", {}, ctxOf(env.memId))) as {
      items: { id: string; kind: string; status: string; note: string }[];
    };
    expect(mine.items).toEqual([
      expect.objectContaining({
        id: out.request.id,
        kind: "enable",
        status: "pending",
        note: "For the weekly report.",
      }),
    ]);
    expect(await run("requests.list-mine", {}, ctxOf(env.bossId))).toEqual({
      items: [],
      total: 0,
      next: null,
    });
    const [row] = await audits("catalog.requested");
    expect(row?.detail).toMatchObject({ via: "agent", operation: "requests.create" });
    // asked twice: the pending one is named
    const again = await failure(
      run("requests.create", { itemId: item, kind: "enable" }, ctxOf(env.memId)),
    );
    expect(again.message).toContain("catalog.request_pending");
  });
});

describe("connectors and extensions", () => {
  it("connectors.get carries no credential, and only the public endpoint whatever the role", async () => {
    const item = await seedPlugin(env, { name: "with-gh", skills: [] });
    const url = `${env.mcp.url}?tenant=acme-4711`;
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${item}/switch`,
      payload: {
        enabled: true,
        inputs: { connectors: { gh: { ...tokenInput(), endpoint: { url } } } },
      },
    });
    expect(on.statusCode, on.body).toBe(200);
    const list = (await run("connectors.list", {}, ctxOf(env.memId))) as {
      items: { id: string; auth: unknown }[];
    };
    expect(list.items).toHaveLength(1);
    const id = list.items[0]?.id as string;
    const out = (await run("connectors.get", { connectorId: id }, ctxOf(env.memId))) as {
      connector: { auth: unknown; credential: unknown; tools: unknown[] };
    };
    expect(out.connector.auth).toEqual({ type: "bearer", ownership: "org" });
    expect(out.connector.credential).toEqual({ ownership: "org", status: "connected" });
    expect(out.connector.tools.length).toBeGreaterThan(0);
    const asAdmin = await run("connectors.get", { connectorId: id }, ctxOf(env.bossId));
    const json = JSON.stringify(out) + JSON.stringify(list) + JSON.stringify(asAdmin);
    expect(json).not.toContain(MCP_TOKEN);
    expect(json).not.toContain("tenant");
    expect(json).not.toContain("/mcp");
    expect(out.connector).toMatchObject({ endpoint: { url: `${new URL(url).origin}/…` } });
    expect(json).not.toMatch(/"(token|password|clientSecret|headers|connectorData)"/);

    // platform.me names connector tools by the keys the model calls (finding 10)
    const slug = (list.items[0] as unknown as { slug: string }).slug;
    const enabled = (out.connector.tools as { name: string; status: string }[])
      .filter((t) => t.status === "enabled")
      .map((t) => `mcp__${slug}__${t.name}`);
    expect(enabled.length).toBeGreaterThan(0);
    const agent = await env.k.app.get(AgentsService).create(env.orgId, env.bossId, {
      definition: {
        name: "With connector",
        instructions: "Use the docs.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "builtin", name: "Platform" },
          { kind: "connector", connectorId: id, tools: "all" },
        ],
        toolPolicies: {},
        fallback: null,
        modelParams: {},
        fallbackParams: {},
        avatarUrl: null,
      },
      visibility: "private",
    });
    const me = (await run(
      "platform.me",
      {},
      {
        ...ctxOf(env.bossId),
        agentId: agent.agent.id,
      },
    )) as { tools: string[] };
    expect(me.tools).toEqual(["Platform", ...enabled]);
    expect(JSON.stringify(me)).not.toContain("connector:");
  });

  it("extensions.list is state only; extensions.points describes every point", async () => {
    const ext = (await run("extensions.list", {}, ctxOf(env.bossId))) as {
      items: Record<string, unknown>[];
    };
    expect(ext.items.length).toBeGreaterThan(0);
    for (const e of ext.items) {
      for (const k of ["config", "secrets", "orgConfigSchema", "permissions"]) {
        expect(e).not.toHaveProperty(k);
      }
    }
    expect(ext.items.find((e) => e.id === "fake-connector")).toMatchObject({
      state: "on",
      available: true,
      provides: ["connector@1"],
    });
    type Points = {
      points: { name: string; description: string; providers?: string[]; hasProvider?: boolean }[];
    };
    expect(availability(op("extensions.points"), facts("guest")).ok).toBe(false);
    // a member learns whether a point has a provider, never which extension
    const asMember = (await run("extensions.points", {}, ctxOf(env.memId))) as Points;
    for (const p of asMember.points) {
      expect(p.description).toMatch(/\S/);
      expect(p).not.toHaveProperty("providers");
    }
    expect(asMember.points.find((p) => p.name === "connector")?.hasProvider).toBe(true);
    expect(JSON.stringify(asMember)).not.toContain("fake-connector");
    // an org admin gets the providers' plugin names
    const asAdmin = (await run("extensions.points", {}, ctxOf(env.bossId))) as Points;
    expect(asAdmin.points.find((p) => p.name === "connector")?.providers).toContain(
      "fake-connector",
    );
  });
});

/**
 * The acceptance case (session c9a4e7bf, spec §14.2 problems 1-4): an extension installed on the
 * platform but not loaded because its deployment API key is missing. One call tells why and what
 * the person does next, for their role; members never get the admin console path or a field name.
 */
describe("an extension waiting for its deployment config", () => {
  const NAME = "keyed-ai";
  const config = { deployment: z.object({ apiKey: secret(z.string().min(1)) }) };
  const real = defineExtension({
    name: NAME,
    version: "1.0.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    permissions: {},
    config,
    setup() {},
  });
  const entry = [
    'import { defineExtension, secret } from "@capybara-hq/plugin-sdk";',
    'import { z } from "zod";',
    `export default defineExtension({ name: ${JSON.stringify(NAME)}, version: "1.0.0", sdk: "^0.1.0-rc.0", provides: [], permissions: {}, config: { deployment: z.object({ apiKey: secret(z.string().min(1)) }) }, setup() {} });`,
  ].join("\n");
  const ADMIN_PATH = `admin console → Extensions → ${NAME} → fill in the deployment config`;
  let itemId: string;

  /** The Platform tool on the real operations, with the actor facts given. */
  const toolAs = (f: ActorFacts) =>
    platformTool({
      ops,
      actor: { facts: async () => f },
      docs: { topics: () => [], read: () => null },
      setting: async () => "on",
    });
  const enableCall = () => ({
    action: "call",
    operation: "plugins.set-enabled",
    params: { itemId, enabled: true },
  });
  const policyCtx = (accountId: string) => ({
    orgId: env.orgId,
    accountId,
    agentId: randomUUID(),
    conversationId: randomUUID(),
    runId: randomUUID(),
  });

  beforeEach(async () => {
    const bytes = await pluginTgz({
      manifest: { name: NAME },
      extension: { manifest: { ...staticManifestOf(real) }, entry },
    });
    itemId = await importPlugin(env, bytes);
    // installed and enabled on the platform, but the host keeps it pending: no API key
    await waitFor(
      async () =>
        (
          await env.db
            .selectFrom("extension_replica_status")
            .select(["state", "reason"])
            .where("plugin", "=", NAME)
            .executeTakeFirst()
        )?.reason === "config",
      15_000,
      "pending config",
    );
  });

  type Row = { id: string; state: string; reason?: string; next?: string; available?: boolean };

  it("extensions.list and plugins.list say unavailable with the reason, and the org page's API too", async () => {
    const ext = (await run("extensions.list", {}, ctxOf(env.bossId))) as { items: Row[] };
    expect(ext.items.find((e) => e.id === NAME)).toMatchObject({
      available: false,
      state: "unavailable",
      reason: "needs_deployment_config",
    });
    const plugins = (await run("plugins.list", {}, ctxOf(env.bossId))) as { items: Row[] };
    expect(plugins.items.find((p) => p.id === itemId)).toMatchObject({
      state: "unavailable",
      reason: "needs_deployment_config",
    });
    // compact rows: no long fields; details come from plugins.get
    for (const p of plugins.items) {
      for (const k of ["description", "componentCounts", "latestVersion", "owner"]) {
        expect(p).not.toHaveProperty(k);
      }
    }
    // the org 扩展 page reads the same state and reason, never a config value or field
    const http = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/extensions` });
    expect(http.statusCode, http.body).toBe(200);
    const view = (http.json() as { extensions: Record<string, unknown>[] }).extensions.find(
      (e) => e.plugin === NAME,
    );
    expect(view).toMatchObject({
      available: false,
      status: "pending_config",
      reason: "needs_deployment_config",
    });
    expect(JSON.stringify(view)).not.toContain("apiKey");
  });

  it("plugins.set-enabled as the super admin is denied before the card, naming the admin console path", async () => {
    const p = await toolAs(facts("owner", { isSuperAdmin: true })).callPolicy?.(
      enableCall(),
      policyCtx(env.rootId),
    );
    expect(p?.policy).toBe("deny");
    expect(p?.denyReason).toContain("needs_deployment_config");
    expect(p?.denyReason).toContain(ADMIN_PATH);
    expect(p?.denyReason).not.toContain("install and enable");
  });

  it("as an org admin the next step goes to the super admin, without the admin console path", async () => {
    const p = await toolAs(facts("admin")).callPolicy?.(enableCall(), policyCtx(env.bossId));
    expect(p?.policy).toBe("deny");
    expect(p?.denyReason).toContain("needs_deployment_config");
    expect(p?.denyReason).toContain("super admin");
    expect(p?.denyReason).not.toContain("admin console");
    expect(p?.denyReason).not.toContain("apiKey");
  });

  it("a member reads the reason and asks an org admin: no admin console path, no field names", async () => {
    for (const id of ["extensions.list", "plugins.list"]) {
      const out = (await run(id, {}, ctxOf(env.memId))) as { items: Row[] };
      const row = out.items.find((r) => r.id === NAME || r.id === itemId);
      expect(row).toMatchObject({ state: "unavailable", reason: "needs_deployment_config" });
      expect(row?.next).toContain("org admin");
      expect(JSON.stringify(row)).not.toContain("admin console");
      expect(JSON.stringify(row)).not.toContain("apiKey");
    }
  });

  it("one call decides it: plugins.get carries the state, the reason and the role's next step", async () => {
    const asRoot = (await run("plugins.get", { itemId }, ctxOf(env.rootId))) as { item: Row };
    expect(asRoot.item).toMatchObject({ state: "unavailable", reason: "needs_deployment_config" });
    expect(asRoot.item.next).toContain(ADMIN_PATH);
    const asMember = (await run("plugins.get", { itemId }, ctxOf(env.memId))) as { item: Row };
    expect(asMember.item.next).toContain("org admin");
    expect(asMember.item.next).not.toContain("admin console");
  });
});
