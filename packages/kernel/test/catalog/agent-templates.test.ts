import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { AgentTemplatesService } from "../../src/agents/templates.js";
import type { PluginReview } from "../../src/catalog/plugin-import.js";
import type { UpgradePreview } from "../../src/catalog/plugin-upgrade.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { currentTemplate } from "../../src/evals/worker.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { resolveRoster } from "../../src/runtime/subagents/roster.js";
import { truncateTables } from "../helpers/db.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  eventsOf,
  PW,
  postMessage,
  session,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { install, type OrgEnv, resetOrgCatalog, startOrgEnv } from "./org-env.js";
import { bundlePlugin } from "./packages.js";

/**
 * Phase C Task 15: agent templates shipped in plugins (`agents/<name>.md`, sub-agents spec §16):
 * the import review and its hash, org install (the roster type `<plugin>:<name>`), upgrade (a new
 * version, listed in the diff), uninstall (a selected template is kept: used_by_agents), rollback
 * (the previous definition comes back) and a started sub-agent's frozen definition.
 */

let env: OrgEnv;
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  capture.restore();
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await truncateTables(env.db, "capybara.conversations");
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
  capture.reset();
});

const md = (name: string, body: string, front = "") =>
  `---\nname: ${name}\ndescription: Reviews ${name} work.\n${front}---\n${body}\n`;

/** Plugin `crm` at `version` with the given agent templates (file name -> content). */
const agentPlugin = (version: string, agents: Record<string, string>) =>
  bundlePlugin({
    name: "crm",
    version,
    files: Object.fromEntries(Object.entries(agents).map(([n, c]) => [`agents/${n}.md`, c])),
  });

async function prepare(bytes: Uint8Array): Promise<{ stagingId: string; review: PluginReview }> {
  const r = await env.root({
    method: "POST",
    url: "/api/v1/admin/catalog/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

async function importOk(bytes: Uint8Array): Promise<string> {
  const { stagingId, review } = await prepare(bytes);
  const c = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
    payload: { reviewHash: review.reviewHash, deployExtension: false },
  });
  expect(c.statusCode, c.body).toBe(201);
  return c.json().item.id as string;
}

async function installOk(itemId: string, version: string): Promise<string> {
  const r = await install(env.boss, env, itemId, { version });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().installed.pluginInstallId as string;
}

async function upgradeTo(installId: string, version: string): Promise<UpgradePreview> {
  const p = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade/preview`,
    payload: { version },
  });
  expect(p.statusCode, p.body).toBe(200);
  const preview = p.json() as UpgradePreview;
  const u = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade`,
    payload: { version, diffHash: preview.diffHash },
  });
  expect(u.statusCode, u.body).toBe(200);
  return preview;
}

const templates = () => new AgentTemplatesService(env.db).listForOrg(env.orgId);

const allTemplateRows = () =>
  env.db
    .selectFrom("agent_templates")
    .select(["id", "name", "plugin_name", "current_version", "deleted_at"])
    .orderBy("name")
    .execute();

/** An org agent with the agent tool that selects these templates. */
async function lead(templateIds: string[]): Promise<{ id: string; definition: AgentDefinition }> {
  const definition = {
    name: "Lead",
    instructions: "Lead the work.",
    model: { provider: "model-fake", model: "fake-1" },
    tools: [{ kind: "builtin", name: "agent" }],
    subagents: { templates: templateIds },
  };
  const r = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: { definition, visibility: "org" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().agent?.id ?? r.json().id, definition: definition as AgentDefinition };
}

