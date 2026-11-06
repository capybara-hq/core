import { randomUUID } from "node:crypto";
import type { AgentTemplate } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentView } from "../../src/agents/agents.service.js";
import { type PlanOptions, planFromTemplate } from "../../src/agents/from-template.js";
import { PendingConnectorRequests } from "../../src/agents/pending-connector-requests.js";
import { loadTemplates } from "../../src/agents/templates.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { createOrg, enableExtensions, type Req } from "../helpers/runs.js";

/**
 * Plugin scope phase 4, Task 3: creating an agent from a template (rulings P4-3…P4-6, P4-8). The
 * preview lists what carries over (carried / pending / unavailable) and a hash; the create
 * resolves again, refuses a stale hash, writes version 1 with the pending connectors and the
 * provenance, and hands the pending connectors to the request seam when the creator cannot
 * configure connectors.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
  await env.db.deleteFrom("model_purpose_mappings").execute();
  await enableExtensions(env.k.app.get(KernelDb).pool, env.orgId, "fake-tools-ui");
  vi.restoreAllMocks();
});

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

async function catalogItem(plugin: string): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("catalog_items")
    .values({
      id,
      name: plugin,
      package_name: `@acme/plugin-${plugin}`,
      publisher: "Acme",
      description: "d",
      latest_version: "1.0.0",
      policy: "allow",
    })
    .execute();
  return id;
}

/** A platform template on in every org (own scope `all`); more versions with `versions`. */
async function platformTemplate(
  template: AgentTemplate,
  o: {
    plugin?: string;
    itemId?: string;
    ownerOrgId?: string;
    versions?: AgentTemplate[];
    scope?: "all" | "optional";
  } = {},
): Promise<string> {
  const id = randomUUID();
  const versions = [template, ...(o.versions ?? [])];
  await env.db
    .insertInto("platform_agent_templates")
    .values({
      id,
      catalog_item_id: o.itemId ?? null,
      plugin_name: o.plugin ?? null,
      name: template.name,
      description: template.description,
      current_version: versions.length,
      scope_mode: "own",
      scope: o.scope ?? "all",
      ...(o.ownerOrgId !== undefined && {
        owner_org_id: o.ownerOrgId,
        origin_org_id: o.ownerOrgId,
        shareable: true,
      }),
    })
    .execute();
  for (const [i, v] of versions.entries()) {
    await env.db
      .insertInto("platform_agent_template_versions")
      .values({ template_id: id, version: i + 1, definition: JSON.stringify(v) })
      .execute();
  }
  return id;
}

/** A platform connector template `<itemId>/<templateId>` (fake-connector). */
async function connectorTemplate(itemId: string, templateId: string): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("platform_connector_templates")
    .values({
      id,
      catalog_item_id: itemId,
      template_id: templateId,
      current_version: "1.0.0",
      file: JSON.stringify({
        displayName: { zh: templateId.toUpperCase(), en: templateId.toUpperCase() },
        template: { plugin: "fake-connector", endpoint: { url: "https://x.example.com" } },
      }),
    })
    .execute();
  return id;
}

/** An org connector (made from `platformTemplateId` when given) with these tools. */
async function connector(
  slug: string,
  tools: string[],
  platformTemplateId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("connectors")
    .values({
      id,
      org_id: env.orgId,
      slug,
      name: `Conn ${slug}`,
      connector: "fake",
      endpoint: JSON.stringify({}),
      auth: JSON.stringify({}),
      created_by: env.bossId,
      platform_template_id: platformTemplateId,
    })
    .execute();
  if (tools.length > 0) {
    await env.db
      .insertInto("connector_tools")
      .values(
        tools.map((name) => ({
          connector_id: id,
          name,
          spec: JSON.stringify({ name, description: "d", inputSchema: { type: "object" } }),
          spec_hash: "h",
          status: "enabled" as const,
          default_policy: "allow" as const,
        })),
      )
      .execute();
  }
  // created_at orders "the first by creation"
  await new Promise((r) => setTimeout(r, 5));
  return id;
}

