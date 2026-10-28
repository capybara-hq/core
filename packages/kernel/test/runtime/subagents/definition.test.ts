import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AgentDefinition, AgentDefinitionSchema } from "../../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { type Account, AccountsService } from "../../../src/identity/accounts.js";
import { ApiTokenService } from "../../../src/identity/api-tokens.js";
import { SettingsService } from "../../../src/identity/settings.js";
import { createKernel, type Kernel } from "../../../src/kernel.js";
import { createLogger } from "../../../src/log.js";
import { OrgsService } from "../../../src/orgs/orgs.service.js";
import {
  CHILD_REMOVED_TOOLS,
  type CheckedOrgAgent,
  childRunDefinition,
  effectiveDefinition,
  intersectTools,
  narrowFollowUp,
  stricterPolicies,
} from "../../../src/runtime/subagents/definition.js";
import { checkOrgAgent } from "../../../src/runtime/subagents/org-agents.js";
import {
  findType,
  type RosterEntry,
  resolveRoster,
} from "../../../src/runtime/subagents/roster.js";
import { truncateTables } from "../../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../../helpers/model-plugins.js";

/** Sub-agent roster and effective definitions (phase C, spec §4.3, §5.3–§5.5). */

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let cfg: KernelConfig;
let orgId: string;
let owner: Account;
let parentAgentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  cfg = KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    runtime: { maxSteps: 30 },
    ...MODEL_PLUGINS_CONFIG,
  });
  k = await createKernel(cfg, { env: {}, logger: createLogger("error", { write: () => {} }) });
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let n = 0;
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  n++;
  owner = await new AccountsService(db).createLocal({
    login: `owner${n}`,
    password: "correct horse battery",
    displayName: "O",
  });
  orgId = (
    await new OrgsService(db, new SettingsService(db), new ApiTokenService(db)).create(
      { name: "Acme", slug: `acme-${n}` },
      owner,
    )
  ).id;
  parentAgentId = await orgAgent(def());
});

const FAKE1 = { provider: "model-fake", model: "fake-1" };
const FAKE2 = { provider: "model-fake", model: "fake-2" };

const def = (over: Record<string, unknown> = {}): AgentDefinition =>
  AgentDefinitionSchema.parse({ name: "Lead", model: FAKE1, ...over });

const inline = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `Use ${name} for things.`,
  instructions: `You are ${name}.`,
  ...over,
});

async function template(
  name: string,
  over: Record<string, unknown> = {},
  plugin = "superpowers",
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("agent_templates")
    .values({ id, org_id: orgId, name, plugin_name: plugin, current_version: 2 })
    .execute();
  for (const version of [1, 2]) {
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: id,
        version,
        definition: JSON.stringify({
          name,
          description: `Template ${name} v${version}.`,
          instructions: `Body of ${name} v${version}.`,
          ...over,
        }),
      })
      .execute();
  }
  return id;
}

/** A catalog item named `name` (catalog items are global: reused across tests). */
async function catalogItem(name: string): Promise<string> {
  const got = await db
    .selectFrom("catalog_items")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirst();
  if (got) return got.id;
  const id = randomUUID();
  await db
    .insertInto("catalog_items")
    .values({
      id,
      name,
      package_name: `@acme/plugin-${name}`,
      publisher: "Acme",
      description: "d",
      latest_version: "1.0.0",
      policy: "allow",
    })
    .execute();
  return id;
}

async function skill(
  name: string,
  bytes = 100,
  agentId?: string,
  plugin?: string,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: orgId,
      scope: agentId === undefined ? "org" : "agent",
      agent_id: agentId ?? null,
      catalog_item_id: plugin === undefined ? null : await catalogItem(plugin),
      name,
      description: "d",
      current_version: 1,
      created_by: owner.id,
    })
    .execute();
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify({
        name,
        description: "d",
        files: [{ path: "SKILL.md", size: bytes, sha256: "0".repeat(64) }],
      }),
      object_prefix: `skills/${id}/`,
      created_by: owner.id,
    })
    .execute();
  return id;
}

async function connector(slug: string, tools: string[]): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connectors")
    .values({
      id,
      org_id: orgId,
      slug,
      name: slug,
      connector: "mcp",
      endpoint: JSON.stringify({}),
      auth: JSON.stringify({}),
      created_by: owner.id,
    })
    .execute();
  await db
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
  return id;
}

