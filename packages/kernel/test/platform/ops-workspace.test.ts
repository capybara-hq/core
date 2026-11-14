import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { OrgAgentTemplates } from "../../src/agents/org-templates.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperationsProvider } from "../../src/platform/ops/platform.ops.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { effectiveDevicePolicy, readDeploymentDevicePolicy } from "../../src/sandbox/modes.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { type OrgEnv, resetOrgCatalog, setDeployment, startOrgEnv } from "../catalog/org-env.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { PW } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";

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
});
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetOrgCatalog(env);
  await setDeployment(env, { customSkills: "allow" });
  await env.db.deleteFrom("conversations").execute();
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

/** Parses like the tool does, then runs; a service refusal becomes the tool's error. */
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "orgAdmin"));
  });
};

/** The operation's precheck, as the tool's callPolicy runs it before the card. */
const precheck = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};

/** The card summary and the class of a write, as the tool's callPolicy reads them. */
const summarize = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.summary?.(o.input.parse(input), ctx);
};
const classOf = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.confirmFor === undefined ? o.confirm : o.confirmFor(o.input.parse(input), ctx);
};

async function agentOf(owner: string, visibility: "private" | "org", name = "Helper") {
  const r = await env.k.app.get(AgentsService).create(env.orgId, owner, {
    definition: {
      name,
      instructions: "Be helpful.",
      model: MODEL,
      disabledSkills: [],
      disabledTools: builtinsOff("Bash"),
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

/** Stores `c`'s conversation (a web one): operations that read the run's conversation need it. */
async function inConversation(c: OperationContext): Promise<OperationContext> {
  await env.db
    .insertInto("conversations")
    .values({
      id: c.conversationId,
      org_id: c.orgId,
      agent_id: c.agentId,
      account_id: c.actorAccountId,
      source: "web",
    })
    .execute();
  return c;
}

/** An org skill without a plugin, uploaded by the org admin; returns its id. */
async function orgSkill(name: string): Promise<string> {
  const md = new TextEncoder().encode(SKILL_MD(name, `Do ${name}.`));
  const out = await env.k.app.get(SkillsService).createVersionFromFiles(env.orgId, env.bossId, {
    name,
    description: `Do ${name}.`,
    files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
  });
  return out.skill.id;
}

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
      "agent-templates.available",
      "agent-templates.delete",
      "agent-templates.delete-preview",
      "agent-templates.disable-preview",
      "agent-templates.get",
      "agent-templates.list",
      "agent-templates.save",
      "agent-templates.set-enabled",
      "agent-templates.set-shareable",
      "agent-templates.update",
      "agents.bind-connector",
      "agents.connector-setup-status",
      "agents.create",
      "agents.create-from-template",
      "agents.delete",
      "agents.delete-skill",
      "agents.get",
      "agents.invocable-skills",
      "agents.list",
      "agents.preview-from-template",
      "agents.readiness",
      "agents.register-skill",
      "agents.request-connector-setup",
      "agents.share-skill",
      "agents.skills",
      "agents.update",
      "agents.update-profile",
      "agents.versions",
      "platform.me",
      "platform.overview",
      "platform.preferences",
      "platform.set-preferences",
      "skills.available",
      "skills.delete",
      "skills.delete-preview",
      "skills.disable-preview",
      "skills.get",
      "skills.get-change",
      "skills.list",
      "skills.set-enabled",
      "skills.set-shareable",
    ]);
  });
});

describe("skills", () => {
  it("a member lists the org skills", async () => {
    await orgSkill("report");
    const out = (await run("skills.list", {}, ctxOf(env.memId, randomUUID()))) as {
      skills: { name: string }[];
    };
    expect(out.skills.map((s) => s.name)).toEqual(["report"]);
    expect(availability(op("skills.list"), facts("member"))).toEqual({ ok: true });
  });

  it("there is no skills.create operation: skills enter only as uploaded packages", () => {
    expect(ops.get("skills.create")).toBeNull();
  });
});

