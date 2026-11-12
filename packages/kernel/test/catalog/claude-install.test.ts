import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { install, type OrgEnv, resetOrgCatalog, seedPlugin, startOrgEnv } from "./org-env.js";

/**
 * Platform skills carry a catalog version's source format and the per-skill pinned suggestion
 * (phase B, spec §9.1), also through a platform plugin update, and the skills API shows them.
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

/** Installs the plugin in the org. */
async function installOk(itemId: string): Promise<string> {
  const r = await install(env.boss, env, itemId, {});
  expect(r.statusCode, r.body).toBe(201);
  return r.json().installed.pluginInstallId as string;
}

/** The platform skill versions. */
const versionsOf = () =>
  env.db
    .selectFrom("platform_skill_versions as v")
    .innerJoin("platform_skills as s", "s.id", "v.skill_id")
    .select(["s.name", "v.version", "v.source_format", "v.suggest_pinned"])
    .orderBy("s.name")
    .orderBy("v.version")
    .execute();

/** Previews and confirms the platform update to `version`; returns the skill changes. */
async function updateTo(itemId: string, version: string): Promise<string[]> {
  const p = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
    payload: { version },
  });
  expect(p.statusCode, p.body).toBe(200);
  const r = await env.root({
    method: "PUT",
    url: `/api/v1/admin/catalog/items/${itemId}/update`,
    payload: { version, diffHash: p.json().diffHash },
  });
  expect(r.statusCode, r.body).toBe(200);
  return (p.json().components as { kind: string; change: string }[])
    .filter((c) => c.kind === "skill")
    .map((c) => c.change);
}

const seedSuperpowers = (o: { version?: string; addTo?: string; legacyPinned?: string[] } = {}) =>
  seedPlugin(env, {
    name: "superpowers",
    skills: ["brainstorming", "using-superpowers"],
    templates: false,
    legacyPinned: o.legacyPinned ?? ["using-superpowers"],
    sourceFormat: "claude-code",
    ...(o.version !== undefined && { version: o.version }),
    ...(o.addTo !== undefined && { addTo: o.addTo }),
    // a 2.0.0 changes both skills' files, so the upgrade writes a new version of each
    ...(o.version === "2.0.0" && {
      skillScripts: { brainstorming: "print(2)\n", "using-superpowers": "print(2)\n" },
    }),
  });

describe("org skills from a Claude Code plugin", { timeout: 90_000 }, () => {
  it("the org catalog view carries the latest version's source format", async () => {
    const item = await seedSuperpowers();
    const r = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
    expect(r.statusCode, r.body).toBe(200);
    const view = (r.json().items as { id: string; sourceFormat: string }[]).find(
      (i) => i.id === item,
    );
    expect(view?.sourceFormat).toBe("claude-code");
  });

  it("a claude-code version's platform skills record source_format; a stored pinned flag suggests nothing", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    // suggest_pinned stays in the table but nothing writes it any more (skills default-on)
    expect(await versionsOf()).toEqual([
      { name: "brainstorming", version: 1, source_format: "claude-code", suggest_pinned: false },
      {
        name: "using-superpowers",
        version: 1,
        source_format: "claude-code",
        suggest_pinned: false,
      },
    ]);
  });

  it("an update that only moves the stored pinned flag changes nothing", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    // 1.1.0: the same files, the old flag moved to brainstorming
    await seedSuperpowers({ version: "1.1.0", addTo: item, legacyPinned: ["brainstorming"] });
    expect(await updateTo(item, "1.1.0")).toEqual(["same", "same"]);
    expect(await versionsOf()).toEqual([
      { name: "brainstorming", version: 1, source_format: "claude-code", suggest_pinned: false },
      {
        name: "using-superpowers",
        version: 1,
        source_format: "claude-code",
        suggest_pinned: false,
      },
    ]);
  });

  it("an update to new files writes new versions, none with a pinned suggestion", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    await seedSuperpowers({ version: "2.0.0", addTo: item });
    expect(await updateTo(item, "2.0.0")).toEqual(["upgrade", "upgrade"]);
    expect((await versionsOf()).map((v) => [v.name, v.version, v.suggest_pinned])).toEqual([
      ["brainstorming", 1, false],
      ["brainstorming", 2, false],
      ["using-superpowers", 1, false],
      ["using-superpowers", 2, false],
    ]);
  });

  it("GET skills returns plugin, sourceFormat and builtin, and no pinning fields", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/skills` });
    expect(r.statusCode, r.body).toBe(200);
    const skills = r.json().skills as Record<string, unknown>[];
    expect(skills).toMatchObject([
      { name: "brainstorming", plugin: "superpowers", sourceFormat: "claude-code", builtin: false },
      {
        name: "using-superpowers",
        plugin: "superpowers",
        sourceFormat: "claude-code",
        builtin: false,
      },
    ]);
    for (const s of skills) {
      expect(s).not.toHaveProperty("suggestPinned");
      expect(s).not.toHaveProperty("entryBytes");
      expect(s).not.toHaveProperty("tokenEstimate");
    }
  });
});
