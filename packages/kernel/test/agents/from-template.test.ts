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
async function orgSkill(
  name: string,
  o: { manual?: boolean; itemId?: string; bytes?: number } = {},
) {
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
      ...(o.itemId !== undefined && { catalog_item_id: o.itemId }),
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
        files: [{ path: "SKILL.md", size: o.bytes ?? 100, sha256: "0".repeat(64) }],
        ...(o.manual && { invocation: { model: false, user: true } }),
      }),
      object_prefix: `skills/${id}/`,
      created_by: env.bossId,
    })
    .execute();
  return id;
}

const ZERO_HASH = `${"0".repeat(64)}.${"0".repeat(16)}`;

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
          plugin__nope__write: "deny",
        },
        skills: ["pdf", "manual"],
        selectedSkills: ["sheets", "missing-skill"],
        connectors: [
          { template: "none", policies: { x: "ask" } },
          {
            template: "one",
            tools: ["delete_all", "gone"],
            policies: { delete_all: "deny", search: "ask", gone: "ask" },
          },
          { template: "crm:many" },
          {
            needs: {
              protocol: "mcp",
              endpoint: "https://h.example.com/mcp",
              tools: ["q"],
              label: "Wiki",
            },
            policies: { q: "deny" },
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
      expect.arrayContaining([
        "maxSteps",
        "connectors.connector-2.tools.gone",
        "connectors.connector-2.policies.search",
        "connectors.connector-2.policies.gone",
      ]),
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
    // policies only for the agent's tools; Read was disallowed, the nope plugin is unavailable;
    // the connector entry's policy lands on the bound connector's key
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
      { key: "connector-1", label: "NONE", source: { template: none }, policies: { x: "ask" } },
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
        policies: { q: "deny" },
      },
    ]);
    expect(agent.profile.description).toBe("Helps with things.");
    expect(agent.profile.quickActions).toEqual([{ title: "Summarize", body: "Summarize this." }]);
    expect(agent.visibility).toBe("private");
    expect(agent.currentVersion).toBe(1);

    // pending connectors are model-invisible: the tools are exactly those `tools` implies
    // (SendMessage comes with Agent; Bash is unavailable without a sandbox provider here)
    const resolved = await env.k.app.get(ToolRegistry).forAgent(env.orgId, d);
    expect(resolved.tools.map((t) => t.key).sort()).toEqual(
      [
        "Agent",
        "SendMessage",
        "mcp__many-a__search",
        "mcp__one__delete_all",
        "plugin__fake-tools-ui__write",
      ].sort(),
    );
    expect(resolved.unavailable.map((u) => u.ref)).toEqual(["Bash"]);
  });

  it("binds nothing and adds no Agent tool for a plain template; tools default", async () => {
    const id = await platformTemplate(tpl());
    const { agent, preview: p } = await createOk(env.mem, id);
    expect(pick(p, "tool")).toEqual([
      ["AskUserQuestion", "carried", "default"],
      ["ReadToolOutput", "carried", "default"],
      ["Platform", "carried", "default"],
    ]);
    expect(agent.definition.pendingConnectors).toBeUndefined();
    expect(agent.definition.subagents).toBeUndefined();
    expect(agent.definition.instructions).toBe("Help.");
    expect(agent.ownerAccountId).toBe(env.memId);
  });

  it("narrows a bound connector by disallowedTools", async () => {
    const itemId = await catalogItem("crm");
    const ct = await connectorTemplate(itemId, "gh");
    const conn = await connector("gh", ["search", "delete_all"], ct);
    const id = await platformTemplate(
      tpl({ connectors: [{ template: "gh" }], disallowedTools: ["mcp__gh__delete_all"] }),
      { plugin: "crm", itemId },
    );
    const { agent } = await createOk(env.boss, id);
    expect(agent.definition.tools).toContainEqual({
      kind: "connector",
      connectorId: conn,
      tools: ["search"],
    });
  });

  it("inline tools: absent = all, [] = none, all dropped = none (ruling P4-T3-8)", async () => {
    const id = await platformTemplate(
      tpl({
        tools: ["Read"],
        subagents: {
          inline: [
            {
              name: "web",
              description: "Web.",
              instructions: "Go.",
              tools: ["WebFetch"],
              skills: [],
              model: "inherit",
            },
            {
              name: "none",
              description: "None.",
              instructions: "Go.",
              tools: [],
              skills: [],
              model: "inherit",
            },
            {
              name: "any",
              description: "Any.",
              instructions: "Go.",
              skills: [],
              model: "inherit",
            },
          ],
        },
      }),
    );
    const { agent, preview: p } = await createOk(env.mem, id);
    expect(p.dropped).toContain("subagents.inline.web.tools.WebFetch");
    expect(agent.definition.subagents?.inline?.map((x) => [x.name, x.tools ?? null])).toEqual([
      ["web", []],
      ["none", []],
      ["any", null],
    ]);
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
          ? [
              {
                key: "effort",
                standard: "effort",
                schema: { type: "string", enum: ["low"] },
                label: { zh: "思考深度", en: "Effort" },
              },
            ]
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
    // the person's choice wins; the base hash does not depend on the model
    usable.add("p/chosen");
    const chosen = await plan({ model: { provider: "p", model: "chosen" } });
    expect(chosen.model?.source).toBe("chosen");
    expect(chosen.auto).toBeNull();
    expect(chosen.baseHash).toBe(none.baseHash);
    expect(chosen.modelHash).toBe(none.modelHash);
    // choosing the automatic model keeps its params and source; the model part follows it
    usable.add("p/tier");
    const sameAsAuto = await plan({ model: { provider: "p", model: "tier" } });
    expect(sameAsAuto.model).toEqual({
      ref: { provider: "p", model: "tier" },
      params: { effort: "low" },
      source: "tier",
    });
    expect(sameAsAuto.modelHash).not.toBe(none.modelHash);
    expect(sameAsAuto.hash).toBe(`${sameAsAuto.baseHash}.${sameAsAuto.modelHash}`);
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
    expect(errCode(r)).toBe("component.not_found");
    const c = await create(env.mem, { templateId: shared, name: "X", previewHash: ZERO_HASH });
    expect(c.statusCode).toBe(404);
    expect(errCode(c)).toBe("component.not_found");
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
  it("lists the connector, sub-agent and Agent edge cases (P4-5)", async () => {
    const itemId = await catalogItem("crm");
    const gh = await connectorTemplate(itemId, "gh");
    await connector("gh", ["search"], gh);
    const nar = await connectorTemplate(itemId, "nar");
    await connector("nar", ["x"], nar);
    const old = await connectorTemplate(itemId, "old");
    const oldConn = await connector("old", ["read"], old);
    const gone = await connectorTemplate(itemId, "gone");
    await env.db
      .updateTable("platform_connector_templates")
      .set({ deleted_at: new Date() })
      .where("id", "in", [old, gone])
      .execute();
    const reviewer = await platformTemplate(tpl({ name: "reviewer" }), { plugin: "crm", itemId });
    const orgRev = randomUUID();
    await env.db
      .insertInto("agent_templates")
      .values({ id: orgRev, org_id: env.orgId, name: "rev", plugin_name: null, current_version: 1 })
      .execute();
    await env.db
      .insertInto("agent_template_versions")
      .values({
        template_id: orgRev,
        version: 1,
        definition: JSON.stringify(tpl({ name: "rev" })),
        source_format: "capybara",
        catalog_version: null,
      })
      .execute();
    const inline = (name: string) => ({
      name,
      description: "D.",
      instructions: "I.",
      skills: [],
      model: "inherit" as const,
    });
    const id = await platformTemplate(
      tpl({
        tools: ["Read"],
        disallowedTools: ["mcp__nar__x"],
        connectors: [
          { template: "gh", tools: ["absent"] },
          { template: "nar" },
          { template: "old" },
          { template: "gone" },
        ],
        subagents: {
          types: ["reviewer", "crm:reviewer", "rev"],
          inline: ["rev", ...Array.from({ length: 10 }, (_, i) => `in-${i}`)].map(inline),
        },
      }),
      { plugin: "crm", itemId },
    );
    const { agent, preview: p } = await createOk(env.boss, id);
    expect(pick(p, "connector")).toEqual([
      ["GH", "pending", "tools_missing"],
      ["Conn nar", "unavailable", "disallowed"],
      ["Conn old", "carried", null],
      // removed, and the org made nothing from it: no longer the org's to see, so unnamed
      ["gone", "unavailable", "template_not_found"],
    ]);
    // a pending connector keeps its names: none is both kept and dropped
    expect(p.dropped.filter((d) => d.startsWith("connectors."))).toEqual([]);
    expect(agent.definition.pendingConnectors).toEqual([
      { key: "connector-1", label: "GH", source: { template: gh }, tools: ["absent"] },
    ]);
    expect(agent.definition.tools).toEqual([
      { kind: "builtin", name: "Read" },
      { kind: "connector", connectorId: oldConn, tools: "all" },
      { kind: "builtin", name: "Agent" },
    ]);
    expect(pick(p, "subagent")).toEqual([
      ["crm:reviewer", "carried", null],
      ["crm:reviewer", "unavailable", "type_taken"],
      ["rev", "unavailable", "type_taken"],
      ["rev", "carried", null],
      ...Array.from({ length: 9 }, (_, i) => [`in-${i}`, "carried", null]),
      ["in-9", "unavailable", "too_many"],
    ]);
    expect(agent.definition.subagents?.templates).toEqual([reviewer]);
    expect(agent.definition.subagents?.inline).toHaveLength(10);
  });

  it("adds Agent for general: true, and never against the template's disallow", async () => {
    const general = await platformTemplate(tpl({ tools: ["Read"], subagents: { general: true } }));
    const g = await createOk(env.mem, general);
    expect(pick(g.preview, "tool")).toEqual([
      ["Read", "carried", null],
      ["Agent", "carried", "subagents"],
    ]);
    const denied = await platformTemplate(
      tpl({
        name: "denied",
        disallowedTools: ["Agent"],
        subagents: {
          inline: [
            { name: "a", description: "D.", instructions: "I.", skills: [], model: "inherit" },
          ],
        },
      }),
    );
    const d = await createOk(env.mem, denied);
    expect(d.agent.definition.tools.some((r) => r.kind === "builtin" && r.name === "Agent")).toBe(
      false,
    );
  });

  it("gives every name of one skill its item and leaves an oversized one unpinned", async () => {
    const itemId = await catalogItem("crm");
    const pdf = await orgSkill("pdf", { itemId });
    const big = await orgSkill("big", { bytes: 40_000 });
    const id = await platformTemplate(tpl({ skills: ["pdf", "big"], selectedSkills: ["crm:pdf"] }));
    const { agent, preview: p } = await createOk(env.mem, id);
    expect(pick(p, "skill")).toEqual([
      ["pdf", "carried", "pinned"],
      ["big", "carried", "not_pinned_too_large"],
      ["crm:pdf", "carried", "pinned"],
    ]);
    expect(agent.definition.skills).toEqual({ orgSkills: [pdf, big], pinned: [pdf] });
  });

  it("404s another org's unshared org template", async () => {
    const other = await createOrg(env.root, "Elsewhere");
    const theirs = randomUUID();
    await env.db
      .insertInto("agent_templates")
      .values({ id: theirs, org_id: other, name: "theirs", plugin_name: null, current_version: 1 })
      .execute();
    await env.db
      .insertInto("agent_template_versions")
      .values({
        template_id: theirs,
        version: 1,
        definition: JSON.stringify(tpl({ name: "theirs" })),
        source_format: "capybara",
        catalog_version: null,
      })
      .execute();
    const r = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents/from-template/preview`,
      payload: { templateId: theirs },
    });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("component.not_found");
  });

  it("refuses an unusable chosen model; a silent change of the automatic one is stale", async () => {
    const id = await platformTemplate(tpl({ model: "fast" }));
    const p = await preview(env.mem, id);
    expect(p.model?.source).toBe("default");
    const bad = await create(env.mem, {
      templateId: id,
      name: "X",
      model: { provider: "model-fake", model: "nope" },
      previewHash: p.previewHash,
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(errCode(bad)).toBe("agent.model_unavailable");

    // the tier gets mapped after the preview: the automatic choice changed
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
    const silent = await create(env.mem, { templateId: id, name: "X", previewHash: p.previewHash });
    expect(silent.statusCode).toBe(409);
    expect(errCode(silent)).toBe("agent.template_preview_stale");
    // an explicit choice is not stale; equal to the automatic one, it keeps the tier's params
    const chosen = await create(env.mem, {
      templateId: id,
      name: "X",
      model: { provider: "model-fake", model: "fake-1" },
      previewHash: p.previewHash,
    });
    expect(chosen.statusCode, chosen.body).toBe(201);
    expect((chosen.json() as { agent: AgentView }).agent.definition.modelParams).toEqual({
      effort: "low",
    });
  });

  it("resolves a bare sub-agent type to the template's own plugin first", async () => {
    const itemId = await catalogItem("acme");
    const acmeResearcher = await platformTemplate(tpl({ name: "researcher" }), {
      plugin: "acme",
      itemId,
    });
    // the org's own bare `researcher` must not shadow the plugin's
    const orgResearcher = randomUUID();
    await env.db
      .insertInto("agent_templates")
      .values({
        id: orgResearcher,
        org_id: env.orgId,
        name: "researcher",
        plugin_name: null,
        current_version: 1,
      })
      .execute();
    await env.db
      .insertInto("agent_template_versions")
      .values({
        template_id: orgResearcher,
        version: 1,
        definition: JSON.stringify(tpl({ name: "researcher" })),
        source_format: "capybara",
        catalog_version: null,
      })
      .execute();
    const lead = await platformTemplate(
      tpl({ name: "lead", subagents: { types: ["researcher"] } }),
      { plugin: "acme", itemId },
    );
    const { agent, preview: p } = await createOk(env.boss, lead);
    expect(pick(p, "subagent")).toEqual([["acme:researcher", "carried", null]]);
    expect(agent.definition.subagents?.templates).toEqual([acmeResearcher]);

    // a template without a plugin of its own takes the exact bare type
    const plain = await platformTemplate(
      tpl({ name: "plain", subagents: { types: ["researcher"] } }),
    );
    const q = await createOk(env.boss, plain);
    expect(q.agent.definition.subagents?.templates).toEqual([orgResearcher]);
  });

  it("treats a connector template the org may not see as unavailable, without its name", async () => {
    const hiddenItem = await catalogItem("hidden");
    // offered only to the orgs on its list: not this one
    await env.db
      .updateTable("catalog_items")
      .set({ scope: "named" })
      .where("id", "=", hiddenItem)
      .execute();
    await connectorTemplate(hiddenItem, "secret");
    const owned = await connectorTemplate(hiddenItem, "mine");
    await env.db
      .updateTable("platform_connector_templates")
      .set({ owner_org_id: env.orgId })
      .where("id", "=", owned)
      .execute();
    const id = await platformTemplate(
      tpl({ connectors: [{ template: "hidden:secret" }, { template: "hidden:mine" }] }),
    );
    const r = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents/from-template/preview`,
      payload: { templateId: id },
    });
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json() as Preview;
    expect(pick(p, "connector")).toEqual([
      ["hidden:secret", "unavailable", "template_not_found"],
      // the org's own connector template stays visible to it
      ["MINE", "pending", "no_connector"],
    ]);
    expect(r.body).not.toContain("SECRET");
  });

  it("sanitizes a needs endpoint of a plugin template; an invalid one is unavailable", async () => {
    const id = await platformTemplate(
      tpl({
        connectors: [
          {
            needs: {
              protocol: "mcp",
              endpoint: "https://alice:pw@wiki.example.com/mcp?token=sekrit#top",
              tools: ["find"],
              label: "Wiki",
            },
          },
          {
            needs: { protocol: "openapi", endpoint: "not a url", tools: [], label: "Broken" },
          },
        ],
      }),
      { plugin: "acme" },
    );
    const { agent, preview: p } = await createOk(env.boss, id);
    expect(pick(p, "connector")).toEqual([
      ["Wiki", "pending", "needs"],
      ["Broken", "unavailable", "invalid_endpoint"],
    ]);
    expect(agent.definition.pendingConnectors).toEqual([
      {
        key: "connector-1",
        label: "Wiki",
        source: {
          needs: {
            protocol: "mcp",
            endpoint: "https://wiki.example.com/mcp",
            tools: ["find"],
            label: "Wiki",
          },
        },
        tools: ["find"],
      },
    ]);
    expect(JSON.stringify(agent.definition)).not.toContain("sekrit");
  });

  it("round-trips an agent through save-as and create (P4-10, P4-5)", async () => {
    const itemId = await catalogItem("kit");
    const kitTpl = await connectorTemplate(itemId, "kit");
    const kit = await connector("kit", ["search", "fetch"], kitTpl);
    // a hand-configured MCP connector: its endpoint's query never travels
    const wiki = randomUUID();
    await env.db
      .insertInto("connectors")
      .values({
        id: wiki,
        org_id: env.orgId,
        slug: "wiki",
        name: "Wiki",
        connector: "mcp",
        endpoint: JSON.stringify({ url: "https://wiki.example.com/mcp?token=sekrit" }),
        auth: JSON.stringify({}),
        created_by: env.bossId,
      })
      .execute();
    await env.db
      .insertInto("connector_tools")
      .values(
        ["find", "wipe"].map((name) => ({
          connector_id: wiki,
          name,
          spec: JSON.stringify({ name, description: "d", inputSchema: { type: "object" } }),
          spec_hash: "h",
          status: name === "find" ? ("enabled" as const) : ("disabled" as const),
          default_policy: "allow" as const,
        })),
      )
      .execute();
    const pdf = await orgSkill("pdf");
    const sheets = await orgSkill("sheets");
    const notes = await orgSkill("review-notes");
    const reviewer = await platformTemplate(tpl({ name: "reviewer" }), { plugin: "crm" });

    const agentId = randomUUID();
    await env.db
      .insertInto("agents")
      .values({
        id: agentId,
        org_id: env.orgId,
        owner_account_id: env.bossId,
        visibility: "private",
        current_version: 1,
        profile_avatar: JSON.stringify({ kind: "preset", id: "p01" }),
        profile_description: "Leads the team.",
        profile_quick_actions: JSON.stringify([{ title: "Weekly", body: "Write the report." }]),
      })
      .execute();
    const source = {
      name: "Lead",
      instructions: "# AGENTS.md\n\nLead.\n\n# style.md\n\nBe brief.",
      instructionFiles: [
        { name: "AGENTS.md", content: "Lead." },
        { name: "style.md", content: "Be brief." },
      ],
      model: { provider: "model-fake", model: "fake-1" },
      modelParams: { effort: "high", "model-fake.style": "shout" },
      fallback: { provider: "model-fake", model: "fake-1" },
      fallbackParams: { effort: "low" },
      tools: [
        { kind: "builtin", name: "Read" },
        { kind: "builtin", name: "Agent" },
        { kind: "plugin", plugin: "fake-tools-ui", name: "write" },
        { kind: "connector", connectorId: kit, tools: ["search"] },
        { kind: "connector", connectorId: wiki, tools: "all" },
      ],
      toolPolicies: {
        Read: "ask",
        "plugin__fake-tools-ui__write": "deny",
        mcp__kit__search: "ask",
        mcp__wiki__find: "deny",
      },
      skills: { orgSkills: [pdf, sheets, notes], pinned: [pdf] },
      subagents: {
        general: false,
        templates: [reviewer],
        inline: [
          {
            name: "helper",
            description: "Helps.",
            instructions: "Help out.",
            tools: ["Read"],
            skills: [notes],
            model: "fast",
          },
          { name: "solo", description: "Alone.", instructions: "Work alone." },
          { name: "mute", description: "Talks.", instructions: "Just talk.", tools: [] },
        ],
      },
    };
    await env.db
      .insertInto("agent_versions")
      .values({
        agent_id: agentId,
        version: 1,
        definition: JSON.stringify(source),
        created_by: env.bossId,
      })
      .execute();

    const saved = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents/${agentId}/save-as-template`,
      payload: { name: "lead", description: "Leads the team." },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const { template, omitted } = saved.json() as {
      template: { id: string };
      omitted: unknown[];
    };
    // what has no place in a template is listed, never dropped silently
    expect(omitted).toEqual([
      { kind: "model_param", name: "model-fake.style", reason: "model_param" },
      { kind: "fallback_model", name: "model-fake/fake-1", reason: "fallback" },
    ]);

    const { agent, preview: p } = await createOk(env.boss, template.id);
    expect(p.items.filter((i) => i.state !== "carried")).toEqual([
      { kind: "connector", name: "Wiki", state: "pending", reason: "needs" },
    ]);
    expect(p.dropped).toEqual([]);
    const d = agent.definition;
    // instructions and files
    expect(d.instructionFiles).toEqual(source.instructionFiles);
    expect(d.instructions).toBe(source.instructions);
    // model, tier and effort (the other params and the fallback were listed above)
    expect(p.model).toMatchObject({ provider: "model-fake", model: "fake-1", source: "modelRef" });
    expect(d.model).toEqual(source.model);
    expect(d.modelParams).toEqual({ effort: "high" });
    expect(d.fallback).toBeNull();
    // tools and policies; the template-made connector rebinds with its tools and policy
    expect(d.tools).toEqual([
      { kind: "builtin", name: "Read" },
      { kind: "builtin", name: "Agent" },
      { kind: "plugin", plugin: "fake-tools-ui", name: "write" },
      { kind: "connector", connectorId: kit, tools: ["search"] },
    ]);
    expect(d.toolPolicies).toEqual({
      Read: "ask",
      "plugin__fake-tools-ui__write": "deny",
      mcp__kit__search: "ask",
    });
    // pinned and selected skills
    expect(d.skills).toEqual({ orgSkills: [pdf, sheets, notes], pinned: [pdf] });
    // the hand-configured connector comes back as a need, with its policy and no secret
    expect(d.pendingConnectors).toEqual([
      {
        key: "connector-2",
        label: "Wiki",
        source: {
          needs: {
            protocol: "mcp",
            endpoint: "https://wiki.example.com/mcp",
            tools: ["find"],
            label: "Wiki",
          },
        },
        tools: ["find"],
        policies: { find: "deny" },
      },
    ]);
    expect(JSON.stringify(d)).not.toContain("sekrit");
    // sub-agents: the type, and inline ones with tools absent and []
    expect(d.subagents).toEqual({
      general: false,
      templates: [reviewer],
      inline: [
        {
          name: "helper",
          description: "Helps.",
          instructions: "Help out.",
          tools: ["Read"],
          skills: [notes],
          model: "fast",
        },
        { name: "solo", description: "Alone.", instructions: "Work alone.", model: "inherit" },
        {
          name: "mute",
          description: "Talks.",
          instructions: "Just talk.",
          tools: [],
          model: "inherit",
        },
      ],
    });
    // the profile
    expect(agent.profile.description).toBe("Leads the team.");
    expect(agent.profile.quickActions).toEqual([{ title: "Weekly", body: "Write the report." }]);
  });

  it("cuts text in UTF-16 units so the agent saves again as created", async () => {
    const id = await platformTemplate(
      tpl({
        description: "😀".repeat(300),
        instructions: "😀".repeat(60_000),
        quickActions: [{ title: "😀".repeat(30), body: "Go." }],
      }),
    );
    const { agent, preview: p } = await createOk(env.mem, id);
    expect(p.dropped).toEqual(
      expect.arrayContaining(["description", "instructions", "quickActions.0.title"]),
    );
    expect(agent.profile.description).toBe("😀".repeat(250));
    expect(agent.definition.instructions).toBe("😀".repeat(50_000));
    expect(agent.profile.quickActions[0]?.title).toBe("😀".repeat(20));
    const url = `/api/v1/orgs/${env.orgId}/agents/${agent.id}`;
    const patch = await env.mem({
      method: "PATCH",
      url,
      payload: { definition: agent.definition },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const profile = await env.mem({
      method: "PATCH",
      url: `${url}/profile`,
      payload: {
        description: agent.profile.description,
        quickActions: agent.profile.quickActions,
        expectedUpdatedAt: agent.profile.updatedAt,
      },
    });
    expect(profile.statusCode, profile.body).toBe(200);

    // instruction files: case-insensitive duplicates and a join past the limit are left out
    const files = await platformTemplate(
      tpl({
        name: "files",
        instructionFiles: [
          { name: "AGENTS.md", content: "x".repeat(60_000) },
          { name: "agents.md", content: "dup" },
          { name: "more.md", content: "y".repeat(60_000) },
        ],
      }),
    );
    const f = await createOk(env.mem, files);
    expect(pick(f.preview, "instruction_file")).toEqual([
      ["AGENTS.md", "carried", null],
      ["agents.md", "unavailable", "duplicate"],
      ["more.md", "unavailable", "too_long"],
    ]);
    expect(f.agent.definition.instructionFiles?.map((x) => x.name)).toEqual(["AGENTS.md"]);
  });
});
