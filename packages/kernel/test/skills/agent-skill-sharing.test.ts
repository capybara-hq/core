import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ApiError } from "../../src/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { AGENT_SKILLS_MAX, AgentSkillsService } from "../../src/skills/agent-skills.service.js";
import { resolveSkills } from "../../src/skills/catalog.js";
import { SkillChangesService } from "../../src/skills/changes.service.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { type OrgEnv, resetOrgCatalog, setDeployment, startOrgEnv } from "../catalog/org-env.js";
import { eventsOf, type Req } from "../helpers/runs.js";
import { makeZip, SKILL_MD } from "./zip.js";

/**
 * Sharing an agent's own skill with the org and version proposals on a shared skill, both decided
 * by org admins (spec §5.4, §5.5). Real kernel, model-fake agents, SeaweedFS. `boss` is an org
 * admin, `mem` a member.
 */

let env: OrgEnv;
let svc: AgentSkillsService;
let changes: SkillChangesService;

beforeAll(async () => {
  env = await startOrgEnv();
  svc = env.k.app.get(AgentSkillsService);
  changes = env.k.app.get(SkillChangesService);
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await setDeployment(env, { customSkills: "allow" });
  await env.db.deleteFrom("skill_change_requests").execute();
  await env.db.deleteFrom("conversation_events").execute();
  await env.db.deleteFrom("runs").execute();
  await env.db.deleteFrom("conversations").execute();
  await env.db.deleteFrom("skill_versions").execute();
  await env.db.deleteFrom("skills").execute();
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
});

