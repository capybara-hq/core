import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_SCOPE_QUEUE } from "../../src/catalog/scope-sync.js";
import { createOrg, enableConnectorExtensions, waitFor } from "../helpers/runs.js";
import {
  importSkill,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setBuiltin,
  startOrgEnv,
} from "./org-env.js";
import { skillPlugin } from "./packages.js";

/**
 * The super admin's plugin scope and disable (plugin and component management spec §5 rules
 * 2-4 and 8): `POST items/:id/scope/preview` lists the orgs that lose the plugin and their agents
 * using it, `PUT items/:id/scope` and `PUT items/:id/disabled` check the preview's `scopeHash`, bump
 * the scope version, audit `catalog.scope_changed` and let the scope sync converge the orgs.
 */

let env: OrgEnv;
let orgB: string;

beforeAll(async () => {
  env = await startOrgEnv();
  orgB = await createOrg(env.root, "Scope B");
  await enableConnectorExtensions(env.k, orgB);
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

const base = "/api/v1/admin/catalog/items";
const queue = () => env.k.app.get<Queue>(getQueueToken(PLUGIN_SCOPE_QUEUE));

/** Waits until the scope queue has nothing waiting, delayed or running. */
async function idle(): Promise<void> {
  await waitFor(
    async () => {
      const c = await queue().getJobCounts("waiting", "active", "delayed", "prioritized");
      return Object.values(c).every((n) => n === 0);
    },
    30_000,
    "scope queue idle",
  );
}

type Preview = {
  affected: {
    orgId: string;
    orgName: string;
    agents: { id: string; name: string }[];
    connectorsKept: number;
  }[];
  needsConfig: string[];
  scopeHash: string;
};

async function preview(itemId: string, body: Record<string, unknown>): Promise<Preview> {
  const r = await env.root({
    method: "POST",
    url: `${base}/${itemId}/scope/preview`,
    payload: body,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Preview;
}

const putScope = (itemId: string, body: Record<string, unknown>) =>
  env.root({ method: "PUT", url: `${base}/${itemId}/scope`, payload: body });
const putDisabled = (itemId: string, body: Record<string, unknown>) =>
  env.root({ method: "PUT", url: `${base}/${itemId}/disabled`, payload: body });

/** Changes the scope through preview + PUT and waits for the sync. */
async function changeScope(itemId: string, scope: string, orgs?: string[]) {
  const body = { scope, ...(orgs !== undefined && { orgs }) };
  const p = await preview(itemId, body);
  const r = await putScope(itemId, { ...body, scopeHash: p.scopeHash });
  expect(r.statusCode, r.body).toBe(200);
  await idle();
  return r.json();
}

async function liveOrgs(itemId: string): Promise<string[]> {
  const rows = await env.db
    .selectFrom("plugin_installs")
    .select("org_id")
    .where("item_id", "=", itemId)
    .where("status", "in", ["installing", "installed", "upgrading"])
    .execute();
  return rows.map((r) => r.org_id).sort();
}

async function itemOf(itemId: string) {
  const r = await env.root({ method: "GET", url: `${base}/${itemId}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().item;
}

/** An agent of the org whose current definition selects the item's skill. */
async function agentUsingSkill(orgId: string, itemId: string, name: string): Promise<string> {
  const skill = await env.db
    .selectFrom("skills")
    .select("id")
    .where("catalog_item_id", "=", itemId)
    .where("org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  const agentId = randomUUID();
  await env.db
    .insertInto("agents")
    .values({
      id: agentId,
      org_id: orgId,
      owner_account_id: env.rootId,
      visibility: "private",
      current_version: 1,
    })
    .execute();
  await env.db
    .insertInto("agent_versions")
    .values({
      agent_id: agentId,
      version: 1,
      definition: JSON.stringify({ name, skills: { orgSkills: [skill.id] } }),
      created_by: env.rootId,
    })
    .execute();
  return agentId;
}

describe("plugin scope", { timeout: 90_000 }, () => {
  it("the item view counts the latest version's components and names its format (list and detail)", async () => {
    const itemId = await importSkill(env);
    const counts = { extension: 0, skills: 1, connectorTemplates: 0, agentTemplates: 0 };
    expect(await itemOf(itemId)).toMatchObject({
      componentCounts: counts,
      sourceFormat: "capybara",
    });
    const list = await env.root({ method: "GET", url: base });
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json() as { items: { id: string }[] }).items.find((i) => i.id === itemId);
    expect(row).toMatchObject({ componentCounts: counts, sourceFormat: "capybara" });
  });

  it("all -> optional: the preview lists the orgs with installs and the agent using the skill", async () => {
    const itemId = await importSkill(env);
    expect(await itemOf(itemId)).toMatchObject({
      scope: "optional",
      scopeOrgs: [],
      builtin: false,
      disabled: false,
      enabledOrgs: 0,
      pending: false,
    });
    const all = await changeScope(itemId, "all");
    expect(all).toMatchObject({ scope: "all" });
    await waitFor(async () => (await liveOrgs(itemId)).length >= 2, 30_000, "installed by scope");
    expect(await liveOrgs(itemId)).toEqual(expect.arrayContaining([env.orgId, orgB].sort()));
    const agentId = await agentUsingSkill(env.orgId, itemId, "Helper");
    const p = await preview(itemId, { scope: "optional" });
    expect(p.needsConfig).toEqual([]);
    expect(p.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    const a = p.affected.find((x) => x.orgId === env.orgId);
    const b = p.affected.find((x) => x.orgId === orgB);
    expect(a).toEqual({
      orgId: env.orgId,
      orgName: expect.any(String),
      agents: [{ id: agentId, name: "Helper" }],
      connectorsKept: 0,
    });
    expect(b).toEqual({ orgId: orgB, orgName: "Scope B", agents: [], connectorsKept: 0 });
  });

  it("PUT scope with a wrong hash is 409 plugin.scope_stale; the right one bumps the version, audits and syncs", async () => {
    const itemId = await importSkill(env);
    await changeScope(itemId, "all");
    await waitFor(async () => (await liveOrgs(itemId)).length >= 2, 30_000, "installed by scope");
    const before = await env.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const stale = await putScope(itemId, {
      scope: "named",
      orgs: [orgB],
      scopeHash: "0".repeat(64),
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe("plugin.scope_stale");
    const p = await preview(itemId, { scope: "named", orgs: [orgB] });
    expect(p.affected.map((x) => x.orgId)).toContain(env.orgId);
    expect(p.affected.map((x) => x.orgId)).not.toContain(orgB);
    // A hash of another target is stale too
    const other = await putScope(itemId, { scope: "optional", scopeHash: p.scopeHash });
    expect(other.statusCode).toBe(409);
    const ok = await putScope(itemId, { scope: "named", orgs: [orgB], scopeHash: p.scopeHash });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ scope: "named", scopeOrgs: [orgB] });
    const after = await env.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(after.scope_version).toBe(before.scope_version + 1);
    const audits = await env.db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "catalog.scope_changed")
      .where("target", "=", itemId)
      .orderBy("id")
      .execute();
    expect(audits.at(-1)?.detail).toMatchObject({
      from: { scope: "all", orgs: [] },
      to: { scope: "named", orgs: [orgB] },
    });
    await idle();
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === orgB,
      30_000,
      "uninstalled outside the list",
    );
    expect((await itemOf(itemId)).enabledOrgs).toBe(1);
  });

  it("an import confirmed with scope named is installed in the listed orgs by the sync", async () => {
    const prep = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await skillPlugin("named-at-import")),
    });
    expect(prep.statusCode, prep.body).toBe(200);
    const c = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${prep.json().stagingId}/confirm`,
      payload: { reviewHash: prep.json().review.reviewHash, scope: "named", orgs: [orgB] },
    });
    expect(c.statusCode, c.body).toBe(201);
    const itemId = c.json().item.id as string;
    await idle();
    await waitFor(async () => (await liveOrgs(itemId)).join() === orgB, 30_000, "named install");
  });

  it("a new version of a named or an all item keeps its scope, org list and scope version", async () => {
    const named = await importSkill(env, { name: "named-v" });
    await changeScope(named, "named", [orgB]);
    const all = await importSkill(env, { name: "all-v" });
    await changeScope(all, "all");
    const state = async (id: string) => ({
      row: await env.db
        .selectFrom("catalog_items")
        .select(["scope", "scope_version"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
      orgs: (
        await env.db
          .selectFrom("catalog_item_scope_orgs")
          .select("org_id")
          .where("item_id", "=", id)
          .execute()
      ).map((r) => r.org_id),
    });
    const before = { named: await state(named), all: await state(all) };
    expect(await importSkill(env, { name: "named-v", version: "2.0.0" })).toBe(named);
    expect(await importSkill(env, { name: "all-v", version: "2.0.0" })).toBe(all);
    expect(await state(named)).toEqual(before.named);
    expect(await state(all)).toEqual(before.all);
    expect(before.named).toMatchObject({ row: { scope: "named" }, orgs: [orgB] });
    expect(before.all).toMatchObject({ row: { scope: "all" }, orgs: [] });
    // the import audits record the scope the item has, not the confirm's unused default
    const audits = await env.db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "catalog.imported")
      .where("target", "in", [named, all])
      .orderBy("id")
      .execute();
    const v2 = audits.filter((a) => (a.detail as { version?: string }).version === "2.0.0");
    expect(v2.map((a) => [a.target, (a.detail as { scope: unknown }).scope])).toEqual([
      [named, "named"],
      [all, "all"],
    ]);
    expect((v2[0]?.detail as { orgs?: string[] } | undefined)?.orgs).toEqual([orgB]);
  });

  it("orgs only with named, unknown orgs refused (400 validation_failed)", async () => {
    const itemId = await importSkill(env);
    for (const body of [
      { scope: "optional", orgs: [orgB] },
      { scope: "named", orgs: ["org-nowhere"] },
    ]) {
      const r = await env.root({
        method: "POST",
        url: `${base}/${itemId}/scope/preview`,
        payload: body,
      });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
  });

  it("a builtin plugin: preview, scope and disabled are 409 plugin.builtin", async () => {
    const itemId = await importSkill(env);
    await setBuiltin(env, itemId);
    const r1 = await env.root({
      method: "POST",
      url: `${base}/${itemId}/scope/preview`,
      payload: { scope: "optional" },
    });
    const r2 = await putScope(itemId, { scope: "optional", scopeHash: "0".repeat(64) });
    const r3 = await putDisabled(itemId, { disabled: true, scopeHash: "0".repeat(64) });
    for (const r of [r1, r2, r3]) {
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe("plugin.builtin");
    }
  });
});

describe("disable", { timeout: 90_000 }, () => {
  it("disabled: true needs the preview's hash; after the sync no org has it; re-enabling reinstalls", async () => {
    const itemId = await importSkill(env);
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect((await itemOf(itemId)).enabledOrgs).toBe(1);
    const missing = await putDisabled(itemId, { disabled: true });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error.code).toBe("validation_failed");
    const p = await preview(itemId, { disabled: true });
    expect(p.affected.map((a) => a.orgId)).toEqual([env.orgId]);
    const stale = await putDisabled(itemId, { disabled: true, scopeHash: "0".repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("plugin.scope_stale");
    const off = await putDisabled(itemId, { disabled: true, scopeHash: p.scopeHash });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ disabled: true, scope: "optional" });
    await idle();
    await waitFor(async () => (await liveOrgs(itemId)).length === 0, 30_000, "uninstalled");
    expect((await itemOf(itemId)).enabledOrgs).toBe(0);
    // The switch row is kept: re-enabling reinstalls (no hash needed)
    const back = await putDisabled(itemId, { disabled: false });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ disabled: false });
    await idle();
    await waitFor(async () => (await liveOrgs(itemId)).length === 1, 30_000, "reinstalled");
  });

  it("disabling keeps the connectors an org's install created, with their credentials; re-enabling makes no second one", async () => {
    const itemId = await seedPlugin(env, { name: "with-gh", skills: ["with-gh-skill"] });
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
      payload: {
        enabled: true,
        inputs: {
          connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } } },
        },
      },
    });
    expect(on.statusCode, on.body).toBe(200);
    const connectors = () =>
      env.db
        .selectFrom("connectors")
        .select("id")
        .where("org_id", "=", env.orgId)
        .where("catalog_item_id", "=", itemId)
        .where("deleted_at", "is", null)
        .execute();
    const [connector] = await connectors();
    if (connector === undefined) throw new Error("no connector installed");
    const secrets = () =>
      env.db
        .selectFrom("secrets")
        .select("key")
        .where("org_id", "=", env.orgId)
        .where("key", "like", `%${connector.id}%`)
        .execute();
    expect((await secrets()).length).toBeGreaterThan(0);
    const p = await preview(itemId, { disabled: true });
    expect(p.affected).toEqual([expect.objectContaining({ orgId: env.orgId, connectorsKept: 1 })]);
    const off = await putDisabled(itemId, { disabled: true, scopeHash: p.scopeHash });
    expect(off.statusCode, off.body).toBe(200);
    await idle();
    await waitFor(async () => (await liveOrgs(itemId)).length === 0, 30_000, "uninstalled");
    // the connector and its credentials stay as the org's own
    expect(await connectors()).toEqual([{ id: connector.id }]);
    expect((await secrets()).length).toBeGreaterThan(0);
    const removed = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.org_uninstalled")
      .where("org_id", "=", env.orgId)
      .execute();
    expect(removed).toHaveLength(1);
    expect(removed[0]?.detail).toMatchObject({
      via: "scope",
      kept: [{ kind: "connector", ref: connector.id, reason: "org_owned" }],
    });
    // re-enabling: the switch is still on, but the install needs the template's input again, so
    // the sync leaves it `needs_config` and creates no second connector
    const back = await putDisabled(itemId, { disabled: false });
    expect(back.statusCode, back.body).toBe(200);
    await idle();
    expect(await liveOrgs(itemId)).toEqual([]);
    expect(await connectors()).toEqual([{ id: connector.id }]);
    const list = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
    const item = (list.json() as { items: { id: string; state: string }[] }).items.find(
      (i) => i.id === itemId,
    );
    expect(item?.state).toBe("needs_config");
  });
});
