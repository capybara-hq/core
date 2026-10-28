import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AgentsService, isAgentVisibleTo } from "../../src/agents/agents.service.js";
import { type AgentDefinition, AgentDefinitionSchema } from "../../src/agents/definition.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { AGENTS } from "../../src/http/tokens.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import type { OrgsService } from "../../src/orgs/orgs.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, orgsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";

/** Saving an agent definition's `subagents` block (phase C, spec §5.2). */

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let orgs: OrgsService;
let agents: AgentsService;

const PW = "correct horse battery";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
  orgs = orgsFor(db);
  // the kernel's own instance: soft delete cancels pending skill changes in its transaction, which
  // must be the kernel's (a service over another pool would run them outside it)
  agents = k.app.get<AgentsService>(AGENTS);
}, 120_000);

afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let owner: Account;
let member: Account;

let n = 0;
const account = (): Promise<Account> => {
  n++;
  return accounts.createLocal({ login: `user${n}`, password: PW, displayName: `U${n}` });
};

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  owner = await account();
  orgId = (await orgs.create({ name: "Acme", slug: `acme-${n}` }, owner)).id;
  member = await account();
  await members.add(orgId, member.id, "member", owner.id);
});

const def = (over: Record<string, unknown> = {}): AgentDefinition =>
  AgentDefinitionSchema.parse({
    name: "Lead",
    model: { provider: "model-fake", model: "fake-1" },
    tools: [
      { kind: "builtin", name: "ask_user" },
      { kind: "builtin", name: "read_tool_output" },
    ],
    ...over,
  });

const inline = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `Use ${name} for things.`,
  instructions: `You are ${name}.`,
  ...over,
});

async function template(name: string, plugin = "superpowers"): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("agent_templates")
    .values({ id, org_id: orgId, name, plugin_name: plugin, current_version: 1 })
    .execute();
  await db
    .insertInto("agent_template_versions")
    .values({
      template_id: id,
      version: 1,
      definition: JSON.stringify({ name, description: "d", instructions: "i" }),
    })
    .execute();
  return id;
}

async function skill(name: string, agentId?: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: orgId,
      scope: agentId === undefined ? "org" : "agent",
      agent_id: agentId ?? null,
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
        files: [{ path: "SKILL.md", size: 100, sha256: "0".repeat(64) }],
      }),
      object_prefix: `skills/${id}/`,
      created_by: owner.id,
    })
    .execute();
  return id;
}

/** An agent other agents may allowlist (dispatchable unless said otherwise). */
async function target(
  by: Account,
  opts: { dispatchable?: boolean; visibility?: "private" | "org" | "members" } = {},
): Promise<string> {
  const { agent } = await agents.create(orgId, by.id, {
    definition: def({ name: "Analyst", subagents: { dispatchable: opts.dispatchable ?? true } }),
    visibility: opts.visibility ?? "org",
  });
  return agent.id;
}

const problems = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).code).toBe("agent.subagents_invalid");
  return ((e as ApiError).details as { reason: string; path: string }[]).map((d) => [
    d.reason,
    d.path,
  ]);
};

const create = (definition: AgentDefinition, by: Account = owner) =>
  agents.create(orgId, by.id, { definition, visibility: "org" });