async function createAgent(who: Req, orgSkills: string[] = []): Promise<string> {
  const res = await who({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name: "Writer",
        instructions: "Write skills.",
        model: { provider: "model-fake", model: "fake-1" },
        ...(orgSkills.length > 0 && { skills: { orgSkills } }),
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function createConv(who: Req, agentId: string): Promise<string> {
  const res = await who({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/conversations`,
    payload: { agentId },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

const zipOf = (name: string, body = "Steps.") =>
  new Uint8Array(
    makeZip([
      {
        name: "SKILL.md",
        data: `---\nname: ${name}\ndescription: Work with PDFs.\n---\n${body}\n`,
      },
    ]),
  );

const actor = (agentId: string, accountId: string, conversationId?: string) => ({
  orgId: env.orgId,
  agentId,
  accountId,
  ...(conversationId !== undefined && { conversationId }),
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return (e as ApiError).code;
  }
  throw new Error("expected a rejection");
}

const skillRow = (id: string) =>
  env.db.selectFrom("skills").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const versionOf = (skillId: string, v: number) =>
  env.db
    .selectFrom("skill_versions")
    .select(["manifest", "object_prefix"])
    .where("skill_id", "=", skillId)
    .where("version", "=", v)
    .executeTakeFirstOrThrow();
const requestRow = (id: string) =>
  env.db
    .selectFrom("skill_change_requests")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
const keysUnder = async (prefix: string) =>
  (await env.k.app.get(StorageService).kernel(env.orgId).list(prefix)).items.map((o) => o.key);

type CatalogEvent = Extract<ConversationEvent, { type: "skills_catalog" }>;
const lastCatalog = async (convId: string) =>
  (await eventsOf(env.db, convId))
    .filter((e): e is CatalogEvent => e.type === "skills_catalog")
    .at(-1)?.payload;

/** The effective skills of an agent in a conversation, by name -> source. */
async function effective(agentId: string, conversationId?: string, orgSkills: string[] = []) {
  const rows = await resolveSkills(env.db, {
    orgId: env.orgId,
    agentId,
    agent: { skills: { orgSkills } },
    ...(conversationId !== undefined && { conversationId }),
  });
  return Object.fromEntries(rows.map((r) => [r.skill.name, r.skill]));
}

const decideHttp = (who: Req, id: string, decision: "approve" | "reject") =>
  who({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/skill-changes/${id}/decide`,
    payload: { decision },
  });

/** A member's agent with its own skill "notes", shared through an admin's approval. */
async function sharedByMember() {
  const agentId = await createAgent(env.mem);
  const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
  const out = await svc.share(actor(agentId, env.memId), own.skillId);
  if (out.kind !== "requested") throw new Error("expected a request");
  const res = await decideHttp(env.boss, out.requestId, "approve");
  expect(res.statusCode, res.body).toBe(200);
  return { agentId, skillId: own.skillId };
}

describe("sharing an agent skill", () => {
  it("a member owner asks; an org admin approves; the skill becomes the org's", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const v1 = await versionOf(own.skillId, 1);
    const out = await svc.share(actor(agentId, env.memId), own.skillId);
    expect(out.kind).toBe("requested");
    if (out.kind !== "requested") throw new Error("unreachable");
    const req = await requestRow(out.requestId);
    expect(req).toMatchObject({
      kind: "share",
      skill_id: own.skillId,
      status: "pending",
      object_prefix: v1.object_prefix,
      requested_by_account: env.memId,
      requested_in_conversation: null,
    });
    // a second ask while it waits
    expect(await codeOf(svc.share(actor(agentId, env.memId), own.skillId))).toBe(
      "skill.share_pending",
    );
    // org admins see it in the inbox; the member does not
    const pending = await changes.listPending(env.orgId, env.bossId);
    expect(pending.map((c) => [c.id, c.kind])).toEqual([[out.requestId, "share"]]);
    expect(await changes.listPending(env.orgId, env.memId)).toEqual([]);
    // still the agent's own skill while it waits
    expect((await skillRow(own.skillId)).scope).toBe("agent");

    const res = await decideHttp(env.boss, out.requestId, "approve");
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (res.json() as { skillChange: { status: string; kind: string } }).skillChange,
    ).toMatchObject({ status: "approved", kind: "share" });
    expect(await skillRow(own.skillId)).toMatchObject({
      scope: "org",
      agent_id: null,
      origin_agent_id: agentId,
      maintainer_account_id: env.memId,
      current_version: 1,
    });
    // version history and files are kept
    expect(await keysUnder(v1.object_prefix)).toHaveLength(1);
    // the original agent still has it without a definition change; another agent can select it
    expect((await effective(agentId)).notes?.id).toBe(own.skillId);
    const other = await createAgent(env.boss, [own.skillId]);
    expect((await effective(other, undefined, [own.skillId])).notes?.id).toBe(own.skillId);
    expect(await effective(other)).toEqual({});
    const audits = await env.db
      .selectFrom("audit_events")
      .select("action")
      .where("target", "in", [own.skillId, out.requestId])
      .execute();
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["skill.share_requested", "skill.shared", "skill.change_decided"]),
    );
  });

  it("an org admin owner shares at once", async () => {
    const agentId = await createAgent(env.boss);
    const own = await svc.register(actor(agentId, env.bossId), zipOf("notes"));
    const out = await svc.share(actor(agentId, env.bossId), own.skillId);
    expect(out).toEqual({ kind: "shared", skillId: own.skillId });
    expect(await skillRow(own.skillId)).toMatchObject({
      scope: "org",
      agent_id: null,
      origin_agent_id: agentId,
      maintainer_account_id: env.bossId,
    });
    expect(await env.db.selectFrom("skill_change_requests").select("id").execute()).toEqual([]);
  });

  it("over HTTP: POST .../skills/:skillId/share", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const res = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents/${agentId}/skills/${own.skillId}/share`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { share: { kind: string } }).share.kind).toBe("requested");
    // only the owner
    const res2 = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents/${agentId}/skills/${own.skillId}/share`,
    });
    expect(res2.statusCode).toBe(404);
  });

  it("a name taken by an org skill: skill.name_exists, the own skill unchanged", async () => {
    await env.k.app.get(SkillsService).createVersionFromFiles(env.orgId, env.bossId, {
      name: "notes",
      description: "Org notes.",
      files: [
        {
          path: "SKILL.md",
          data: new TextEncoder().encode(SKILL_MD("notes")),
          size: SKILL_MD("notes").length,
          sha256: "x",
        },
      ],
    });
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    expect(await codeOf(svc.share(actor(agentId, env.memId), own.skillId))).toBe(
      "skill.name_exists",
    );
    const boss = await createAgent(env.boss);
    const mine = await svc.register(actor(boss, env.bossId), zipOf("notes"));
    expect(await codeOf(svc.share(actor(boss, env.bossId), mine.skillId))).toBe(
      "skill.name_exists",
    );
    expect(await skillRow(own.skillId)).toMatchObject({ scope: "agent", agent_id: agentId });
  });

  it("customSkills deny refuses sharing, not registration", async () => {
    await setDeployment(env, { customSkills: "deny" });
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    expect(await codeOf(svc.share(actor(agentId, env.memId), own.skillId))).toBe(
      "catalog.custom_disabled",
    );
  });

  it("only the owner shares", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    expect(await codeOf(svc.share(actor(agentId, env.bossId), own.skillId))).toBe(
      "agent.not_found",
    );
    expect(await codeOf(svc.share(actor(agentId, env.memId), "nope"))).toBe("skill.not_found");
  });

  it("a non-admin cannot decide: 403", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const out = await svc.share(actor(agentId, env.memId), own.skillId);
    if (out.kind !== "requested") throw new Error("expected a request");
    const res = await decideHttp(env.mem, out.requestId, "approve");
    expect(res.statusCode).toBe(403);
    expect(
      await codeOf(changes.decide(env.orgId, out.requestId, env.memId, { decision: "approve" })),
    ).toBe("forbidden");
    expect((await requestRow(out.requestId)).status).toBe("pending");
  });

  it("reject leaves the skill the agent's own and its files", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const v1 = await versionOf(own.skillId, 1);
    const out = await svc.share(actor(agentId, env.memId), own.skillId);
    if (out.kind !== "requested") throw new Error("expected a request");
    const res = await decideHttp(env.boss, out.requestId, "reject");
    expect(res.statusCode, res.body).toBe(200);
    expect((await skillRow(own.skillId)).scope).toBe("agent");
    expect(await keysUnder(v1.object_prefix)).toHaveLength(1);
  });

  it("a new version of the skill cancels its pending share", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const v1 = await versionOf(own.skillId, 1);
    const out = await svc.share(actor(agentId, env.memId), own.skillId);
    if (out.kind !== "requested") throw new Error("expected a request");
    const v2 = await svc.register(actor(agentId, env.memId), zipOf("notes", "V2."));
    expect(v2).toMatchObject({ kind: "version", skillId: own.skillId, version: 2 });
    expect((await requestRow(out.requestId)).status).toBe("cancelled");
    expect(await keysUnder(v1.object_prefix)).toHaveLength(1);
  });

  it("approve never shares a version the admin did not review", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const v1 = await versionOf(own.skillId, 1);
    const out = await svc.share(actor(agentId, env.memId), own.skillId);
    if (out.kind !== "requested") throw new Error("expected a request");
    // the versions diverge behind the request's back
    await env.db
      .insertInto("skill_versions")
      .values({
        skill_id: own.skillId,
        version: 2,
        manifest: JSON.stringify(v1.manifest),
        object_prefix: v1.object_prefix,
        created_by: env.memId,
      })
      .execute();
    await env.db
      .updateTable("skills")
      .set({ current_version: 2 })
      .where("id", "=", own.skillId)
      .execute();
    const res = await decideHttp(env.boss, out.requestId, "approve");
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { skillChange: { status: string } }).skillChange.status).toBe(
      "cancelled",
    );
    expect((await skillRow(own.skillId)).scope).toBe("agent");
  });

  it("agent deleted while a share is pending: cancelled, files kept", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const v1 = await versionOf(own.skillId, 1);
    const out = await svc.share(actor(agentId, env.memId), own.skillId);
    if (out.kind !== "requested") throw new Error("expected a request");
    await env.k.app.get(AgentsService).softDelete(env.orgId, agentId, env.memId);
    expect((await requestRow(out.requestId)).status).toBe("cancelled");
    expect(await keysUnder(v1.object_prefix)).toHaveLength(1);
  });

  it("ownership transfer cancels a pending share", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    const out = await svc.share(actor(agentId, env.memId), own.skillId);
    if (out.kind !== "requested") throw new Error("expected a request");
    await env.k.app.get(AgentsService).reassignOwner(env.orgId, agentId, env.bossId, env.bossId);
    expect((await requestRow(out.requestId)).status).toBe("cancelled");
  });

  it("a pending share does not count twice toward the agent skill cap", async () => {
    const agentId = await createAgent(env.mem);
    const own = await svc.register(actor(agentId, env.memId), zipOf("notes"));
    await env.db
      .insertInto("skills")
      .values(
        Array.from({ length: AGENT_SKILLS_MAX - 2 }, (_, i) => ({
          id: `cap-${i}`,
          org_id: env.orgId,
          scope: "agent" as const,
          agent_id: agentId,
          name: `skill-${i}`,
          description: "d",
          current_version: 1,
          created_by: env.memId,
        })),
      )
      .execute();
    await svc.share(actor(agentId, env.memId), own.skillId);
    // 49 own skills (one with a pending share): one more fits
    const last = await svc.register(actor(agentId, env.memId), zipOf("last"));
    expect(last.kind).toBe("version");
    expect(await codeOf(svc.register(actor(agentId, env.memId), zipOf("over")))).toBe(
      "skill.agent_cap",
    );
  });
});

