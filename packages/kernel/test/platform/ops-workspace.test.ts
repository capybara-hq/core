import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { OrgAgentTemplates } from "../../src/agents/org-templates.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { type OrgEnv, resetOrgCatalog, setDeployment, startOrgEnv } from "../catalog/org-env.js";
import { accountsFor } from "../helpers/identity.js";
import { PW } from "../helpers/runs.js";

/**
 * Task 5 of the Platform tool: the skills, agents and agent-template operations against PG with
 * the real services (spec §6-§7). Operations run by `op.run(input, ctx)`, refusals by
 * `availability()`.
 */

let env: OrgEnv;
let ops: PlatformOperations;

beforeAll(async () => {
  env = await startOrgEnv();
  ops = env.k.app.get(PlatformOperations);
}, 240_000);
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetOrgCatalog(env);
  await setDeployment(env, { customSkills: "allow" });
  await env.db.deleteFrom("agents").execute();
});

const MODEL = { provider: "model-fake", model: "fake-1" };

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const facts = (role: ActorFacts["role"]): ActorFacts => ({
  role,
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: "on",
});

/** Parses like the tool does, then runs. */
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx);
};

async function agentOf(owner: string, visibility: "private" | "org", name = "Helper") {
  const r = await env.k.app.get(AgentsService).create(env.orgId, owner, {
    definition: {
      name,
      instructions: "Be helpful.",
      model: MODEL,
      tools: [
        { kind: "builtin", name: "Bash" },
        { kind: "builtin", name: "Skill" },
      ],
      toolPolicies: {},
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      avatarUrl: null,
    },
    visibility,
  });
  return r.agent.id;
}

const ctxOf = (accountId: string, agentId: string): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId,
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});

const audits = (action: string) =>
  env.db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

describe("registration", () => {
  it("registers every operation of the four domains", () => {
    expect(
      ops
        .all()
        .map((o) => o.id)
        .filter((id) => /^(platform|skills|agents|agent-templates)\./.test(id)),
    ).toEqual([
      "agent-templates.get",
      "agent-templates.list",
      "agent-templates.save",
      "agents.create",
      "agents.create-from-template",
      "agents.get",
      "agents.list",
      "agents.preview-from-template",
      "agents.update",
      "platform.me",
      "platform.overview",
      "skills.create",
      "skills.get",
      "skills.list",
    ]);
  });
});

describe("skills", () => {
  it("a member lists the org skills", async () => {
    const c = ctxOf(env.bossId, randomUUID());
    await run(
      "skills.create",
      { name: "report", description: "Write reports.", body: "# Steps" },
      c,
    );
    const out = (await run("skills.list", {}, ctxOf(env.memId, randomUUID()))) as {
      skills: { name: string }[];
    };
    expect(out.skills.map((s) => s.name)).toEqual(["report"]);
    expect(availability(op("skills.list"), facts("member"))).toEqual({ ok: true });
  });

  it("a member cannot create a skill: the reason names an org admin", () => {
    const a = availability(op("skills.create"), facts("member"));
    expect(a.ok).toBe(false);
    expect(a.ok ? "" : a.reason).toContain("an org admin");
  });

  it("an admin creates a skill and the audit row says it came through the agent", async () => {
    const c = ctxOf(env.bossId, randomUUID());
    expect(availability(op("skills.create"), facts("admin"))).toEqual({ ok: true });
    const out = (await run(
      "skills.create",
      { name: "triage", description: "Triage requests.", body: "# Steps" },
      c,
    )) as { skill: { id: string; name: string } };
    expect(out.skill.name).toBe("triage");
    const [row] = await audits("skill.created");
    expect(row?.detail).toMatchObject({
      name: "triage",
      via: "agent",
      conversationId: c.conversationId,
      runId: c.runId,
      operation: "skills.create",
    });
    const got = (await run("skills.get", { skillId: out.skill.id }, c)) as { body: string };
    expect(got.body).toContain("# Steps");
  });

  it("a taken name answers a ToolError naming the code", async () => {
    const c = ctxOf(env.bossId, randomUUID());
    const input = { name: "dup", description: "Dup.", body: "# x" };
    await run("skills.create", input, c);
    await expect(run("skills.create", input, c)).rejects.toThrow(/skill\.name_exists/);
  });
});

