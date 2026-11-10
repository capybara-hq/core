import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ApiError } from "../../src/errors.js";
import { AGENT_SKILLS_MAX, AgentSkillsService } from "../../src/skills/agent-skills.service.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { type OrgEnv, resetOrgCatalog, setDeployment, startOrgEnv } from "../catalog/org-env.js";
import { eventsOf, type Req } from "../helpers/runs.js";
import { makeZip, SKILL_MD } from "./zip.js";

/**
 * AgentSkillsService: an agent's owner registers a zip package as one of the agent's own skills
 * (`scope = 'agent'`) and deletes them. Real kernel, model-fake agents, SeaweedFS.
 */

let env: OrgEnv;
let svc: AgentSkillsService;

beforeAll(async () => {
  env = await startOrgEnv();
  svc = env.k.app.get(AgentSkillsService);
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await setDeployment(env, { customSkills: "allow" });
  await env.db.deleteFrom("conversation_events").execute();
  await env.db.deleteFrom("runs").execute();
  await env.db.deleteFrom("conversations").execute();
  await env.db.deleteFrom("skill_versions").execute();
  await env.db.deleteFrom("skills").execute();
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
});

async function createAgent(visibility: "private" | "org"): Promise<string> {
  const res = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name: "Writer",
        instructions: "Write skills.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function createConv(req: Req, agentId: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/conversations`,
    payload: { agentId },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

const RUN_SH = "#!/bin/sh\necho run\n";

const zipOf = (name: string, extra: { name: string; data: string }[] = [], md = SKILL_MD(name)) =>
  new Uint8Array(makeZip([{ name: "SKILL.md", data: md }, ...extra]));

const actor = (agentId: string, accountId = env.bossId, conversationId?: string) => ({
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

const version = (skillId: string, v: number) =>
  env.db
    .selectFrom("skill_versions")
    .select(["manifest", "object_prefix"])
    .where("skill_id", "=", skillId)
    .where("version", "=", v)
    .executeTakeFirstOrThrow();

type CatalogEvent = Extract<ConversationEvent, { type: "skills_catalog" }>;
const catalogs = async (convId: string) =>
  (await eventsOf(env.db, convId)).filter((e): e is CatalogEvent => e.type === "skills_catalog");

/** Uploads a zip through the web flow and returns the attachment id. */
async function upload(zip: Uint8Array): Promise<string> {
  const reg = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/skills/uploads`,
    payload: { name: "s.zip", size: zip.byteLength },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const c = reg.json() as {
    id: string;
    upload: {
      method: "PUT" | "POST";
      url: string;
      headers: Record<string, string>;
      fields?: Record<string, string>;
    };
  };
  let put: Response;
  if (c.upload.method === "PUT") {
    put = await fetch(c.upload.url, {
      method: "PUT",
      headers: c.upload.headers,
      body: Buffer.from(zip),
    });
  } else {
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
    form.append("file", new Blob([Buffer.from(zip)], { type: "application/zip" }));
    put = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  }
  expect(put.status).toBeLessThan(300);
  return c.id;
}

describe("AgentSkillsService.register", () => {
  it("registers a zip as the agent's own skill", async () => {
    const agentId = await createAgent("private");
    const out = await svc.register(
      actor(agentId),
      zipOf("notes", [{ name: "scripts/run.sh", data: RUN_SH }]),
    );
    expect(out).toMatchObject({
      kind: "version",
      name: "notes",
      version: 1,
      created: true,
      manualOnly: false,
    });
    if (out.kind !== "version") throw new Error("unreachable");
    const row = await env.db
      .selectFrom("skills")
      .select(["scope", "agent_id", "name", "current_version"])
      .where("id", "=", out.skillId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ scope: "agent", agent_id: agentId, name: "notes", current_version: 1 });
    const v = await version(out.skillId, 1);
    const got = await env.k.app
      .get(StorageService)
      .kernel(env.orgId)
      .get(`${v.object_prefix}scripts/run.sh`);
    expect(await new Response(got?.body).text()).toBe(RUN_SH);
    const actions = await env.db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("target", "=", out.skillId)
      .execute();
    expect(actions.map((a) => a.action)).toEqual(["skill.created"]);
  });

  it("same name registers a new complete version", async () => {
    const agentId = await createAgent("private");
    const first = await svc.register(
      actor(agentId),
      zipOf("notes", [{ name: "scripts/run.sh", data: RUN_SH }]),
    );
    const second = await svc.register(
      { ...actor(agentId), auditDetail: { via: "agent", operation: "test" } },
      zipOf("notes"),
    );
    expect(second).toMatchObject({
      kind: "version",
      skillId: first.skillId,
      version: 2,
      created: false,
    });
    const v2 = await version(first.skillId, 2);
    expect(v2.manifest.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("target", "=", first.skillId)
      .where("action", "=", "skill.version_created")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ via: "agent", operation: "test", version: 2 });
  });

  it.each([
    { variant: "root", prefix: "" },
    { variant: "outer folder", prefix: "parity-main/" },
  ])("parity with web upload ($variant)", async ({ prefix }) => {
    const agentId = await createAgent("private");
    const zip = new Uint8Array(
      makeZip([
        { name: `${prefix}SKILL.md`, data: SKILL_MD("parity") },
        { name: `${prefix}scripts/run.sh`, data: RUN_SH },
        { name: `${prefix}docs/a.md`, data: "# A\n" },
      ]),
    );
    const mine = await svc.register(actor(agentId), zip);
    const web = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/skills`,
      payload: { uploadId: await upload(zip) },
    });
    expect(web.statusCode, web.body).toBe(201);
    const webId = (web.json() as { skill: { id: string } }).skill.id;
    expect((await version(mine.skillId, 1)).manifest).toEqual((await version(webId, 1)).manifest);
  });

  it("non-owner is refused", async () => {
    const agentId = await createAgent("org");
    const store = env.k.app.get(StorageService).kernel(env.orgId);
    const keys = async () => (await store.list("skills/")).items.map((o) => o.key).sort();
    const before = await keys();
    expect(await codeOf(svc.register(actor(agentId, env.memId), zipOf("notes")))).toBe("forbidden");
    expect(await env.db.selectFrom("skills").select("id").execute()).toEqual([]);
    expect(await keys()).toEqual(before);
  });

  it("an agent the actor cannot see: agent.not_found", async () => {
    const agentId = await createAgent("private");
    expect(await codeOf(svc.register(actor(agentId, env.memId), zipOf("notes")))).toBe(
      "agent.not_found",
    );
  });

  it("an invalid package: skill.invalid_package", async () => {
    const agentId = await createAgent("private");
    const zip = new Uint8Array(makeZip([{ name: "README.md", data: "no skill" }]));
    expect(await codeOf(svc.register(actor(agentId), zip))).toBe("skill.invalid_package");
  });

  it("appends a catalog snapshot in the conversation", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(env.boss, agentId);
    const out = await svc.register(actor(agentId, env.bossId, conv), zipOf("notes"));
    const v = await version(out.skillId, 1);
    const last = (await catalogs(conv)).at(-1);
    expect(last?.payload.skills).toEqual([
      {
        id: out.skillId,
        name: "notes",
        description: "Work with PDFs.",
        version: 1,
        source: v.object_prefix,
      },
    ]);

    // Without a conversation: no event anywhere
    const other = await createConv(env.boss, agentId);
    await svc.register(actor(agentId), zipOf("other"));
    expect(await catalogs(other)).toEqual([]);
  });

  it("manual-only is not in the snapshot", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(env.boss, agentId);
    const md =
      "---\nname: manual\ndescription: Only by hand.\ndisable-model-invocation: true\n---\n# Manual\n";
    const out = await svc.register(actor(agentId, env.bossId, conv), zipOf("manual", [], md));
    expect(out).toMatchObject({ kind: "version", manualOnly: true });
    const last = (await catalogs(conv)).at(-1);
    expect(last?.payload.skills ?? []).toEqual([]);
  });

  it(`cap: ${AGENT_SKILLS_MAX} existing skills -> skill.agent_cap`, async () => {
    const agentId = await createAgent("private");
    await env.db
      .insertInto("skills")
      .values(
        Array.from({ length: AGENT_SKILLS_MAX }, (_, i) => ({
          id: `cap-${i}`,
          org_id: env.orgId,
          scope: "agent" as const,
          agent_id: agentId,
          name: `skill-${i}`,
          description: "d",
          current_version: 1,
          created_by: env.bossId,
        })),
      )
      .execute();
    expect(await codeOf(svc.register(actor(agentId), zipOf("one-more")))).toBe("skill.agent_cap");
  });
});

describe("AgentSkillsService.deleteAgentSkill", () => {
  it("the owner soft-deletes; a non-owner is refused", async () => {
    const agentId = await createAgent("org");
    const out = await svc.register(actor(agentId), zipOf("notes"));
    expect(await codeOf(svc.deleteAgentSkill(env.orgId, agentId, out.skillId, env.memId))).toBe(
      "forbidden",
    );
    await svc.deleteAgentSkill(env.orgId, agentId, out.skillId, env.bossId);
    const row = await env.db
      .selectFrom("skills")
      .select("deleted_at")
      .where("id", "=", out.skillId)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });
});