describe("version proposals on a shared skill", () => {
  it("the maintainer proposes; only the proposing conversation sees it; approve applies it", async () => {
    const { agentId, skillId } = await sharedByMember();
    const conv = await createConv(env.mem, agentId);
    const other = await createConv(env.mem, agentId);
    const out = await svc.register(actor(agentId, env.memId, conv), zipOf("notes", "Version 2."));
    expect(out).toMatchObject({ kind: "proposed", skillId, name: "notes", version: 2 });
    if (out.kind !== "proposed") throw new Error("unreachable");
    const req = await requestRow(out.requestId);
    expect(req).toMatchObject({
      kind: "version",
      skill_id: skillId,
      requested_in_conversation: conv,
    });
    // the org skill is unchanged; the trial is only in the proposing conversation
    expect((await skillRow(skillId)).current_version).toBe(1);
    expect((await lastCatalog(conv))?.skills).toEqual([
      expect.objectContaining({ id: skillId, version: 2, source: req.object_prefix }),
    ]);
    expect((await effective(agentId, conv)).notes?.source).toBe(req.object_prefix);
    expect((await effective(agentId, other)).notes?.version).toBe(1);
    // admins see it as a version proposal
    expect((await changes.listPending(env.orgId, env.bossId)).map((c) => c.kind)).toEqual([
      "version",
    ]);

    const res = await decideHttp(env.boss, out.requestId, "approve");
    expect(res.statusCode, res.body).toBe(200);
    expect((await skillRow(skillId)).current_version).toBe(2);
    expect((await versionOf(skillId, 2)).object_prefix).toBe(req.object_prefix);
    // every agent's next run sees it
    expect((await effective(agentId, other)).notes).toMatchObject({
      version: 2,
      source: req.object_prefix,
    });
    const reader = await createAgent(env.boss, [skillId]);
    expect((await effective(reader, undefined, [skillId])).notes?.version).toBe(2);
  });

  it("reject reverts the trial and deletes the draft", async () => {
    const { agentId, skillId } = await sharedByMember();
    const v1 = await versionOf(skillId, 1);
    const conv = await createConv(env.mem, agentId);
    const out = await svc.register(actor(agentId, env.memId, conv), zipOf("notes", "Version 2."));
    if (out.kind !== "proposed") throw new Error("expected a proposal");
    const req = await requestRow(out.requestId);
    expect(await keysUnder(req.object_prefix)).toHaveLength(1);
    const res = await decideHttp(env.boss, out.requestId, "reject");
    expect(res.statusCode, res.body).toBe(200);
    expect((await lastCatalog(conv))?.skills).toEqual([
      expect.objectContaining({ id: skillId, version: 1, source: v1.object_prefix }),
    ]);
    expect(await keysUnder(req.object_prefix)).toEqual([]);
    expect((await skillRow(skillId)).current_version).toBe(1);
  });

  it("another conversation's pending proposal: skill.proposal_pending_elsewhere; the same conversation supersedes", async () => {
    const { agentId } = await sharedByMember();
    const a = await createConv(env.mem, agentId);
    const b = await createConv(env.mem, agentId);
    const first = await svc.register(actor(agentId, env.memId, a), zipOf("notes", "V2."));
    if (first.kind !== "proposed") throw new Error("expected a proposal");
    const firstPrefix = (await requestRow(first.requestId)).object_prefix;
    expect(await codeOf(svc.register(actor(agentId, env.memId, b), zipOf("notes", "V2b.")))).toBe(
      "skill.proposal_pending_elsewhere",
    );
    // another agent of the maintainer is refused too
    const second = await createAgent(env.mem);
    const c = await createConv(env.mem, second);
    expect(await codeOf(svc.register(actor(second, env.memId, c), zipOf("notes", "V2c.")))).toBe(
      "skill.proposal_pending_elsewhere",
    );
    const again = await svc.register(actor(agentId, env.memId, a), zipOf("notes", "V2 again."));
    if (again.kind !== "proposed") throw new Error("expected a proposal");
    expect((await requestRow(first.requestId)).status).toBe("cancelled");
    expect((await requestRow(again.requestId)).status).toBe("pending");
    expect(await keysUnder(firstPrefix)).toEqual([]);
  });

  it("an org admin maintainer applies the version at once", async () => {
    const agentId = await createAgent(env.boss);
    const own = await svc.register(actor(agentId, env.bossId), zipOf("notes"));
    await svc.share(actor(agentId, env.bossId), own.skillId);
    const conv = await createConv(env.boss, agentId);
    const out = await svc.register(actor(agentId, env.bossId, conv), zipOf("notes", "V2."));
    expect(out).toMatchObject({
      kind: "version",
      skillId: own.skillId,
      version: 2,
      created: false,
    });
    expect(await skillRow(own.skillId)).toMatchObject({ scope: "org", current_version: 2 });
    expect(await env.db.selectFrom("skill_change_requests").select("id").execute()).toEqual([]);
    const v2 = await versionOf(own.skillId, 2);
    expect((await lastCatalog(conv))?.skills).toEqual([
      expect.objectContaining({ id: own.skillId, version: 2, source: v2.object_prefix }),
    ]);
    // from the web (no conversation): the upload is consumed before the version is written
    let consumed = 0;
    const web = await svc.register(actor(agentId, env.bossId), zipOf("notes", "V3."), {
      inTransaction: async () => {
        consumed++;
      },
    });
    expect(web).toMatchObject({ kind: "version", skillId: own.skillId, version: 3 });
    expect(consumed).toBe(1);
  });

  it("a non-maintainer: refused for an org skill the agent uses, an own skill otherwise", async () => {
    const { agentId: origin, skillId } = await sharedByMember();
    const user = await createAgent(env.boss, [skillId]);
    expect(await codeOf(svc.register(actor(user, env.bossId), zipOf("notes", "Mine.")))).toBe(
      "skill.name_exists",
    );
    // the origin agent after a transfer: it still uses the skill, the new owner does not maintain it
    await env.k.app.get(AgentsService).reassignOwner(env.orgId, origin, env.bossId, env.bossId);
    expect(await codeOf(svc.register(actor(origin, env.bossId), zipOf("notes", "Mine.")))).toBe(
      "skill.name_exists",
    );
    // an agent that does not use the org skill gets an own skill of the name
    const agentId = await createAgent(env.boss);
    const out = await svc.register(actor(agentId, env.bossId), zipOf("notes", "Mine."));
    expect(out.kind).toBe("version");
    expect(out.skillId).not.toBe(skillId);
    expect((await skillRow(out.skillId)).scope).toBe("agent");
  });

  it("customSkills deny refuses proposals, their approval and an admin's direct version", async () => {
    const { agentId } = await sharedByMember();
    const conv = await createConv(env.mem, agentId);
    const out = await svc.register(actor(agentId, env.memId, conv), zipOf("notes", "V2."));
    if (out.kind !== "proposed") throw new Error("expected a proposal");
    await setDeployment(env, { customSkills: "deny" });
    expect(
      await codeOf(svc.register(actor(agentId, env.memId, conv), zipOf("notes", "V2b."))),
    ).toBe("catalog.custom_disabled");
    expect(
      await codeOf(changes.decide(env.orgId, out.requestId, env.bossId, { decision: "approve" })),
    ).toBe("catalog.custom_disabled");
    expect((await requestRow(out.requestId)).status).toBe("pending");

    await setDeployment(env, { customSkills: "allow" });
    const bossAgent = await createAgent(env.boss);
    const own = await svc.register(actor(bossAgent, env.bossId), zipOf("mine"));
    await svc.share(actor(bossAgent, env.bossId), own.skillId);
    await setDeployment(env, { customSkills: "deny" });
    expect(await codeOf(svc.register(actor(bossAgent, env.bossId), zipOf("mine", "V2.")))).toBe(
      "catalog.custom_disabled",
    );
  });

  it("an admin's direct version supersedes a pending proposal of the skill", async () => {
    const agentId = await createAgent(env.boss);
    const own = await svc.register(actor(agentId, env.bossId), zipOf("notes"));
    await svc.share(actor(agentId, env.bossId), own.skillId);
    const conv = await createConv(env.boss, agentId);
    const role = (r: "admin" | "member") =>
      env.db
        .updateTable("memberships")
        .set({ role: r })
        .where("org_id", "=", env.orgId)
        .where("account_id", "=", env.bossId)
        .execute();
    await role("member");
    let proposed: Awaited<ReturnType<typeof svc.register>>;
    try {
      proposed = await svc.register(actor(agentId, env.bossId, conv), zipOf("notes", "Old."));
    } finally {
      await role("admin");
    }
    if (proposed.kind !== "proposed") throw new Error("expected a proposal");
    const draft = (await requestRow(proposed.requestId)).object_prefix;
    const out = await svc.register(actor(agentId, env.bossId), zipOf("notes", "New."));
    expect(out).toMatchObject({ kind: "version", version: 2 });
    expect((await requestRow(proposed.requestId)).status).toBe("cancelled");
    expect(await keysUnder(draft)).toEqual([]);
    // the trial in the proposing conversation went back to a real version
    expect((await lastCatalog(conv))?.skills.map((x) => x.source)).not.toContain(draft);
  });

  it("agent deleted while a proposal is pending: cancelled, draft deleted", async () => {
    const { agentId } = await sharedByMember();
    const conv = await createConv(env.mem, agentId);
    const out = await svc.register(actor(agentId, env.memId, conv), zipOf("notes", "V2."));
    if (out.kind !== "proposed") throw new Error("expected a proposal");
    const prefix = (await requestRow(out.requestId)).object_prefix;
    await env.k.app.get(AgentsService).softDelete(env.orgId, agentId, env.memId);
    expect((await requestRow(out.requestId)).status).toBe("cancelled");
    expect(await keysUnder(prefix)).toEqual([]);
  });
});

