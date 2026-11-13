import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionHost } from "../../src/extensions/host.js";
import { clientPlugin, importClientPlugin } from "../client/client-env.js";
import { enableExtensions } from "../helpers/runs.js";
import { setThemeScope, setThemeSwitch, writeOrgTheme, writeUiTheme } from "../themes/theme-env.js";
import { clearAppearance, importLook, LOOK, orgRows, platformRows } from "./appearance-env.js";
import { type OrgEnv, startOrgEnv } from "./org-env.js";

/**
 * Applying a plugin's suggested appearance (client extensions spec §6.5, plan Task 12): the super
 * admin writes the platform default theme and the platform arrangement's `use` for each
 * replacement, an org admin the org's (keeping `personal`), in one transaction; a dry run lists the
 * changes and writes nothing; a theme that cannot be set refuses the whole call; an unavailable
 * replacement or an unknown slot is skipped, not refused.
 */

let env: OrgEnv;
let itemId: string;
let themeId: string;
let plainId: string;
const PLAIN = "cx-plain";

beforeAll(async () => {
  env = await startOrgEnv();
  ({ itemId, themeId } = await importLook(env));
  plainId = await importClientPlugin(
    env,
    await clientPlugin({ name: PLAIN, components: [{ id: "brand", slot: "shell.brand" }] }),
    PLAIN,
  );
  await enableExtensions(env.db, env.orgId, LOOK, PLAIN);
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await clearAppearance(env);
  await setThemeScope(env, themeId, "all");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const applyPlatform = (id: string, dryRun?: boolean) =>
  env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${id}/appearance`,
    payload: dryRun === undefined ? {} : { dryRun },
  });

const applyOrg = (req: OrgEnv["boss"], extension: string, dryRun?: boolean) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/extensions/${extension}/appearance`,
    payload: dryRun === undefined ? {} : { dryRun },
  });

const UNKNOWN = { what: "shell.future", reason: "unknown-slot" };

