import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { PRESET_IDS } from "../../src/agents/profile.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { createOrgWithProviders, type Req } from "../helpers/runs.js";
import {
  avatarThemePlugin,
  clearThemeLevels,
  importAvatarTheme,
  setThemeScope,
  setThemeSwitch,
  writeOrgTheme,
  writeUiTheme,
} from "../themes/theme-env.js";

/**
 * Theme brand coverage spec §4: an avatar input's preset id is a built-in id (always accepted,
 * also while the theme hides it) or a theme preset key, accepted only while it is a preset of the
 * writing org's effective default theme and stored pinned to the theme version; the agent views
 * return it with its immutable URL. The random default draws from the visible built-ins and the
 * theme's presets.
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
  await clearThemeLevels(env);
  await writeUiTheme(env, null);
  await env.db.deleteFrom("conversations").execute();
  await env.db.deleteFrom("agents").execute();
});

const definition = {
  name: "Helper",
  instructions: "Be helpful.",
  model: { provider: "model-fake", model: "fake-1" },
};

interface Avatar {
  kind: string;
  id?: string;
  themeId?: string;
  version?: string;
  preset?: string;
  file?: string;
  url?: string;
}
interface AgentJson {
  id: string;
  profile: { avatar: Avatar | null; updatedAt: string };
}

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

const createReq = (req: Req, orgId: string, avatar?: Record<string, unknown> | null) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition,
      visibility: "org",
      ...(avatar !== undefined && { profile: { avatar } }),
    },
  });

async function create(
  avatar?: Record<string, unknown> | null,
  req: Req = env.mem,
  orgId = env.orgId,
): Promise<AgentJson> {
  const r = await createReq(req, orgId, avatar);
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { agent: AgentJson }).agent;
}

const patchReq = (agent: AgentJson, avatar: Record<string, unknown> | null, req: Req = env.mem) =>
  req({
    method: "PATCH",
    url: `/api/v1/orgs/${env.orgId}/agents/${agent.id}/profile`,
    payload: { avatar, expectedUpdatedAt: agent.profile.updatedAt },
  });

async function getAgent(id: string, req: Req = env.mem, orgId = env.orgId): Promise<AgentJson> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${id}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { agent: AgentJson }).agent;
}

const stored = async (id: string) =>
  (
    await env.db
      .selectFrom("agents")
      .select("profile_avatar")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).profile_avatar;

const assetUrl = (themeId: string, version: string, preset: string) =>
  `/api/v1/themes/${themeId}/${version}/assets/avatars%2F${preset}.svg`;

/** The pinned value of preset `preset` of theme `themeId` version `version`. */
const pinned = (themeId: string, preset: string, version = "1") => ({
  kind: "theme",
  themeId,
  version,
  preset,
  file: `./avatars/${preset}.svg`,
});

/** A brand theme as the org's default: presets mascot and robot-2, hides panda and capybara. */
async function brandDefault(): Promise<{ id: string; itemId: string }> {
  const t = await importAvatarTheme(env, "brand", "brand-grid", {
    presets: ["mascot", "robot-2"],
    hidden: ["panda", "capybara"],
  });
  await writeOrgTheme(env, env.orgId, { id: t.id, personal: "allowed" });
  return t;
}