describe("agent templates in plugins", () => {
  it("a plugin with agents/reviewer.md imports with the template in the review and reviewHash", async () => {
    const one = await prepare(
      await agentPlugin("1.0.0", {
        reviewer: md("reviewer", "Review v1.", "model: fast\ntools: [sandbox_read]\n"),
      }),
    );
    expect(one.review.agentTemplates).toEqual([
      expect.objectContaining({
        name: "reviewer",
        path: "agents/reviewer.md",
        description: "Reviews reviewer work.",
        model: "fast",
        tools: ["sandbox_read"],
        instructions: "Review v1.\n",
      }),
    ]);
    // another template body: another hash (same name, version, everything else)
    await truncateTables(env.db, "capybara.plugin_import_staging");
    const two = await prepare(
      await agentPlugin("1.0.0", {
        reviewer: md("reviewer", "Review v2.", "model: fast\ntools: [sandbox_read]\n"),
      }),
    );
    expect(two.review.reviewHash).not.toBe(one.review.reviewHash);
    const c = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${two.stagingId}/confirm`,
      payload: { reviewHash: two.review.reviewHash, deployExtension: false },
    });
    expect(c.statusCode, c.body).toBe(201);
  });

  it("an invalid agent template refuses the import with its path", async () => {
    const r = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await agentPlugin("1.0.0", { bad: md("Bad", "x") })),
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain("agents/bad.md: name must match");
  });

  it("org install creates the template; an agent selects it; it appears in the roster as <plugin>:reviewer", async () => {
    const itemId = await importOk(await agentPlugin("1.0.0", { reviewer: md("reviewer", "R.") }));
    const installId = await installOk(itemId, "1.0.0");
    const [t] = await templates();
    expect(t).toMatchObject({ name: "reviewer", plugin: "crm", type: "crm:reviewer", version: 1 });
    const view = (
      await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/plugin-installs` })
    ).json().installs[0];
    expect(view.id).toBe(installId);
    expect(view.components).toContainEqual(
      expect.objectContaining({ kind: "agent_template", ref: t?.id, created: true }),
    );
    const { definition } = await lead([t?.id as string]);
    const roster = await resolveRoster(env.db, env.orgId, definition);
    expect(roster.map((e) => e.type)).toEqual(["general-purpose", "crm:reviewer"]);
    expect(
      await new AgentTemplatesService(env.db).resolve(env.orgId, "crm:reviewer"),
    ).toMatchObject({ id: t?.id, version: 1, plugin: "crm" });
  });

  it("upgrade adds a version and lists it in the diff; rollback restores the previous version", async () => {
    const itemId = await importOk(await agentPlugin("1.0.0", { reviewer: md("reviewer", "R1.") }));
    await importOk(
      await agentPlugin("1.1.0", {
        reviewer: md("reviewer", "R2."),
        tester: md("tester", "T."),
      }),
    );
    const installId = await installOk(itemId, "1.0.0");
    const up = await upgradeTo(installId, "1.1.0");
    expect(up.components.filter((c) => c.kind === "agent_template")).toEqual([
      { kind: "agent_template", ref: "reviewer", change: "changed" },
      { kind: "agent_template", ref: "tester", change: "added" },
    ]);
    const svc = new AgentTemplatesService(env.db);
    expect((await svc.resolve(env.orgId, "crm:reviewer"))?.version).toBe(2);
    expect((await svc.resolve(env.orgId, "crm:reviewer"))?.template.instructions).toBe("R2.\n");
    expect((await svc.resolve(env.orgId, "crm:tester"))?.version).toBe(1);

    // rollback to 1.0.0: the previous definition comes back as a new version, tester goes
    const back = await upgradeTo(installId, "1.0.0");
    expect(back.components.filter((c) => c.kind === "agent_template")).toEqual([
      { kind: "agent_template", ref: "reviewer", change: "changed" },
      { kind: "agent_template", ref: "tester", change: "removed" },
    ]);
    const r = await svc.resolve(env.orgId, "crm:reviewer");
    expect(r?.version).toBe(3);
    expect(r?.template.instructions).toBe("R1.\n");
    expect(await svc.resolve(env.orgId, "crm:tester")).toBeNull();
  });

  it("the eval worker's currentTemplate reads the live row: upgraded -> another version, removed -> 0", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", { reviewer: md("reviewer", "R1."), tester: md("tester", "T.") }),
    );
    await importOk(await agentPlugin("1.1.0", { reviewer: md("reviewer", "R2.") }));
    const installId = await installOk(itemId, "1.0.0");
    const byName = Object.fromEntries((await templates()).map((t) => [t.name, t]));
    /** A child case snapshot of a plugin template (only what currentTemplate reads). */
    const caseOf = (id: string) =>
      ({
        orgId: env.orgId,
        events: [
          {
            seq: 1,
            type: "subagent_started",
            runId: null,
            createdAt: new Date().toISOString(),
            payload: { template: { source: "plugin", id, version: 1, plugin: "crm" } },
          },
        ],
      }) as unknown as CaseSnapshot;
    const reviewer = byName.reviewer?.id as string;
    const tester = byName.tester?.id as string;
    expect(await currentTemplate(env.db, caseOf(reviewer))).toEqual({ id: reviewer, version: 1 });
    await upgradeTo(installId, "1.1.0");
    expect(await currentTemplate(env.db, caseOf(reviewer))).toEqual({ id: reviewer, version: 2 });
    // tester is gone in 1.1.0 (soft-deleted): version 0, always a change
    expect(await currentTemplate(env.db, caseOf(tester))).toEqual({ id: tester, version: 0 });
  });

  it("GET /agent-templates lists the org's live templates for a member", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", {
        reviewer: md("reviewer", "R.", "model: fast\n"),
        tester: md("tester", "T."),
      }),
    );
    await installOk(itemId, "1.0.0");
    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/agent-templates` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().templates).toEqual([
      expect.objectContaining({
        name: "reviewer",
        type: "crm:reviewer",
        model: "fast",
        version: 1,
      }),
      expect.objectContaining({ name: "tester", type: "crm:tester", model: "inherit" }),
    ]);
    const other = await env.mem({ method: "GET", url: "/api/v1/orgs/nope/agent-templates" });
    expect(other.statusCode).not.toBe(200);
    // the agent editor needs agents.create: a guest of the org gets 403 (batch 14 review m6)
    const guestId = (
      await new AccountsService(env.db).createLocal({
        login: "tpl-guest",
        password: PW,
        displayName: "G",
      })
    ).id;
    await env.db
      .insertInto("memberships")
      .values({ org_id: env.orgId, account_id: guestId, role: "guest" })
      .execute();
    const guest = await session(env.k, "tpl-guest");
    const denied = await guest({ method: "GET", url: `/api/v1/orgs/${env.orgId}/agent-templates` });
    expect(denied.statusCode, denied.body).toBe(403);
  });

  it("uninstall keeps a selected template (used_by_agents) and removes the others", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", { reviewer: md("reviewer", "R."), tester: md("tester", "T.") }),
    );
    const installId = await installOk(itemId, "1.0.0");
    const reviewer = (await templates()).find((t) => t.name === "reviewer");
    await lead([reviewer?.id as string]);
    const r = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().kept).toContainEqual({
      kind: "agent_template",
      ref: reviewer?.id,
      reason: "used_by_agents",
    });
    expect(r.json().removed).toContainEqual(expect.objectContaining({ kind: "agent_template" }));
    expect((await templates()).map((t) => t.name)).toEqual(["reviewer"]);
    expect((await allTemplateRows()).find((t) => t.name === "tester")?.deleted_at).not.toBeNull();
  });

  it("a failed install rolls the created template back", async () => {
    // the skills step (after the agent templates) fails: storage lost a skill file
    const itemId = await importOk(
      await bundlePlugin({
        name: "crm",
        version: "1.0.0",
        skills: ["notes"],
        files: { "agents/reviewer.md": md("reviewer", "R.") },
      }),
    );
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select(["object_prefix"])
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    await env.k.storage.deployment().delete(`${v.object_prefix}skills/notes/scripts/run.py`);
    const r = await install(env.boss, env, itemId, { version: "1.0.0" });
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.details[0]).toMatchObject({ step: "skills", rolledBack: true });
    expect(await templates()).toEqual([]);
    expect((await allTemplateRows()).map((t) => t.deleted_at !== null)).toEqual([true]);
  });

  it("a failed upgrade undoes the template version it added", async () => {
    const itemId = await importOk(await agentPlugin("1.0.0", { reviewer: md("reviewer", "R1.") }));
    const next = await importOk(
      await bundlePlugin({
        name: "crm",
        version: "1.1.0",
        skills: ["notes"],
        files: { "agents/reviewer.md": md("reviewer", "R2.") },
      }),
    );
    expect(next).toBe(itemId);
    const installId = await installOk(itemId, "1.0.0");
    // the skills step (after the agent templates) fails: storage lost the new version's skill file
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select(["object_prefix"])
      .where("item_id", "=", itemId)
      .where("version", "=", "1.1.0")
      .executeTakeFirstOrThrow();
    await env.k.storage.deployment().delete(`${v.object_prefix}skills/notes/scripts/run.py`);
    const p = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade/preview`,
      payload: { version: "1.1.0" },
    });
    expect(p.statusCode, p.body).toBe(200);
    const u = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade`,
      payload: { version: "1.1.0", diffHash: (p.json() as UpgradePreview).diffHash },
    });
    expect(u.statusCode, u.body).toBe(502);
    const r = await new AgentTemplatesService(env.db).resolve(env.orgId, "crm:reviewer");
    expect(r).toMatchObject({ version: 1 });
    expect(r?.template.instructions).toBe("R1.\n");
    const versions = await env.db
      .selectFrom("agent_template_versions")
      .select("version")
      .where("template_id", "=", r?.id as string)
      .execute();
    expect(versions.map((x) => x.version)).toEqual([1]);
  });

  it("an upgrade drops a selected template (kept, used_by_agents); a later upgrade brings it back", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", { reviewer: md("reviewer", "R."), tester: md("tester", "T1.") }),
    );
    await importOk(await agentPlugin("1.1.0", { reviewer: md("reviewer", "R.") }));
    await importOk(
      await agentPlugin("1.2.0", { reviewer: md("reviewer", "R."), tester: md("tester", "T2.") }),
    );
    const installId = await installOk(itemId, "1.0.0");
    const tester = (await templates()).find((t) => t.name === "tester");
    await lead([tester?.id as string]);
    const ledger = () =>
      env.db
        .selectFrom("plugin_install_components")
        .select(["ref", "dropped"])
        .where("install_id", "=", installId)
        .where("kind", "=", "agent_template")
        .where("ref", "=", tester?.id as string)
        .execute();

    const down = await upgradeTo(installId, "1.1.0");
    expect(down.components).toContainEqual({
      kind: "agent_template",
      ref: "tester",
      change: "removed",
    });
    // still there for the agent that selects it, and still this install's (dropped)
    expect((await templates()).map((t) => t.name)).toEqual(["reviewer", "tester"]);
    expect(await ledger()).toEqual([{ ref: tester?.id, dropped: true }]);

    await upgradeTo(installId, "1.2.0");
    expect(await ledger()).toEqual([{ ref: tester?.id, dropped: false }]);
    const back = await new AgentTemplatesService(env.db).resolve(env.orgId, "crm:tester");
    expect(back?.id).toBe(tester?.id);
    expect(back?.template.instructions).toBe("T2.\n");
  });

  it("a running sub-agent keeps its frozen definition after an upgrade", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", { reviewer: md("reviewer", "Review v1.") }),
    );
    await importOk(await agentPlugin("1.1.0", { reviewer: md("reviewer", "Review v2.") }));
    const installId = await installOk(itemId, "1.0.0");
    const [t] = await templates();
    const { id: agentId } = await lead([t?.id as string]);
    const conv = await createConv(env.boss, env.orgId, agentId);
    await postMessage(
      env.boss,
      env.orgId,
      conv,
      `tool:agent:${JSON.stringify({ description: "Review", prompt: "echo:first", subagent_type: "crm:reviewer" })}`,
    );
    await waitForTerminal(env.db, conv, 1, 30_000);
    const dispatched = (await eventsOf(env.db, conv)).find(
      (e) => e.type === "subagent_dispatched",
    ) as Extract<ConversationEvent, { type: "subagent_dispatched" }> | undefined;
    const subagentId = dispatched?.payload.subagentId as string;
    expect(subagentId).toBeTruthy();

    await upgradeTo(installId, "1.1.0");
    capture.reset();
    await postMessage(
      env.boss,
      env.orgId,
      conv,
      `tool:agent:${JSON.stringify({ description: "Again", prompt: "echo:again", resume: subagentId })}`,
    );
    await waitForTerminal(env.db, conv, 2, 30_000);
    const childReq = await waitFor(
      async () =>
        // the child's request: its last user message is the follow-up prompt (the parent's
        // carries it inside the tool call)
        capture.sent.find((r) => {
          const last = r.messages.at(-1);
          return (
            last?.role === "user" &&
            JSON.stringify(last.content).includes("echo:again") &&
            !JSON.stringify(last.content).includes("tool:agent")
          );
        }),
      10_000,
      "the resumed child's request",
    );
    const system = childReq.system.map((s) => s.text).join("\n");
    expect(system).toContain("Review v1.");
    expect(system).not.toContain("Review v2.");
    const child = await eventsOf(env.db, subagentId);
    expect(child.filter((e) => e.type === "subagent_started")).toHaveLength(1);
  });
});