describe("version proposals on a promoted shared skill", () => {
  /** The member's shared "notes", made shareable and shown to other orgs (promoted). */
  async function promotedShared() {
    const shared = await sharedByMember();
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/skills/${shared.skillId}/shareable`,
      payload: { shareable: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    const shown = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${shared.skillId}/shown`,
      payload: { shownToOthers: true },
    });
    expect(shown.statusCode, shown.body).toBe(200);
    const platformId = (await skillRow(shared.skillId)).platform_skill_id;
    if (platformId === null) throw new Error("expected a promoted skill");
    return { ...shared, platformId };
  }
  const platformPrefixes = async (platformId: string) => {
    const listed = await env.k.app
      .get(StorageService)
      .deployment()
      .list(`platform/skills/${platformId}/`);
    return [...new Set(listed.items.map((o) => o.key.split("/").slice(0, 4).join("/")))].sort();
  };
  const platformVersion = (platformId: string) =>
    env.db
      .selectFrom("platform_skills as p")
      .innerJoin("platform_skill_versions as v", (j) =>
        j.onRef("v.skill_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
      )
      .select(["p.current_version", "v.object_prefix", "v.manifest"])
      .where("p.id", "=", platformId)
      .executeTakeFirstOrThrow();

  it("approve writes the version on the platform row; the draft goes", async () => {
    const { agentId, skillId, platformId } = await promotedShared();
    const before = await platformVersion(platformId);
    const conv = await createConv(env.mem, agentId);
    const out = await svc.register(actor(agentId, env.memId, conv), zipOf("notes", "V2."));
    if (out.kind !== "proposed") throw new Error("expected a proposal");
    const draft = (await requestRow(out.requestId)).object_prefix;
    const res = await decideHttp(env.boss, out.requestId, "approve");
    expect(res.statusCode, res.body).toBe(200);
    const after = await platformVersion(platformId);
    expect(after.current_version).toBe(before.current_version + 1);
    expect(after.object_prefix).not.toBe(draft);
    const store = env.k.app.get(StorageService).deployment();
    for (const f of after.manifest.files) {
      expect(await store.get(`${after.object_prefix}${f.path}`)).not.toBeNull();
    }
    expect(await keysUnder(draft)).toEqual([]);
    // the org row stays linked: the skill keeps its id for every agent
    expect((await skillRow(skillId)).platform_skill_id).toBe(platformId);
  });

  it("a stale approval discards the prepared platform copy; committed files stay", async () => {
    const { agentId, platformId } = await promotedShared();
    const before = await platformVersion(platformId);
    const prefixes = await platformPrefixes(platformId);
    const conv = await createConv(env.mem, agentId);
    const out = await svc.register(actor(agentId, env.memId, conv), zipOf("notes", "V2."));
    if (out.kind !== "proposed") throw new Error("expected a proposal");
    // the agent is gone behind the request's back (no eager cancel): stale in the transaction
    await env.db
      .updateTable("agents")
      .set({ deleted_at: new Date() })
      .where("id", "=", agentId)
      .execute();
    const res = await decideHttp(env.boss, out.requestId, "approve");
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { skillChange: { status: string } }).skillChange.status).toBe(
      "cancelled",
    );
    expect(await platformVersion(platformId)).toEqual(before);
    expect(await platformPrefixes(platformId)).toEqual(prefixes);
    const store = env.k.app.get(StorageService).deployment();
    for (const f of before.manifest.files) {
      expect(await store.get(`${before.object_prefix}${f.path}`)).not.toBeNull();
    }
  });
});

