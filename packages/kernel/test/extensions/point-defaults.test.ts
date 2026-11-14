import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { ExtensionPointDefaults } from "../../src/extensions/point-defaults.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Web tools spec §6: the org default provider of an `org-default` extension point. Candidates are
 * the loaded providers enabled in the org whose `configured()` accepts the org config; one is used
 * as is, several need the org's stored default, which survives the provider being disabled.
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
  orgId = await createOrg(await session(k, "owner"));
});

const enable = (plugin: string, token?: string) =>
  configs.put(
    orgId,
    plugin,
    { enabled: true, ...(token !== undefined && { config: { token } }) },
    ownerId,
  );
const disable = (plugin: string) => configs.put(orgId, plugin, { enabled: false }, ownerId);

const errCode = (e: unknown) => (e as { code?: string }).code;

describe("ExtensionPointDefaults.resolve", () => {
  it("nothing enabled → none", async () => {
    expect(await points.resolve(orgId, "web-search")).toEqual({ ok: false, reason: "none" });
    expect(await points.resolve(orgId, "web-fetch")).toEqual({ ok: false, reason: "none" });
  });

  it("enabled without a token → none; with a token → that provider and its org config", async () => {
    await enable("fake-web");
    expect(await points.resolve(orgId, "web-search")).toEqual({ ok: false, reason: "none" });
    await enable("fake-web", "tok-1");
    const r = await points.resolve<{ search: unknown }>(orgId, "web-search");
    expect(r).toMatchObject({ ok: true, extension: "fake-web", orgConfig: { token: "tok-1" } });
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

  it("an invalid stored org config excludes the provider and logs a warning", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    // A stored config the schema rejects (as after a schema change): no secret, a number token
    await db
      .deleteFrom("secrets")
      .where("org_id", "=", orgId)
      .where("key", "=", "plugin-config:fake-web-2:token")
      .execute();
    await db
      .updateTable("extension_org_configs")
      .set({ config: JSON.stringify({ token: 5 }) })
      .where("org_id", "=", orgId)
      .where("plugin", "=", "fake-web-2")
      .execute();
    expect(await points.resolve(orgId, "web-search")).toMatchObject({
      ok: true,
      extension: "fake-web",
    });
    expect(lines.some((l) => l.includes("provider excluded") && l.includes("fake-web-2"))).toBe(
      true,
    );
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