describe("suggested appearance", () => {
  it("a dry run lists the changes and writes nothing", async () => {
    const r = await applyPlatform(itemId, true);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      theme: { from: null, to: themeId },
      replacements: [
        { slot: "shell.brand", from: null, to: `${LOOK}/brand` },
        { slot: "conversation.empty", from: null, to: `${LOOK}/empty` },
      ],
      skipped: [UNKNOWN],
    });
    const o = await applyOrg(env.boss, LOOK, true);
    expect(o.statusCode, o.body).toBe(200);
    // the org follows the platform, which has no default theme
    expect(o.json().theme).toEqual({ from: null, to: themeId, followsPlatform: true });
    expect(await platformRows(env)).toEqual({});
    expect(await orgRows(env, env.orgId)).toEqual({});
  });

  it("the super admin applies theme and replacements in one step", async () => {
    const r = await applyPlatform(itemId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().replacements).toHaveLength(2);
    const s = await env.root({ method: "GET", url: "/api/v1/admin/settings" });
    expect(s.json().uiTheme).toEqual({ id: themeId });
    expect(s.json().uiArrangement).toEqual({
      "shell.brand": { use: `${LOOK}/brand` },
      "conversation.empty": { use: `${LOOK}/empty` },
    });
    // the org level is untouched
    expect(await orgRows(env, env.orgId)).toEqual({});
    // audited by the settings writer, naming the plugin
    const audits = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "deployment.settings.updated")
      .execute();
    expect(audits.map((a) => a.detail)).toContainEqual(
      expect.objectContaining({ appearance: { itemId, plugin: LOOK } }),
    );
    // applied again: nothing left to change
    const again = await applyPlatform(itemId, true);
    expect(again.json()).toEqual({ theme: null, replacements: [], skipped: [UNKNOWN] });
  });

  it("an org admin applies them at org level and keeps personal", async () => {
    await writeOrgTheme(env, env.orgId, { id: null, personal: "locked" });
    const r = await applyOrg(env.boss, LOOK);
    expect(r.statusCode, r.body).toBe(200);
    expect(await orgRows(env, env.orgId)).toEqual({
      theme: { id: themeId, personal: "locked" },
      uiArrangement: {
        "shell.brand": { use: `${LOOK}/brand` },
        "conversation.empty": { use: `${LOOK}/empty` },
      },
    });
    expect(await platformRows(env)).toEqual({});
    const audits = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "org.settings_updated")
      .where("org_id", "=", env.orgId)
      .execute();
    expect(audits.map((a) => a.detail)).toContainEqual(
      expect.objectContaining({ appearance: { itemId, plugin: LOOK } }),
    );
  });

  it("a theme that cannot be the platform default refuses the whole call", async () => {
    await setThemeScope(env, themeId, "optional");
    for (const dryRun of [true, false]) {
      const r = await applyPlatform(itemId, dryRun);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toMatchObject({
        code: "theme.not_available",
        details: [{ theme: themeId }],
      });
    }
    expect(await platformRows(env)).toEqual({});
    // off in the org: the org call is refused the same way, nothing written
    const o = await applyOrg(env.boss, LOOK);
    expect(o.statusCode, o.body).toBe(400);
    expect(o.json().error.code).toBe("theme.not_available");
    expect(await orgRows(env, env.orgId)).toEqual({});
  });

  it("an unavailable replacement is skipped, not refused", async () => {
    const host = env.k.app.get(ExtensionHost);
    const real = host.uiContributions.bind(host);
    // the running build no longer has the empty-state component
    vi.spyOn(host, "uiContributions").mockImplementation(() =>
      real().filter((c) => !(c.plugin === LOOK && c.contribution.id === "empty")),
    );
    const r = await applyPlatform(itemId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      theme: { from: null, to: themeId },
      replacements: [{ slot: "shell.brand", from: null, to: `${LOOK}/brand` }],
      // in the author's order (plugin.json), not the jsonb key order
      skipped: [{ what: "conversation.empty", reason: "not-available" }, UNKNOWN],
    });
    expect((await platformRows(env)).uiArrangement).toEqual({
      "shell.brand": { use: `${LOOK}/brand` },
    });
  });

  it("an unknown slot is skipped", async () => {
    const r = await applyOrg(env.boss, LOOK);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().skipped).toEqual([UNKNOWN]);
    const stored = (await orgRows(env, env.orgId)).uiArrangement as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["conversation.empty", "shell.brand"]);
  });

  it("a member gets 403 and no action", async () => {
    const r = await applyOrg(env.mem, LOOK);
    expect(r.statusCode, r.body).toBe(403);
    // not a super admin: the platform route is refused too
    const p = await env.boss({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/appearance`,
      payload: {},
    });
    expect(p.statusCode, p.body).toBe(403);
    expect(await platformRows(env)).toEqual({});
    expect(await orgRows(env, env.orgId)).toEqual({});
    // the list offers the action to admins only
    const asMember = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/extensions` });
    const mine = (asMember.json().extensions as { plugin: string }[]).find(
      (e) => e.plugin === LOOK,
    );
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty("suggestedAppearance");
    const asAdmin = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/extensions` });
    const items = asAdmin.json().extensions as { plugin: string; suggestedAppearance: unknown }[];
    expect(items.find((e) => e.plugin === LOOK)?.suggestedAppearance).toEqual({
      theme: "look",
      replacements: {
        "shell.brand": "brand",
        "conversation.empty": "empty",
        "shell.future": "fx",
      },
    });
    expect(items.find((e) => e.plugin === PLAIN)?.suggestedAppearance).toBeNull();
    // the author's order survives the jsonb storage
    const look = items.find((e) => e.plugin === LOOK)?.suggestedAppearance as {
      replacements: Record<string, string>;
    };
    expect(Object.keys(look.replacements)).toEqual([
      "shell.brand",
      "conversation.empty",
      "shell.future",
    ]);
  });

  it("a plugin without suggestedAppearance is 404", async () => {
    const p = await applyPlatform(plainId, true);
    expect(p.statusCode, p.body).toBe(404);
    expect(p.json().error.code).toBe("catalog.item_not_found");
    const o = await applyOrg(env.boss, PLAIN, true);
    expect(o.statusCode, o.body).toBe(404);
    expect(o.json().error.code).toBe("extension.not_found");
    // an extension that is not on in the org is 404 as well
    await env.db
      .updateTable("extension_org_configs")
      .set({ enabled: false })
      .where("plugin", "=", LOOK)
      .where("org_id", "=", env.orgId)
      .execute();
    try {
      const off = await applyOrg(env.boss, LOOK, true);
      expect(off.statusCode, off.body).toBe(404);
      expect(off.json().error.code).toBe("extension.not_found");
    } finally {
      await enableExtensions(env.db, env.orgId, LOOK);
    }
    // the item detail tells the admin page when to offer the action
    const detail = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${itemId}` });
    expect(detail.json().suggestedAppearance).toMatchObject({ theme: "look" });
    expect(Object.keys(detail.json().suggestedAppearance.replacements)).toEqual([
      "shell.brand",
      "conversation.empty",
      "shell.future",
    ]);
    const plain = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${plainId}` });
    expect(plain.json().suggestedAppearance).toBeNull();
  });
  it("an org following the platform that already uses the suggestion pins nothing", async () => {
    expect((await applyPlatform(itemId)).statusCode).toBe(200);
    const o = await applyOrg(env.boss, LOOK, true);
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json()).toEqual({ theme: null, replacements: [], skipped: [UNKNOWN] });
    expect((await applyOrg(env.boss, LOOK)).statusCode).toBe(200);
    // the org keeps following the platform
    expect(await orgRows(env, env.orgId)).toEqual({});
  });

  it("a following org whose platform default is no longer eligible sees the built-in", async () => {
    // the platform stores this theme, but it is no longer scope all: every org renders the
    // built-in instead, so applying it in an org (where it is switched on) is a change
    await writeUiTheme(env, themeId);
    await setThemeScope(env, themeId, "optional");
    await setThemeSwitch(env, env.orgId, themeId, true);
    try {
      const o = await applyOrg(env.boss, LOOK, true);
      expect(o.statusCode, o.body).toBe(200);
      expect(o.json().theme).toEqual({ from: null, to: themeId, followsPlatform: true });
      // still eligible: nothing changes
      await setThemeScope(env, themeId, "all");
      expect((await applyOrg(env.boss, LOOK, true)).json().theme).toBeNull();
    } finally {
      await env.db
        .deleteFrom("component_org_switches")
        .where("component_id", "=", themeId)
        .execute();
    }
  });

  it("at org level from is the effective value and says whether it follows the platform", async () => {
    const platform = await env.root({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { uiArrangement: { "shell.brand": { use: `${PLAIN}/brand` } } },
    });
    expect(platform.statusCode, platform.body).toBe(200);
    // the org's own built-in entry on conversation.empty; shell.brand follows the platform
    await env.db
      .updateTable("orgs")
      .set({
        settings: sql`jsonb_set(settings, '{uiArrangement}', ${JSON.stringify({
          "conversation.empty": { use: null },
          "shell.overlay": { hidden: [], order: [`${LOOK}/fx`] },
        })}::jsonb)` as unknown as string,
      })
      .where("id", "=", env.orgId)
      .execute();
    const o = await applyOrg(env.boss, LOOK);
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json().replacements).toEqual([
      { slot: "shell.brand", from: `${PLAIN}/brand`, to: `${LOOK}/brand`, followsPlatform: true },
      { slot: "conversation.empty", from: null, to: `${LOOK}/empty`, followsPlatform: false },
    ]);
    // the list slot's entry survives the apply
    expect((await orgRows(env, env.orgId)).uiArrangement).toEqual({
      "shell.brand": { use: `${LOOK}/brand` },
      "conversation.empty": { use: `${LOOK}/empty` },
      "shell.overlay": { hidden: [], order: [`${LOOK}/fx`] },
    });
  });

  it("a stored manifest naming a slot twice or a list slot is skipped as not eligible", async () => {
    const stored = await env.db
      .selectFrom("catalog_item_versions")
      .select(["version", "manifest", "appearance_order"])
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    const replacements = {
      "shell.brand@1": "brand",
      "shell.overlay": "brand",
      "shell.brand": "brand",
    };
    const write = (manifest: unknown, order: string[] | null) =>
      env.db
        .updateTable("catalog_item_versions")
        .set({ manifest: JSON.stringify(manifest), appearance_order: order })
        .where("item_id", "=", itemId)
        .where("version", "=", stored.version)
        .execute();
    await write(
      {
        ...(stored.manifest as object),
        suggestedAppearance: { replacements },
      },
      Object.keys(replacements),
    );
    try {
      for (const r of [await applyPlatform(itemId, true), await applyOrg(env.boss, LOOK, true)]) {
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().replacements.map((x: { slot: string }) => x.slot)).toEqual(["shell.brand"]);
        expect(r.json().skipped).toEqual([
          { what: "shell.overlay", reason: "not-eligible" },
          { what: "shell.brand", reason: "not-eligible" },
        ]);
      }
    } finally {
      await write(stored.manifest, stored.appearance_order);
    }
  });
});
