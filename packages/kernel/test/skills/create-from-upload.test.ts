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
import { makeZip, SKILL_MD } from "./zip.js";

/**
 * `POST /orgs/:orgId/skills` takes `{ uploadId, shareable? }` only: skills enter as uploaded zip
 * packages. The text form (`{ name, description, body }`) is gone and a body with those fields is a
 * 400 `validation_failed`.
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
});

const post = (payload: Record<string, unknown>) =>
  env.boss({ method: "POST", url: `/api/v1/orgs/${env.orgId}/skills`, payload });

const upload = async (zip: Uint8Array): Promise<string> => {
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

const zipOf = (name: string) => makeZip([{ name: "SKILL.md", data: SKILL_MD(name) }]);

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
    const r = await post({ uploadId: await upload(zipOf("zipped")), shareable: true });
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
    const uploadId = await upload(zipOf("denied"));
    await setDeployment(env, { customSkills: "deny" });
    const r = await post({ uploadId });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("catalog.custom_disabled");
  });

  it("a platform skill offered to the org with that name: 409 plugin.skill_conflict", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: ["pdf-tools"], templates: false });
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const r = await post({ uploadId: await upload(zipOf("pdf-tools")) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("plugin.skill_conflict");
  });
});
