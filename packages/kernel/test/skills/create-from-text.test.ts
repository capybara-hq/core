import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SkillsService } from "../../src/skills/skills.service.js";
import { usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
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
 * Plugin scope phase 3, Task 10 (spec §14, P3-24, P3-6): `POST /orgs/:orgId/skills` also takes
 * `{ name, description, body, shareable? }` and builds the skill from text, through the same checks
 * as an upload (custom policy, rule 10 name clash with offered platform skills). A live org skill of
 * that name is `skill.name_exists`.
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

const text = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: "Summarise a document.",
  body: "# Steps\n\n1. Read it.\n2. Summarise.",
  ...over,
});

describe("create a skill from text", () => {
  it("creates a skill from text; version 1 round-trips and the org can use it", async () => {
    const r = await post(text("summariser"));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      skill: { name: "summariser", description: "Summarise a document.", currentVersion: 1 },
      version: 1,
      created: true,
    });
    const v = await env.db
      .selectFrom("skill_versions")
      .select("object_prefix")
      .where("skill_id", "=", r.json().skill.id)
      .executeTakeFirstOrThrow();
    const md = await env.k.app
      .get(StorageService)
      .kernel(env.orgId)
      .get(`${v.object_prefix}SKILL.md`);
    const src = await new Response(md?.body).text();
    expect(src).toContain("name: summariser");
    expect(src).toContain("description: Summarise a document.");
    expect(src).toContain("# Steps\n\n1. Read it.\n2. Summarise.");
    expect((await usableSkills(env.db, env.orgId)).map((s) => s.name)).toContain("summariser");
  });

  it("a description with a colon stays valid YAML", async () => {
    const r = await post(text("colon", { description: "Use when: the user says #1 - ok" }));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().skill.description).toBe("Use when: the user says #1 - ok");
  });

  it("customSkills deny: 403 catalog.custom_disabled", async () => {
    await setDeployment(env, { customSkills: "deny" });
    const r = await post(text("denied"));
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("catalog.custom_disabled");
  });

  it("a platform skill offered to the org with that name: 409 plugin.skill_conflict", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: ["pdf-tools"], templates: false });
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const r = await post(text("pdf-tools"));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("plugin.skill_conflict");
  });

  it("a live org skill of that name: skill.name_exists, nothing changed", async () => {
    expect((await post(text("dup"))).statusCode).toBe(201);
    await expect(
      env.k.app.get(SkillsService).createFromText(env.orgId, env.bossId, {
        ...text("dup", { description: "Other." }),
      } as never),
    ).rejects.toMatchObject({ code: "skill.name_exists" });
    const row = await env.db
      .selectFrom("skills")
      .select(["current_version", "description"])
      .where("name", "=", "dup")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ current_version: 1, description: "Summarise a document." });
  });

  it("an invalid name: 400 validation_failed", async () => {
    for (const name of ["Bad Name", "-x", "a--b", ""]) {
      const r = await post(text(name));
      expect(r.statusCode, name).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
  });

  it("shareable: true is stored (text and upload)", async () => {
    const r = await post(text("shared-one", { shareable: true }));
    expect(r.statusCode, r.body).toBe(201);
    const row = await env.db
      .selectFrom("skills")
      .select("shareable")
      .where("id", "=", r.json().skill.id)
      .executeTakeFirstOrThrow();
    expect(row.shareable).toBe(true);
    const plain = await post(text("plain-one"));
    const p = await env.db
      .selectFrom("skills")
      .select("shareable")
      .where("id", "=", plain.json().skill.id)
      .executeTakeFirstOrThrow();
    expect(p.shareable).toBe(false);
  });

  it("the upload form still works, with shareable", async () => {
    const zip = makeZip([{ name: "SKILL.md", data: SKILL_MD("zipped") }]);
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
    const r = await post({ uploadId: c.id, shareable: true });
    expect(r.statusCode, r.body).toBe(201);
    const row = await env.db
      .selectFrom("skills")
      .select("shareable")
      .where("id", "=", r.json().skill.id)
      .executeTakeFirstOrThrow();
    expect(row.shareable).toBe(true);
  });
});
