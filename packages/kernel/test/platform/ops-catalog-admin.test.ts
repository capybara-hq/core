import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../src/extensions/host.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { ORG_OWNED } from "../../src/platform/ops/catalog-admin.ops.js";
import { OTHER_ORG } from "../../src/platform/ops/other-orgs.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import {
  importDeployedPlugin,
  importSkill,
  type OrgEnv,
  resetOrgCatalog,
  setScope,
  startOrgEnv,
} from "../catalog/org-env.js";
import { skillPlugin } from "../catalog/packages.js";
import { createOrg, enableExtensions, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";

/**
 * Task 8 of Platform phase 2: the admin catalog, platform extensions, marketplaces, the org's
 * models, the org's plugin installs and own plugins, extension tool switches and point defaults,
 * against PG with the real services. Super-admin operations refuse other orgs' private plugins
 * (spec §14.5 item 1); every write's audit carries `via: "agent"` and the operation.
 */

let env: OrgEnv;
let ops: PlatformOperations;
let org2: string;
const ORG2_NAME = "Gamma Corp";

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

const ctxOf = (accountId: string, over: Partial<OperationContext> = {}): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
  ...over,
});

const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "superAdmin"));
  });
};

const precheck = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};

const summarize = async (id: string, input: unknown, ctx: OperationContext) =>
  op(id).summary?.(op(id).input.parse(input), ctx);

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

/** The audit row of `action` carries the agent's detail for `operation`. */
const expectViaAgent = async (action: string, operation: string, ctx: OperationContext) => {
  const rows = await audits(action);
  expect(rows.map((r) => r.detail)).toContainEqual(
    expect.objectContaining({
      via: "agent",
      operation,
      agentConversationId: ctx.conversationId,
      agentRunId: ctx.runId,
    }),
  );
};

const SUPER = facts("owner", { isSuperAdmin: true });