/** An org agent row with `versions` versions (no save checks). */
async function orgAgent(definition: AgentDefinition, versions = 1): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("agents")
    .values({
      id,
      org_id: orgId,
      owner_account_id: owner.id,
      visibility: "org",
      current_version: versions,
    })
    .execute();
  for (let v = 1; v <= versions; v++) {
    await db
      .insertInto("agent_versions")
      .values({
        agent_id: id,
        version: v,
        definition: JSON.stringify({ ...definition, instructions: `v${v}` }),
        created_by: owner.id,
      })
      .execute();
  }
  return id;
}

const deps = () => ({
  db,
  purposes: k.purposes,
  registry: k.runs.registry,
  config: () => cfg,
});

const eff = async (parent: AgentDefinition, type: string, tier?: string) => {
  const roster = await resolveRoster(db, orgId, parent);
  const entry = findType(roster, type);
  if (!entry) throw new Error(`no ${type}`);
  let orgAgent: CheckedOrgAgent | undefined;
  if (entry.source === "agent") {
    const c = await checkOrgAgent(db, {
      orgId,
      parentDefinition: parent,
      agentId: entry.agentId as string,
      triggerAccountId: owner.id,
    });
    if (!c.ok) throw new Error(`gate ${c.gate}`);
    orgAgent = { version: c.version, definition: c.definition };
  }
  return effectiveDefinition(deps(), {
    orgId,
    parent,
    parentAgentId,
    entry,
    ...(tier !== undefined && { tier: tier as "inherit" }),
    ...(orgAgent !== undefined && { orgAgent }),
  });
};

describe("resolveRoster / findType", { timeout: 60_000 }, () => {
  it("general-purpose first, then templates, inline and org agents in the owner's order", async () => {
    const t1 = await template("code-reviewer");
    const t2 = await template("implementer", {}, "other");
    const gone = await template("gone");
    await db
      .updateTable("agent_templates")
      .set({ deleted_at: new Date() })
      .where("id", "=", gone)
      .execute();
    const a = await orgAgent(def({ name: "Data Analyst" }));
    const roster = await resolveRoster(
      db,
      orgId,
      def({
        subagents: {
          templates: [t2, gone, t1],
          inline: [inline("scout", { description: "x".repeat(2000) })],
          agents: [{ agentId: a, as: "analyst", description: "Data questions." }],
        },
      }),
    );
    expect(roster).toEqual<RosterEntry[]>([
      {
        type: "general-purpose",
        source: "general",
        description: "a copy of you with your tools and skills, for multi-step work.",
      },
      {
        type: "other:implementer",
        source: "plugin",
        description: "Template implementer v2.",
        templateId: t2,
        plugin: "other",
      },
      {
        type: "superpowers:code-reviewer",
        source: "plugin",
        description: "Template code-reviewer v2.",
        templateId: t1,
        plugin: "superpowers",
      },
      { type: "scout", source: "inline", description: "x".repeat(1024) },
      {
        type: "analyst",
        source: "agent",
        description: "Data questions.",
        agentId: a,
        agentName: "Data Analyst",
      },
    ]);
  });

  it("a definition without subagents has only general-purpose; general: false removes it", async () => {
    expect((await resolveRoster(db, orgId, def())).map((e) => e.type)).toEqual(["general-purpose"]);
    const t = await template("x");
    expect(
      (await resolveRoster(db, orgId, def({ subagents: { general: false, templates: [t] } }))).map(
        (e) => e.type,
      ),
    ).toEqual(["superpowers:x"]);
  });

  it("the roster is cut to 20 entries", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await template(`t${i}`));
    const roster = await resolveRoster(db, orgId, def({ subagents: { templates: ids } }));
    expect(roster).toHaveLength(20);
    expect(roster.at(-1)?.type).toBe("superpowers:t18");
  });

  it("findType: exact match first; a bare plugin name only when unique", async () => {
    const t1 = await template("reviewer");
    const t2 = await template("reviewer", {}, "other");
    const t3 = await template("planner");
    const roster = await resolveRoster(
      db,
      orgId,
      def({ subagents: { templates: [t1, t2, t3], inline: [inline("scout")] } }),
    );
    expect(findType(roster, "superpowers:reviewer")?.templateId).toBe(t1);
    expect(findType(roster, "reviewer")).toBeNull();
    expect(findType(roster, "planner")?.templateId).toBe(t3);
    expect(findType(roster, "scout")?.source).toBe("inline");
    expect(findType(roster, "general-purpose")?.source).toBe("general");
    expect(findType(roster, "nope")).toBeNull();
    expect(findType(roster, "sp:planner")).toBeNull();
    // an inline type with the bare name wins over the plugin template
    const withInline = await resolveRoster(
      db,
      orgId,
      def({ subagents: { templates: [t3], inline: [inline("planner")] } }),
    );
    expect(findType(withInline, "planner")?.source).toBe("inline");
  });
});