/** An org skill (`manual`: manual-only, never pinned). */
async function orgSkill(name: string, o: { manual?: boolean; plugin?: string } = {}) {
  const id = randomUUID();
  await env.db
    .insertInto("skills")
    .values({
      id,
      org_id: env.orgId,
      scope: "org",
      agent_id: null,
      name,
      description: "d",
      current_version: 1,
      created_by: env.bossId,
    })
    .execute();
  await env.db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify({
        name,
        description: "d",
        files: [{ path: "SKILL.md", size: 100, sha256: "0".repeat(64) }],
        ...(o.manual && { invocation: { model: false, user: true } }),
      }),
      object_prefix: `skills/${id}/`,
      created_by: env.bossId,
    })
    .execute();
  return id;
}

const tpl = (over: Partial<AgentTemplate> = {}): AgentTemplate => ({
  name: "helper",
  description: "Helps with things.",
  instructions: "Help.",
  ...over,
});

interface Preview {
  items: { kind: string; name: string; state: string; reason?: string }[];
  model: { provider: string; model: string; source: string } | null;
  dropped: string[];
  previewHash: string;
}

async function preview(req: Req, templateId: string): Promise<Preview> {
  const r = await req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents/from-template/preview`,
    payload: { templateId },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Preview;
}

const create = (req: Req, body: Record<string, unknown>) =>
  req({ method: "POST", url: `/api/v1/orgs/${env.orgId}/agents/from-template`, payload: body });

async function createOk(req: Req, templateId: string, extra: Record<string, unknown> = {}) {
  const p = await preview(req, templateId);
  const r = await create(req, {
    templateId,
    name: "From tpl",
    previewHash: p.previewHash,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return { agent: (r.json() as { agent: AgentView }).agent, preview: p };
}

const pick = (p: Preview, kind: string) =>
  p.items.filter((i) => i.kind === kind).map((i) => [i.name, i.state, i.reason ?? null]);

describe("creating an agent from a template", () => {
  it("carries tools, skills, connectors and sub-agents into buckets (P4-5)", async () => {
    const itemId = await catalogItem("crm");
    const none = await connectorTemplate(itemId, "none");
    const one = await connectorTemplate(itemId, "one");
    const many = await connectorTemplate(itemId, "many");
    const oneConn = await connector("one", ["search", "delete_all"], one);
    const firstMany = await connector("many-a", ["search"], many);
    await connector("many-b", ["search"], many);
    const pinnedSkill = await orgSkill("pdf");
    const selectedSkill = await orgSkill("sheets");
    const manualSkill = await orgSkill("manual", { manual: true });
    const inlineSkill = await orgSkill("review-notes");
    const reviewer = await platformTemplate(tpl({ name: "reviewer" }), {
      plugin: "crm",
      itemId,
    });
    const id = await platformTemplate(
      tpl({
        instructionFiles: [
          { name: "AGENTS.md", content: "Be useful." },
          { name: "style.md", content: "Be brief." },
        ],
        quickActions: [{ title: "Summarize", body: "Summarize this." }],
        tools: [
          "Bash",
          "Read",
          "plugin__fake-tools-ui__write",
          "plugin__nope__write",
          "mcp__docs__search",
          "Nonexistent",
        ],
        disallowedTools: ["Read"],
        toolPolicies: {
          Bash: "ask",
          Read: "deny",
          mcp__one__delete_all: "deny",
          plugin__nope__write: "deny",
        },
        skills: ["pdf", "manual"],
        selectedSkills: ["sheets", "missing-skill"],
        connectors: [
          { template: "none" },
          { template: "one", tools: ["delete_all", "gone"] },
          { template: "crm:many" },
          {
            needs: {
              protocol: "mcp",
              endpoint: "https://h.example.com/mcp",
              tools: ["q"],
              label: "Wiki",
            },
          },
          { template: "unknown" },
        ],
        subagents: {
          types: ["reviewer", "crm:absent"],
          inline: [
            {
              name: "checker",
              description: "Checks.",
              instructions: "Check.",
              tools: ["Bash", "WebFetch"],
              skills: ["review-notes", "missing-skill"],
              model: "fast",
            },
          ],
        },
        maxSteps: 12,
      }),
      { plugin: "crm", itemId },
    );

    const { agent, preview: p } = await createOk(env.boss, id);
    expect(pick(p, "tool")).toEqual([
      ["Bash", "carried", null],
      ["plugin__fake-tools-ui__write", "carried", null],
      ["plugin__nope__write", "unavailable", "plugin_unavailable"],
      ["mcp__docs__search", "unavailable", "connector_key"],
      ["Nonexistent", "unavailable", "unknown_tool"],
      ["Agent", "carried", "subagents"],
    ]);
    expect(pick(p, "skill")).toEqual([
      ["pdf", "carried", "pinned"],
      ["manual", "carried", "not_pinned_manual_only"],
      ["sheets", "carried", null],
      ["missing-skill", "unavailable", "not_found"],
      ["review-notes", "carried", "subagent"],
    ]);
    expect(pick(p, "connector")).toEqual([
      ["NONE", "pending", "no_connector"],
      ["Conn one", "carried", null],
      ["Conn many-a", "carried", "several"],
      ["Wiki", "pending", "needs"],
      ["unknown", "unavailable", "template_not_found"],
    ]);
    expect(pick(p, "subagent")).toEqual([
      ["crm:reviewer", "carried", null],
      ["crm:absent", "unavailable", "type_not_found"],
      ["checker", "carried", null],
    ]);
    expect(pick(p, "instruction_file")).toEqual([
      ["AGENTS.md", "carried", null],
      ["style.md", "carried", null],
    ]);
    expect(pick(p, "quick_action")).toEqual([["Summarize", "carried", null]]);
    expect(p.dropped).toEqual(
      expect.arrayContaining(["maxSteps", "connectors.connector-2.tools.gone"]),
    );

    const d = agent.definition;
    expect(d.name).toBe("From tpl");
    expect(d.instructions).toBe("# AGENTS.md\n\nBe useful.\n\n# style.md\n\nBe brief.");
    expect(d.tools).toEqual([
      { kind: "builtin", name: "Bash" },
      { kind: "plugin", plugin: "fake-tools-ui", name: "write" },
      { kind: "connector", connectorId: oneConn, tools: ["delete_all"] },
      { kind: "connector", connectorId: firstMany, tools: "all" },
      { kind: "builtin", name: "Agent" },
    ]);
    // policies only for the agent's tools; Read was disallowed, the nope plugin is unavailable
    expect(d.toolPolicies).toEqual({ Bash: "ask", mcp__one__delete_all: "deny" });
    expect(d.skills).toEqual({
      orgSkills: [pinnedSkill, manualSkill, selectedSkill, inlineSkill],
      pinned: [pinnedSkill],
    });
    expect(d.subagents).toEqual({
      templates: [reviewer],
      inline: [
        {
          name: "checker",
          description: "Checks.",
          instructions: "Check.",
          tools: ["Bash"],
          skills: [inlineSkill],
          model: "fast",
        },
      ],
    });
    expect(d.pendingConnectors).toEqual([
      { key: "connector-1", label: "NONE", source: { template: none } },
      {
        key: "connector-4",
        label: "Wiki",
        source: {
          needs: {
            protocol: "mcp",
            endpoint: "https://h.example.com/mcp",
            tools: ["q"],
            label: "Wiki",
          },
        },
        tools: ["q"],
      },
    ]);
    expect(agent.profile.description).toBe("Helps with things.");
    expect(agent.profile.quickActions).toEqual([{ title: "Summarize", body: "Summarize this." }]);
    expect(agent.visibility).toBe("private");
    expect(agent.currentVersion).toBe(1);

    // pending connectors are model-invisible: tools come from `tools` only
    const resolved = await env.k.app.get(ToolRegistry).forAgent(env.orgId, d);
    const keys = resolved.tools.map((t) => t.key);
    expect(keys).toContain("mcp__one__delete_all");
    expect(keys.some((k) => k.includes("Wiki") || k.startsWith("mcp__none"))).toBe(false);
  });

  it("binds nothing and adds no Agent tool for a plain template; tools default", async () => {
    const id = await platformTemplate(tpl());
    const { agent, preview: p } = await createOk(env.mem, id);
    expect(pick(p, "tool")).toEqual([
      ["AskUserQuestion", "carried", "default"],
      ["ReadToolOutput", "carried", "default"],
    ]);
    expect(agent.definition.pendingConnectors).toBeUndefined();
    expect(agent.definition.subagents).toBeUndefined();
    expect(agent.definition.instructions).toBe("Help.");
    expect(agent.ownerAccountId).toBe(env.memId);
  });

  it("chooses the model: modelRef, then the tier's purpose, then the default (P4-4)", async () => {
    const plain = await platformTemplate(tpl());
    expect((await preview(env.mem, plain)).model).toEqual({
      provider: "model-fake",
      model: "fake-1",
      source: "default",
    });
    const ref = await platformTemplate(tpl({ name: "r", modelRef: "model-fake/fake-1" }));
    expect((await preview(env.mem, ref)).model?.source).toBe("modelRef");
    const badRef = await platformTemplate(tpl({ name: "b", modelRef: "gone/x", model: "fast" }));
    expect((await preview(env.mem, badRef)).model?.source).toBe("default");
    await env.db
      .insertInto("model_purpose_mappings")
      .values({
        org_id: env.orgId,
        purpose: "subagent_fast",
        provider: "model-fake",
        model: "fake-1",
        params: JSON.stringify({ effort: "low" }),
        updated_by: env.bossId,
      })
      .execute();
    expect((await preview(env.mem, badRef)).model?.source).toBe("tier");
    const { agent } = await createOk(env.mem, badRef);
    expect(agent.definition.modelParams).toEqual({ effort: "low" });

    // effort becomes the model parameter when declared and valid; else dropped
    const effort = await platformTemplate(tpl({ name: "e", effort: "high" }));
    const made = await createOk(env.mem, effort);
    expect(made.agent.definition.modelParams).toEqual({ effort: "high" });
    const tooMuch = await platformTemplate(tpl({ name: "x", effort: "max" }));
    const p = await preview(env.mem, tooMuch);
    expect(p.dropped).toContain("effort");
  });

  it("orders the model choice in planFromTemplate (stubbed models)", async () => {
    const id = await platformTemplate(tpl({ modelRef: "p/ref", model: "capable", effort: "low" }));
    const row = (await loadTemplates(env.db, env.orgId, [id])).get(id);
    if (!row) throw new Error("template not loaded");
    const usable = new Set<string>();
    const opts = (o: Partial<PlanOptions> = {}): PlanOptions => ({
      pluginTools: [],
      enabledPlugins: new Set(),
      resolveModel: async (r) =>
        usable.has(`${r.provider}/${r.model}`)
          ? [{ key: "effort", standard: "effort", schema: { type: "string", enum: ["low"] } }]
          : null,
      purpose: async (p) =>
        p === "subagent_capable" ? { model: { provider: "p", model: "tier" }, params: {} } : null,
      defaultModel: async () => ({ provider: "p", model: "default" }),
      ...o,
    });
    const plan = (o?: Partial<PlanOptions>) => planFromTemplate(env.db, env.orgId, row, opts(o));

    usable.add("p/ref").add("p/tier").add("p/default");
    expect((await plan()).model).toEqual({
      ref: { provider: "p", model: "ref" },
      params: { effort: "low" },
      source: "modelRef",
    });
    usable.delete("p/ref");
    expect((await plan()).model?.ref.model).toBe("tier");
    usable.delete("p/tier");
    expect((await plan()).model?.ref.model).toBe("default");
    usable.delete("p/default");
    const none = await plan();
    expect(none.model).toBeNull();
    expect(none.dropped).toContain("effort");
    // the person's choice wins; the hash does not depend on the model
    usable.add("p/chosen");
    const chosen = await plan({ model: { provider: "p", model: "chosen" } });
    expect(chosen.model?.source).toBe("chosen");
    expect(chosen.hash).toBe(none.hash);
  });

  it("only an admin creates it for others (403 agent.visibility_forbidden)", async () => {
    const id = await platformTemplate(tpl());
    const p = await preview(env.mem, id);
    for (const visibility of ["org", "members"]) {
      const r = await create(env.mem, {
        templateId: id,
        name: "Mine",
        visibility,
        ...(visibility === "members" && { members: [env.memId] }),
        previewHash: p.previewHash,
      });
      expect(r.statusCode, r.body).toBe(403);
      expect(errCode(r)).toBe("agent.visibility_forbidden");
    }
    expect(await env.db.selectFrom("agents").select("id").execute()).toEqual([]);
    const { agent } = await createOk(env.boss, id, { visibility: "org" });
    expect(agent.visibility).toBe("org");
    const shared = await createOk(env.boss, id, { visibility: "members", members: [env.memId] });
    expect(shared.agent.memberIds).toEqual([env.memId]);
  });

  it("refuses a stale preview (409 agent.template_preview_stale)", async () => {
    const itemId = await catalogItem("crm");
    const ct = await connectorTemplate(itemId, "gh");
    const id = await platformTemplate(tpl({ connectors: [{ template: "gh" }] }), {
      plugin: "crm",
      itemId,
    });
    const before = await preview(env.mem, id);
    // the org's state changed: a connector made from the template now exists
    await connector("gh", ["search"], ct);
    const r = await create(env.mem, {
      templateId: id,
      name: "X",
      previewHash: before.previewHash,
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(errCode(r)).toBe("agent.template_preview_stale");

    // the template's version changed
    const fresh = await preview(env.mem, id);
    await env.db
      .insertInto("platform_agent_template_versions")
      .values({ template_id: id, version: 2, definition: JSON.stringify(tpl()) })
      .execute();
    await env.db
      .updateTable("platform_agent_templates")
      .set({ current_version: 2 })
      .where("id", "=", id)
      .execute();
    const r2 = await create(env.mem, { templateId: id, name: "X", previewHash: fresh.previewHash });
    expect(r2.statusCode).toBe(409);
    expect(errCode(r2)).toBe("agent.template_preview_stale");
    // a model choice never makes a preview stale
    const again = await preview(env.mem, id);
    const ok = await create(env.mem, {
      templateId: id,
      name: "X",
      model: { provider: "model-fake", model: "fake-1" },
      previewHash: again.previewHash,
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("uses another org's shared template that is on, and 404s a template off in the org", async () => {
    const other = await createOrg(env.root, "Other");
    // optional scope: on in this org through its switch
    const shared = await platformTemplate(tpl({ name: "shared" }), {
      ownerOrgId: other,
      scope: "optional",
    });
    await env.db
      .insertInto("component_org_switches")
      .values({ kind: "agent_template", component_id: shared, org_id: env.orgId, enabled: true })
      .execute();
    const { agent } = await createOk(env.mem, shared);
    expect(agent.createdFrom).toEqual({
      templateId: shared,
      version: 1,
      name: "shared",
      available: true,
    });

    await env.db
      .updateTable("component_org_switches")
      .set({ enabled: false })
      .where("component_id", "=", shared)
      .execute();
    const r = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents/from-template/preview`,
      payload: { templateId: shared },
    });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("agent.template_not_found");
    const c = await create(env.mem, { templateId: shared, name: "X", previewHash: "0".repeat(64) });
    expect(c.statusCode).toBe(404);
    expect(errCode(c)).toBe("agent.template_not_found");
    // the provenance stays; the link is gone
    const g = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/agents/${agent.id}` });
    expect((g.json() as { agent: AgentView }).agent.createdFrom).toEqual({
      templateId: shared,
      version: 1,
      name: "shared",
      available: false,
    });
  });

  it("records provenance once and shows it in GET (P4-8)", async () => {
    const orgTpl = randomUUID();
    await env.db
      .insertInto("agent_templates")
      .values({
        id: orgTpl,
        org_id: env.orgId,
        name: "ours",
        plugin_name: null,
        current_version: 1,
      })
      .execute();
    await env.db
      .insertInto("agent_template_versions")
      .values({
        template_id: orgTpl,
        version: 1,
        definition: JSON.stringify(tpl({ name: "ours" })),
        source_format: "capybara",
        catalog_version: null,
      })
      .execute();
    const { agent } = await createOk(env.boss, orgTpl);
    const row = await env.db
      .selectFrom("agents")
      .select([
        "created_from_template_id",
        "created_from_template_version",
        "created_from_template_name",
      ])
      .where("id", "=", agent.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      created_from_template_id: orgTpl,
      created_from_template_version: 1,
      created_from_template_name: "ours",
    });
    // an edit writes a version, never the provenance
    const u = await env.boss({
      method: "PATCH",
      url: `/api/v1/orgs/${env.orgId}/agents/${agent.id}`,
      payload: { definition: { ...agent.definition, instructions: "Changed." } },
    });
    expect(u.statusCode, u.body).toBe(200);
    const g = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/agents/${agent.id}`,
    });
    const view = (g.json() as { agent: AgentView }).agent;
    expect(view.currentVersion).toBe(2);
    expect(view.createdFrom).toEqual({
      templateId: orgTpl,
      version: 1,
      name: "ours",
      available: true,
    });
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "agent.created")
      .where("target", "=", agent.id)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ template: { id: orgTpl, version: 1 } });
    // an agent created otherwise has none
    const plain = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: { name: "P", model: { provider: "model-fake", model: "fake-1" } },
        visibility: "org",
      },
    });
    expect((plain.json() as { agent: AgentView }).agent.createdFrom).toBeNull();
  });

  it("opens the pending connector request only for a creator without connectors.manage", async () => {
    const id = await platformTemplate(
      tpl({
        connectors: [
          {
            needs: {
              protocol: "openapi",
              endpoint: "https://a.example.com",
              tools: ["x"],
              label: "A",
            },
          },
        ],
      }),
    );
    const plain = await platformTemplate(tpl({ name: "plain" }));
    const spy = vi.spyOn(env.k.app.get(PendingConnectorRequests), "openFor");
    const { agent } = await createOk(env.mem, id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      orgId: env.orgId,
      agentId: agent.id,
      ownerAccountId: env.memId,
      keys: ["connector-1"],
    });
    spy.mockClear();
    await createOk(env.boss, id);
    await createOk(env.mem, plain);
    expect(spy).not.toHaveBeenCalled();
    // a failing request writer never fails the create
    spy.mockRejectedValueOnce(new Error("boom"));
    await createOk(env.mem, id);
  });

  it("keeps pending connectors across edits; only removing them is allowed", async () => {
    const id = await platformTemplate(
      tpl({
        connectors: [
          {
            needs: { protocol: "mcp", endpoint: "https://a.example.com", tools: ["x"], label: "A" },
          },
          {
            needs: { protocol: "mcp", endpoint: "https://b.example.com", tools: ["y"], label: "B" },
          },
        ],
      }),
    );
    const { agent } = await createOk(env.mem, id);
    const url = `/api/v1/orgs/${env.orgId}/agents/${agent.id}`;
    const { pendingConnectors, ...withoutPending } = agent.definition;
    expect(pendingConnectors).toHaveLength(2);
    // an editor that does not send them keeps them (no new version for an equal save)
    const same = await env.mem({ method: "PATCH", url, payload: { definition: withoutPending } });
    expect(same.statusCode, same.body).toBe(200);
    expect((same.json() as { agent: AgentView }).agent.currentVersion).toBe(1);
    expect((same.json() as { agent: AgentView }).agent.definition.pendingConnectors).toEqual(
      pendingConnectors,
    );
    // adding or changing one is refused
    const changed = await env.mem({
      method: "PATCH",
      url,
      payload: {
        definition: {
          ...withoutPending,
          pendingConnectors: [{ ...pendingConnectors?.[0], label: "Renamed" }],
        },
      },
    });
    expect(changed.statusCode).toBe(400);
    expect(errCode(changed)).toBe("validation_failed");
    // removing one keeps the other
    const removed = await env.mem({
      method: "PATCH",
      url,
      payload: { definition: { ...withoutPending, pendingConnectors: [pendingConnectors?.[1]] } },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      (removed.json() as { agent: AgentView }).agent.definition.pendingConnectors?.map(
        (c) => c.key,
      ),
    ).toEqual(["connector-2"]);
    const cleared = await env.mem({
      method: "PATCH",
      url,
      payload: { definition: { ...withoutPending, pendingConnectors: [] } },
    });
    expect(
      (cleared.json() as { agent: AgentView }).agent.definition.pendingConnectors,
    ).toBeUndefined();

    // a plain create never takes them
    const plain = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: {
          name: "P",
          model: { provider: "model-fake", model: "fake-1" },
          pendingConnectors,
        },
        visibility: "private",
      },
    });
    expect(plain.statusCode, plain.body).toBe(201);
    expect(
      (plain.json() as { agent: AgentView }).agent.definition.pendingConnectors,
    ).toBeUndefined();
  });
});