describe("registration and who may call", () => {
  it("registers the Task 8 operations", () => {
    const ids = new Set(ops.all().map((o) => o.id));
    for (const id of [
      "plugins.import-npm",
      "plugins.import-git",
      "plugins.import-review",
      "plugins.scope-preview",
      "plugins.set-scope",
      "plugins.set-disabled",
      "plugins.set-shown",
      "plugins.delete",
      "plugins.installs",
      "plugins.uninstall",
      "plugins.upload-review",
      "plugins.set-shareable",
      "plugins.owned-delete-preview",
      "plugins.owned-delete",
      "plugins.withdraw-upload",
      "extensions.platform-list",
      "extensions.platform-get",
      "extensions.platform-enable",
      "extensions.platform-disable",
      "extensions.uninstall",
      "extensions.tools",
      "extensions.tool-disable-preview",
      "extensions.set-tool-enabled",
      "extensions.point-defaults",
      "extensions.point-availability",
      "extensions.set-point-default",
      "marketplaces.platform-entries",
      "marketplaces.update",
      "marketplaces.remove",
      "marketplaces.refresh",
      "marketplaces.import",
      "models.purposes",
      "models.set-purpose",
      "models.set-disabled",
      "requests.platform-list",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("platform operations refuse an org admin and a shared agent; org writes refuse a member", () => {
    for (const id of [
      "plugins.set-scope",
      "plugins.delete",
      "extensions.platform-disable",
      "extensions.uninstall",
      "marketplaces.remove",
      "requests.platform-list",
    ]) {
      const a = availability(op(id), facts("admin"));
      expect(a.ok, id).toBe(false);
      expect(
        availability(op(id), facts("owner", { isSuperAdmin: true, agentPrivateToActor: false })).ok,
      ).toBe(false);
      expect(availability(op(id), SUPER), id).toEqual({ ok: true });
    }
    for (const id of [
      "extensions.set-tool-enabled",
      "extensions.set-point-default",
      "models.set-purpose",
      "models.set-disabled",
      "plugins.uninstall",
      "plugins.set-shareable",
      "plugins.owned-delete",
    ]) {
      expect(availability(op(id), facts("member")).ok, id).toBe(false);
      expect(availability(op(id), facts("admin")), id).toEqual({ ok: true });
    }
    // and the classes: platform writes are platform, org writes org
    expect(op("plugins.set-scope").confirm).toBe("platform");
    expect(op("extensions.platform-enable").confirm).toBe("platform");
    expect(op("extensions.set-tool-enabled").confirm).toBe("org");
    expect(op("models.set-purpose").confirm).toBe("org");
  });
});

describe("the platform catalog (super admin)", () => {
  it("scope-preview then set-scope: a stale hash is refused before the card, the audit says via agent", async () => {
    const item = await importSkill(env);
    const c = ctxOf(env.rootId);
    const p = (await run(
      "plugins.scope-preview",
      { itemId: item, scope: "named", orgs: [org2] },
      c,
    )) as { scopeHash: string; affected: unknown[] };
    expect(p.affected).toEqual([]);
    const input = { itemId: item, scope: "named", orgs: [org2], scopeHash: p.scopeHash };
    expect(await precheck("plugins.set-scope", input, c)).toEqual({ ok: true });
    expect(
      await precheck("plugins.set-scope", { ...input, scopeHash: "0".repeat(64) }, c),
    ).toMatchObject({ ok: false, code: "plugin.scope_stale" });
    expect(await summarize("plugins.set-scope", input, c)).toEqual({
      zh: "把平台插件「pdf-tools」的范围改为 named（1 个组织）：0 个组织将失去它",
      en: 'Change the scope of platform plugin "pdf-tools" to named (1 orgs): 0 orgs lose it',
    });
    const out = (await run("plugins.set-scope", input, c)) as {
      item: { scope: string; scopeOrgs: unknown };
    };
    // a platform plugin: its orgs are named (spec §14.5 item 1)
    expect(out.item).toMatchObject({ scope: "named", scopeOrgs: [org2] });
    await expectViaAgent("catalog.scope_changed", "plugins.set-scope", c);
  });

  it("set-shown, set-disabled (enable) and delete write with the agent's audit detail", async () => {
    const item = await importSkill(env);
    const c = ctxOf(env.rootId);
    await run("plugins.set-shown", { itemId: item, shownToOthers: false }, c);
    await run("plugins.set-shown", { itemId: item, shownToOthers: true }, c);
    await expectViaAgent("catalog.shown_changed", "plugins.set-shown", c);
    // disabling needs the hash of the disable preview; enabling needs none
    expect(() =>
      op("plugins.set-disabled").input.parse({ itemId: item, disabled: true }),
    ).toThrow();
    const p = (await run("plugins.scope-preview", { itemId: item, disabled: true }, c)) as {
      scopeHash: string;
    };
    await run("plugins.set-disabled", { itemId: item, disabled: true, scopeHash: p.scopeHash }, c);
    await run("plugins.set-disabled", { itemId: item, disabled: false }, c);
    await expectViaAgent("catalog.scope_changed", "plugins.set-disabled", c);
    expect(await precheck("plugins.delete", { itemId: item }, c)).toEqual({ ok: true });
    await run("plugins.delete", { itemId: item }, c);
    await expectViaAgent("catalog.removed", "plugins.delete", c);
    expect(await precheck("plugins.delete", { itemId: item }, c)).toMatchObject({
      ok: false,
      code: "catalog.item_not_found",
    });
  });

  it("another org's private plugin is refused: preview, precheck and write never describe it", async () => {
    const theirs = await importSkill(env, { name: "gamma-secret-tool" });
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: org2 })
      .where("id", "=", theirs)
      .execute();
    const c = ctxOf(env.rootId);
    const e = await failure(run("plugins.scope-preview", { itemId: theirs, scope: "optional" }, c));
    expect(e.message).toBe(OTHER_ORG);
    for (const [id, input] of [
      ["plugins.delete", { itemId: theirs }],
      ["plugins.set-shown", { itemId: theirs, shownToOthers: true }],
      ["plugins.set-scope", { itemId: theirs, scope: "all", scopeHash: "0".repeat(64) }],
    ] as const) {
      const r = await precheck(id, input, c);
      expect(r).toEqual({ ok: false, code: "catalog.item_not_found", message: OTHER_ORG });
      expect((await failure(run(id, input, c))).message).toBe(OTHER_ORG);
    }
    expect(
      (
        await env.db
          .selectFrom("catalog_items")
          .select("deleted_at")
          .where("id", "=", theirs)
          .executeTakeFirstOrThrow()
      ).deleted_at,
    ).toBeNull();
  });

  it("set-scope: a skill name conflict is refused before the card, naming the org but not the plugins", async () => {
    const item = await importSkill(env);
    // offered only to this org first, so org2 can have its own skill of that name
    await setScope(env, item, "named", [env.orgId]);
    const md = new TextEncoder().encode(SKILL_MD("pdf-tools", "Their own"));
    await env.k.app.get(SkillsService).createVersionFromFiles(org2, env.rootId, {
      name: "pdf-tools",
      description: "Their own",
      files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
    });
    const c = ctxOf(env.rootId);
    const p = (await run(
      "plugins.scope-preview",
      { itemId: item, scope: "named", orgs: [org2] },
      c,
    )) as { scopeHash: string; conflicts: { orgName: string; plugins: number }[] };
    expect(p.conflicts).toMatchObject([{ orgName: ORG2_NAME, plugins: 0 }]);
    const r = await precheck(
      "plugins.set-scope",
      { itemId: item, scope: "named", orgs: [org2], scopeHash: p.scopeHash },
      c,
    );
    expect(r).toMatchObject({ ok: false, code: "plugin.skill_conflict" });
    expect(r.ok ? "" : r.message).toContain(
      `skill "pdf-tools" is already used in org ${ORG2_NAME}`,
    );
    expect(
      nextStepFor(op("plugins.set-scope").errors, "plugin.skill_conflict", "superAdmin"),
    ).toMatch(/preview again/);
  });

  it("set-scope run, past the precheck: a write-time conflict never names another org's plugin", async () => {
    const item = await importSkill(env);
    await setScope(env, item, "named", [env.orgId]);
    // org2's own plugin brings a skill of the same name, installed there
    const theirs = await importSkill(env, { name: "gamma-secret-plugin", skillName: "pdf-tools" });
    await setScope(env, theirs, "named", [org2]);
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: org2 })
      .where("id", "=", theirs)
      .execute();
    const on = await env.root({
      method: "PUT",
      url: `/api/v1/orgs/${org2}/catalog/${theirs}/switch`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    const c = ctxOf(env.rootId);
    const p = (await run(
      "plugins.scope-preview",
      { itemId: item, scope: "named", orgs: [org2] },
      c,
    )) as { scopeHash: string; conflicts: { plugins: number }[] };
    expect(p.conflicts).toMatchObject([{ plugins: 1 }]);
    expect(JSON.stringify(p)).not.toContain("gamma-secret-plugin");
    // the run without its precheck (skipped on a timeout, or a change in between)
    const e = await failure(
      run(
        "plugins.set-scope",
        { itemId: item, scope: "named", orgs: [org2], scopeHash: p.scopeHash },
        c,
      ),
    );
    expect(e.message).toContain("plugin.skill_conflict");
    expect(e.message).toContain(ORG2_NAME);
    expect(e.message).toContain("1 plugin(s)");
    expect(e.message).not.toContain("gamma-secret-plugin");
  });

  it("set-shown refuses a plugin an org owns, the conversation org's own included", async () => {
    const item = await importSkill(env, { name: "own-shown" });
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: env.orgId })
      .where("id", "=", item)
      .execute();
    const c = ctxOf(env.rootId);
    expect(
      await precheck("plugins.set-shown", { itemId: item, shownToOthers: true }, c),
    ).toMatchObject({ ok: false, code: "catalog.org_owned" });
    expect(
      (await failure(run("plugins.set-shown", { itemId: item, shownToOthers: true }, c))).message,
    ).toBe(ORG_OWNED);
  });

  it("import-npm and import-git cards name what is fetched and say a person confirms", async () => {
    const c = ctxOf(env.rootId);
    expect(
      await summarize("plugins.import-npm", { package: "@acme/crm", version: "1.2.0" }, c),
    ).toEqual({
      zh: "从 npm 准备导入插件 @acme/crm@1.2.0（确认在网页上进行）",
      en: "Prepare importing plugin @acme/crm@1.2.0 from npm (confirmed on the web)",
    });
    expect(
      await summarize("plugins.import-git", { url: "acme/crm", ref: "v1", path: "plugin" }, c),
    ).toEqual({
      zh: "从 git 准备导入插件 acme/crm#v1 plugin（确认在网页上进行）",
      en: "Prepare importing plugin acme/crm#v1 plugin from git (confirmed on the web)",
    });
    expect(op("plugins.import-npm").confirm).toBe("platform");
  });

  it("import-review reads a staged import with a reviewUrl and never its reviewHash", async () => {
    const r = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await skillPlugin("staged-tool")),
    });
    expect(r.statusCode, r.body).toBe(200);
    const stagingId = (r.json() as { stagingId: string }).stagingId;
    const out = (await run("plugins.import-review", { stagingId }, ctxOf(env.rootId))) as {
      review: { name: string; skills: string[] };
      reviewUrl: string;
      next: string;
    };
    expect(out.review).toMatchObject({ name: "staged-tool", skills: ["staged-tool"] });
    expect(out.reviewUrl).toBe(`/admin/plugins/import?staging=${stagingId}`);
    expect(out.next).toContain("only a person");
    expect(JSON.stringify(out)).not.toContain("reviewHash");
  });
});