describe("agent definition subagents (save checks)", { timeout: 60_000 }, () => {
  it("a definition without subagents saves without a new version", async () => {
    const { agent } = await create(def());
    expect(agent.definition.subagents).toBeUndefined();
    const r = await agents.update(orgId, agent.id, owner.id, { definition: def() });
    expect(r.agent.currentVersion).toBe(1);
  });

  it("a valid block saves and round-trips", async () => {
    const t = await template("code-reviewer");
    const s = await skill("tdd");
    const a = await target(owner);
    const subagents = {
      general: true,
      templates: [t],
      inline: [
        inline("scout", {
          tools: ["read_tool_output"],
          disallowedTools: ["ask_user"],
          toolPolicies: { read_tool_output: "ask" },
          model: "fast",
          maxSteps: 5,
          skills: [s],
        }),
      ],
      agents: [{ agentId: a, as: "analyst", description: "Data questions." }],
    };
    const { agent } = await create(def({ subagents, skills: { orgSkills: [s] } }));
    expect(agent.definition.subagents).toEqual(subagents);
  });

  it("an unknown or deleted template id is not_found", async () => {
    const t = await template("gone");
    await db.updateTable("agent_templates").set({ deleted_at: new Date() }).execute();
    expect(await problems(create(def({ subagents: { templates: ["nope", t] } })))).toEqual([
      ["not_found", "subagents.templates.0"],
      ["not_found", "subagents.templates.1"],
    ]);
  });

  it("a bad name or general-purpose is invalid_name", async () => {
    expect(
      await problems(
        create(def({ subagents: { inline: [inline("Bad_Name"), inline("general-purpose")] } })),
      ),
    ).toEqual([
      ["invalid_name", "subagents.inline.0.name"],
      ["invalid_name", "subagents.inline.1.name"],
    ]);
  });

  it("a name used twice in the roster is duplicate", async () => {
    const a = await target(owner);
    const t = await template("reviewer");
    expect(
      await problems(
        create(
          def({
            subagents: {
              templates: [t, t],
              inline: [inline("scout")],
              agents: [{ agentId: a, as: "scout", description: "d" }],
            },
          }),
        ),
      ),
    ).toEqual([
      ["duplicate", "subagents.templates.1"],
      ["duplicate", "subagents.agents.0.as"],
    ]);
  });

  it("an inline tool the agent has not selected is tool_not_selected", async () => {
    expect(
      await problems(
        create(
          def({
            subagents: {
              inline: [
                inline("scout", {
                  tools: ["sandbox_bash"],
                  disallowedTools: ["skill_load"],
                  toolPolicies: { tool_search: "deny" },
                }),
              ],
            },
          }),
        ),
      ),
    ).toEqual([
      ["tool_not_selected", "subagents.inline.0.tools.0"],
      ["tool_not_selected", "subagents.inline.0.disallowedTools.0"],
      ["tool_not_selected", "subagents.inline.0.toolPolicies.tool_search"],
    ]);
  });

  it("an inline skill the agent has not selected is skill_not_selected", async () => {
    const s1 = await skill("one");
    const s2 = await skill("two");
    expect(
      await problems(
        create(
          def({
            skills: { orgSkills: [s1] },
            subagents: { inline: [inline("scout", { skills: [s1, s2] })] },
          }),
        ),
      ),
    ).toEqual([["skill_not_selected", "subagents.inline.0.skills.1"]]);
  });

  it("an inline skill may be one of the agent's own skills", async () => {
    const { agent } = await create(def());
    const own = await skill("mine", agent.id);
    const r = await agents.update(orgId, agent.id, owner.id, {
      definition: def({ subagents: { inline: [inline("scout", { skills: [own] })] } }),
    });
    expect(r.agent.currentVersion).toBe(2);
  });

  it("allowlisting an agent the editor cannot see → agent_not_available", async () => {
    const hidden = await target(member, { visibility: "private" });
    expect(
      await problems(
        create(def({ subagents: { agents: [{ agentId: hidden, as: "x", description: "d" }] } })),
      ),
    ).toEqual([["agent_not_available", "subagents.agents.0.agentId"]]);
    expect(await isAgentVisibleTo(db, hidden, owner.id)).toBe(false);
    expect(await isAgentVisibleTo(db, hidden, member.id)).toBe(true);
    // its own owner can allowlist it
    await create(
      def({ subagents: { agents: [{ agentId: hidden, as: "x", description: "d" }] } }),
      member,
    );
  });

  it("dispatchable false on the target → agent_not_available", async () => {
    const off = await target(owner, { dispatchable: false });
    const deleted = await target(owner);
    await agents.softDelete(orgId, deleted, owner.id);
    expect(await isAgentVisibleTo(db, deleted, owner.id)).toBe(false);
    expect(
      await problems(
        create(
          def({
            subagents: {
              agents: [
                { agentId: off, as: "a", description: "d" },
                { agentId: deleted, as: "b", description: "d" },
                { agentId: "nope", as: "c", description: "d" },
              ],
            },
          }),
        ),
      ),
    ).toEqual([
      ["agent_not_available", "subagents.agents.0.agentId"],
      ["agent_not_available", "subagents.agents.1.agentId"],
      ["agent_not_available", "subagents.agents.2.agentId"],
    ]);
  });

  it("an allowlisted agent that stops being dispatchable does not block unrelated edits", async () => {
    const a = await target(owner);
    const block = { agents: [{ agentId: a, as: "analyst", description: "d" }] };
    const { agent } = await create(def({ subagents: block }));
    await agents.update(orgId, a, owner.id, {
      definition: def({ name: "Analyst", subagents: { dispatchable: false } }),
    });
    const r = await agents.update(orgId, agent.id, owner.id, {
      definition: def({ instructions: "changed", subagents: block }),
    });
    expect(r.agent.currentVersion).toBe(2);
  });

  it("the agent itself is self", async () => {
    const { agent } = await create(def({ subagents: { dispatchable: true } }));
    expect(
      await problems(
        agents.update(orgId, agent.id, owner.id, {
          definition: def({
            subagents: {
              dispatchable: true,
              agents: [{ agentId: agent.id, as: "me", description: "d" }],
            },
          }),
        }),
      ),
    ).toEqual([["self", "subagents.agents.0.agentId"]]);
  });

  it("more than 20 roster entries is too_many", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await template(`t${i}`));
    expect(await problems(create(def({ subagents: { templates: ids } })))).toEqual([
      ["too_many", "subagents"],
    ]);
    // without general-purpose, 20 fit
    await create(def({ subagents: { general: false, templates: ids } }));
  });

  it("the schema bounds the block (strict, inline fields)", () => {
    const base = { name: "a", model: { provider: "p", model: "m" } };
    const ok = (subagents: unknown) =>
      AgentDefinitionSchema.safeParse({ ...base, subagents }).success;
    expect(ok({})).toBe(true);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ inline: [inline("a", { model: "huge" })] })).toBe(false);
    expect(ok({ inline: [inline("a", { maxSteps: 0 })] })).toBe(false);
    expect(ok({ inline: [inline("a", { skills: ["a", "b", "c", "d"] })] })).toBe(false);
    expect(ok({ inline: [{ name: "a", description: "d" }] })).toBe(false);
    expect(ok({ agents: [{ agentId: "x", as: "y", description: "" }] })).toBe(false);
  });
});