describe("theme avatar presets on the write paths", () => {
  it("a theme key of the org's effective default theme is stored pinned and returned with its url", async () => {
    const { id } = await brandDefault();
    const a = await create({ kind: "preset", id: "brand/brand-grid/mascot" });
    // stored without the url: the url is derived when read
    expect(await stored(a.id)).toEqual(pinned(id, "mascot"));
    expect(a.profile.avatar).toEqual({ ...pinned(id, "mascot"), url: assetUrl(id, "1", "mascot") });
    expect((await getAgent(a.id)).profile.avatar).toEqual(a.profile.avatar);
    // PATCH …/profile takes a key too
    const r = await patchReq(a, { kind: "preset", id: "brand/brand-grid/robot-2" });
    expect(r.statusCode, r.body).toBe(200);
    expect(await stored(a.id)).toEqual(pinned(id, "robot-2"));
    expect((r.json() as { profile: { avatar: Avatar } }).profile.avatar).toEqual({
      ...pinned(id, "robot-2"),
      url: assetUrl(id, "1", "robot-2"),
    });
    // the platform default applies while the org follows it
    await writeOrgTheme(env, env.orgId, { id: null, personal: "allowed" });
    await writeUiTheme(env, id);
    const b = await create({ kind: "preset", id: "brand/brand-grid/mascot" });
    expect(await stored(b.id)).toEqual(pinned(id, "mascot"));
  });

  it("a theme key of a theme that is not the org's default is 400 agent.avatar_unavailable", async () => {
    await brandDefault();
    // on in the org, but not its default
    await importAvatarTheme(env, "other", "other-paper", { presets: ["mascot"] });
    const r = await createReq(env.mem, env.orgId, {
      kind: "preset",
      id: "other/other-paper/mascot",
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(errCode(r)).toBe("agent.avatar_unavailable");
    expect((r.json() as { error: { message: string } }).error.message).toMatch(
      /choose one of the presets the picker shows/,
    );
    // a key-shaped id the default theme does not have
    const unknown = await createReq(env.mem, env.orgId, {
      kind: "preset",
      id: "brand/brand-grid/ghost",
    });
    expect(errCode(unknown)).toBe("agent.avatar_unavailable");
    const a = await create({ kind: "preset", id: "owl" });
    const p = await patchReq(a, { kind: "preset", id: "other/other-paper/mascot" });
    expect(p.statusCode, p.body).toBe(400);
    expect(errCode(p)).toBe("agent.avatar_unavailable");
    expect(await stored(a.id)).toEqual({ kind: "preset", id: "owl" });
    // no default theme at all: no key is available
    await writeOrgTheme(env, env.orgId, { id: null, personal: "allowed" });
    expect(
      errCode(
        await createReq(env.mem, env.orgId, { kind: "preset", id: "brand/brand-grid/mascot" }),
      ),
    ).toBe("agent.avatar_unavailable");
  });

  it("a theme key of another org's org-owned theme is 400", async () => {
    // org B owns a theme that is on only in B and is B's default
    const orgB = await createOrgWithProviders(env.k, env.root, "Theme owner");
    const { id, itemId } = await importAvatarTheme(env, "secret", "secret-brand", {
      presets: ["mascot"],
    });
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: orgB, shareable: false })
      .where("id", "=", itemId)
      .execute();
    await setThemeScope(env, id, "optional");
    await setThemeSwitch(env, orgB, id, true);
    await writeOrgTheme(env, orgB, { id, personal: "allowed" });
    const key = { kind: "preset", id: "secret/secret-brand/mascot" };
    // the key is a real preset where it belongs
    const inB = await create(key, env.root, orgB);
    expect(await stored(inB.id)).toEqual(pinned(id, "mascot"));
    // org A guesses it: refused on create and on PATCH
    const r = await createReq(env.mem, env.orgId, key);
    expect(r.statusCode, r.body).toBe(400);
    expect(errCode(r)).toBe("agent.avatar_unavailable");
    const a = await create({ kind: "preset", id: "owl" });
    expect(errCode(await patchReq(a, key))).toBe("agent.avatar_unavailable");
    // even with A's setting naming B's theme (as data only): it is not on in A, so no presets
    await writeOrgTheme(env, env.orgId, { id, personal: "allowed" });
    expect(errCode(await createReq(env.mem, env.orgId, key))).toBe("agent.avatar_unavailable");
    expect(await stored(a.id)).toEqual({ kind: "preset", id: "owl" });
  });

  it("a built-in id is accepted while the theme hides it", async () => {
    await brandDefault();
    const a = await create({ kind: "preset", id: "panda" });
    expect(a.profile.avatar).toEqual({ kind: "preset", id: "panda" });
    const r = await patchReq(a, { kind: "preset", id: "capybara" });
    expect(r.statusCode, r.body).toBe(200);
    expect(await stored(a.id)).toEqual({ kind: "preset", id: "capybara" });
  });

  it("a pinned avatar is still served after the theme updates to a new version and after it leaves the org", async () => {
    const { id, itemId } = await brandDefault();
    const a = await create({ kind: "preset", id: "brand/brand-grid/mascot" });
    const url = assetUrl(id, "1", "mascot");
    expect((await env.mem({ method: "GET", url })).statusCode).toBe(200);
    // version 2 changes the preset's bytes: a new theme version
    const imported = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(
        await avatarThemePlugin("brand", "brand-grid", {
          presets: ["mascot", "robot-2"],
          hidden: ["panda", "capybara"],
          version: "2.0.0",
          fill: "#fff",
        }),
      ),
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const confirmed = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${imported.json().stagingId}/confirm`,
      payload: { reviewHash: imported.json().review.reviewHash },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const p = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version: "2.0.0" },
    });
    expect(p.statusCode, p.body).toBe(200);
    const u = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/update`,
      payload: { version: "2.0.0", diffHash: p.json().diffHash },
    });
    expect(u.statusCode, u.body).toBe(200);
    const theme = await env.db
      .selectFrom("platform_themes")
      .select("current_version")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(String(theme.current_version)).toBe("2");
    // the agent keeps version 1, which is still served
    expect((await getAgent(a.id)).profile.avatar).toEqual({ ...pinned(id, "mascot"), url });
    expect((await env.mem({ method: "GET", url })).statusCode).toBe(200);
    // a new pick pins version 2
    const b = await create({ kind: "preset", id: "brand/brand-grid/mascot" });
    expect(await stored(b.id)).toEqual(pinned(id, "mascot", "2"));
    // the theme leaves the org: the stored avatar stays and is still served
    await setThemeScope(env, id, "optional");
    await setThemeSwitch(env, env.orgId, id, false);
    expect((await getAgent(a.id)).profile.avatar).toEqual({ ...pinned(id, "mascot"), url });
    expect((await env.mem({ method: "GET", url })).statusCode).toBe(200);
    // and a new pick of it is refused
    expect(
      errCode(
        await createReq(env.mem, env.orgId, { kind: "preset", id: "brand/brand-grid/mascot" }),
      ),
    ).toBe("agent.avatar_unavailable");
  });
});

