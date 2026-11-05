import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usableTemplates } from "../../src/agents/templates.js";
import type { PlatformUpdatePreview } from "../../src/catalog/plugin-upgrade.js";
import { usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { makeZip, SKILL_MD } from "../skills/zip.js";
import {
  auditActions,
  importPlugin,
  type OrgEnv,
  resetOrgCatalog,
  startOrgEnv,
} from "./org-env.js";
import { bundlePlugin, skillFiles } from "./packages.js";

/**
 * Plugin scope phase 2, Task 8 (spec §7.2): a platform skill or agent template updated on its own.
 * The upload keeps the plugin provenance, writes the next version flagged `updated_on_own`, serves
 * in orgs at once, and the next plugin update preview marks it.
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
});

const reviewerMd = (body: string) =>
  `---\nname: reviewer\ndescription: Reviews kit work.\n---\n${body}\n`;

async function importKit(): Promise<string> {
  return importPlugin(
    env,
    await bundlePlugin({
      name: "kit",
      version: "1.0.0",
      skills: [],
      files: {
        ...skillFiles("alpha", SKILL_MD("alpha", "Alpha things.")),
        "agents/reviewer.md": reviewerMd("Review the change."),
      },
    }),
  );
}

const skillOf = (name: string) =>
  env.db
    .selectFrom("platform_skills")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirstOrThrow();
const templateOf = (name: string) =>
  env.db
    .selectFrom("platform_agent_templates")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirstOrThrow();

/** Make the component on in every org (own scope, all). */
async function onEverywhere(table: "platform_skills" | "platform_agent_templates", id: string) {
  await env.db
    .updateTable(table)
    .set({ scope_mode: "own", scope: "all" })
    .where("id", "=", id)
    .execute();
}

const uploadSkill = (id: string, body: Buffer | string, req = env.root) =>
  req({
    method: "POST",
    url: `/api/v1/admin/components/skill/${id}/versions`,
    headers: { "content-type": "application/octet-stream" },
    payload: body,
  });

const uploadTemplate = (id: string, content: string, req = env.root) =>
  req({
    method: "POST",
    url: `/api/v1/admin/components/agent_template/${id}/versions`,
    payload: { content },
  });

const readText = async (key: string): Promise<string | null> => {
  const got = await env.k.app.get(StorageService).deployment().get(key);
  return got ? await new Response(got.body).text() : null;
};

/** Imports kit 2.0.0 (a new version of the item; platform rows are left alone) and previews it. */
async function previewV2(
  itemId: string,
  reviewer = "Review the change.",
): Promise<PlatformUpdatePreview> {
  await importPlugin(
    env,
    await bundlePlugin({
      name: "kit",
      version: "2.0.0",
      skills: [],
      files: {
        ...skillFiles("alpha", SKILL_MD("alpha", "Alpha 2.")),
        "agents/reviewer.md": reviewerMd(reviewer),
      },
    }),
  );
  const r = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
    payload: { version: "2.0.0" },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as PlatformUpdatePreview;
}

describe("a platform component updated on its own (spec §7.2)", { timeout: 120_000 }, () => {
  it("a skill zip becomes the next version: plugin kept, updated_on_own, served in orgs at once, the next update marks it", async () => {
    const item = await importKit();
    const alpha = await skillOf("alpha");
    await onEverywhere("platform_skills", alpha.id);
    const zip = makeZip([
      { name: "SKILL.md", data: SKILL_MD("alpha", "Alpha, tuned by the admin.") },
      { name: "notes.txt", data: "hello\n" },
    ]);

    const r = await uploadSkill(alpha.id, zip);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({ kind: "skill", id: alpha.id, name: "alpha", version: 2 });

    const now = await skillOf("alpha");
    expect(now).toMatchObject({
      current_version: 2,
      plugin_name: "kit",
      catalog_item_id: item,
      scope_mode: "own",
      description: "Alpha, tuned by the admin.",
    });
    const v2 = await env.db
      .selectFrom("platform_skill_versions")
      .selectAll()
      .where("skill_id", "=", alpha.id)
      .where("version", "=", 2)
      .executeTakeFirstOrThrow();
    expect(v2).toMatchObject({
      updated_on_own: true,
      catalog_version: null,
      created_by: env.rootId,
      object_prefix: `platform/skills/${alpha.id}/2/`,
    });
    expect(await readText(`${v2.object_prefix}notes.txt`)).toBe("hello\n");
    // version 1 is untouched
    const v1 = await env.db
      .selectFrom("platform_skill_versions")
      .select(["updated_on_own", "catalog_version"])
      .where("skill_id", "=", alpha.id)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    expect(v1).toEqual({ updated_on_own: false, catalog_version: "1.0.0" });
    // served in the org at once
    const usable = (await usableSkills(env.db, env.orgId)).find((s) => s.name === "alpha");
    expect(usable).toMatchObject({ id: alpha.id, version: 2, origin: "platform" });
    expect(await auditActions(env)).toContain("component.version_uploaded");

    // the next plugin update preview marks it and the confirm moves it to the plugin's version
    const p = await previewV2(item);
    expect(p.components.find((c) => c.name === "alpha")).toMatchObject({
      id: alpha.id,
      change: "upgrade",
      updatedOnOwn: true,
    });
    const c = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${item}/update`,
      payload: { version: "2.0.0", diffHash: p.diffHash },
    });
    expect(c.statusCode, c.body).toBe(200);
    const moved = await env.db
      .selectFrom("platform_skill_versions")
      .select(["version", "catalog_version", "updated_on_own"])
      .where("skill_id", "=", alpha.id)
      .orderBy("version")
      .execute();
    expect(moved.at(-1)).toEqual({ version: 3, catalog_version: "2.0.0", updated_on_own: false });
  });

  it("an agent template file becomes the next version, likewise", async () => {
    const item = await importKit();
    const reviewer = await templateOf("reviewer");
    await onEverywhere("platform_agent_templates", reviewer.id);

    const r = await uploadTemplate(reviewer.id, reviewerMd("Review it twice."));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({
      kind: "agent_template",
      id: reviewer.id,
      name: "reviewer",
      version: 2,
    });
    const now = await templateOf("reviewer");
    expect(now).toMatchObject({ current_version: 2, plugin_name: "kit", catalog_item_id: item });
    const v2 = await env.db
      .selectFrom("platform_agent_template_versions")
      .selectAll()
      .where("template_id", "=", reviewer.id)
      .where("version", "=", 2)
      .executeTakeFirstOrThrow();
    expect(v2).toMatchObject({
      updated_on_own: true,
      catalog_version: null,
      created_by: env.rootId,
    });
    expect(await readText(`${v2.object_prefix}reviewer.md`)).toContain("Review it twice.");
    const t = (await usableTemplates(env.db, env.orgId)).find((x) => x.name === "reviewer");
    expect(t).toMatchObject({ id: reviewer.id, version: 2, origin: "platform" });
    expect(t?.template.instructions).toContain("Review it twice.");

    // the next update (a 2.0.0 with the template changed again) marks it
    const p = await previewV2(item, "Review it thrice.");
    expect(
      p.components.find((c) => c.kind === "agent_template" && c.name === "reviewer"),
    ).toMatchObject({
      change: "upgrade",
      updatedOnOwn: true,
    });
  });

  it("refuses a changed name, an invalid package, a non-super-admin and an unknown component", async () => {
    await importKit();
    const alpha = await skillOf("alpha");
    const reviewer = await templateOf("reviewer");

    const renamed = await uploadSkill(
      alpha.id,
      makeZip([{ name: "SKILL.md", data: SKILL_MD("beta") }]),
    );
    expect(renamed.statusCode, renamed.body).toBe(400);
    expect(renamed.json().error.code).toBe("validation_failed");
    const bad = await uploadSkill(alpha.id, makeZip([{ name: "notes.txt", data: "x" }]));
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe("skill.invalid_package");
    const tRenamed = await uploadTemplate(
      reviewer.id,
      reviewerMd("x").replace("name: reviewer", "name: other"),
    );
    expect(tRenamed.statusCode, tRenamed.body).toBe(400);
    const tBad = await uploadTemplate(reviewer.id, "no frontmatter");
    expect(tBad.statusCode, tBad.body).toBe(400);
    const nope = await uploadTemplate("missing", reviewerMd("x"));
    expect(nope.statusCode, nope.body).toBe(404);
    expect(nope.json().error.code).toBe("component.not_found");
    const notAdmin = await uploadTemplate(reviewer.id, reviewerMd("x"), env.boss);
    expect(notAdmin.statusCode, notAdmin.body).toBe(403);
    const notAdminZip = await uploadSkill(
      alpha.id,
      makeZip([{ name: "SKILL.md", data: SKILL_MD("alpha") }]),
      env.boss,
    );
    expect([401, 403]).toContain(notAdminZip.statusCode);

    expect((await skillOf("alpha")).current_version).toBe(1);
    expect((await templateOf("reviewer")).current_version).toBe(1);
  });

  it("GET …/versions lists a component's versions newest first, with the catalog version and the updated-on-own flag", async () => {
    await importKit();
    const alpha = await skillOf("alpha");
    const reviewer = await templateOf("reviewer");
    const up = await uploadSkill(
      alpha.id,
      makeZip([{ name: "SKILL.md", data: SKILL_MD("alpha", "Alpha 1.1.") }]),
    );
    expect(up.statusCode, up.body).toBe(201);
    const versions = (kind: string, id: string, req = env.root) =>
      req({ method: "GET", url: `/api/v1/admin/components/${kind}/${id}/versions` });

    const s = await versions("skill", alpha.id);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().versions).toMatchObject([
      { version: "2", catalogVersion: null, updatedOnOwn: true },
      { version: "1", catalogVersion: "1.0.0", updatedOnOwn: false },
    ]);
    expect(typeof s.json().versions[0].createdAt).toBe("string");
    const a = await versions("agent_template", reviewer.id);
    expect(a.json().versions).toMatchObject([
      { version: "1", catalogVersion: "1.0.0", updatedOnOwn: false },
    ]);
    expect((await versions("skill", "missing")).json().error.code).toBe("component.not_found");
    expect((await versions("skill", alpha.id, env.boss)).statusCode).toBe(403);
  });
});
