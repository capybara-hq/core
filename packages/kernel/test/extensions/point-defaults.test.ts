import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { OrgOverrides } from "../../src/extensions/org-overrides.js";
import { ExtensionPointDefaults } from "../../src/extensions/point-defaults.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrgWithProviders,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Web tools spec §6: the org default provider of an `org-default` extension point. Candidates are
 * the loaded providers enabled in the org whose effective config for the org is valid and whose
 * `configured(config)` accepts it; one is used as is, several need the org's stored default, which
 * survives the provider being disabled. The fake web providers' `token` is a required overridable
 * field the platform leaves empty: an org runs a provider only with its own copy.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let points: ExtensionPointDefaults;
let configs: OrgExtensionConfigs;
const lines: string[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [fakeExtensionEntry("fake-web"), fakeExtensionEntry("fake-web-2")],
      },
    ),
    { logger: createLogger("debug", { write: (l) => lines.push(l) }) },
  );
  points = k.app.get(ExtensionPointDefaults);
  configs = k.app.get(OrgExtensionConfigs);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let ownerId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  lines.length = 0;
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrgWithProviders(k, await session(k, "owner"));
});

/** Enables `plugin` in the org and, with a token, saves the org's copy holding it. */
const enable = async (plugin: string, token?: string) => {
  await configs.put(orgId, plugin, { enabled: true }, ownerId);
  if (token !== undefined) {
    await k.app.get(OrgOverrides).save(orgId, plugin, { token }, [], { accountId: ownerId });
  }
};

/** Makes the org's copy of `plugin` invalid (its required token secret gone). */
const breakCopy = async (plugin: string) => {
  await db
    .deleteFrom("secrets")
    .where("org_id", "=", orgId)
    .where("key", "=", `plugin-override:${plugin}:token`)
    .execute();
  await k.app.get(EffectiveConfigs).invalidate(orgId, plugin);
};
const disable = (plugin: string) => configs.put(orgId, plugin, { enabled: false }, ownerId);

const errCode = (e: unknown) => (e as { code?: string }).code;

describe("ExtensionPointDefaults.resolve", () => {
  it("nothing enabled → none", async () => {
    expect(await points.resolve(orgId, "web-search")).toEqual({ ok: false, reason: "none" });
    expect(await points.resolve(orgId, "web-fetch")).toEqual({ ok: false, reason: "none" });
  });

  it("enabled without a token → none; with the org's copy → that provider and its effective config", async () => {
    await enable("fake-web");
    expect(await points.resolve(orgId, "web-search")).toEqual({ ok: false, reason: "none" });
    await enable("fake-web", "tok-1");
    const r = await points.resolve<{ search: unknown }>(orgId, "web-search");
    expect(r).toMatchObject({ ok: true, extension: "fake-web", config: { token: "tok-1" } });
    expect(r).not.toHaveProperty("orgConfig");
    expect(r.ok && typeof r.impl.search).toBe("function");
    const f = await points.resolve<{ fetch: unknown }>(orgId, "web-fetch");
    expect(f.ok && typeof f.impl.fetch).toBe("function");
  });

  it("two candidates and no default → ambiguous; the stored default wins", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    expect(await points.resolve(orgId, "web-search")).toEqual({ ok: false, reason: "ambiguous" });
    await points.setDefault(orgId, "web-search", "fake-web-2", ownerId);
    expect(await points.resolve(orgId, "web-search")).toMatchObject({
      ok: true,
      extension: "fake-web-2",
    });
    // The default is per point
    expect(await points.resolve(orgId, "web-fetch")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("a disabled default is ignored and restored when enabled again (no new setDefault)", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    await points.setDefault(orgId, "web-search", "fake-web-2", ownerId);
    await disable("fake-web-2");
    expect(await points.resolve(orgId, "web-search")).toMatchObject({
      ok: true,
      extension: "fake-web",
    });
    const row = await db
      .selectFrom("org_extension_point_defaults")
      .select(["extension"])
      .where("org_id", "=", orgId)
      .where("point", "=", "web-search")
      .executeTakeFirst();
    expect(row?.extension).toBe("fake-web-2");
    await enable("fake-web-2");
    expect(await points.resolve(orgId, "web-search")).toMatchObject({
      ok: true,
      extension: "fake-web-2",
    });
  });

  it("an invalid effective config (the org's copy no longer validates) excludes the provider", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    await breakCopy("fake-web-2");
    expect(await points.resolve(orgId, "web-search")).toMatchObject({
      ok: true,
      extension: "fake-web",
    });
    const { providers, failed } = await points.providersFor(orgId, "web-search");
    expect(providers.map((p) => p.extension)).toEqual(["fake-web"]);
    // a known state, not a read failure
    expect([...failed]).toEqual([]);
  });

  it("a provider whose configured(config) is false is excluded; each gets its own org's config", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "unconfigured");
    const { providers } = await points.providersFor(orgId, "web-search");
    expect(providers).toMatchObject([{ extension: "fake-web", config: { token: "a" } }]);
    for (const p of providers) expect(p).not.toHaveProperty("orgConfig");
  });

  it("a configured() that throws excludes the provider and logs a warning", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "throw:configured");
    expect(await points.resolve(orgId, "web-fetch")).toMatchObject({
      ok: true,
      extension: "fake-web",
    });
    expect(lines.some((l) => l.includes("configured() threw") && l.includes("fake-web-2"))).toBe(
      true,
    );
  });

  it("a point without selection throws", async () => {
    await expect(points.resolve(orgId, "channel")).rejects.toThrow(/selection/);
  });
});