describe("the random default avatar", () => {
  it("random default never picks a hidden preset", async () => {
    const { id } = await importAvatarTheme(env, "brand", "brand-grid", {
      presets: ["mascot"],
      hidden: PRESET_IDS.filter((p) => p !== "owl"),
    });
    await writeOrgTheme(env, env.orgId, { id, personal: "allowed" });
    const allowed = [{ kind: "preset", id: "owl" }, pinned(id, "mascot")];
    for (let i = 0; i < 50; i++) {
      const a = await create();
      expect(allowed).toContainEqual(await stored(a.id));
    }
    // an explicit null on create is the random default too
    const n = await create(null);
    expect(allowed).toContainEqual(await stored(n.id));
  });

  it("random default is null when nothing is visible", async () => {
    // a theme hides every built-in; its row without provenance offers none of its presets
    const { id } = await importAvatarTheme(env, "bare", "bare-grid", {
      presets: ["mascot"],
      hidden: [...PRESET_IDS],
    });
    await env.db
      .updateTable("platform_themes")
      .set({ plugin_name: null })
      .where("id", "=", id)
      .execute();
    await writeOrgTheme(env, env.orgId, { id, personal: "allowed" });
    const a = await create();
    expect(a.profile.avatar).toBeNull();
    expect(await stored(a.id)).toBeNull();
    expect(await env.k.app.get(AgentsService).randomAvatar(env.orgId)).toBeNull();
  });

  it("without a default theme the random default is a built-in", async () => {
    const a = await create();
    expect(a.profile.avatar?.kind).toBe("preset");
    expect(PRESET_IDS).toContain(a.profile.avatar?.id);
  });
});

describe("theme avatars in the views", () => {
  it("GET agents/:id/avatar redirects to the pinned URL for a theme avatar", async () => {
    const { id } = await brandDefault();
    const a = await create({ kind: "preset", id: "brand/brand-grid/mascot" });
    const r = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/agents/${a.id}/avatar`,
    });
    expect(r.statusCode, r.body).toBe(302);
    expect(r.headers.location).toBe(assetUrl(id, "1", "mascot"));
    // a built-in preset still has no image
    const b = await create({ kind: "preset", id: "owl" });
    const none = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/agents/${b.id}/avatar`,
    });
    expect(none.statusCode).toBe(404);
  });

  it("the admin listing and the conversation list carry url for a theme avatar", async () => {
    const { id } = await brandDefault();
    const a = await create({ kind: "preset", id: "brand/brand-grid/mascot" });
    const view = { ...pinned(id, "mascot"), url: assetUrl(id, "1", "mascot") };
    // the super admin's listing and detail
    const list = await env.root({ method: "GET", url: "/api/v1/admin/agents" });
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json() as { agents: { id: string; avatar: unknown }[] }).agents.find(
      (x) => x.id === a.id,
    );
    expect(row?.avatar).toEqual(view);
    const detail = await env.root({ method: "GET", url: `/api/v1/admin/agents/${a.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as { agent: { avatar: unknown } }).agent.avatar).toEqual(view);
    // the agents list
    const agents = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/agents` });
    expect(
      (agents.json() as { agents: AgentJson[] }).agents.find((x) => x.id === a.id)?.profile.avatar,
    ).toEqual(view);
    // the sidebar's conversation groups
    await env.db
      .insertInto("conversations")
      .values({
        id: randomUUID(),
        org_id: env.orgId,
        agent_id: a.id,
        account_id: env.memId,
        source: "web",
      })
      .execute();
    const groups = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/conversations/groups`,
    });
    expect(groups.statusCode, groups.body).toBe(200);
    const g = (
      groups.json() as { groups: { agent: { id: string; profile: { avatar: unknown } } }[] }
    ).groups.find((x) => x.agent.id === a.id);
    expect(g?.agent.profile.avatar).toEqual(view);
  });
});
