import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlatformOperations } from "../../src/platform/registry.js";
import { type OrgEnv, resetOrgCatalog, setScope, startOrgEnv } from "../catalog/org-env.js";
import {
  clearThemeLevels,
  importTheme,
  setThemeScope,
  setThemeSwitch,
  writeUiTheme,
} from "./theme-env.js";

/**
 * Themes spec §7, §9 (plan Task 8): each level's write checks its theme (`theme.not_available`):
 * an org default must be on in the org, the platform default must be a platform theme with
 * effective scope `all`, a person's pick must be on in one of their orgs; `PUT /me/preferences` is
 * a partial update.
 */
describe("theme settings", () => {
  let env: OrgEnv;
  /** On in the org (own scope `all`). */
  let on: string;
  /** Offered but off (own scope `optional`, no switch). */
  let off: string;

  /** The `uiTheme` row as the migrations left it (before any reset). */
  let seeded: unknown;

  beforeAll(async () => {
    env = await startOrgEnv();
    seeded = (
      await env.db
        .selectFrom("deployment_settings")
        .select("value")
        .where("key", "=", "uiTheme")
        .executeTakeFirst()
    )?.value;
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await resetOrgCatalog(env);
    await clearThemeLevels(env);
    on = (await importTheme(env, "neon", "night-city")).id;
    off = (await importTheme(env, "paper", "paper", "both")).id;
    await setThemeScope(env, on, "all");
    await setThemeScope(env, off, "optional");
  });

  const orgSettings = (body: Record<string, unknown>) =>
    env.boss({ method: "PATCH", url: `/api/v1/orgs/${env.orgId}/settings`, payload: body });
  const adminSettings = (body: Record<string, unknown>) =>
    env.root({ method: "PUT", url: "/api/v1/admin/settings", payload: body });
  const prefs = (body: Record<string, unknown>) =>
    env.mem({ method: "PUT", url: "/api/v1/me/preferences", payload: body });

  describe("the org default", () => {
    it("a theme off in the org is refused with theme.not_available", async () => {
      const r = await orgSettings({ theme: { id: off, personal: "locked" } });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toMatchObject({
        code: "theme.not_available",
        details: [{ theme: off }],
      });
      const s = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/settings` });
      expect(s.json().settings.theme).toBeUndefined();
    });

    it("a theme on in the org is set with the lock; null follows the platform again", async () => {
      const r = await orgSettings({ theme: { id: on, personal: "locked" } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().settings.theme).toEqual({ id: on, personal: "locked" });
      const follow = await orgSettings({ theme: { id: null, personal: "allowed" } });
      expect(follow.json().settings.theme).toEqual({ id: null, personal: "allowed" });
      const cleared = await orgSettings({ theme: null });
      expect(cleared.json().settings.theme).toBeUndefined();
    });

    it("an unknown id is refused", async () => {
      const r = await orgSettings({ theme: { id: "nope", personal: "allowed" } });
      expect(r.json().error.code).toBe("theme.not_available");
    });
  });

  describe("the platform default", () => {
    it("the migrations seed the uiTheme row; a missing row reads as the built-in theme", async () => {
      expect(seeded).toEqual({ id: null });
      // resetOrgCatalog truncated the table
      const g = await env.root({ method: "GET", url: "/api/v1/admin/settings" });
      expect(g.json().uiTheme).toEqual({ id: null });
    });

    it("a theme whose scope is optional is refused", async () => {
      const r = await adminSettings({ uiTheme: { id: off } });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe("theme.not_available");
    });

    it("an org-owned theme with scope all is refused", async () => {
      await env.db
        .updateTable("platform_themes")
        .set({ owner_org_id: env.orgId })
        .where("id", "=", on)
        .execute();
      const r = await adminSettings({ uiTheme: { id: on } });
      expect(r.json().error.code).toBe("theme.not_available");
    });

    it("a disabled theme is refused", async () => {
      await env.db
        .updateTable("platform_themes")
        .set({ disabled: true })
        .where("id", "=", on)
        .execute();
      const r = await adminSettings({ uiTheme: { id: on } });
      expect(r.json().error.code).toBe("theme.not_available");
    });

    it("a platform theme with scope all is set; the guard then reads it through the typed reader", async () => {
      const r = await adminSettings({ uiTheme: { id: on } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().uiTheme).toEqual({ id: on });
      const row = await env.db
        .selectFrom("deployment_settings")
        .select("value")
        .where("key", "=", "uiTheme")
        .executeTakeFirstOrThrow();
      expect(row.value).toEqual({ id: on });
      // the platform default is locked on: switching it off in the org is refused
      const sw = await env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/components/theme/${on}/switch`,
        payload: { enabled: false },
      });
      expect(sw.json().error.code).toBe("theme.platform_default");
      // back to the built-in theme
      const back = await adminSettings({ uiTheme: { id: null } });
      expect(back.json().uiTheme).toEqual({ id: null });
    });

    it("an invalid stored value reads as the built-in theme everywhere", async () => {
      await writeUiTheme(env, null);
      await env.db
        .updateTable("deployment_settings")
        .set({ value: JSON.stringify({ id: 42 }) })
        .where("key", "=", "uiTheme")
        .execute();
      const g = await env.root({ method: "GET", url: "/api/v1/admin/settings" });
      expect(g.json().uiTheme).toEqual({ id: null });
      const sw = await env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/components/theme/${on}/switch`,
        payload: { enabled: false },
      });
      expect(sw.statusCode, sw.body).toBe(200);
    });
  });

  describe("the platform default must be on in every org", () => {
    const orgName = async (id: string) =>
      (
        await env.db
          .selectFrom("orgs")
          .select("name")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).name;

    it("a scope-all theme an org switched off is refused, naming that org", async () => {
      await setThemeSwitch(env, env.orgId, on, false);
      const r = await adminSettings({ uiTheme: { id: on } });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toMatchObject({
        code: "theme.not_available",
        details: [{ theme: on, orgs: [{ orgId: env.orgId, orgName: await orgName(env.orgId) }] }],
      });
      const row = await env.db
        .selectFrom("deployment_settings")
        .select("value")
        .where("key", "=", "uiTheme")
        .executeTakeFirst();
      const stored: unknown = row === undefined ? { id: null } : row.value;
      expect(stored).toEqual({ id: null });
    });

    it("a follow theme of an all-scope plugin not installed in an org is refused", async () => {
      const t = await importTheme(env, "glow", "glow");
      await setScope(env, t.itemId, "all");
      // no install in the org (the scope sync is not awaited here): the theme is off there
      await env.db.deleteFrom("plugin_installs").where("item_id", "=", t.itemId).execute();
      const r = await adminSettings({ uiTheme: { id: t.id } });
      expect(r.json().error.code).toBe("theme.not_available");
      expect(r.json().error.details[0].orgs).toContainEqual({
        orgId: env.orgId,
        orgName: await orgName(env.orgId),
      });
    });

    it("setting the default and an org switch-off of it in parallel never deadlock", async () => {
      // The org switch's order (component-scope setSwitch): item FOR SHARE, theme row FOR UPDATE,
      // then `uiTheme` FOR SHARE. Held open here on another connection while the setter runs.
      const item = (
        await env.db
          .selectFrom("platform_themes")
          .select("catalog_item_id")
          .where("id", "=", on)
          .executeTakeFirstOrThrow()
      ).catalog_item_id as string;
      await writeUiTheme(env, null); // the row the migration seeds (the reset truncated it)
      let setter: Promise<{ statusCode: number; body: string }> | undefined;
      await env.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom("catalog_items")
          .select("id")
          .where("id", "=", item)
          .forShare()
          .execute();
        await trx
          .selectFrom("platform_themes")
          .select("id")
          .where("id", "=", on)
          .forUpdate()
          .execute();
        setter = adminSettings({ uiTheme: { id: on } });
        // wait until the setter is blocked on the theme row this transaction holds
        let blocked = false;
        for (let i = 0; i < 400 && !blocked; i++) {
          const w = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%platform_themes%for share%'`.execute(
            env.db,
          );
          blocked = (w.rows[0]?.n ?? 0) > 0;
          if (!blocked) await new Promise((r) => setTimeout(r, 25));
        }
        expect(blocked).toBe(true);
        await trx
          .selectFrom("deployment_settings")
          .select("key")
          .where("key", "=", "uiTheme")
          .forShare()
          .execute();
        await trx
          .insertInto("component_org_switches")
          .values({ kind: "theme", component_id: on, org_id: env.orgId, enabled: false })
          .execute();
      });
      const r = await (setter as Promise<{ statusCode: number; body: string }>);
      // the switch-off committed first, so the setter sees the theme off in the org
      expect(r.body).not.toContain("deadlock");
      expect(r.statusCode, r.body).toBe(400);
      expect(JSON.parse(r.body).error.code).toBe("theme.not_available");
    });

    it("the reverse: a switch-off waits for the setter and is then refused", async () => {
      const results = await Promise.all([
        adminSettings({ uiTheme: { id: on } }),
        env.boss({
          method: "PUT",
          url: `/api/v1/orgs/${env.orgId}/components/theme/${on}/switch`,
          payload: { enabled: false },
        }),
      ]);
      for (const r of results) expect(r.statusCode, r.body).not.toBe(500);
      const [set, sw] = results;
      if (set?.statusCode === 200) {
        expect(sw?.json().error.code).toBe("theme.platform_default");
      } else {
        // the switch-off returns its preview first (nothing written), so the setter succeeds
        expect(set?.statusCode).toBe(200);
      }
    });
  });

  describe("Platform tool summaries name only themes the reader may see", () => {
    const ctx = (accountId: string) => ({
      orgId: env.orgId,
      actorAccountId: accountId,
      agentId: randomUUID(),
      conversationId: randomUUID(),
      runId: randomUUID(),
      signal: new AbortController().signal,
    });
    const summary = async (id: string, input: unknown, accountId: string) => {
      const o = env.k.app.get(PlatformOperations).get(id);
      if (o === null) throw new Error(id);
      return o.summary?.(o.input.parse(input) as never, ctx(accountId));
    };

    it("set-preferences shows a theme off in your orgs by its id, one on by its name", async () => {
      expect(await summary("platform.set-preferences", { theme: off }, env.memId)).toEqual({
        zh: `把你的主题从「跟随组织」改为「${off}」`,
        en: `Change your theme from "follow the org" to "${off}"`,
      });
      expect(await summary("platform.set-preferences", { theme: on }, env.memId)).toEqual({
        zh: "把你的主题从「跟随组织」改为「night-city zh」",
        en: 'Change your theme from "follow the org" to "night-city en"',
      });
    });

    it("org and deployment settings summaries show theme names", async () => {
      expect(
        await summary("org-settings.update", { theme: { id: on, personal: "locked" } }, env.bossId),
      ).toEqual({
        zh: "修改组织设置：theme → night-city zh（个人选择：锁定）",
        en: "Update the org settings: theme → night-city en (personal picks locked)",
      });
      expect(
        await summary(
          "org-settings.update",
          { theme: { id: off, personal: "allowed" } },
          env.bossId,
        ),
      ).toMatchObject({ en: `Update the org settings: theme → ${off} (personal picks allowed)` });
      expect(await summary("admin.update-settings", { uiTheme: { id: on } }, env.rootId)).toEqual({
        zh: "修改平台部署设置：uiTheme=night-city zh",
        en: "Change the deployment settings: uiTheme=night-city en",
      });
      expect(await summary("admin.update-settings", { uiTheme: { id: null } }, env.rootId)).toEqual(
        {
          zh: "修改平台部署设置：uiTheme=内置主题",
          en: "Change the deployment settings: uiTheme=built-in theme",
        },
      );
    });
  });

  describe("PUT /me/preferences is partial", () => {
    it("setting the theme keeps the time zone", async () => {
      expect((await prefs({ timeZone: "Europe/Berlin" })).json()).toEqual({
        timeZone: "Europe/Berlin",
        theme: null,
      });
      const r = await prefs({ theme: on });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ timeZone: "Europe/Berlin", theme: on });
      const g = await env.mem({ method: "GET", url: "/api/v1/me/preferences" });
      expect(g.json()).toEqual({ timeZone: "Europe/Berlin", theme: on });
    });

    it("clearing the time zone keeps the theme", async () => {
      await prefs({ theme: on, timeZone: "Asia/Shanghai" });
      const r = await prefs({ timeZone: null });
      expect(r.json()).toEqual({ timeZone: null, theme: on });
      expect((await prefs({ theme: null })).json()).toEqual({ timeZone: null, theme: null });
    });

    it("a theme on in none of the person's orgs is refused", async () => {
      const r = await prefs({ theme: off });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe("theme.not_available");
      expect((await env.mem({ method: "GET", url: "/api/v1/me/preferences" })).json().theme).toBe(
        null,
      );
    });

    it("a theme on in another of the person's orgs is accepted", async () => {
      const created = await env.root({
        method: "POST",
        url: "/api/v1/orgs",
        payload: { name: "Second", slug: `second-${Date.now()}` },
      });
      expect(created.statusCode, created.body).toBe(201);
      const second = (created.json() as { org: { id: string } }).org.id;
      await env.db
        .insertInto("memberships")
        .values({ org_id: second, account_id: env.memId, role: "member" })
        .execute();
      await setThemeSwitch(env, second, off, true);
      expect((await prefs({ theme: off })).json()).toMatchObject({ theme: off });
    });
  });
});
