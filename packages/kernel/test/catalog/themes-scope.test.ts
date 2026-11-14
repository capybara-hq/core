import { createHash } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { conflictsError } from "../../src/catalog/catalog-scope.service.js";
import { PlatformPluginUpdater } from "../../src/catalog/plugin-upgrade.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  importPlugin,
  importSkill,
  type OrgEnv,
  resetOrgCatalog,
  setScope,
  startOrgEnv,
} from "./org-env.js";

/**
 * Themes spec §6-§7 (plan Task 7): themes are components with scope, org switches and previews;
 * theme ids are unique in an org's usable set (rule 10); a change that takes a theme away lists the
 * orgs whose default it is and how many people picked it; and every change that would take the
 * platform default theme (`uiTheme`) away from any org is refused with `theme.platform_default`.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const FONT = enc("wOF2");

const themeJson = () =>
  JSON.stringify({
    name: { en: "Neon Grid", zh: "霓虹网格" },
    schemes: {
      dark: {
        color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" },
      },
    },
    fonts: [
      { family: "Fixture", file: "./fonts/Fixture-Regular.woff2", weight: 400, role: "prose" },
    ],
  });

const themePlugin = (
  name: string,
  o: { version?: string; themeId?: string; noTheme?: boolean; skill?: string } = {},
) =>
  pluginTgz({
    manifest: { name, ...(o.version !== undefined && { version: o.version }) },
    files: {
      ...(o.noTheme !== true && {
        [`themes/${o.themeId ?? "neon-grid"}.json`]: themeJson(),
        "fonts/Fixture-Regular.woff2": FONT,
      }),
      ...(o.skill !== undefined && { [`skills/${o.skill}/SKILL.md`]: SKILL_MD(o.skill) }),
    },
  });

describe("themes: scope, switches, previews and the platform default", () => {
  let env: OrgEnv;

  beforeAll(async () => {
    env = await startOrgEnv();
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await resetOrgCatalog(env);
    await env.db.updateTable("accounts").set({ theme: null }).execute();
    await env.db
      .updateTable("orgs")
      .set({ settings: sql`settings - 'theme'` as unknown as string })
      .execute();
  });

  const themeOf = (itemId: string) =>
    env.db
      .selectFrom("platform_themes")
      .selectAll()
      .where("catalog_item_id", "=", itemId)
      .executeTakeFirstOrThrow();

  const setUiTheme = (id: string) =>
    env.db
      .insertInto("deployment_settings")
      .values({ key: "uiTheme", value: JSON.stringify({ id }) })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify({ id }) }))
      .execute();

  const previewComponent = async (id: string, body: Record<string, unknown>) => {
    const r = await env.root({
      method: "POST",
      url: `/api/v1/admin/components/theme/${id}/scope/preview`,
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as {
      affected: { orgId: string }[];
      conflicts: { orgId: string; name: string; skills: string[]; themes?: string[] }[];
      themes?: {
        id: string;
        orgDefaults: { orgId: string; orgName: string }[];
        pickedBy: number;
      }[];
      scopeHash: string;
    };
  };

  /** Previews then confirms a theme's own scope (or `follow`); returns the confirm's response. */
  const scopeTheme = async (id: string, body: Record<string, unknown>) => {
    const p = await previewComponent(id, body);
    return env.root({
      method: "PUT",
      url: `/api/v1/admin/components/theme/${id}/scope`,
      payload: { ...body, scopeHash: p.scopeHash },
    });
  };

  const previewItem = async (itemId: string, body: Record<string, unknown>) => {
    const r = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/scope/preview`,
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { themes?: unknown; scopeHash: string };
  };

  /** A theme plugin whose theme has its own scope `all` (on in every org without an install). */
  const allTheme = async (name: string, themeId?: string) => {
    const itemId = await importPlugin(
      env,
      await themePlugin(name, themeId !== undefined ? { themeId } : {}),
    );
    const t = await themeOf(itemId);
    const r = await scopeTheme(t.id, { scope: "all" });
    expect(r.statusCode, r.body).toBe(200);
    return { itemId, theme: t };
  };

  const switchTheme = (id: string, body: Record<string, unknown>) =>
    env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/components/theme/${id}/switch`,
      payload: body,
    });

  it("the admin component list has themes", async () => {
    const itemId = await importPlugin(env, await themePlugin("neon"));
    const t = await themeOf(itemId);
    const r = await env.root({ method: "GET", url: "/api/v1/admin/components?kind=theme" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().components).toEqual([
      expect.objectContaining({
        kind: "theme",
        id: t.id,
        name: "neon-grid",
        plugin: "neon",
        itemId,
        scopeMode: "follow",
        // its name and swatches from the current definition (the admin pickers)
        theme: {
          name: expect.objectContaining({ en: expect.any(String) }),
          swatches: expect.objectContaining({
            dark: expect.objectContaining({ bg: expect.any(String) }),
          }),
        },
      }),
    ]);
  });

  it("an org admin switches a theme off for the org", async () => {
    const { theme } = await allTheme("neon");
    // the org's default, and one member picked it: the preview says so (themes spec §6)
    const set = await env.boss({
      method: "PATCH",
      url: `/api/v1/orgs/${env.orgId}/settings`,
      payload: { theme: { id: theme.id, personal: "allowed" } },
    });
    expect(set.statusCode, set.body).toBe(200);
    await env.db
      .updateTable("accounts")
      .set({ theme: theme.id })
      .where("id", "=", env.memId)
      .execute();
    const first = await switchTheme(theme.id, { enabled: false });
    expect(first.statusCode, first.body).toBe(200);
    const { confirm, preview } = first.json() as {
      confirm: string;
      preview: { themes?: { id: string; orgDefaults: { orgId: string }[]; pickedBy: number }[] };
    };
    expect(preview.themes).toEqual([
      { id: theme.id, orgDefaults: [expect.objectContaining({ orgId: env.orgId })], pickedBy: 1 },
    ]);
    const r = await switchTheme(theme.id, { enabled: false, confirm });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().component).toMatchObject({ kind: "theme", id: theme.id, on: false });
    const list = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/components?kind=theme`,
    });
    expect(list.json().components).toEqual([
      expect.objectContaining({ id: theme.id, on: false, switch: false }),
    ]);
  });

  describe("theme ids are unique in an org's usable set", () => {
    it("switching a theme on is refused while another theme with its id is on", async () => {
      const a = await allTheme("neon");
      const bItem = await importPlugin(env, await themePlugin("glow"));
      const b = await themeOf(bItem);
      expect((await scopeTheme(b.id, { scope: "optional" })).statusCode).toBe(200);
      const r = await switchTheme(b.id, { enabled: true });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe("theme.id_taken");
      expect(r.json().error.details).toEqual([
        { theme: "neon-grid", orgId: env.orgId, themes: [a.theme.id], plugins: ["neon"] },
      ]);
    });

    it("a scope change that turns it on next to a theme with its id is refused", async () => {
      const a = await allTheme("neon");
      const bItem = await importPlugin(env, await themePlugin("glow"));
      const b = await themeOf(bItem);
      const p = await previewComponent(b.id, { scope: "all" });
      expect(p.conflicts).toEqual([
        expect.objectContaining({
          orgId: env.orgId,
          name: "neon-grid",
          skills: [],
          themes: [a.theme.id],
        }),
      ]);
      const r = await env.root({
        method: "PUT",
        url: `/api/v1/admin/components/theme/${b.id}/scope`,
        payload: { scope: "all", scopeHash: p.scopeHash },
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe("theme.id_taken");
    });

    it("installing a plugin whose theme id is taken in the org is refused", async () => {
      await allTheme("neon");
      const bItem = await importPlugin(env, await themePlugin("glow"));
      await setScope(env, bItem, "optional");
      const r = await env.boss({
        method: "POST",
        url: `/api/v1/orgs/${env.orgId}/catalog/${bItem}/install`,
        payload: {},
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe("theme.id_taken");
    });
  });

  describe("previews list who loses a theme", () => {
    it("a theme scope preview lists the orgs whose default it is and the people who picked it", async () => {
      const { theme } = await allTheme("neon");
      await env.db
        .updateTable("orgs")
        .set({
          settings:
            sql`jsonb_set(settings, '{theme}', ${JSON.stringify({ id: theme.id, personal: "allowed" })}::jsonb)` as unknown as string,
        })
        .where("id", "=", env.orgId)
        .execute();
      await env.db
        .updateTable("accounts")
        .set({ theme: theme.id })
        .where("id", "in", [env.bossId, env.memId])
        .execute();
      const org = await env.db
        .selectFrom("orgs")
        .select("name")
        .where("id", "=", env.orgId)
        .executeTakeFirstOrThrow();
      const p = await previewComponent(theme.id, { scope: "named", orgs: [] });
      expect(p.affected.map((a) => a.orgId)).toContain(env.orgId);
      expect(p.themes).toEqual([
        { id: theme.id, orgDefaults: [{ orgId: env.orgId, orgName: org.name }], pickedBy: 2 },
      ]);
      // a preview that takes nothing away has no themes block
      const keep = await previewComponent(theme.id, { scope: "all" });
      expect(keep.themes).toBeUndefined();
    });

    it("a plugin scope preview lists its themes that orgs lose", async () => {
      const { itemId, theme } = await allTheme("neon");
      await env.db
        .updateTable("accounts")
        .set({ theme: theme.id })
        .where("id", "=", env.memId)
        .execute();
      const p = await previewItem(itemId, { scope: "named", orgs: [] });
      expect(p.themes).toEqual([{ id: theme.id, orgDefaults: [], pickedBy: 1 }]);
    });

    it("an update that removes a theme lists it", async () => {
      const { itemId, theme } = await allTheme("neon");
      await importPlugin(
        env,
        await themePlugin("neon", { version: "2.0.0", noTheme: true, skill: "notes" }),
      );
      const r = await env.root({
        method: "POST",
        url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
        payload: { version: "2.0.0" },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().themes).toEqual([{ id: theme.id, orgDefaults: [], pickedBy: 0 }]);
    });

    it("an owner's update preview names the orgs whose default a removed theme is, and counts only its own people", async () => {
      const { itemId, theme } = await allTheme("neon");
      // version 2 drops the theme (imported before org B owns the name)
      await importPlugin(
        env,
        await themePlugin("neon", { version: "2.0.0", noTheme: true, skill: "notes" }),
      );
      // org B owns the shared plugin; org A has the theme as its default and its member picked it
      const orgB = await createOrg(env.root, "Theme owner");
      await env.db
        .updateTable("catalog_items")
        .set({ owner_org_id: orgB, shareable: true })
        .where("id", "=", itemId)
        .execute();
      await env.db
        .updateTable("orgs")
        .set({
          settings:
            sql`jsonb_set(settings, '{theme}', ${JSON.stringify({ id: theme.id, personal: "allowed" })}::jsonb)` as unknown as string,
        })
        .where("id", "=", env.orgId)
        .execute();
      await env.db
        .updateTable("accounts")
        .set({ theme: theme.id })
        .where("id", "=", env.memId)
        .execute();
      const org = await env.db
        .selectFrom("orgs")
        .select("name")
        .where("id", "=", env.orgId)
        .executeTakeFirstOrThrow();
      const updater = env.k.app.get(PlatformPluginUpdater);
      const owner = await updater.previewForOwner(orgB, itemId, "2.0.0");
      // the member of A is no member of B: B is told of nobody's pick
      expect(owner.themes).toEqual([
        { id: theme.id, orgDefaults: [{ orgId: env.orgId, orgName: org.name }], pickedBy: 0 },
      ]);
      expect(owner.orgNames?.[env.orgId]).toBe(org.name);
      // the super admin's preview counts everyone, and both hash alike (display-only narrowing)
      const admin = await updater.preview(itemId, "2.0.0");
      expect(admin.themes).toEqual([
        { id: theme.id, orgDefaults: [{ orgId: env.orgId, orgName: org.name }], pickedBy: 1 },
      ]);
      expect(owner.diffHash).toBe(admin.diffHash);
    });

    it("an org's plugin switch-off preview lists the themes it takes away there", async () => {
      const itemId = await importPlugin(env, await themePlugin("neon"));
      await setScope(env, itemId, "optional");
      const inst = await env.boss({
        method: "POST",
        url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/install`,
        payload: {},
      });
      expect(inst.statusCode, inst.body).toBe(201);
      const theme = await themeOf(itemId);
      await env.db
        .updateTable("accounts")
        .set({ theme: theme.id })
        .where("id", "=", env.memId)
        .execute();
      const r = await env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
        payload: { enabled: false },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().preview.themes).toEqual([{ id: theme.id, orgDefaults: [], pickedBy: 1 }]);
    });

    it("previews without themes keep their hashes", async () => {
      const itemId = await importSkill(env);
      const skill = await env.db
        .selectFrom("platform_skills")
        .select("id")
        .where("catalog_item_id", "=", itemId)
        .executeTakeFirstOrThrow();
      const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
      const c = await env.root({
        method: "POST",
        url: `/api/v1/admin/components/skill/${skill.id}/scope/preview`,
        payload: { scope: "named", orgs: [] },
      });
      expect(c.json()).not.toHaveProperty("themes");
      expect(c.json().scopeHash).toBe(
        sha({
          component: { kind: "skill", id: skill.id },
          target: { scopeMode: "own", scope: "named", orgs: [], disabled: false },
          affected: [],
          conflicts: [],
        }),
      );
      const p = await previewItem(itemId, { scope: "named", orgs: [] });
      expect(p).not.toHaveProperty("themes");
      expect(p.scopeHash).toBe(
        sha({
          target: { scope: "named", orgs: [], disabled: false, scopeChange: true },
          affected: [],
          needsConfig: [],
          replaced: [],
          conflicts: [],
        }),
      );
    });
  });

  describe("the platform default theme cannot be taken away", () => {
    const refused = (r: { statusCode: number; body: string; json(): unknown }, id: string) => {
      expect(r.statusCode, r.body).toBe(409);
      expect((r.json() as { error: unknown }).error).toMatchObject({
        code: "theme.platform_default",
        details: [{ theme: id, setting: "uiTheme" }],
      });
    };

    it("its own scope narrowed to optional", async () => {
      const { theme } = await allTheme("neon");
      await setUiTheme(theme.id);
      refused(await scopeTheme(theme.id, { scope: "optional" }), theme.id);
      expect(await themeOf(theme.catalog_item_id as string)).toMatchObject({
        scope_mode: "own",
        scope: "all",
      });
    });

    it("following a plugin that is not all", async () => {
      const { itemId, theme } = await allTheme("neon");
      await setScope(env, itemId, "optional");
      await setUiTheme(theme.id);
      refused(await scopeTheme(theme.id, { follow: true }), theme.id);
    });

    it("its plugin's scope narrowed to named", async () => {
      const { itemId, theme } = await allTheme("neon");
      await setUiTheme(theme.id);
      const p = await previewItem(itemId, { scope: "named", orgs: [env.orgId] });
      const r = await env.root({
        method: "PUT",
        url: `/api/v1/admin/catalog/items/${itemId}/scope`,
        payload: { scope: "named", orgs: [env.orgId], scopeHash: p.scopeHash },
      });
      refused(r, theme.id);
      expect((await themeOf(itemId)).scope_mode).toBe("own");
    });

    it("its plugin's scope set to all is allowed (the theme follows an all plugin)", async () => {
      const { itemId, theme } = await allTheme("neon");
      await setUiTheme(theme.id);
      const p = await previewItem(itemId, { scope: "all" });
      const r = await env.root({
        method: "PUT",
        url: `/api/v1/admin/catalog/items/${itemId}/scope`,
        payload: { scope: "all", scopeHash: p.scopeHash },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect((await themeOf(itemId)).scope_mode).toBe("follow");
    });

    it("disabled", async () => {
      const { theme } = await allTheme("neon");
      await setUiTheme(theme.id);
      const p = await previewComponent(theme.id, { disabled: true });
      const r = await env.root({
        method: "PUT",
        url: `/api/v1/admin/components/theme/${theme.id}/disabled`,
        payload: { disabled: true, scopeHash: p.scopeHash },
      });
      refused(r, theme.id);
    });

    it("its plugin disabled", async () => {
      const { itemId, theme } = await allTheme("neon");
      await setUiTheme(theme.id);
      const p = await previewItem(itemId, { disabled: true });
      const r = await env.root({
        method: "PUT",
        url: `/api/v1/admin/catalog/items/${itemId}/disabled`,
        payload: { disabled: true, scopeHash: p.scopeHash },
      });
      refused(r, theme.id);
    });

    it("its plugin uninstalled from the deployment", async () => {
      const { itemId, theme } = await allTheme("neon");
      await setUiTheme(theme.id);
      refused(
        await env.root({ method: "DELETE", url: `/api/v1/admin/catalog/items/${itemId}` }),
        theme.id,
      );
      expect((await themeOf(itemId)).deleted_at).toBeNull();
    });

    it("an update that removes it", async () => {
      const { itemId, theme } = await allTheme("neon");
      await importPlugin(
        env,
        await themePlugin("neon", { version: "2.0.0", noTheme: true, skill: "notes" }),
      );
      await setUiTheme(theme.id);
      refused(
        await env.root({
          method: "POST",
          url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
          payload: { version: "2.0.0" },
        }),
        theme.id,
      );
    });

    it("its org-owned plugin deleted by its owner", async () => {
      const base = `/api/v1/orgs/${env.orgId}/catalog/uploads`;
      const up = await env.boss({
        method: "POST",
        url: `${base}/file`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from(await themePlugin("org-neon")),
      });
      expect(up.statusCode, up.body).toBe(200);
      const staged = up.json() as { stagingId: string; review: { reviewHash: string } };
      const c = await env.boss({
        method: "POST",
        url: `${base}/${staged.stagingId}/confirm`,
        payload: { reviewHash: staged.review.reviewHash },
      });
      expect(c.statusCode, c.body).toBe(201);
      const itemId = (c.json() as { item: { id: string } }).item.id;
      const theme = await themeOf(itemId);
      await setUiTheme(theme.id);
      const owned = `/api/v1/orgs/${env.orgId}/owned-plugins/${itemId}`;
      const p = await env.boss({ method: "POST", url: `${owned}/delete/preview`, payload: {} });
      expect(p.statusCode, p.body).toBe(200);
      refused(
        await env.boss({
          method: "POST",
          url: `${owned}/delete`,
          payload: { previewHash: p.json().previewHash },
        }),
        theme.id,
      );
      const item = await env.db
        .selectFrom("catalog_items")
        .select("deleted_at")
        .where("id", "=", itemId)
        .executeTakeFirstOrThrow();
      expect(item.deleted_at).toBeNull();
    });

    it("an org admin cannot switch it off in the org, and the org list shows it locked", async () => {
      const { theme } = await allTheme("neon");
      await setUiTheme(theme.id);
      // refused at the first call, before any preview
      refused(await switchTheme(theme.id, { enabled: false }), theme.id);
      const sw = await env.db
        .selectFrom("component_org_switches")
        .select("enabled")
        .where("component_id", "=", theme.id)
        .execute();
      expect(sw).toEqual([]);
      const list = await env.boss({
        method: "GET",
        url: `/api/v1/orgs/${env.orgId}/components?kind=theme`,
      });
      expect(list.json().components).toEqual([
        expect.objectContaining({ id: theme.id, on: true, locked: true, switchable: false }),
      ]);
    });

    /** A theme plugin installed in the org (scope optional), its theme following it. */
    const installedTheme = async () => {
      const itemId = await importPlugin(env, await themePlugin("neon"));
      await setScope(env, itemId, "optional");
      const inst = await env.boss({
        method: "POST",
        url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/install`,
        payload: {},
      });
      expect(inst.statusCode, inst.body).toBe(201);
      return { itemId, theme: await themeOf(itemId), installId: inst.json().id as string };
    };

    const liveInstalls = (itemId: string) =>
      env.db
        .selectFrom("plugin_installs")
        .select("id")
        .where("item_id", "=", itemId)
        .where("org_id", "=", env.orgId)
        .execute();

    it("an org admin cannot switch its plugin off in the org", async () => {
      const { itemId, theme } = await installedTheme();
      await setUiTheme(theme.id);
      refused(
        await env.boss({
          method: "PUT",
          url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
          payload: { enabled: false },
        }),
        theme.id,
      );
      expect(await liveInstalls(itemId)).toHaveLength(1);
    });

    it("an org admin cannot uninstall its plugin from the org", async () => {
      const { itemId, theme } = await installedTheme();
      const [install] = await liveInstalls(itemId);
      await setUiTheme(theme.id);
      refused(
        await env.boss({
          method: "DELETE",
          url: `/api/v1/orgs/${env.orgId}/plugin-installs/${install?.id}`,
        }),
        theme.id,
      );
      expect(await liveInstalls(itemId)).toHaveLength(1);
    });

    it("the uninstall's transaction refuses a switch-off confirmed after the theme became the default", async () => {
      const { itemId, theme } = await installedTheme();
      const p = await env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
        payload: { enabled: false },
      });
      expect(p.statusCode, p.body).toBe(200);
      await setUiTheme(theme.id);
      refused(
        await env.boss({
          method: "PUT",
          url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
          payload: { enabled: false, confirm: p.json().confirm },
        }),
        theme.id,
      );
      expect(await liveInstalls(itemId)).toHaveLength(1);
    });

    it("another theme is not guarded", async () => {
      const { theme } = await allTheme("neon");
      const other = await allTheme("glow", "glow");
      await setUiTheme(theme.id);
      expect((await scopeTheme(other.theme.id, { scope: "optional" })).statusCode).toBe(200);
    });
  });
});

describe("conflictsError", () => {
  const skill = { orgId: "o1", orgName: "One", name: "notes", skills: ["s1"], plugins: [] };
  const theme = {
    orgId: "o1",
    orgName: "One",
    name: "neon-grid",
    skills: [],
    themes: ["t1"],
    plugins: ["neon"],
    kind: "theme" as const,
  };

  it("theme clashes alone are theme.id_taken with the clashing themes", () => {
    const e = conflictsError([theme]);
    expect(e.code).toBe("theme.id_taken");
    expect(e.details).toEqual([
      { theme: "neon-grid", orgId: "o1", themes: ["t1"], plugins: ["neon"] },
    ]);
  });

  it("skill and theme clashes together are all listed", () => {
    const e = conflictsError([skill, theme]);
    expect(e.code).toBe("plugin.skill_conflict");
    expect(e.details).toEqual([
      expect.objectContaining({ skill: "notes", orgId: "o1", skills: ["s1"] }),
      { theme: "neon-grid", orgId: "o1", themes: ["t1"], plugins: ["neon"] },
    ]);
    expect(e.message).toContain("notes");
    expect(e.message).toContain("neon-grid");
  });
});
