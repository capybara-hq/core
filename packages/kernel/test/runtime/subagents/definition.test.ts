import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AgentDefinition, AgentDefinitionSchema } from "../../../src/agents/definition.js";
import { joinInstructionFiles } from "../../../src/agents/instruction-files.js";
import { type KernelConfig, KernelConfigSchema } from "../../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import type { Account } from "../../../src/identity/accounts.js";
import { createLogger } from "../../../src/log.js";
import { ModelPurposesService } from "../../../src/models/purposes.js";
import { ProviderRegistry } from "../../../src/runtime/providers.js";
import {
  CHILD_REMOVED_TOOLS,
  type CheckedOrgAgent,
  childRunDefinition,
  effectiveDefinition,
  narrowFollowUp,
  stricterPolicies,
} from "../../../src/runtime/subagents/definition.js";
import { checkOrgAgent } from "../../../src/runtime/subagents/org-agents.js";
import { SUBAGENT_PREAMBLE } from "../../../src/runtime/subagents/preamble.js";
import {
  findType,
  type RosterEntry,
  resolveRoster,
} from "../../../src/runtime/subagents/roster.js";
import { filterSubagentTools, type ResolvedTool } from "../../../src/tools/registry.js";
import { truncateTables } from "../../helpers/db.js";
import { builtinsOff } from "../../helpers/disabled-tools.js";
import { accountsFor, orgsFor } from "../../helpers/identity.js";
import { MODEL_PLUGINS_CONFIG } from "../../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../../helpers/runs.js";

/** Sub-agent roster and effective definitions (phase C, spec §4.3, §5.3–§5.5). */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
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
  k = await startKernel(cfg, { env: {}, logger: createLogger("error", { write: () => {} }) });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let n = 0;
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  n++;
  owner = await accountsFor(db).createLocal({
    login: `owner${n}`,
    password: "correct horse battery",
    displayName: "O",
  });
  orgId = (await orgsFor(db).create({ name: "Acme", slug: `acme-${n}` }, owner)).id;
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
  purposes: k.app.get(ModelPurposesService),
  registry: k.app.get(ProviderRegistry),
  config: { get: () => cfg },
});