describe("effectiveDefinition", { timeout: 60_000 }, () => {
  const parentTools = [
    { kind: "builtin", name: "ask_user" },
    { kind: "builtin", name: "read_tool_output" },
    { kind: "builtin", name: "skill_write" },
    { kind: "builtin", name: "sandbox_deliver" },
    { kind: "builtin", name: "sandbox_bash" },
    { kind: "builtin", name: "agent" },
  ];

  it("general-purpose: the parent's definition minus the child-removed tools, nothing pinned", async () => {
    const s = await skill("brainstorming");
    const parent = def({
      instructions: "Lead instructions.",
      avatarUrl: "https://example.com/a.png",
      tools: parentTools,
      toolPolicies: { sandbox_bash: "ask", skill_write: "deny" },
      modelParams: { effort: "low" },
      fallback: FAKE2,
      fallbackParams: { effort: "high" },
      skills: { orgSkills: [s], pinned: [s], writePolicy: "ask" },
      subagents: { inline: [inline("scout")] },
    });
    const r = await eff(parent, "general-purpose");
    expect(CHILD_REMOVED_TOOLS).toEqual(["agent", "ask_user", "sandbox_deliver", "skill_write"]);
    expect(r.definition).toEqual({
      name: "Lead › general-purpose",
      avatarUrl: "https://example.com/a.png",
      instructions: "Lead instructions.",
      model: FAKE1,
      fallback: FAKE2,
      modelParams: { effort: "low" },
      fallbackParams: { effort: "high" },
      tools: [
        { kind: "builtin", name: "read_tool_output" },
        { kind: "builtin", name: "sandbox_bash" },
      ],
      toolPolicies: { sandbox_bash: "ask", skill_write: "deny" },
      skills: { orgSkills: [s] },
    });
    expect(r.template).toEqual({ source: "general" });
    expect(r.maxSteps).toBe(30);
    expect(r.warnings).toEqual([]);
    expect(r.model).toEqual(FAKE1);
    expect(r.tierFallback).toBe(false);
    expect(AgentDefinitionSchema.parse(r.definition)).toEqual(r.definition);
  });

  it("the child name is cut to the 80-character limit", async () => {
    const r = await eff(def({ name: "L".repeat(80) }), "general-purpose");
    expect(r.definition.name).toHaveLength(80);
  });

  it("inline: tools narrowed by key (connector all narrowed), disallowed removed, stricter policies", async () => {
    const jira = await connector("jira", ["create", "delete", "search"]);
    const wiki = await connector("wiki", ["read", "write"]);
    const parent = def({
      tools: [
        ...parentTools,
        { kind: "connector", connectorId: jira, tools: "all" },
        { kind: "connector", connectorId: wiki, tools: ["read", "write"] },
      ],
      toolPolicies: { jira__search: "ask", sandbox_bash: "ask", jira__create: "deny" },
      subagents: {
        inline: [
          inline("scout", {
            tools: ["sandbox_bash", "jira__search", "jira__create", "ask_user", "nope"],
            toolPolicies: { sandbox_bash: "deny", jira__create: "ask", jira__search: "ask" },
            maxSteps: 80,
          }),
          inline("writer", { disallowedTools: ["wiki__write", "jira__delete", "sandbox_bash"] }),
        ],
      },
    });
    const scout = await eff(parent, "scout");
    expect(scout.definition.tools).toEqual([
      { kind: "builtin", name: "sandbox_bash" },
      { kind: "connector", connectorId: jira, tools: ["create", "search"] },
    ]);
    expect(scout.definition.toolPolicies).toEqual({
      jira__search: "ask",
      sandbox_bash: "deny",
      jira__create: "deny",
    });
    expect(scout.definition.instructions).toBe("You are scout.");
    expect(scout.definition.name).toBe("Lead › scout");
    expect(scout.template).toEqual({ source: "inline" });
    expect(scout.maxSteps).toBe(30);

    const writer = await eff(parent, "writer");
    expect(writer.definition.tools).toEqual([
      { kind: "builtin", name: "read_tool_output" },
      { kind: "connector", connectorId: jira, tools: ["create", "search"] },
      { kind: "connector", connectorId: wiki, tools: ["read"] },
    ]);
  });

  it("an untouched connector keeps tools: all; maxSteps takes the smaller limit", async () => {
    const jira = await connector("jira", ["search"]);
    const parent = def({
      tools: [{ kind: "connector", connectorId: jira, tools: "all" }],
      subagents: { inline: [inline("scout", { maxSteps: 5 })] },
    });
    const r = await eff(parent, "scout");
    expect(r.definition.tools).toEqual([{ kind: "connector", connectorId: jira, tools: "all" }]);
    expect(r.maxSteps).toBe(5);
  });

  it("pinned = the template's skills the parent selects, within 3 and 32 KB, with warnings", async () => {
    const a = await skill("alpha", 20_000);
    const b = await skill("beta", 20_000);
    const c = await skill("gamma", 100);
    const unselected = await skill("delta", 100);
    const own = await skill("own", 100, parentAgentId);
    const parent = def({
      skills: { orgSkills: [a, b, c] },
      subagents: {
        inline: [
          inline("scout", { skills: [a, b, c] }),
          inline("helper", { skills: [unselected, own] }),
        ],
      },
    });
    const scout = await eff(parent, "scout");
    expect(scout.definition.skills).toEqual({ orgSkills: [a, b, c], pinned: [a, c] });
    expect(scout.warnings).toEqual([
      'The skill "beta" was not pinned: pinned skills are limited to 32 KB in total.',
    ]);
    const helper = await eff(parent, "helper");
    expect(helper.definition.skills).toEqual({ orgSkills: [a, b, c], pinned: [own] });
    expect(helper.warnings).toEqual([
      `The skill "${unselected}" was not pinned: the agent does not select it.`,
    ]);
  });

  it("a template allowlist or deny key under a connector writes out its names, never all", async () => {
    const jira = await connector("jira", ["search"]);
    const parent = def({
      tools: [{ kind: "connector", connectorId: jira, tools: "all" }],
      subagents: {
        inline: [
          // the allowlist covers every tool the connector has today
          inline("scout", { tools: ["jira__search"] }),
          // a deny key for a tool the connector does not have yet
          inline("writer", { disallowedTools: ["jira__delete"] }),
        ],
      },
    });
    for (const type of ["scout", "writer"]) {
      expect((await eff(parent, type)).definition.tools).toEqual([
        { kind: "connector", connectorId: jira, tools: ["search"] },
      ]);
    }
  });

  it("stricterPolicies ignores values other than ask and deny", () => {
    expect(
      stricterPolicies({ a: "ask" }, {
        a: "allow",
        b: "allow",
        c: "bogus",
        d: "deny",
      } as unknown as Record<string, "ask">),
    ).toEqual({ a: "ask", d: "deny" });
  });

  it("a bare skill name prefers the template's plugin, then the agent's own skill, with a warning", async () => {
    const own = await skill("brainstorming", 100, parentAgentId);
    const sp = await skill("brainstorming", 100, undefined, "superpowers");
    const t = await template("implementer", { skills: ["brainstorming"] });
    const parent = def({ skills: { orgSkills: [sp] }, subagents: { templates: [t] } });
    const r = await eff(parent, "implementer");
    expect(r.definition.skills?.pinned).toEqual([sp]);
    expect(r.warnings).toEqual([
      'The skill name "brainstorming" matches more than one selected skill; the one from the plugin superpowers was pinned.',
    ]);

    await db.updateTable("skills").set({ deleted_at: new Date() }).where("id", "=", sp).execute();
    const other = await skill("brainstorming", 100, undefined, "other");
    const parent2 = def({ skills: { orgSkills: [other] }, subagents: { templates: [t] } });
    const r2 = await eff(parent2, "implementer");
    expect(r2.definition.skills?.pinned).toEqual([own]);
    expect(r2.warnings).toEqual([
      'The skill name "brainstorming" matches more than one selected skill; the agent\'s own skill was pinned.',
    ]);
  });

  it("plugin template: current version, skills by name, template reference", async () => {
    const tdd = await skill("test-driven-development");
    const t = await template("implementer", {
      tools: ["read_tool_output"],
      skills: ["test-driven-development", "superpowers:missing"],
      maxSteps: 12,
    });
    const parent = def({
      tools: parentTools,
      skills: { orgSkills: [tdd] },
      subagents: { templates: [t] },
    });
    const r = await eff(parent, "implementer");
    expect(r.template).toEqual({ source: "plugin", id: t, version: 2, plugin: "superpowers" });
    expect(r.definition.instructions).toBe("Body of implementer v2.");
    expect(r.definition.name).toBe("Lead › superpowers:implementer");
    expect(r.definition.tools).toEqual([{ kind: "builtin", name: "read_tool_output" }]);
    expect(r.definition.skills).toEqual({ orgSkills: [tdd], pinned: [tdd] });
    expect(r.warnings).toEqual([
      'The skill "superpowers:missing" was not pinned: the agent does not select it.',
    ]);
    expect(r.maxSteps).toBe(12);
  });

  describe("model tiers", () => {
    const map = (tier: string, model = FAKE2, params: Record<string, unknown> = {}) =>
      k.purposes.setOrg(orgId, `subagent_${tier}`, { model, params: params as never }, owner.id);

    it("the call's tier maps to its purpose; the target's params replace the parent's", async () => {
      await map("fast", FAKE2, { "model-fake.style": "shout" });
      const parent = def({ modelParams: { effort: "low" }, fallback: FAKE1 });
      const r = await eff(parent, "general-purpose", "fast");
      expect(r.model).toEqual(FAKE2);
      expect(r.tierFallback).toBe(false);
      expect(r.definition.model).toEqual(FAKE2);
      expect(r.definition.modelParams).toEqual({ "model-fake.style": "shout" });
      expect(r.definition.fallback).toBeNull();
      expect(r.definition.fallbackParams).toEqual({});
    });

    it("call → template → inherit", async () => {
      await map("capable");
      const parent = def({ subagents: { inline: [inline("scout", { model: "capable" })] } });
      expect((await eff(parent, "scout")).model).toEqual(FAKE2);
      expect((await eff(parent, "scout", "inherit")).model).toEqual(FAKE1);
      expect((await eff(parent, "general-purpose")).model).toEqual(FAKE1);
    });

    it("an unmapped tier falls back to the parent's model with tierFallback", async () => {
      const parent = def({ modelParams: { effort: "low" } });
      const r = await eff(parent, "general-purpose", "standard");
      expect(r.model).toEqual(FAKE1);
      expect(r.tierFallback).toBe(true);
      expect(r.definition.modelParams).toEqual({ effort: "low" });
    });

    it("a template effort sets modelParams.effort only when the model declares it", async () => {
      const parent = def({
        modelParams: { effort: "low" },
        subagents: {
          inline: [inline("deep", { effort: "high" }), inline("max", { effort: "max" })],
        },
      });
      expect((await eff(parent, "deep")).definition.modelParams).toEqual({ effort: "high" });
      // fake-1 accepts low / medium / high only: max is dropped, the inherited value stays
      expect((await eff(parent, "max")).definition.modelParams).toEqual({ effort: "low" });
    });
  });

  describe("org agents (§5.5)", () => {
    it("checkOrgAgent: deleted, allowlist, dispatchable and visibility gates, else the checked version", async () => {
      const a = await orgAgent(def({ name: "Data Analyst", subagents: { dispatchable: true } }), 2);
      const parent = def({
        subagents: { agents: [{ agentId: a, as: "analyst", description: "Data." }] },
      });
      const check = (over: Partial<Parameters<typeof checkOrgAgent>[1]> = {}) =>
        checkOrgAgent(db, {
          orgId,
          parentDefinition: parent,
          agentId: a,
          triggerAccountId: owner.id,
          ...over,
        });
      expect(await check()).toMatchObject({
        ok: true,
        version: 2,
        definition: { name: "Data Analyst", instructions: "v2" },
      });
      expect(await check({ parentDefinition: def() })).toEqual({ ok: false, gate: "allowlist" });
      // another org's agent is never available
      expect(await check({ orgId: "other-org" })).toEqual({ ok: false, gate: "deleted" });
      const stranger = await new AccountsService(db).createLocal({
        login: `s-${randomUUID().slice(0, 8)}`,
        password: "correct horse battery",
        displayName: "S",
      });
      expect(await check({ triggerAccountId: stranger.id })).toEqual({
        ok: false,
        gate: "visibility",
      });
      await db
        .insertInto("agent_versions")
        .values({
          agent_id: a,
          version: 3,
          definition: JSON.stringify(def({ subagents: { dispatchable: false } })),
          created_by: owner.id,
        })
        .execute();
      await db.updateTable("agents").set({ current_version: 3 }).where("id", "=", a).execute();
      expect(await check()).toEqual({ ok: false, gate: "dispatchable" });
      await db.updateTable("agents").set({ deleted_at: new Date() }).where("id", "=", a).execute();
      expect(await check()).toEqual({ ok: false, gate: "deleted" });
    });

    it("the agent's own definition with the parent's stricter policies on top", async () => {
      const jira = await connector("jira", ["search", "create"]);
      const s = await skill("analysis");
      const agentDef = def({
        name: "Data Analyst",
        avatarUrl: "https://example.com/an.png",
        model: FAKE2,
        modelParams: { effort: "medium" },
        tools: [
          { kind: "builtin", name: "ask_user" },
          { kind: "builtin", name: "skill_write" },
          { kind: "builtin", name: "sandbox_bash" },
          { kind: "connector", connectorId: jira, tools: "all" },
        ],
        toolPolicies: { jira__create: "ask", sandbox_bash: "deny" },
        skills: { orgSkills: [s], pinned: [s] },
        subagents: { dispatchable: true },
      });
      const a = await orgAgent(agentDef, 3);
      await k.purposes.setOrg(orgId, "subagent_fast", { model: FAKE1, params: {} }, owner.id);
      const parent = def({
        tools: [{ kind: "builtin", name: "read_tool_output" }],
        toolPolicies: { jira__search: "deny", sandbox_bash: "ask", read_tool_output: "ask" },
        subagents: { agents: [{ agentId: a, as: "analyst", description: "Data questions." }] },
      });
      const r = await eff(parent, "analyst", "fast");
      expect(r.template).toEqual({ source: "agent", id: a, version: 3 });
      expect(r.definition).toEqual({
        ...agentDef,
        instructions: "v3",
        tools: [
          { kind: "builtin", name: "sandbox_bash" },
          { kind: "connector", connectorId: jira, tools: "all" },
        ],
        toolPolicies: {
          jira__create: "ask",
          sandbox_bash: "deny",
          jira__search: "deny",
          read_tool_output: "ask",
        },
        subagents: undefined,
      });
      expect(r.definition.subagents).toBeUndefined();
      expect(r.model).toEqual(FAKE2);
      expect(r.tierFallback).toBe(false);
      expect(r.maxSteps).toBe(30);
    });
  });
});

