import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SKILL_MD } from "../skills/zip.js";
import { install, type OrgEnv, resetOrgCatalog, seedPlugin, startOrgEnv } from "./org-env.js";

/**
 * Org install and upgrade carry a catalog version's source format and the per-skill pinned
 * suggestion onto the org skill versions (phase B, spec §9.1), and the skills API shows them.
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

async function installOk(itemId: string): Promise<string> {
  const r = await install(env.boss, env, itemId, {});
  expect(r.statusCode, r.body).toBe(201);
  return r.json().installed.pluginInstallId as string;
}

const versionsOf = () =>
  env.db
    .selectFrom("skill_versions as v")
    .innerJoin("skills as s", "s.id", "v.skill_id")
    .select(["s.name", "v.version", "v.source_format", "v.suggest_pinned"])
    .where("s.org_id", "=", env.orgId)
    .orderBy("s.name")
    .orderBy("v.version")
    .execute();

const seedSuperpowers = (o: { version?: string; addTo?: string; pinned?: string[] } = {}) =>
  seedPlugin(env, {
    name: "superpowers",
    skills: ["brainstorming", "using-superpowers"],
    templates: false,
    pinned: o.pinned ?? ["using-superpowers"],
    sourceFormat: "claude-code",
    ...(o.version !== undefined && { version: o.version }),
    ...(o.addTo !== undefined && { addTo: o.addTo }),
    // a 2.0.0 changes both skills' files, so the upgrade writes a new version of each
    ...(o.version === "2.0.0" && {
      skillScripts: { brainstorming: "print(2)\n", "using-superpowers": "print(2)\n" },
    }),
  });

describe("org skills from a Claude Code plugin", { timeout: 90_000 }, () => {
  it("org install of a claude-code version records source_format and suggest_pinned per skill version", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    expect(await versionsOf()).toEqual([
      { name: "brainstorming", version: 1, source_format: "claude-code", suggest_pinned: false },
      { name: "using-superpowers", version: 1, source_format: "claude-code", suggest_pinned: true },
    ]);
  });

  it("upgrade to a version that unticks the suggestion clears it on the new version", async () => {
    const item = await seedSuperpowers();
    const installId = await installOk(item);
    await seedSuperpowers({ version: "2.0.0", addTo: item, pinned: [] });
    const p = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade/preview`,
      payload: { version: "2.0.0" },
    });
    expect(p.statusCode, p.body).toBe(200);
    const r = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade`,
      payload: { version: "2.0.0", diffHash: p.json().diffHash },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await versionsOf()).toEqual([
      { name: "brainstorming", version: 1, source_format: "claude-code", suggest_pinned: false },
      { name: "brainstorming", version: 2, source_format: "claude-code", suggest_pinned: false },
      { name: "using-superpowers", version: 1, source_format: "claude-code", suggest_pinned: true },
      {
        name: "using-superpowers",
        version: 2,
        source_format: "claude-code",
        suggest_pinned: false,
      },
    ]);
  });

  it("GET skills returns plugin, sourceFormat, suggestPinned, entryBytes, tokenEstimate", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/skills` });
    expect(r.statusCode, r.body).toBe(200);
    const bytes = (n: string) => new TextEncoder().encode(SKILL_MD(n)).byteLength;
    expect(r.json().skills).toMatchObject([
      {
        name: "brainstorming",
        plugin: "superpowers",
        sourceFormat: "claude-code",
        suggestPinned: false,
        entryBytes: bytes("brainstorming"),
        tokenEstimate: Math.ceil(bytes("brainstorming") / 4),
      },
      {
        name: "using-superpowers",
        plugin: "superpowers",
        sourceFormat: "claude-code",
        suggestPinned: true,
        entryBytes: bytes("using-superpowers"),
        tokenEstimate: Math.ceil(bytes("using-superpowers") / 4),
      },
    ]);
  });
});
