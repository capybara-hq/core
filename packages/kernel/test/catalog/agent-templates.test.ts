import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { PluginReview } from "../../src/catalog/plugin-import.js";
import type { PlatformUpdatePreview } from "../../src/catalog/plugin-upgrade.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { currentTemplate } from "../../src/evals/worker.js";
import { resolveRoster } from "../../src/runtime/subagents/roster.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { agentTemplatesFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
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
import { SKILL_MD } from "../skills/zip.js";
import { install, type OrgEnv, resetOrgCatalog, startOrgEnv } from "./org-env.js";
import { bundlePlugin, skillFiles } from "./packages.js";

/**
 * Phase C Task 15: agent templates shipped in plugins (`agents/<name>.md`, sub-agents spec §16):
 * the import review and its hash, org install (the roster type `<plugin>:<name>`), the platform
 * plugin update (a new version of the platform template, listed in the diff; a removed template
 * agents use stays), uninstall (a selected template goes off in the org), a downgrade (the previous
 * definition comes back as a new version) and a started sub-agent's frozen definition.
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
    payload: { reviewHash: review.reviewHash },
  });
  expect(c.statusCode, c.body).toBe(201);
  return c.json().item.id as string;
}

/** Installs the plugin in the org (at the platform version, `version`). */
async function installOk(itemId: string, _version: string): Promise<string> {
  const r = await install(env.boss, env, itemId);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().installed.pluginInstallId as string;
}

/** Previews and confirms the platform plugin update to `version` (Task 7). */
async function updateTo(itemId: string, version: string): Promise<PlatformUpdatePreview> {
  const p = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
    payload: { version },
  });
  expect(p.statusCode, p.body).toBe(200);
  const preview = p.json() as PlatformUpdatePreview;
  const u = await env.root({
    method: "PUT",
    url: `/api/v1/admin/catalog/items/${itemId}/update`,
    payload: { version, diffHash: preview.diffHash },
  });
  expect(u.statusCode, u.body).toBe(200);
  return preview;
}

const templateChanges = (p: PlatformUpdatePreview) =>
  p.components
    .filter((c) => c.kind === "agent_template")
    .map((c) => ({ name: c.name, change: c.change }));

const templates = () => agentTemplatesFor(env.db).listForOrg(env.orgId);

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
    tools: [{ kind: "builtin", name: "Agent" }],
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

