import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OrgEnv, resetOrgCatalog, setDeployment, startOrgEnv } from "../catalog/org-env.js";
import type { Req } from "../helpers/runs.js";
import { makeZip, SKILL_MD } from "./zip.js";

/**
 * The agent skill package routes: the agent's owner uploads a zip onto the agent
 * (`POST /agents/:agentId/skills/uploads`, then `POST /agents/:agentId/skills { uploadId }`).
 * Real kernel, model-fake agents, SeaweedFS.
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
  await setDeployment(env, { customSkills: "allow" });
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

interface Created {
  id: string;
  upload: {
    method: "PUT" | "POST";
    url: string;
    headers: Record<string, string>;
    fields?: Record<string, string>;
  };
}

const zipOf = (name: string) =>
  new Uint8Array(makeZip([{ name: "SKILL.md", data: SKILL_MD(name) }]));

const createUpload = (req: Req, agentId: string, size: number) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents/${agentId}/skills/uploads`,
    payload: { name: "skill.zip", size },
  });

/** Registers an upload on the agent and puts the bytes to the store (not finalized). */
async function upload(req: Req, agentId: string, zip: Uint8Array): Promise<string> {
  const res = await createUpload(req, agentId, zip.byteLength);
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json() as Created;
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
  expect(put.status, await put.clone().text()).toBeLessThan(300);
  return c.id;
}

const register = (req: Req, agentId: string, uploadId: string) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents/${agentId}/skills`,
    payload: { uploadId },
  });

describe("agent skill package routes", () => {
  it("the owner uploads a package and registers it: version 1, listed on the agent", async () => {
    const agentId = await createAgent("private");
    const r = await register(env.boss, agentId, await upload(env.boss, agentId, zipOf("weekly")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      skill: { kind: "version", name: "weekly", version: 1, created: true, manualOnly: false },
    });
    const list = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/agents/${agentId}/skills`,
    });
    expect((list.json() as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual([
      "weekly",
    ]);
  });

  it("a second upload of the same name is version 2; a consumed upload is 404", async () => {
    const agentId = await createAgent("private");
    const first = await upload(env.boss, agentId, zipOf("weekly"));
    expect((await register(env.boss, agentId, first)).statusCode).toBe(200);
    const again = await register(env.boss, agentId, first);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("attachment.not_found");
    const second = await register(
      env.boss,
      agentId,
      await upload(env.boss, agentId, zipOf("weekly")),
    );
    expect(second.json()).toMatchObject({ skill: { version: 2, created: false } });
  });

  it("a member on a shared agent: 403 forbidden for the upload and the register", async () => {
    const agentId = await createAgent("org");
    const up = await createUpload(env.mem, agentId, 100);
    expect(up.statusCode, up.body).toBe(403);
    expect(up.json().error.code).toBe("forbidden");
    expect(up.json().error.message).toBe("Only the agent's owner can change its skills.");
    const reg = await register(env.mem, agentId, "00000000-0000-4000-8000-000000000000");
    expect(reg.statusCode).toBe(403);
    expect(reg.json().error.code).toBe("forbidden");
    expect(
      await env.db
        .selectFrom("attachments")
        .select("id")
        .where("account_id", "=", env.memId)
        .execute(),
    ).toEqual([]);
  });

  it("customSkills deny still allows the agent upload", async () => {
    await setDeployment(env, { customSkills: "deny" });
    const agentId = await createAgent("private");
    const r = await register(env.boss, agentId, await upload(env.boss, agentId, zipOf("denied")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ skill: { name: "denied", version: 1 } });
  });

  it("an unknown uploadId: 404 attachment.not_found", async () => {
    const agentId = await createAgent("private");
    const r = await register(env.boss, agentId, "00000000-0000-4000-8000-000000000000");
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("attachment.not_found");
  });
});