describe("platform extensions (super admin)", () => {
  it("platform-list gives compact rows; platform-get leaves out reviewHash and config values", async () => {
    const list = (await run("extensions.platform-list", {}, ctxOf(env.rootId))) as {
      items: Record<string, unknown>[];
    };
    const row = list.items.find((x) => x.id === "fake-connector");
    expect(row).toMatchObject({ id: "fake-connector", state: "enabled" });
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ["enabledOrgs", "id", "name", "required", "state", "version"].sort(),
    );
    const got = (await run(
      "extensions.platform-get",
      { name: "fake-object-store" },
      ctxOf(env.rootId),
    )) as Record<string, unknown>;
    expect(got).toMatchObject({ name: "fake-object-store", status: "enabled" });
    expect(got).not.toHaveProperty("reviewHash");
    // the deployment config's secret never appears
    expect(JSON.stringify(got)).not.toContain('secretAccessKey":"');
    // a startup-declared extension cannot be switched here
    expect(
      await precheck("extensions.platform-disable", { name: "fake-connector" }, ctxOf(env.rootId)),
    ).toMatchObject({ ok: false, code: "extension.config_declared" });
  });

  it("disable, uninstall: prechecks before the card, the audit says via agent; the org plugin keeps its state and gains the reason", async () => {
    const { itemId } = await importDeployedPlugin(env, "deploy-me");
    // switched on in the org, then stopped on the platform
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    const c = ctxOf(env.rootId);
    expect(await precheck("extensions.uninstall", { name: "deploy-me" }, c)).toMatchObject({
      ok: false,
      code: "extension.not_disabled",
    });
    expect(await summarize("extensions.platform-disable", { name: "deploy-me" }, c)).toMatchObject({
      en: expect.stringContaining('Disable extension "deploy-me" on the platform'),
    });
    await run("extensions.platform-disable", { name: "deploy-me" }, c);
    await expectViaAgent("extension.disabled", "extensions.platform-disable", c);
    await waitFor(
      async () => env.k.app.get(ExtensionHost).current("deploy-me") === undefined,
      15_000,
      "unloaded",
    );

    // deferred item (a): installed in the org, its extension stopped: state stays, reason and next added
    type Row = { id: string; state: string; reason?: string; next?: string };
    const boss = ctxOf(env.bossId);
    const rows = (await run("plugins.list", {}, boss)) as { items: Row[] };
    const mine = rows.items.find((r) => r.id === itemId);
    expect(mine).toMatchObject({ state: "on", reason: "deployment_disabled" });
    expect(mine?.next).toContain("super admin");
    expect(mine?.next).not.toContain("admin console");
    const got = (await run("plugins.get", { itemId }, boss)) as { item: Row };
    expect(got.item).toMatchObject({ state: "on", reason: "deployment_disabled" });

    expect(await precheck("extensions.uninstall", { name: "deploy-me" }, c)).toEqual({ ok: true });
    await run("extensions.uninstall", { name: "deploy-me" }, c);
    await expectViaAgent("extension.uninstalled", "extensions.uninstall", c);
    expect(await precheck("extensions.platform-enable", { name: "deploy-me" }, c)).toMatchObject({
      ok: false,
      code: "extension.not_found",
    });
  });

  it("an extension only another org's own plugin brings is counted, never listed, read or changed", async () => {
    const { itemId } = await importDeployedPlugin(env, "gamma-private-ext");
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: org2 })
      .where("id", "=", itemId)
      .execute();
    const c = ctxOf(env.rootId);
    const list = (await run("extensions.platform-list", {}, c)) as {
      items: { id: string }[];
      otherOrgExtensions: number;
    };
    expect(list.items.map((x) => x.id)).not.toContain("gamma-private-ext");
    expect(list.otherOrgExtensions).toBe(1);
    expect(JSON.stringify(list)).not.toContain("gamma-private-ext");
    const e = await failure(run("extensions.platform-get", { name: "gamma-private-ext" }, c));
    expect(e.message).toBe(OTHER_ORG);
    for (const id of [
      "extensions.platform-enable",
      "extensions.platform-disable",
      "extensions.uninstall",
    ]) {
      expect(await precheck(id, { name: "gamma-private-ext" }, c), id).toEqual({
        ok: false,
        code: "extension.not_found",
        message: OTHER_ORG,
      });
      expect((await failure(run(id, { name: "gamma-private-ext" }, c))).message).toBe(OTHER_ORG);
    }
    // the conversation org's own plugin is its own: listed
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: env.orgId })
      .where("id", "=", itemId)
      .execute();
    const mine = (await run("extensions.platform-list", {}, c)) as { items: { id: string }[] };
    expect(mine.items.map((x) => x.id)).toContain("gamma-private-ext");
    await run("extensions.platform-disable", { name: "gamma-private-ext" }, c);
  });

  it("a deleted catalog item counts on neither side for an extension's owner", async () => {
    const { itemId } = await importDeployedPlugin(env, "gamma-deleted-ext");
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: org2, deleted_at: new Date() })
      .where("id", "=", itemId)
      .execute();
    const c = ctxOf(env.rootId);
    // the only item is deleted: nobody's private extension, so it is listed
    const list = (await run("extensions.platform-list", {}, c)) as {
      items: { id: string }[];
      otherOrgExtensions: number;
    };
    expect(list.items.map((x) => x.id)).toContain("gamma-deleted-ext");
    // a live item of another org next to a deleted platform one: theirs
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: null })
      .where("id", "=", itemId)
      .execute();
    const live = await importSkill(env, { name: "gamma-deleted-ext-2" });
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: org2 })
      .where("id", "=", live)
      .execute();
    await env.db
      .insertInto("extension_catalog_sources")
      .values({ plugin: "gamma-deleted-ext", item_id: live })
      .execute();
    expect(
      (await failure(run("extensions.platform-get", { name: "gamma-deleted-ext" }, c))).message,
    ).toBe(OTHER_ORG);
  });
});