describe("agents", () => {
  it("a member creates a private agent; the audit row carries via, and an org agent is refused", async () => {
    const seed = await agentOf(env.memId, "private", "Seed");
    const c = ctxOf(env.memId, seed);
    const out = (await run("agents.create", { definition: { name: "Mine", model: MODEL } }, c)) as {
      agent: { id: string; visibility: string; definition: { disabledTools: unknown[] } };
    };
    expect(out.agent.visibility).toBe("private");
    // nothing turned off: every tool the org offers (tools default-on spec §8)
    expect(out.agent.definition.disabledTools).toEqual([]);
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

  it("agents.create and agents.update take disabledSkills; agents.get returns it", async () => {
    const seed = await agentOf(env.memId, "private", "Seed");
    const c = ctxOf(env.memId, seed);
    const off = [{ kind: "skill", skillId: await orgSkill("report") }];
    const created = (await run(
      "agents.create",
      { definition: { name: "Narrow", model: MODEL, disabledSkills: off } },
      c,
    )) as { agent: { id: string } };
    const got = (await run("agents.get", { agentId: created.agent.id }, c)) as {
      agent: { definition: { disabledSkills: unknown } };
    };
    expect(got.agent.definition.disabledSkills).toEqual(off);
    await run("agents.update", { agentId: created.agent.id, version: 1, disabledSkills: [] }, c);
    const again = (await run("agents.get", { agentId: created.agent.id }, c)) as {
      agent: { definition: { disabledSkills: unknown } };
    };
    expect(again.agent.definition.disabledSkills).toEqual([]);
    // the selected and pinned skills are gone from the input
    const create = op("agents.create");
    expect(
      create.input.safeParse({
        definition: { name: "Old", model: MODEL, skills: { orgSkills: [], pinned: [] } },
      }).success,
    ).toBe(false);
    expect(
      op("agents.update").input.safeParse({ agentId: seed, version: 1, skills: { orgSkills: [] } })
        .success,
    ).toBe(false);
    for (const id of ["agents.create", "agents.update", "agents.get"]) {
      expect(op(id).description).toContain("disabledSkills");
      expect(op(id).description).not.toMatch(/pinned|orgSkills/);
    }
    expect(create.description).toContain(
      "an agent has every skill on in the org unless disabledSkills turns it off",
    );
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

  it("agents.update is personal only on the actor's own private agent; shared edits are org (finding 1)", async () => {
    const mine = await agentOf(env.memId, "private", "Mine");
    const ownShared = await agentOf(env.memId, "org", "Team helper");
    const theirsPrivate = await agentOf(env.memId, "private", "Member private");
    const input = (agentId: string) => ({ agentId, version: 1, instructions: "x" });
    const mc = ctxOf(env.memId, mine);
    expect(await classOf("agents.update", input(mine), mc)).toBe("personal");
    expect(await classOf("agents.update", input(ownShared), mc)).toBe("org");
    // an org admin editing a member's shared agent: not the admin's own, so org
    expect(await classOf("agents.update", input(ownShared), ctxOf(env.bossId, mine))).toBe("org");
    // an agent the actor cannot read throws; the tool counts that as org (never remembered)
    await expect(
      classOf("agents.update", input(theirsPrivate), ctxOf(env.bossId, mine)),
    ).rejects.toThrow(/Agent not found/);
    // the card names the agent and says whether it is shared
    expect(await summarize("agents.update", input(mine), mc)).toEqual({
      zh: "修改私有智能体「Mine」（版本 1）",
      en: 'Update private agent "Mine" (version 1)',
    });
    expect(await summarize("agents.update", input(ownShared), mc)).toEqual({
      zh: "修改共享智能体「Team helper」（版本 1）",
      en: 'Update shared agent "Team helper" (version 1)',
    });
    // the description matches: shared agents can be edited, visibility cannot be changed
    const d = op("agents.update").description;
    expect(d).toContain("shared");
    expect(d).toContain("visibility cannot be changed");
    expect(d).toContain("confirmed every time");
    expect(d).not.toContain("Only private agents");
    expect(op("agents.update").input.safeParse({ ...input(mine), visibility: "org" }).success).toBe(
      false,
    );
  });

  it("a connector tool 允许 the input adds is confirmed every time, never remembered (an agent never loosens itself on a grant)", async () => {
    const mine = await agentOf(env.memId, "private", "Mine");
    const mc = ctxOf(env.memId, mine);
    const KEY = "mcp__chat__send_message";
    const upd = (toolPolicies: Record<string, string>) => ({
      agentId: mine,
      version: 1,
      toolPolicies,
    });
    // tightening stays personal (may be remembered)
    expect(await classOf("agents.update", upd({ [KEY]: "ask" }), mc)).toBe("personal");
    // adding an allow: confirmed each time
    expect(await classOf("agents.update", upd({ [KEY]: "allow" }), mc)).toBe("org");
    // creating an agent that carries an allow: confirmed each time too
    const create = (toolPolicies: Record<string, string>) => ({
      definition: { name: "New", model: MODEL, toolPolicies },
    });
    expect(await classOf("agents.create", create({ [KEY]: "deny" }), mc)).toBe("personal");
    expect(await classOf("agents.create", create({ [KEY]: "allow" }), mc)).toBe("org");
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
    // the precheck finds a stale hash, an unknown template and a shared visibility before the card
    const zero = `${"0".repeat(64)}.${"0".repeat(16)}`;
    expect(
      await precheck(
        "agents.create-from-template",
        { templateId, name: "Copy", previewHash: zero },
        c,
      ),
    ).toMatchObject({ ok: false, code: "agent.template_preview_stale" });
    expect(
      await precheck(
        "agents.create-from-template",
        { templateId: randomUUID(), name: "Copy", previewHash: zero },
        c,
      ),
    ).toMatchObject({ ok: false, code: "component.not_found" });
    expect(
      await precheck(
        "agents.create-from-template",
        { templateId, name: "Copy", previewHash: zero, visibility: "org" },
        c,
      ),
    ).toMatchObject({ ok: false, code: "agent.visibility_web_only" });

    expect(
      await summarize(
        "agents.create-from-template",
        // the route's hash shape (the input is the route's schema), any value
        { templateId, name: "Copy", previewHash: `${"0".repeat(64)}.${"0".repeat(16)}` },
        c,
      ),
    ).toEqual({
      zh: "从模板「tpl」新建私有智能体「Copy」",
      en: 'Create private agent "Copy" from template "tpl"',
    });
    const preview = (await run("agents.preview-from-template", { templateId }, c)) as {
      previewHash: string;
    };
    expect(
      await precheck(
        "agents.create-from-template",
        { templateId, name: "Copy", previewHash: preview.previewHash },
        c,
      ),
    ).toEqual({ ok: true });
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

describe("agent profile", () => {
  const ACTIONS = [{ title: "Weekly report", body: "Write this week's report from my notes." }];

  it("agents.update-profile is personal on the actor's own private agent, org on a shared one", async () => {
    const mine = await agentOf(env.memId, "private", "Mine");
    const shared = await agentOf(env.memId, "org", "Team helper");
    const mc = ctxOf(env.memId, mine);
    const avatar = (agentId: string) => ({ agentId, avatar: { kind: "preset", id: "owl" } });
    // personal and not marked never-remembered: the person may remember it on a private agent
    expect(op("agents.update-profile").rememberable).toBeUndefined();
    expect(await classOf("agents.update-profile", avatar(mine), mc)).toBe("personal");
    // a shared agent: org, so each change is confirmed and never remembered
    expect(await classOf("agents.update-profile", avatar(shared), mc)).toBe("org");
    // an org admin editing a member's shared agent: not the admin's own, so org
    expect(await classOf("agents.update-profile", avatar(shared), ctxOf(env.bossId, mine))).toBe(
      "org",
    );
    // the card names the agent, whether it is shared and each change
    expect(await summarize("agents.update-profile", avatar(mine), mc)).toEqual({
      zh: "修改私有智能体「Mine」的资料：头像设为预设「owl」",
      en: 'Update the profile of private agent "Mine": set the avatar to preset "owl"',
    });
    expect(
      await summarize(
        "agents.update-profile",
        { agentId: shared, avatar: null, quickActions: ACTIONS },
        mc,
      ),
    ).toEqual({
      zh: "修改共享智能体「Team helper」的资料：移除头像；快捷操作设为 1 条（替换现有的）",
      en: 'Update the profile of shared agent "Team helper": remove the avatar; set 1 quick action (replacing the current ones)',
    });
    expect(
      await summarize("agents.update-profile", { agentId: mine, quickActions: [] }, mc),
    ).toMatchObject({ en: 'Update the profile of private agent "Mine": clear the quick actions' });
  });

  it("takes a preset avatar and quick actions only: no upload, no description, at least one field", () => {
    const input = op("agents.update-profile").input;
    const agentId = randomUUID();
    expect(input.safeParse({ agentId, avatar: { kind: "preset", id: "fox" } }).success).toBe(true);
    expect(input.safeParse({ agentId, avatar: null }).success).toBe(true);
    expect(input.safeParse({ agentId, avatar: { kind: "upload", uploadId: "u1" } }).success).toBe(
      false,
    );
    expect(input.safeParse({ agentId, avatar: { kind: "preset", id: "dragon" } }).success).toBe(
      false,
    );
    expect(input.safeParse({ agentId, description: "Hi" }).success).toBe(false);
    expect(input.safeParse({ agentId, expectedUpdatedAt: "x" }).success).toBe(false);
    expect(input.safeParse({ agentId }).success).toBe(false);
    // the route's bound: at most 9 quick actions
    const ten = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, body: "b" }));
    expect(input.safeParse({ agentId, quickActions: ten }).success).toBe(false);
  });

  it("the owner sets a preset avatar, then quick actions; agents.get shows them and the audit says via", async () => {
    const id = await agentOf(env.memId, "private", "Mine");
    const c = ctxOf(env.memId, id);
    expect(
      await precheck(
        "agents.update-profile",
        { agentId: id, avatar: { kind: "preset", id: "owl" } },
        c,
      ),
    ).toEqual({ ok: true });
    const first = (await run(
      "agents.update-profile",
      { agentId: id, avatar: { kind: "preset", id: "owl" } },
      c,
    )) as { profile: { avatar: unknown; quickActions: unknown[]; updatedAt: string } };
    expect(first.profile.avatar).toEqual({ kind: "preset", id: "owl" });
    expect(first.profile.quickActions).toEqual([]);
    // no updatedAt from the model: the operation reads the current one each time
    const second = (await run(
      "agents.update-profile",
      { agentId: id, quickActions: ACTIONS },
      c,
    )) as { profile: { avatar: unknown; quickActions: unknown[] } };
    expect(second.profile).toMatchObject({
      avatar: { kind: "preset", id: "owl" },
      quickActions: ACTIONS,
    });
    const got = (await run("agents.get", { agentId: id }, c)) as {
      agent: { profile: { avatar: unknown; quickActions: unknown[]; description: string } };
    };
    expect(got.agent.profile).toMatchObject({
      avatar: { kind: "preset", id: "owl" },
      quickActions: ACTIONS,
    });
    // a profile change is display data: no new agent version
    expect((await run("agents.versions", { agentId: id }, c)) as { versions: unknown[] }).toEqual({
      versions: [expect.anything()],
    });
    const rows = await audits("agent.profile_updated");
    expect(rows.map((r) => r.detail)).toEqual([
      expect.objectContaining({ fields: ["avatar"], channel: "agent", via: "agent" }),
      expect.objectContaining({
        fields: ["quickActions"],
        operation: "agents.update-profile",
        agentConversationId: c.conversationId,
        agentRunId: c.runId,
      }),
    ]);
  });

  it("an org admin may change a member's shared agent; a member is refused another's with the next step", async () => {
    const other = (
      await accountsFor(env.db).createLocal({
        login: "profile-other",
        password: PW,
        displayName: "O",
      })
    ).id;
    await env.db
      .insertInto("memberships")
      .values({ org_id: env.orgId, account_id: other, role: "member" })
      .execute();
    const theirs = await agentOf(other, "org", "Theirs");
    const input = { agentId: theirs, avatar: { kind: "preset", id: "fox" } };
    // the member: refused before the card, with the step for a member
    expect(await precheck("agents.update-profile", input, ctxOf(env.memId, theirs))).toEqual({
      ok: false,
      code: "forbidden",
      message: "Only the agent owner or an organization admin can modify it",
    });
    const errors = op("agents.update-profile").errors;
    expect(nextStepFor(errors, "forbidden", "member")).toContain("ask the owner, or an org admin");
    expect(nextStepFor(errors, "forbidden", "orgAdmin")).not.toContain("ask");
    // the service refuses it too, should the card be approved anyway
    await expect(run("agents.update-profile", input, ctxOf(env.memId, theirs))).rejects.toThrow(
      /^forbidden:/,
    );
    // an agent the actor cannot see is not found
    const hidden = await agentOf(other, "private", "Hidden");
    expect(
      await precheck(
        "agents.update-profile",
        { agentId: hidden, avatar: null },
        ctxOf(env.memId, hidden),
      ),
    ).toMatchObject({ ok: false, code: "agent.not_found" });
    // the org admin may
    const c = ctxOf(env.bossId, theirs);
    expect(await precheck("agents.update-profile", input, c)).toEqual({ ok: true });
    const out = (await run("agents.update-profile", input, c)) as { profile: { avatar: unknown } };
    expect(out.profile.avatar).toEqual({ kind: "preset", id: "fox" });
  });
});

describe("agent templates", () => {
  it("a member lists and reads; saving needs an admin, who saves with via in the audit", async () => {
    const agent = await agentOf(env.bossId, "org", "Source");
    expect(availability(op("agent-templates.save"), facts("member")).ok).toBe(false);
    expect(availability(op("agent-templates.save"), facts("admin"))).toEqual({ ok: true });
    const c = ctxOf(env.bossId, agent);
    expect(
      await summarize(
        "agent-templates.save",
        { agentId: agent, name: "triage", description: "Triage." },
        c,
      ),
    ).toEqual({
      zh: "把智能体「Source」另存为组织模板「triage」",
      en: 'Save agent "Source" as org template "triage"',
    });
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

describe("agent description", () => {
  it("agents.update saves the description into a new version and the profile shows it", async () => {
    const mine = await agentOf(env.memId, "private", "Mine");
    const c = await inConversation(ctxOf(env.memId, mine));
    await run(
      "agents.update",
      { agentId: mine, version: 1, description: "Answers HR questions." },
      c,
    );
    const got = (await run("agents.get", { agentId: mine }, c)) as {
      agent: { profile: { description: string } };
    };
    expect(got.agent.profile.description).toBe("Answers HR questions.");
    const me = (await run("platform.me", {}, c)) as {
      profile: { description: string };
      version: number;
    };
    expect(me).toMatchObject({ profile: { description: "Answers HR questions." }, version: 2 });
  });
});

describe("platform", () => {
  it("platform.set-preferences sets your own time zone, personal and rememberable", async () => {
    const id = await agentOf(env.memId, "private");
    const c = ctxOf(env.memId, id);
    expect(await run("platform.preferences", {}, c)).toEqual({ timeZone: null, theme: null });
    const o = op("platform.set-preferences");
    expect(o.confirm).toBe("personal");
    expect(o.rememberable).toBeUndefined();
    expect(await classOf("platform.set-preferences", { timeZone: "Europe/Berlin" }, c)).toBe(
      "personal",
    );
    expect(await summarize("platform.set-preferences", { timeZone: "Europe/Berlin" }, c)).toEqual({
      zh: "把你的时区从「跟随浏览器」改为「Europe/Berlin」",
      en: 'Change your time zone from "follow the browser" to "Europe/Berlin"',
    });
    expect(await run("platform.set-preferences", { timeZone: "Europe/Berlin" }, c)).toEqual({
      timeZone: "Europe/Berlin",
      theme: null,
    });
    expect(await run("platform.preferences", {}, c)).toEqual({
      timeZone: "Europe/Berlin",
      theme: null,
    });
    // only the caller's own account: another member still follows the browser
    const other = ctxOf(env.bossId, randomUUID());
    expect(await run("platform.preferences", {}, other)).toEqual({ timeZone: null, theme: null });
    // null goes back to the browser's zone
    await run("platform.set-preferences", { timeZone: null }, c);
    expect(await run("platform.preferences", {}, c)).toEqual({ timeZone: null, theme: null });
    // a theme that is on in none of your orgs is refused; the time zone is left alone
    await expect(run("platform.set-preferences", { theme: "nope" }, c)).rejects.toThrow(
      /theme\.not_available/,
    );
    expect(await run("platform.preferences", {}, c)).toEqual({ timeZone: null, theme: null });
    expect(await summarize("platform.set-preferences", { theme: null }, c)).toEqual({
      zh: "把你的主题从「跟随组织」改为「跟随组织」",
      en: 'Change your theme from "follow the org" to "follow the org"',
    });
  });

  it("platform.set-preferences refuses a name that is not an IANA time zone before the card", () => {
    const o = op("platform.set-preferences");
    expect(o.input.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(o.input.safeParse({ timeZone: "Asia/Shanghai", extra: 1 }).success).toBe(false);
    expect(o.input.safeParse({}).success).toBe(false);
  });

  it("platform.me lists the agent's tool keys, its sandbox and no secret", async () => {
    const id = await agentOf(env.memId, "private");
    const out = await run("platform.me", {}, await inConversation(ctxOf(env.memId, id)));
    // every builtin but Bash is off; this deployment has no sandbox provider, so Bash cannot load
    // now and is listed with the reason
    expect(out).toMatchObject({
      id,
      tools: [],
      unavailableTools: [{ tool: "Bash" }],
      disabledTools: builtinsOff("Bash"),
      sandbox: { enabled: false },
      model: MODEL,
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/secret|password|token|apiKey/i);
  });

  it("platform.me lists the skills the agent has now and the ones it turns off", async () => {
    await orgSkill("report");
    const draft = await orgSkill("draft");
    const id = await agentOf(env.memId, "private");
    const c = await inConversation(ctxOf(env.memId, id));
    // nothing turned off: every org skill is on (skills default-on spec §11)
    expect(await run("platform.me", {}, c)).toMatchObject({
      skills: [
        { name: "draft", plugin: null },
        { name: "report", plugin: null },
      ],
      disabledSkills: [],
    });
    await run(
      "agents.update",
      { agentId: id, version: 1, disabledSkills: [{ kind: "skill", skillId: draft }] },
      c,
    );
    const out = (await run("platform.me", {}, c)) as Record<string, unknown>;
    expect(out).toMatchObject({
      skills: [{ name: "report", plugin: null }],
      disabledSkills: [{ kind: "skill", skillId: draft }],
    });
    expect(op("platform.me").description).not.toMatch(/pinned/i);
  });

  it("platform.me reports a new device's mode and network as effectiveDevicePolicy does", async () => {
    // the agent has a sandbox tool (this deployment has no sandbox provider, so the tool keys are
    // stubbed); the mode and network then come from the one derivation (hardening spec K2)
    const provider = env.k.app.get(PlatformOperationsProvider);
    const keys = vi
      .spyOn(provider as unknown as { toolKeys: () => Promise<unknown> }, "toolKeys")
      .mockResolvedValue({ keys: ["Bash"], unavailable: [] });
    const settings = env.k.app.get(OrgSettingsService);
    const config = env.k.app.get(KernelConfigService);
    const id = await agentOf(env.memId, "private");
    const c = await inConversation(ctxOf(env.memId, id));
    const OPEN = { mode: "open" as const };
    const LIST = { mode: "allowlist" as const, allowHosts: ["pypi.org"] };
    const cases: {
      platform: "allowed" | "off";
      org: "off" | null;
      net: typeof OPEN | typeof LIST;
      want: [string, string];
    }[] = [
      { platform: "allowed", org: null, net: OPEN, want: ["auto", "open-public"] },
      {
        platform: "allowed",
        org: null,
        net: LIST,
        want: ["auto", "open-public"],
      },
      { platform: "allowed", org: "off", net: OPEN, want: ["sandbox", "open-public"] },
      {
        platform: "allowed",
        org: "off",
        net: LIST,
        want: ["sandbox", "allowlist"],
      },
      { platform: "off", org: null, net: OPEN, want: ["sandbox", "open-public"] },
      {
        platform: "off",
        org: null,
        net: LIST,
        want: ["sandbox", "allowlist"],
      },
    ];
    try {
      for (const k of cases) {
        await setDeployment(env, { devicesAutoMode: { mode: k.platform } });
        await settings.update(env.orgId, { autoMode: k.org, cloudNetwork: k.net }, env.rootId);
        const out = (await run("platform.me", {}, c)) as {
          sandbox: { enabled: boolean; mode: string; network: string };
        };
        const policy = effectiveDevicePolicy(
          await readDeploymentDevicePolicy(env.db, config),
          await settings.get(env.orgId),
          null,
        );
        const label = JSON.stringify(k);
        expect(out.sandbox, label).toEqual({
          enabled: true,
          mode: policy.mode,
          network: policy.network.kind,
        });
        expect([out.sandbox.mode, out.sandbox.network], label).toEqual(k.want);
      }
    } finally {
      keys.mockRestore();
      await settings.update(env.orgId, { autoMode: null, cloudNetwork: null }, env.rootId);
    }
  });

  it("platform.me shows the agent's profile: avatar, description and quick actions", async () => {
    const id = await agentOf(env.memId, "private");
    const c = await inConversation(ctxOf(env.memId, id));
    const actions = [{ title: "Triage", body: "Triage the new issues." }];
    await run(
      "agents.update-profile",
      { agentId: id, avatar: { kind: "preset", id: "panda" }, quickActions: actions },
      c,
    );
    const out = (await run("platform.me", {}, c)) as { profile: unknown };
    expect(out.profile).toEqual({
      avatar: { kind: "preset", id: "panda" },
      description: "",
      quickActions: actions,
    });
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