// Each case imports plugins through the object store and the kernel end to end: about 1 s alone,
// several times that in a full parallel run, past the local 5 s default (CI has 30 s).
describe("agent templates in plugins", { timeout: 30_000 }, () => {
  it("a plugin with agents/reviewer.md imports with the template in the review and reviewHash", async () => {
    const one = await prepare(
      await agentPlugin("1.0.0", {
        reviewer: md("reviewer", "Review v1.", "model: fast\ntools: [Read]\n"),
      }),
    );
    expect(one.review.agentTemplates).toEqual([
      expect.objectContaining({
        name: "reviewer",
        path: "agents/reviewer.md",
        description: "Reviews reviewer work.",
        model: "fast",
        tools: ["Read"],
        instructions: "Review v1.\n",
      }),
    ]);
    // another template body: another hash (same name, version, everything else)
    await truncateTables(env.db, "capybara.plugin_import_staging");
    const two = await prepare(
      await agentPlugin("1.0.0", {
        reviewer: md("reviewer", "Review v2.", "model: fast\ntools: [Read]\n"),
      }),
    );
    expect(two.review.reviewHash).not.toBe(one.review.reviewHash);
    const c = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${two.stagingId}/confirm`,
      payload: { reviewHash: two.review.reviewHash },
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

  it("org install turns the platform template on (no org row); an agent selects it; it appears in the roster as <plugin>:reviewer", async () => {
    const itemId = await importOk(await agentPlugin("1.0.0", { reviewer: md("reviewer", "R.") }));
    const installId = await installOk(itemId, "1.0.0");
    const [t] = await templates();
    expect(t).toMatchObject({
      name: "reviewer",
      plugin: "crm",
      type: "crm:reviewer",
      version: 1,
      origin: "platform",
    });
    expect(await allTemplateRows()).toEqual([]);
    const view = (
      await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/plugin-installs` })
    ).json().installs[0];
    expect(view.id).toBe(installId);
    expect(view.components).toEqual([]);
    const { definition } = await lead([t?.id as string]);
    const roster = await resolveRoster(env.db, env.orgId, definition);
    expect(roster.map((e) => e.type)).toEqual(["general-purpose", "crm:reviewer"]);
    expect(await agentTemplatesFor(env.db).resolve(env.orgId, "crm:reviewer")).toMatchObject({
      id: t?.id,
      version: 1,
      plugin: "crm",
    });
  });

  it("the platform update adds a version and lists it in the diff; a downgrade restores the previous definition", async () => {
    const itemId = await importOk(await agentPlugin("1.0.0", { reviewer: md("reviewer", "R1.") }));
    await importOk(
      await agentPlugin("1.1.0", {
        reviewer: md("reviewer", "R2."),
        tester: md("tester", "T."),
      }),
    );
    await installOk(itemId, "1.0.0");
    const up = await updateTo(itemId, "1.1.0");
    expect(templateChanges(up)).toEqual([
      { name: "reviewer", change: "upgrade" },
      { name: "tester", change: "added" },
    ]);
    const svc = agentTemplatesFor(env.db);
    expect((await svc.resolve(env.orgId, "crm:reviewer"))?.version).toBe(2);
    expect((await svc.resolve(env.orgId, "crm:reviewer"))?.template.instructions).toBe("R2.\n");
    // the added template is a platform component, on in the org with the plugin
    expect(await svc.resolve(env.orgId, "crm:tester")).not.toBeNull();

    // back to 1.0.0: the previous definition comes back as a new version, tester goes
    const back = await updateTo(itemId, "1.0.0");
    expect(templateChanges(back)).toEqual([
      { name: "reviewer", change: "downgrade" },
      { name: "tester", change: "removed" },
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
    await installOk(itemId, "1.0.0");
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
    // the ids are the platform templates' (installs make no org row since phase 2)
    const ref = (version: number) => ({ id: reviewer, version, platformTemplateId: reviewer });
    expect(await currentTemplate(env.db, caseOf(reviewer))).toEqual(ref(1));
    await updateTo(itemId, "1.1.0");
    expect(await currentTemplate(env.db, caseOf(reviewer))).toEqual(ref(2));
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
    // the org's catalog item lists the plugin's agent template files
    const detail = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().agents).toEqual(["agents/reviewer.md", "agents/tester.md"]);
    const other = await env.mem({ method: "GET", url: "/api/v1/orgs/nope/agent-templates" });
    expect(other.statusCode).not.toBe(200);
    // the agent editor needs agents.create: a guest of the org gets 403 (batch 14 review m6)
    const guestId = (
      await accountsFor(env.db).createLocal({
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

  it("switching the plugin off previews the agent selecting its template; its templates go off in the org", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", { reviewer: md("reviewer", "R."), tester: md("tester", "T.") }),
    );
    await installOk(itemId, "1.0.0");
    const reviewer = (await templates()).find((t) => t.name === "reviewer");
    const { id: leadId } = await lead([reviewer?.id as string]);
    const url = `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`;
    const pre = await env.boss({ method: "PUT", url, payload: { enabled: false } });
    expect(pre.statusCode, pre.body).toBe(200);
    expect(pre.json().preview.agents).toEqual([
      { id: leadId, name: "Lead", uses: [{ kind: "agent_template", ref: reviewer?.id }] },
    ]);
    const off = await env.boss({
      method: "PUT",
      url,
      payload: { enabled: false, confirm: pre.json().confirm },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await templates()).toEqual([]);
    expect(await allTemplateRows()).toEqual([]);
  });

  it("a failed platform update leaves the template at its version", async () => {
    const itemId = await importOk(
      await bundlePlugin({
        name: "crm",
        version: "1.0.0",
        skills: ["notes"],
        files: { "agents/reviewer.md": md("reviewer", "R1.") },
      }),
    );
    const next = await importOk(
      await bundlePlugin({
        name: "crm",
        version: "1.1.0",
        files: {
          ...skillFiles("notes", SKILL_MD("notes", "Notes, again.")),
          "agents/reviewer.md": md("reviewer", "R2."),
        },
      }),
    );
    expect(next).toBe(itemId);
    await installOk(itemId, "1.0.0");
    // preparing the platform versions fails: storage lost the new version's skill file
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select(["object_prefix"])
      .where("item_id", "=", itemId)
      .where("version", "=", "1.1.0")
      .executeTakeFirstOrThrow();
    await env.k.app
      .get(StorageService)
      .deployment()
      .delete(`${v.object_prefix}skills/notes/scripts/run.py`);
    const p = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version: "1.1.0" },
    });
    expect(p.statusCode, p.body).toBe(200);
    const u = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/update`,
      payload: { version: "1.1.0", diffHash: (p.json() as PlatformUpdatePreview).diffHash },
    });
    // the files are read before anything is written: refused as storage.unavailable
    expect(u.statusCode, u.body).toBe(503);
    expect(u.json().error.code).toBe("storage.unavailable");
    const r = await agentTemplatesFor(env.db).resolve(env.orgId, "crm:reviewer");
    expect(r).toMatchObject({ version: 1 });
    expect(r?.template.instructions).toBe("R1.\n");
    const versions = await env.db
      .selectFrom("platform_agent_template_versions")
      .select("version")
      .execute();
    expect(versions.map((x) => x.version)).toEqual([1]);
  });

  it("an update leaving out a selected template keeps it (spec §7.3); a later update brings it back", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", { reviewer: md("reviewer", "R."), tester: md("tester", "T1.") }),
    );
    await importOk(await agentPlugin("1.1.0", { reviewer: md("reviewer", "R.") }));
    await importOk(
      await agentPlugin("1.2.0", { reviewer: md("reviewer", "R."), tester: md("tester", "T2.") }),
    );
    await installOk(itemId, "1.0.0");
    const tester = (await templates()).find((t) => t.name === "tester");
    const { id: leadId } = await lead([tester?.id as string]);

    const down = await updateTo(itemId, "1.1.0");
    expect(down.components.find((c) => c.name === "tester")).toMatchObject({
      change: "removed",
      kept: [{ orgId: env.orgId, agents: [{ id: leadId, name: "Lead" }] }],
    });
    // still there for the agent that selects it
    expect((await templates()).map((t) => t.name)).toEqual(["reviewer", "tester"]);

    const up = await updateTo(itemId, "1.2.0");
    expect(templateChanges(up)).toEqual([
      { name: "reviewer", change: "same" },
      { name: "tester", change: "upgrade" },
    ]);
    const back = await agentTemplatesFor(env.db).resolve(env.orgId, "crm:tester");
    expect(back?.id).toBe(tester?.id);
    expect(back?.template.instructions).toBe("T2.\n");
  });

  it("a running sub-agent keeps its frozen definition after an upgrade", async () => {
    const itemId = await importOk(
      await agentPlugin("1.0.0", { reviewer: md("reviewer", "Review v1.") }),
    );
    await importOk(await agentPlugin("1.1.0", { reviewer: md("reviewer", "Review v2.") }));
    await installOk(itemId, "1.0.0");
    const [t] = await templates();
    const { id: agentId } = await lead([t?.id as string]);
    const conv = await createConv(env.boss, env.orgId, agentId);
    await postMessage(
      env.boss,
      env.orgId,
      conv,
      `tool:Agent:${JSON.stringify({ description: "Review", prompt: "echo:first", subagent_type: "crm:reviewer" })}`,
    );
    await waitForTerminal(env.db, conv, 1, 30_000);
    const dispatched = (await eventsOf(env.db, conv)).find(
      (e) => e.type === "subagent_dispatched",
    ) as Extract<ConversationEvent, { type: "subagent_dispatched" }> | undefined;
    const subagentId = dispatched?.payload.subagentId as string;
    expect(subagentId).toBeTruthy();

    await updateTo(itemId, "1.1.0");
    capture.reset();
    await postMessage(
      env.boss,
      env.orgId,
      conv,
      `tool:Agent:${JSON.stringify({ description: "Again", prompt: "echo:again", resume: subagentId })}`,
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
            !JSON.stringify(last.content).includes("tool:Agent")
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
  }, 90_000);
});