describe("extension tools and point defaults in the org", () => {
  it("tools read; turning a tool off is previewed, confirmed, refused when stale, audited via agent", async () => {
    await enableExtensions(env.db, env.orgId, "fake-tools-ui");
    const mem = ctxOf(env.memId);
    const tools = (await run("extensions.tools", { extension: "fake-tools-ui" }, mem)) as {
      tools: { tool: string; enabled: boolean }[];
    };
    const tool = tools.tools[0]?.tool as string;
    expect(tools.tools[0]).toMatchObject({ enabled: true });
    const boss = ctxOf(env.bossId);
    const p = (await run(
      "extensions.tool-disable-preview",
      { extension: "fake-tools-ui", tool },
      boss,
    )) as { affectedAgents: unknown[]; confirm: string };
    const off = { extension: "fake-tools-ui", tool, enabled: false, confirm: p.confirm };
    expect(await precheck("extensions.set-tool-enabled", off, boss)).toEqual({ ok: true });
    expect(
      await precheck("extensions.set-tool-enabled", { ...off, confirm: "stale" }, boss),
    ).toMatchObject({ ok: false, code: "plugin.switch_stale" });
    expect(
      await precheck(
        "extensions.set-tool-enabled",
        { extension: "fake-tools-ui", tool: "nope", enabled: true },
        boss,
      ),
    ).toMatchObject({ ok: false, code: "extension.tool_not_found" });
    expect(await run("extensions.set-tool-enabled", off, boss)).toEqual({ applied: true });
    await expectViaAgent("extension.tool_switched", "extensions.set-tool-enabled", boss);
    await run(
      "extensions.set-tool-enabled",
      { extension: "fake-tools-ui", tool, enabled: true },
      boss,
    );
  });

  it("point defaults read; a non-candidate is refused before the card", async () => {
    const boss = ctxOf(env.bossId);
    const list = (await run("extensions.point-defaults", {}, boss)) as {
      points: { point: string }[];
    };
    expect(list.points.map((p) => p.point)).toContain("web-search");
    const avail = (await run("extensions.point-availability", {}, ctxOf(env.memId))) as {
      points: { point: string; available: boolean }[];
    };
    expect(avail.points.find((p) => p.point === "web-search")).toMatchObject({ available: false });
    expect(
      await precheck(
        "extensions.set-point-default",
        { point: "web-search", extension: "fake-connector" },
        boss,
      ),
    ).toMatchObject({ ok: false, code: "validation_failed" });
    expect(
      await precheck("extensions.set-point-default", { point: "nope", extension: "x" }, boss),
    ).toMatchObject({ ok: false, code: "validation_failed" });
  });
});

