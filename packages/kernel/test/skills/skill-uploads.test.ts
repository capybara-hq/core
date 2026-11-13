import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usableSkills } from "../../src/skills/usable.js";
import {
  install,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setDeployment,
  startOrgEnv,
} from "../catalog/org-env.js";
import type { Req } from "../helpers/runs.js";
import { makeZip, SKILL_MD } from "./zip.js";

/**
 * Skills enter as uploaded zip packages, at org level and on an agent.
 *
 * `POST /orgs/:orgId/skills` takes `{ uploadId, shareable? }` only: the text form
 * (`{ name, description, body }`) is gone and a body with those fields is a 400
 * `validation_failed`. The agent routes let the agent's owner upload a zip onto the agent
 * (`POST /agents/:agentId/skills/uploads`, then `POST /agents/:agentId/skills { uploadId }`).
 * Real kernel, model-fake agents, SeaweedFS.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
});

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

const post = (payload: Record<string, unknown>) =>
  env.boss({ method: "POST", url: `/api/v1/orgs/${env.orgId}/skills`, payload });

const orgUpload = async (zip: Uint8Array): Promise<string> => {
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
};

const zipOf = (name: string) =>
  new Uint8Array(makeZip([{ name: "SKILL.md", data: SKILL_MD(name) }]));

describe("create a skill from an upload", () => {
  it.each([
    { name: "notes", description: "Take notes.", body: "# Notes" },
    { uploadId: "x", name: "notes" },
    { shareable: true },
    {},
  ])("a text or empty body is 400 validation_failed: %j", async (payload) => {
    const r = await post(payload);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
    expect(await env.db.selectFrom("skills").select("id").execute()).toEqual([]);
  });

  it("creates a skill from an uploaded package; shareable is stored", async () => {
    const r = await post({ uploadId: await orgUpload(zipOf("zipped")), shareable: true });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ skill: { name: "zipped" }, version: 1, created: true });
    const row = await env.db
      .selectFrom("skills")
      .select("shareable")
      .where("id", "=", r.json().skill.id)
      .executeTakeFirstOrThrow();
    expect(row.shareable).toBe(true);
    expect((await usableSkills(env.db, env.orgId)).map((s) => s.name)).toContain("zipped");
  });

  it("customSkills deny: 403 catalog.custom_disabled", async () => {
    const uploadId = await orgUpload(zipOf("denied"));
    await setDeployment(env, { customSkills: "deny" });
    const r = await post({ uploadId });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("catalog.custom_disabled");
  });

  it("a platform skill offered to the org with that name: 409 plugin.skill_conflict", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: ["pdf-tools"], templates: false });
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const r = await post({ uploadId: await orgUpload(zipOf("pdf-tools")) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("plugin.skill_conflict");
  });
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