describe("follow-up narrowing (final review I1)", () => {
  const conn = (connectorId: string, tools: "all" | string[]) =>
    ({ kind: "connector", connectorId, tools }) as const;

  it("keeps the refs the current version still has; a connector's all meets the names", () => {
    const frozen = [
      { kind: "builtin", name: "sandbox_read" } as const,
      { kind: "builtin", name: "sandbox_write" } as const,
      { kind: "plugin", plugin: "todo", name: "add" } as const,
      conn("c1", "all"),
      conn("c2", ["a", "b"]),
      conn("c3", "all"),
      conn("c4", ["a"]),
    ];
    const current = [
      { kind: "builtin", name: "sandbox_read" } as const,
      { kind: "plugin", plugin: "todo", name: "add" } as const,
      conn("c1", ["x"]),
      conn("c2", ["b", "c"]),
      conn("c3", "all"),
      conn("c4", ["z"]),
    ];
    expect(intersectTools(frozen, current)).toEqual([
      { kind: "builtin", name: "sandbox_read" },
      { kind: "plugin", plugin: "todo", name: "add" },
      conn("c1", ["x"]),
      conn("c2", ["b"]),
      conn("c3", "all"),
    ]);
  });

  it("drops deselected org skills and the pinned ids among them; the agent's own pinned stay", () => {
    const n = narrowFollowUp(
      { tools: [], skills: { orgSkills: ["o1", "o2"], pinned: ["o1", "own", "o2"] } },
      { tools: [], skills: { orgSkills: ["o2", "o3"] } },
    );
    expect(n).toEqual({ tools: [], skills: { orgSkills: ["o2"], pinned: ["own", "o2"] } });
    expect(narrowFollowUp({ tools: [] }, { tools: [] })).toEqual({ tools: [] });
  });

  it("a run's definition takes its trigger's narrowing; without one it is the frozen definition", () => {
    const frozen = AgentDefinitionSchema.parse({
      name: "C",
      instructions: "frozen",
      model: { provider: "p", model: "m" },
      tools: [{ kind: "builtin", name: "a" }],
      skills: { orgSkills: ["o1"], writePolicy: "ask" },
    });
    expect(childRunDefinition(frozen, undefined)).toBe(frozen);
    const run = childRunDefinition(frozen, { tools: [], skills: { orgSkills: [] } });
    expect(run).toMatchObject({ instructions: "frozen", tools: [] });
    expect(run.skills).toEqual({ orgSkills: [], writePolicy: "ask" });
  });
});