describe("marketplaces (super admin)", () => {
  it("update, refresh precheck and remove; the official one is only switched; audits say via agent", async () => {
    const c = ctxOf(env.rootId);
    const added = (await run(
      "marketplaces.add",
      { name: "Edit me", url: "https://edit.example.com/marketplace.json" },
      c,
    )) as { marketplace: { id: string } };
    const id = added.marketplace.id;
    expect(await precheck("marketplaces.update", { marketplaceId: id, name: "Edited" }, c)).toEqual(
      {
        ok: true,
      },
    );
    expect(
      await summarize("marketplaces.update", { marketplaceId: id, name: "Edited" }, c),
    ).toEqual({
      zh: "修改市场源「Edit me」：name=Edited",
      en: 'Edit marketplace source "Edit me": name=Edited',
    });
    const out = (await run("marketplaces.update", { marketplaceId: id, name: "Edited" }, c)) as {
      marketplace: { name: string };
    };
    expect(out.marketplace.name).toBe("Edited");
    await expectViaAgent("marketplace.updated", "marketplaces.update", c);
    // the token is not an input
    expect(() =>
      op("marketplaces.update").input.parse({ marketplaceId: id, token: "secret" }),
    ).toThrow();
    const unknown = randomUUID();
    for (const opId of ["marketplaces.refresh", "marketplaces.remove"]) {
      expect(await precheck(opId, { marketplaceId: unknown }, c)).toMatchObject({
        ok: false,
        code: "marketplace.not_found",
      });
    }
    const official = (
      (await run("marketplaces.list", {}, c)) as { items: { id: string; builtin: boolean }[] }
    ).items.find((m) => m.builtin);
    if (official !== undefined) {
      expect(
        await precheck("marketplaces.remove", { marketplaceId: official.id }, c),
      ).toMatchObject({ ok: false, code: "marketplace.builtin" });
      expect(
        await precheck("marketplaces.update", { marketplaceId: official.id, enabled: false }, c),
      ).toEqual({ ok: true });
    }
    const entries = (await run("marketplaces.platform-entries", { marketplaceId: id }, c)) as {
      items: unknown[];
    };
    expect(entries.items).toEqual([]);
    await run("marketplaces.remove", { marketplaceId: id }, c);
    await expectViaAgent("marketplace.removed", "marketplaces.remove", c);
  });

  it("marketplaces.import: prechecks a missing, incompatible or deprecated entry; the card names it", async () => {
    const c = ctxOf(env.rootId);
    const added = (await run(
      "marketplaces.add",
      { name: "Import src", url: "https://import.example.com/marketplace.json" },
      c,
    )) as { marketplace: { id: string } };
    const id = added.marketplace.id;
    const row = (name: string, over: Record<string, unknown>) => ({
      source_id: id,
      name,
      version: "1.0.0",
      npm: `@acme/plugin-${name}`,
      entry: JSON.stringify({
        name,
        version: "1.0.0",
        summary: { en: name },
        permissions: { keys: [], sensitive: [] },
        source: { npm: { package: `@acme/plugin-${name}`, version: "1.0.0" } },
        ...over,
      }),
    });
    await env.db
      .insertInto("marketplace_entries")
      .values([row("future", { minKernel: "99.0.0" }), row("old", { deprecated: "use v2" })])
      .execute();
    expect(
      await precheck("marketplaces.import", { marketplaceId: id, name: "none" }, c),
    ).toMatchObject({
      ok: false,
      code: "marketplace.entry_not_found",
    });
    expect(
      await precheck("marketplaces.import", { marketplaceId: id, name: "future" }, c),
    ).toMatchObject({ ok: false, code: "marketplace.incompatible" });
    expect(
      await precheck("marketplaces.import", { marketplaceId: id, name: "old" }, c),
    ).toMatchObject({ ok: false, code: "marketplace.entry_deprecated" });
    expect(
      await summarize(
        "marketplaces.import",
        { marketplaceId: id, name: "future", version: "1.0.0" },
        c,
      ),
    ).toEqual({
      zh: "从市场源「Import src」准备导入插件 future@1.0.0（确认在网页上进行）",
      en: 'Prepare importing plugin future@1.0.0 from marketplace source "Import src" (confirmed on the web)',
    });
    for (const code of ["marketplace.path_unsupported", "marketplace.entry_deprecated"]) {
      expect(nextStepFor(op("marketplaces.import").errors, code, "superAdmin"), code).toBeDefined();
    }
    await run("marketplaces.remove", { marketplaceId: id }, c);
  });
});