describe("agents", () => {
  it("a member creates a private agent; the audit row carries via, and an org agent is refused", async () => {
    const seed = await agentOf(env.memId, "private", "Seed");
    const c = ctxOf(env.memId, seed);
    const out = (await run("agents.create", { definition: { name: "Mine", model: MODEL } }, c)) as {
      agent: { id: string; visibility: string; definition: { tools: unknown[] } };
    };
    expect(out.agent.visibility).toBe("private");
    expect(out.agent.definition.tools.length).toBeGreaterThan(0);
    const rows = await audits("agent.created");
    expect(
      rows.some((r) => (r.detail as { operation?: string }).operation === "agents.create"),
    ).toBe(true);

    const refused = run(
      "agents.create",
      { definition: { name: "Shared", model: MODEL }, visibility: "org" },
      c,
    );
    await expect(refused).rejects.toBeInstanceOf(ToolError);
    await expect(refused).rejects.toThrow(/web app/);
  });

  it("lists and reads the agents the actor can see only", async () => {
    const mine = await agentOf(env.memId, "private", "Mine");
    const theirs = await agentOf(env.bossId, "private", "Theirs");
    const shared = await agentOf(env.bossId, "org", "Shared");
    const c = ctxOf(env.memId, mine);
    const list = (await run("agents.list", {}, c)) as { agents: { id: string }[] };
    expect(list.agents.map((a) => a.id).sort()).toEqual([mine, shared].sort());
    await expect(run("agents.get", { agentId: theirs }, c)).rejects.toThrow(/agent\.not_found/);
  });

  it("a member updating another member's agent gets the service's forbidden error as a ToolError", async () => {
    const other = (
      await accountsFor(env.db).createLocal({ login: "other", password: PW, displayName: "O" })
    ).id;
    await env.db
      .insertInto("memberships")
      .values({ org_id: env.orgId, account_id: other, role: "member" })
      .execute();
    const theirs = await agentOf(other, "org", "Theirs");
    const e = await run(
      "agents.update",
      { agentId: theirs, version: 1, instructions: "Hijacked." },
      ctxOf(env.memId, theirs),
    ).catch((x) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toMatch(/^forbidden:/);
  });

  it("the owner updates with the current version; a stale version is refused", async () => {
    const id = await agentOf(env.memId, "private");
    const c = ctxOf(env.memId, id);
    const out = (await run(
      "agents.update",
      { agentId: id, version: 1, instructions: "Be brief." },
      c,
    )) as { agent: { currentVersion: number; definition: { instructions: string; name: string } } };
    expect(out.agent.currentVersion).toBe(2);
    expect(out.agent.definition).toMatchObject({ instructions: "Be brief.", name: "Helper" });
    const [row] = (await audits("agent.updated")).slice(-1);
    expect(row?.detail).toMatchObject({ via: "agent", operation: "agents.update" });
    await expect(
      run("agents.update", { agentId: id, version: 1, name: "Late" }, c),
    ).rejects.toThrow(/agent\.version_conflict/);
  });

  it("creating from a template: stale hash refused, fresh hash creates a private agent", async () => {
    const source = await agentOf(env.bossId, "org", "Source");
    const saved = await env.k.app
      .get(OrgAgentTemplates)
      .saveAs(env.orgId, env.bossId, source, { name: "tpl", description: "A template." });
    const templateId = saved.template.id;
    const c = ctxOf(env.memId, await agentOf(env.memId, "private", "Seed"));

    const stale = run(
      "agents.create-from-template",
      { templateId, name: "Copy", previewHash: `${"0".repeat(64)}.${"0".repeat(16)}` },
      c,
    );
    await expect(stale).rejects.toBeInstanceOf(ToolError);
    await expect(stale).rejects.toThrow(/agent\.template_preview_stale/);

    const preview = (await run("agents.preview-from-template", { templateId }, c)) as {
      previewHash: string;
    };
    const out = (await run(
      "agents.create-from-template",
      { templateId, name: "Copy", previewHash: preview.previewHash },
      c,
    )) as { agent: { visibility: string; ownerAccountId: string } };
    expect(out.agent).toMatchObject({ visibility: "private", ownerAccountId: env.memId });
    const rows = await audits("agent.created");
    expect(
      rows.some(
        (r) => (r.detail as { operation?: string }).operation === "agents.create-from-template",
      ),
    ).toBe(true);
  });
});

describe("agent templates", () => {
  it("a member lists and reads; saving needs an admin, who saves with via in the audit", async () => {
    const agent = await agentOf(env.bossId, "org", "Source");
    expect(availability(op("agent-templates.save"), facts("member")).ok).toBe(false);
    expect(availability(op("agent-templates.save"), facts("admin"))).toEqual({ ok: true });
    const c = ctxOf(env.bossId, agent);
    const saved = (await run(
      "agent-templates.save",
      { agentId: agent, name: "triage", description: "Triage." },
      c,
    )) as { template: { id: string } };
    const [row] = await audits("agent_template.created");
    expect(row?.detail).toMatchObject({ via: "agent", operation: "agent-templates.save" });

    const mc = ctxOf(env.memId, agent);
    const list = (await run("agent-templates.list", {}, mc)) as { templates: { name: string }[] };
    expect(list.templates.map((t) => t.name)).toContain("triage");
    const got = (await run("agent-templates.get", { templateId: saved.template.id }, mc)) as {
      template: { name: string };
    };
    expect(got.template.name).toBe("triage");
  });
});

describe("platform", () => {
  it("platform.me lists the agent's tool keys, its sandbox and no secret", async () => {
    const id = await agentOf(env.memId, "private");
    const out = await run("platform.me", {}, ctxOf(env.memId, id));
    expect(out).toMatchObject({
      id,
      tools: ["Bash", "Skill"],
      sandbox: { enabled: true },
      model: MODEL,
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/secret|password|token|apiKey/i);
  });

  it("platform.overview gives the role, what it may build and the domains", async () => {
    const id = await agentOf(env.memId, "private");
    const out = (await run("platform.overview", {}, ctxOf(env.memId, id))) as {
      you: { role: string; canBuild: string[] };
      domains: { id: string }[];
    };
    expect(out.you.role).toBe("member");
    expect(out.you.canBuild.join(" ")).toContain("private agents");
    expect(out.you.canBuild.join(" ")).not.toContain("org skills");
    expect(out.domains.map((d) => d.id)).toContain("skills");
  });
});