describe("Platform operations", () => {
  const ctxOf = (accountId: string, agentId: string, conversationId: string): OperationContext => ({
    orgId: env.orgId,
    actorAccountId: accountId,
    agentId,
    conversationId,
    runId: null,
    signal: new AbortController().signal,
  });
  const opOf = (id: string) => {
    const o = env.k.app.get(PlatformOperations).get(id);
    if (o === null) throw new Error(`no operation ${id}`);
    return o;
  };

  it("agents.share-skill mirrors the route; personal for a member, org for an org admin", async () => {
    const op = opOf("agents.share-skill");
    expect(op).toMatchObject({
      mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/skills/:skillId/share"],
      authz: { orgAction: "agents.create" },
      confirm: "personal",
    });
    const mine = await createAgent(env.mem);
    const own = await svc.register(actor(mine, env.memId), zipOf("notes"));
    const memConv = await createConv(env.mem, mine);
    const input = op.input.parse({ agentId: mine, skillId: own.skillId });
    expect(await op.confirmFor?.(input, ctxOf(env.memId, mine, memConv))).toBe("personal");
    const boss = await createAgent(env.boss);
    const bossOwn = await svc.register(actor(boss, env.bossId), zipOf("notes2"));
    const bossConv = await createConv(env.boss, boss);
    expect(
      await op.confirmFor?.(
        op.input.parse({ agentId: boss, skillId: bossOwn.skillId }),
        ctxOf(env.bossId, boss, bossConv),
      ),
    ).toBe("org");
    // not the owner: refused before the card
    expect(await op.precheck?.(input, ctxOf(env.bossId, boss, bossConv))).toMatchObject({
      ok: false,
    });
    const r = (await op.run(input, ctxOf(env.memId, mine, memConv))) as {
      share: { kind: string };
    };
    expect(r.share.kind).toBe("requested");
  });

  it("agents.register-skill is org for an admin maintainer applying a version at once", async () => {
    const op = opOf("agents.register-skill");
    const agentId = await createAgent(env.boss);
    const own = await svc.register(actor(agentId, env.bossId), zipOf("notes"));
    const conv = await createConv(env.boss, agentId);
    const input = op.input.parse({ filePath: "/workspace/notes.zip" });
    expect(await op.confirmFor?.(input, ctxOf(env.bossId, agentId, conv))).toBe("personal");
    await svc.share(actor(agentId, env.bossId), own.skillId);
    expect(await op.confirmFor?.(input, ctxOf(env.bossId, agentId, conv))).toBe("org");
  });
});