const eff = async (
  parent: AgentDefinition,
  type: string,
  tier?: string,
  depth: { childDepth: number; maxDepth: number } = { childDepth: 1, maxDepth: 3 },
) => {
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
    ...depth,
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
  /** The parent keeps these builtins on and turns the others off. */
  const parentOff = builtinsOff("AskUserQuestion", "ReadToolOutput", "Deliver", "Bash", "Agent");
  /** Every child's key filter removes these (sub-agents spec §5.3). */
  const REMOVED = [...CHILD_REMOVED_TOOLS];

  it("general-purpose: the parent's definition minus the child-removed tools, nothing pinned", async () => {
    const s = await skill("brainstorming");
    const parent = def({
      instructions: "Lead instructions.",
      avatarUrl: "https://example.com/a.png",
      disabledTools: parentOff,
      toolPolicies: { Bash: "ask", Write: "deny" },
      modelParams: { effort: "low" },
      fallback: FAKE2,
      fallbackParams: { effort: "high" },
      disabledSkills: [{ kind: "skill", skillId: s }],
      skills: { writePolicy: "ask" },
      subagents: { inline: [inline("scout")] },
    });
    const r = await eff(parent, "general-purpose");
    expect(CHILD_REMOVED_TOOLS).toEqual([
      "AskUserQuestion",
      "Deliver",
      "ScheduleCreate",
      "ScheduleUpdate",
      "ScheduleList",
      "ScheduleTargets",
      "ScheduleDelete",
    ]);
    expect(r.definition).toEqual({
      name: "Lead › general-purpose",
      avatarUrl: "https://example.com/a.png",
      instructions: "Lead instructions.",
      model: FAKE1,
      fallback: FAKE2,
      modelParams: { effort: "low" },
      fallbackParams: { effort: "high" },
      // the parent's turned-off tools, and the child-removed ones by key (tools default-on §4)
      disabledTools: parentOff,
      subagentTools: { deny: REMOVED },
      toolPolicies: { Bash: "ask", Write: "deny" },
      // the parent's catalog: what it turns off (skills default-on §6.1); never its writePolicy
      disabledSkills: [{ kind: "skill", skillId: s }],
      subagents: { inline: [inline("scout")] },
    });
    expect(r.template).toEqual({ source: "general" });
    expect(r.maxSteps).toBe(30);
    expect(r.preamble).toBe(SUBAGENT_PREAMBLE);
    expect(r.warnings).toEqual([]);
    expect(r.model).toEqual(FAKE1);
    expect(r.tierFallback).toBe(false);
    expect(AgentDefinitionSchema.parse(r.definition)).toEqual(r.definition);
  });

  it("the child name is cut to the 80-character limit", async () => {
    const r = await eff(def({ name: "L".repeat(80) }), "general-purpose");
    expect(r.definition.name).toHaveLength(80);
  });

  it("inline: tools narrowed by key (an allowlist stays one), disallowed removed, stricter policies", async () => {
    const parent = def({
      disabledTools: parentOff,
      toolPolicies: { mcp__jira__search: "ask", Bash: "ask", mcp__jira__create: "deny" },
      subagents: {
        inline: [
          inline("scout", {
            tools: ["Bash", "mcp__jira__search", "mcp__jira__create", "AskUserQuestion", "nope"],
            toolPolicies: {
              Bash: "deny",
              mcp__jira__create: "ask",
              mcp__jira__search: "ask",
            },
            maxSteps: 80,
          }),
          inline("writer", {
            disallowedTools: ["mcp__wiki__write", "mcp__jira__delete", "Bash"],
          }),
        ],
      },
    });
    const scout = await eff(parent, "scout");
    expect(scout.definition.disabledTools).toEqual(parentOff);
    expect(scout.definition.subagentTools).toEqual({
      allow: ["Bash", "mcp__jira__search", "mcp__jira__create", "AskUserQuestion", "nope"],
      deny: REMOVED,
    });
    expect(scout.definition.toolPolicies).toEqual({
      mcp__jira__search: "ask",
      Bash: "deny",
      mcp__jira__create: "deny",
    });
    expect(scout.definition.instructions).toBe("You are scout.");
    expect(scout.definition.name).toBe("Lead › scout");
    expect(scout.template).toEqual({ source: "inline" });
    expect(scout.maxSteps).toBe(30);

    const writer = await eff(parent, "writer");
    // no allowlist: the parent's Agent stays below maxDepth
    expect(writer.definition.subagentTools).toEqual({
      deny: [...REMOVED, "mcp__wiki__write", "mcp__jira__delete", "Bash"],
    });
  });

  it("the key filter narrows the resolved tools; TaskOutput / TaskStop / TaskList follow Bash", () => {
    const t = (key: string) => ({ key }) as ResolvedTool;
    const all = [
      "Bash",
      "TaskOutput",
      "TaskStop",
      "TaskList",
      "Read",
      "Agent",
      "mcp__jira__search",
    ].map(t);
    const keys = (f: Parameters<typeof filterSubagentTools>[1]) =>
      filterSubagentTools(all, f).map((x) => x.key);
    expect(keys(undefined)).toEqual(all.map((x) => x.key));
    expect(keys({ deny: ["Agent", "Bash"] })).toEqual(["Read", "mcp__jira__search"]);
    expect(keys({ allow: ["Bash", "mcp__jira__search", "mcp__jira__create"] })).toEqual([
      "Bash",
      "TaskOutput",
      "TaskStop",
      "TaskList",
      "mcp__jira__search",
    ]);
    expect(keys({ allow: [], deny: [] })).toEqual([]);
  });

  it("a template without an allowlist leaves everything but the removed tools; maxSteps takes the smaller limit", async () => {
    const parent = def({ subagents: { inline: [inline("scout", { maxSteps: 5 })] } });
    const r = await eff(parent, "scout");
    expect(r.definition.disabledTools).toEqual([]);
    expect(r.definition.subagentTools).toEqual({ deny: REMOVED });
    expect(r.maxSteps).toBe(5);
  });

  it("runtime.maxSteps 0 (no limit): a template's own limit holds, a template without one logs 0 (no limit)", async () => {
    const saved = cfg;
    cfg = { ...cfg, runtime: { ...cfg.runtime, maxSteps: 0 } };
    try {
      const parent = def({
        subagents: { inline: [inline("scout", { maxSteps: 5 }), inline("free")] },
      });
      expect((await eff(parent, "scout")).maxSteps).toBe(5);
      expect((await eff(parent, "free")).maxSteps).toBe(0);
    } finally {
      cfg = saved;
    }
  });

  it("a template allowlist or deny key under a connector stays a key: a later tool never slips past", async () => {
    const parent = def({
      subagents: {
        inline: [
          // the allowlist covers every tool the connector has today
          inline("scout", { tools: ["mcp__jira__search"] }),
          // a deny key for a tool the connector does not have yet
          inline("writer", { disallowedTools: ["mcp__jira__delete"] }),
        ],
      },
    });
    expect((await eff(parent, "scout")).definition.subagentTools).toEqual({
      allow: ["mcp__jira__search"],
      deny: REMOVED,
    });
    expect((await eff(parent, "writer")).definition.subagentTools).toEqual({
      deny: [...REMOVED, "mcp__jira__delete"],
    });
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

  it("plugin template: current version, skills by name, template reference", async () => {
    const tdd = await skill("test-driven-development");
    const t = await template("implementer", {
      tools: ["ReadToolOutput"],
      skills: ["test-driven-development", "superpowers:missing"],
      maxSteps: 12,
    });
    const parent = def({
      disabledTools: parentOff,
      subagents: { templates: [t] },
    });
    const r = await eff(parent, "implementer");
    expect(r.template).toEqual({ source: "plugin", id: t, version: 2, plugin: "superpowers" });
    expect(r.definition.instructions).toBe("Body of implementer v2.");
    expect(r.definition.name).toBe("Lead › superpowers:implementer");
    expect(r.definition.subagentTools).toEqual({ allow: ["ReadToolOutput"], deny: REMOVED });
    // nothing is pinned (skills default-on spec §6.1): the child has the parent's catalog and is
    // told to load the template's skills first; a name it does not have is a warning
    expect(r.definition.skills).toBeUndefined();
    expect(r.definition.disabledSkills).toEqual([]);
    expect(tdd).toBeDefined();
    expect(r.preamble).toBe(
      `${SUBAGENT_PREAMBLE}\n\nBefore you start, load these skills with Skill: test-driven-development.`,
    );
    expect(r.warnings).toEqual([
      'The skill "superpowers:missing" is not among the sub-agent\'s skills, so it is not asked to load it.',
    ]);
    expect(r.maxSteps).toBe(12);
  });

  it("plugin template skills: catalog names in the template's order, plugin refs checked, no limits", async () => {
    await skill("brainstorming", 100, undefined, "superpowers");
    await skill("writing-plans", 100, undefined, "superpowers");
    await skill("big", 40_000);
    await skill("debugging", 100, undefined, "other");
    const t = await template("planner", {
      skills: ["writing-plans", "superpowers:brainstorming", "big", "superpowers:debugging"],
    });
    const r = await eff(def({ subagents: { templates: [t] } }), "planner");
    // no 3-skill or 32 KB limit any more; `superpowers:debugging` names another plugin's skill
    expect(r.preamble).toBe(
      `${SUBAGENT_PREAMBLE}\n\nBefore you start, load these skills with Skill: writing-plans, brainstorming, big.`,
    );
    expect(r.warnings).toEqual([
      'The skill "superpowers:debugging" is not among the sub-agent\'s skills, so it is not asked to load it.',
    ]);
  });

  it("plugin template disallowedSkills narrow the parent's skills; the skills it turns off are not loaded", async () => {
    await skill("brainstorming", 100, undefined, "superpowers");
    await skill("writing-plans", 100, undefined, "superpowers");
    await skill("lint", 100, undefined, "tools");
    const notes = await skill("notes");
    const t = await template("narrow", {
      skills: ["brainstorming", "notes", "lint"],
      disallowedSkills: ["superpowers:brainstorming", "tools:*", "notes", "gone-skill"],
    });
    const parent = def({
      subagents: { templates: [t] },
      disabledSkills: [{ kind: "plugin", plugin: "superpowers", skills: ["writing-plans"] }],
    });
    const r = await eff(parent, "narrow");
    // the parent's list plus the template's (narrowing only); an unresolved bare name is dropped
    expect(r.definition.disabledSkills).toEqual([
      { kind: "plugin", plugin: "superpowers", skills: ["brainstorming", "writing-plans"] },
      { kind: "plugin", plugin: "tools", skills: "all" },
      { kind: "skill", skillId: notes },
    ]);
    expect(r.preamble).toBe(SUBAGENT_PREAMBLE);
    expect(r.warnings).toEqual(
      ["brainstorming", "notes", "lint"].map(
        (n) =>
          `The skill "${n}" is not among the sub-agent's skills, so it is not asked to load it.`,
      ),
    );
    expect(AgentDefinitionSchema.parse(r.definition)).toEqual(r.definition);
  });

  it("inline template skills are ids: the line names them as the catalog lists them", async () => {
    const a = await skill("alpha");
    const own = await skill("beta", 100, parentAgentId);
    const off = await skill("gamma");
    const parent = def({
      disabledSkills: [{ kind: "skill", skillId: off }],
      subagents: { inline: [inline("scout", { skills: [own, a, off] })] },
    });
    const r = await eff(parent, "scout");
    expect(r.preamble).toBe(
      `${SUBAGENT_PREAMBLE}\n\nBefore you start, load these skills with Skill: beta, alpha.`,
    );
    expect(r.warnings).toEqual([
      `The skill "${off}" is not among the sub-agent's skills, so it is not asked to load it.`,
    ]);
    // general-purpose never gets the line
    const g = await eff(parent, "general-purpose");
    expect(g.preamble).toBe(SUBAGENT_PREAMBLE);
  });

  describe("model tiers", () => {
    const map = (tier: string, model = FAKE2, params: Record<string, unknown> = {}) =>
      k.app
        .get(ModelPurposesService)
        .setOrg(orgId, `subagent_${tier}`, { model, params: params as never }, owner.id);

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

  describe("nested dispatch (agent map spec §4.1)", () => {
    it("an org-agent child keeps its own subagents block", async () => {
      const own = {
        dispatchable: true,
        general: false,
        inline: [inline("digger")],
      };
      const a = await orgAgent(
        def({ name: "Researcher", disabledTools: builtinsOff("Agent"), subagents: own }),
      );
      const parent = def({
        disabledTools: builtinsOff("Agent"),
        subagents: {
          inline: [inline("scout")],
          agents: [{ agentId: a, as: "researcher", description: "Research." }],
        },
      });
      const r = await eff(parent, "researcher");
      expect(r.definition.subagents).toEqual(own);
      expect(r.definition.disabledTools).toEqual(builtinsOff("Agent"));
      expect(r.definition.subagentTools).toEqual({ deny: REMOVED });
    });

    it("a general-purpose child inherits the parent's roster", async () => {
      const sub = { general: true, inline: [inline("scout")] };
      const parent = def({ disabledTools: parentOff, subagents: sub });
      expect((await eff(parent, "general-purpose")).definition.subagents).toEqual(sub);
      // an inline template child dispatches from its parent's roster too
      expect((await eff(parent, "scout")).definition.subagents).toEqual(sub);
      // a parent without a block gives none (its children get general-purpose only)
      expect(
        (await eff(def({ disabledTools: parentOff }), "general-purpose")).definition,
      ).not.toHaveProperty("subagents");
    });

    it("Agent is removed at maxDepth only", async () => {
      const parent = def({ disabledTools: parentOff, subagents: { inline: [inline("scout")] } });
      const denied = (r: Awaited<ReturnType<typeof eff>>) => r.definition.subagentTools?.deny;
      for (const childDepth of [1, 2]) {
        const r = await eff(parent, "general-purpose", undefined, { childDepth, maxDepth: 3 });
        expect(denied(r), `depth ${childDepth}`).toEqual(REMOVED);
      }
      const atMax = await eff(parent, "scout", undefined, { childDepth: 3, maxDepth: 3 });
      expect(denied(atMax)).toEqual([...REMOVED, "Agent"]);
      // maxDepth 1: no nesting at all
      const flat = await eff(parent, "general-purpose", undefined, { childDepth: 1, maxDepth: 1 });
      expect(denied(flat)).toEqual([...REMOVED, "Agent"]);
      // an org agent's own Agent goes at the limit too
      const a = await orgAgent(
        def({
          name: "Researcher",
          disabledTools: builtinsOff("Agent", "Bash"),
          subagents: { dispatchable: true },
        }),
      );
      const withAgent = def({
        subagents: { agents: [{ agentId: a, as: "researcher", description: "Research." }] },
      });
      const deep = await eff(withAgent, "researcher", undefined, { childDepth: 2, maxDepth: 2 });
      expect(denied(deep)).toEqual([...REMOVED, "Agent"]);
      const shallow = await eff(withAgent, "researcher", undefined, { childDepth: 1, maxDepth: 2 });
      expect(denied(shallow)).toEqual(REMOVED);
      // a nested child keeps its parent's filter and adds its own
      const nested = await eff(atMax.definition, "general-purpose", undefined, {
        childDepth: 2,
        maxDepth: 3,
      });
      expect(denied(nested)).toEqual([...REMOVED, "Agent"]);
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
      const stranger = await accountsFor(db).createLocal({
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
      const ownOff = [
        ...builtinsOff("AskUserQuestion", "Bash"),
        { kind: "connector" as const, connectorId: jira, tools: ["create"] },
      ];
      const s = await skill("analysis");
      const agentDef = def({
        name: "Data Analyst",
        avatarUrl: "https://example.com/an.png",
        model: FAKE2,
        modelParams: { effort: "medium" },
        disabledTools: ownOff,
        toolPolicies: { mcp__jira__create: "ask", Bash: "deny" },
        disabledSkills: [{ kind: "skill", skillId: s }],
        subagents: { dispatchable: true },
      });
      const a = await orgAgent(agentDef, 3);
      await k.app
        .get(ModelPurposesService)
        .setOrg(orgId, "subagent_fast", { model: FAKE1, params: {} }, owner.id);
      const parent = def({
        disabledTools: builtinsOff("ReadToolOutput"),
        toolPolicies: { mcp__jira__search: "deny", Bash: "ask", ReadToolOutput: "ask" },
        // never reaches the org agent child: it keeps its own skills (skills default-on §6.1)
        disabledSkills: [{ kind: "plugin", plugin: "superpowers", skills: "all" }],
        subagents: { agents: [{ agentId: a, as: "analyst", description: "Data questions." }] },
      });
      const r = await eff(parent, "analyst", "fast");
      expect(r.definition.disabledSkills).toEqual([{ kind: "skill", skillId: s }]);
      expect(r.preamble).toBe(SUBAGENT_PREAMBLE);
      expect(r.template).toEqual({ source: "agent", id: a, version: 3 });
      expect(r.definition).toEqual({
        ...agentDef,
        instructions: "v3",
        // its own tools, not met with the parent's; only the child-removed ones go (by key)
        disabledTools: ownOff,
        subagentTools: { deny: REMOVED },
        toolPolicies: {
          mcp__jira__create: "ask",
          Bash: "deny",
          mcp__jira__search: "deny",
          ReadToolOutput: "ask",
        },
        subagents: { dispatchable: true },
      });
      expect(r.model).toEqual(FAKE2);
      expect(r.tierFallback).toBe(false);
      expect(r.maxSteps).toBe(30);
    });

    it("an org agent saved with prompt files dispatches with their join and no instructionFiles", async () => {
      const files = [
        { name: "AGENTS.md", content: "You analyse data." },
        { name: "STYLE.md", content: "Use tables." },
      ];
      const joined = joinInstructionFiles(files);
      const a = randomUUID();
      await db
        .insertInto("agents")
        .values({
          id: a,
          org_id: orgId,
          owner_account_id: owner.id,
          visibility: "org",
          current_version: 1,
        })
        .execute();
      await db
        .insertInto("agent_versions")
        .values({
          agent_id: a,
          version: 1,
          definition: JSON.stringify(
            def({
              name: "Data Analyst",
              instructions: joined,
              instructionFiles: files,
              subagents: { dispatchable: true },
            }),
          ),
          created_by: owner.id,
        })
        .execute();
      const parent = def({
        subagents: { agents: [{ agentId: a, as: "analyst", description: "Data questions." }] },
      });
      const r = await eff(parent, "analyst");
      expect(r.definition.instructions).toBe(joined);
      expect(r.definition).not.toHaveProperty("instructionFiles");
      // the frozen copy parses as subagent_started.definition does
      expect(AgentDefinitionSchema.parse(r.definition)).not.toHaveProperty("instructionFiles");
    });
  });
});

describe("follow-up narrowing (final review I1)", () => {
  it("turns off what either the frozen or the current version turns off (it can lose tools, never gain them)", () => {
    const n = narrowFollowUp(
      {
        disabledSkills: [{ kind: "skill", skillId: "s1" }],
        disabledTools: [
          { kind: "builtin", name: "Write" },
          { kind: "connector", connectorId: "c2", tools: ["a"] },
        ],
      },
      {
        disabledSkills: [{ kind: "plugin", plugin: "superpowers", skills: ["tdd"] }],
        disabledTools: [
          { kind: "connector", connectorId: "c2", tools: ["c"] },
          { kind: "plugin", plugin: "todo", tools: "all" },
          { kind: "connector", connectorId: "c1", tools: "all" },
        ],
      },
    );
    expect(n).toEqual({
      disabledTools: [
        { kind: "builtin", name: "Write" },
        { kind: "connector", connectorId: "c2", tools: ["a", "c"] },
        { kind: "plugin", plugin: "todo", tools: "all" },
        { kind: "connector", connectorId: "c1", tools: "all" },
      ],
      disabledSkills: [
        { kind: "plugin", plugin: "superpowers", skills: ["tdd"] },
        { kind: "skill", skillId: "s1" },
      ],
    });
  });

  it("a run's definition takes its trigger's narrowing; without one it is the frozen definition", () => {
    const frozen = AgentDefinitionSchema.parse({
      name: "C",
      instructions: "frozen",
      model: { provider: "p", model: "m" },
      disabledTools: [{ kind: "builtin", name: "Bash" }],
      skills: { writePolicy: "ask" },
    });
    expect(childRunDefinition(frozen, undefined)).toBe(frozen);
    const off = [{ kind: "builtin" as const, name: "Read" }];
    const skillsOff = [{ kind: "skill" as const, skillId: "s1" }];
    const run = childRunDefinition(frozen, { disabledTools: off, disabledSkills: skillsOff });
    expect(run).toMatchObject({ instructions: "frozen", disabledTools: off });
    expect(run.disabledSkills).toEqual(skillsOff);
    expect(run.skills).toEqual({ writePolicy: "ask" });
    // a narrowing logged before tools and skills were on by default narrows nothing of them
    const old = childRunDefinition(frozen, { skills: { orgSkills: [] } });
    expect(old.disabledTools).toEqual(frozen.disabledTools);
    expect(old.disabledSkills).toEqual([]);
  });
});