describe("ExtensionPointDefaults.serves", () => {
  // serves() evaluates one provider; it must agree with providersFor() for each state
  const agree = async () => {
    const { providers } = await points.providersFor(orgId, "web-search");
    const listed = new Set(providers.map((p) => p.extension));
    const out: Record<string, boolean> = {};
    for (const ext of ["fake-web", "fake-web-2"]) {
      const one = await points.serves(orgId, "web-search", ext);
      expect(one).toBe(listed.has(ext));
      out[ext] = one;
    }
    return out;
  };

  it("agrees with providersFor when on, off, unconfigured and with an invalid copy", async () => {
    // off: nothing enabled
    expect(await agree()).toEqual({ "fake-web": false, "fake-web-2": false });
    // on / enabled but without a valid effective config
    await enable("fake-web", "a");
    await enable("fake-web-2");
    expect(await agree()).toEqual({ "fake-web": true, "fake-web-2": false });
    await enable("fake-web-2", "b");
    expect(await agree()).toEqual({ "fake-web": true, "fake-web-2": true });
    // the org's copy no longer validates (as after a schema change)
    await breakCopy("fake-web-2");
    expect(await agree()).toEqual({ "fake-web": true, "fake-web-2": false });
    // switched off
    await disable("fake-web");
    expect(await agree()).toEqual({ "fake-web": false, "fake-web-2": false });
  });

  it("an extension that does not provide the point does not serve it", async () => {
    await enable("fake-web", "a");
    expect(await points.serves(orgId, "channel", "fake-web")).toBe(false);
    expect(await points.serves(orgId, "web-search", "no-such-extension")).toBe(false);
  });
});

describe("ExtensionPointDefaults.setDefault", () => {
  it("400 validation_failed unless the extension provides the point and is enabled", async () => {
    await expect(points.setDefault(orgId, "web-search", "fake-web", ownerId)).rejects.toSatisfy(
      (e) => errCode(e) === "validation_failed",
    );
    await enable("fake-web", "a");
    await expect(points.setDefault(orgId, "web-search", "model-fake", ownerId)).rejects.toSatisfy(
      (e) => errCode(e) === "validation_failed",
    );
    await expect(points.setDefault(orgId, "channel", "fake-web", ownerId)).rejects.toSatisfy(
      (e) => errCode(e) === "validation_failed",
    );
    expect(
      await db
        .selectFrom("org_extension_point_defaults")
        .selectAll()
        .where("org_id", "=", orgId)
        .execute(),
    ).toEqual([]);
  });

  it("upserts the default and writes an audit row", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    await points.setDefault(orgId, "web-fetch", "fake-web", ownerId);
    await points.setDefault(orgId, "web-fetch", "fake-web-2", ownerId);
    const rows = await db
      .selectFrom("org_extension_point_defaults")
      .select(["point", "extension", "updated_by"])
      .where("org_id", "=", orgId)
      .execute();
    expect(rows).toEqual([{ point: "web-fetch", extension: "fake-web-2", updated_by: ownerId }]);
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail", "actor_account_id"])
      .where("org_id", "=", orgId)
      .where("action", "=", "extension_point.default_set")
      .orderBy("at")
      .execute();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      actor_account_id: ownerId,
      detail: { point: "web-fetch", extension: "fake-web-2" },
    });
  });
});

describe("ExtensionPointDefaults.list", () => {
  it("lists every selection point with candidates, default and effective", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2");
    expect(await points.list(orgId)).toEqual([
      { point: "web-search", candidates: ["fake-web"], default: null, effective: "fake-web" },
      { point: "web-fetch", candidates: ["fake-web"], default: null, effective: "fake-web" },
    ]);
    await enable("fake-web-2", "b");
    await points.setDefault(orgId, "web-fetch", "fake-web-2", ownerId);
    expect(await points.list(orgId)).toEqual([
      {
        point: "web-search",
        candidates: ["fake-web", "fake-web-2"],
        default: null,
        effective: null,
      },
      {
        point: "web-fetch",
        candidates: ["fake-web", "fake-web-2"],
        default: "fake-web-2",
        effective: "fake-web-2",
      },
    ]);
  });
});