describe("the org's models", () => {
  it("purposes read; clearing an override and switching models off are audited via agent", async () => {
    const boss = ctxOf(env.bossId);
    const list = (await run("models.purposes", {}, boss)) as { purposes: { purpose: string }[] };
    const purpose = list.purposes[0]?.purpose as string;
    expect(purpose).toBeDefined();
    expect(
      await precheck("models.set-purpose", { purpose: "no-such-purpose", target: null }, boss),
    ).toMatchObject({ ok: false, code: "model.purpose_unknown" });
    // the service's own target checks run before the card
    expect(
      await precheck(
        "models.set-purpose",
        { purpose, target: { model: { provider: "model-fake", model: "no-such-model" } } },
        boss,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await precheck(
        "models.set-purpose",
        { purpose, target: { model: { provider: "no-provider", model: "x" } } },
        boss,
      ),
    ).toMatchObject({ ok: false });
    await run("models.set-purpose", { purpose, target: null }, boss);
    await expectViaAgent("model.purpose_mapped", "models.set-purpose", boss);

    expect(
      await precheck("models.set-disabled", { provider: "no-provider", disable: ["x"] }, boss),
    ).toMatchObject({ ok: false, code: "model.provider_not_found" });
    const input = { provider: "model-fake", disable: ["fake-a"] };
    expect(await precheck("models.set-disabled", input, boss)).toEqual({ ok: true });
    await run("models.set-disabled", input, boss);
    await expectViaAgent("org.model_disabled_set", "models.set-disabled", boss);
    await run("models.set-disabled", { provider: "model-fake", enable: ["fake-a"] }, boss);
  });
});

describe("the org's plugin installs and own plugins", () => {
  it("installs read, uninstall audited via agent", async () => {
    const item = await importSkill(env);
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${item}/switch`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    const boss = ctxOf(env.bossId);
    const list = (await run("plugins.installs", {}, boss)) as {
      items: { id: string; name: string; state: string }[];
    };
    const row = list.items.find((i) => i.name === "pdf-tools");
    expect(row).toMatchObject({ state: "installed" });
    const installId = row?.id as string;
    expect(await precheck("plugins.uninstall", { installId }, boss)).toEqual({ ok: true });
    expect(await precheck("plugins.uninstall", { installId: randomUUID() }, boss)).toMatchObject({
      ok: false,
      code: "plugin.install_not_found",
    });
    await run("plugins.uninstall", { installId }, boss);
    await expectViaAgent("plugin.org_uninstalled", "plugins.uninstall", boss);
  });

  it("an own plugin: share, nothing to withdraw, delete after the preview; another org's is not found", async () => {
    const item = await importSkill(env, { name: "own-tool" });
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: env.orgId, scope: "named" })
      .where("id", "=", item)
      .execute();
    const boss = ctxOf(env.bossId);
    expect(
      await precheck("plugins.set-shareable", { itemId: item, shareable: true }, boss),
    ).toEqual({ ok: true });
    await run("plugins.set-shareable", { itemId: item, shareable: true }, boss);
    await expectViaAgent("catalog.shareable_changed", "plugins.set-shareable", boss);
    expect(await precheck("plugins.withdraw-upload", { itemId: item }, boss)).toMatchObject({
      ok: false,
      code: "extension.not_pending",
    });
    const p = (await run("plugins.owned-delete-preview", { itemId: item }, boss)) as {
      outcome: string;
      previewHash: string;
    };
    expect(p.outcome).toBe("removed");
    expect(
      await precheck("plugins.owned-delete", { itemId: item, previewHash: "stale" }, boss),
    ).toMatchObject({ ok: false, code: "catalog.preview_stale" });
    await run("plugins.owned-delete", { itemId: item, previewHash: p.previewHash }, boss);
    await expectViaAgent("catalog.removed", "plugins.owned-delete", boss);

    const theirs = await importSkill(env, { name: "their-tool" });
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: org2 })
      .where("id", "=", theirs)
      .execute();
    expect(
      await precheck("plugins.set-shareable", { itemId: theirs, shareable: true }, boss),
    ).toMatchObject({ ok: false, code: "catalog.item_not_found" });
  });
});

describe("requests and the actor's role", () => {
  it("requests.platform-list reads the platform's requests as compact rows", async () => {
    const out = (await run("requests.platform-list", {}, ctxOf(env.rootId))) as {
      items: unknown[];
      next: string | null;
    };
    expect(out).toEqual({ items: [], total: 0, next: null });
  });

  it("next steps use the role the tool derived (ctx.errorRole) rather than reading it again", async () => {
    const { itemId } = await importDeployedPlugin(env, "role-probe");
    await run("extensions.platform-disable", { name: "role-probe" }, ctxOf(env.rootId));
    await waitFor(
      async () => env.k.app.get(ExtensionHost).current("role-probe") === undefined,
      15_000,
      "unloaded",
    );
    type Row = { id: string; next?: string };
    const asRoot = (await run("plugins.list", {}, ctxOf(env.rootId))) as { items: Row[] };
    expect(asRoot.items.find((r) => r.id === itemId)?.next).toContain("admin console");
    // the same account, but the tool said member: the member's step, no admin console
    const asMember = (await run(
      "plugins.list",
      {},
      ctxOf(env.rootId, { errorRole: "member" }),
    )) as { items: Row[] };
    expect(asMember.items.find((r) => r.id === itemId)?.next).not.toContain("admin console");
  });
});
