import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import {
  type CloudNetworkSetting,
  type OrgSettings,
  OrgSettingsPatchSchema,
  type OrgSettingsService,
  parseOrgSettings,
} from "../../src/orgs/settings.service.js";
import { DEVICES_AUTO_MODE_SETTING } from "../../src/sandbox/platform-auto-mode.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, orgSettingsFor, orgsFor } from "../helpers/identity.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let accountId: string;
let orgId: string;

const LIMITS = {
  egress: "allowlist" as "none" | "allowlist",
  allowHosts: ["registry.npmjs.org", "github.com"],
  cpu: 1,
  memoryMb: 2048,
};

/** A config holder: the startup config's `devices.autoMode` (unset here unless the test says so). */
const settingsWith = (
  opts: { egress?: "none" | "allowlist"; allowHosts?: string[]; autoMode?: "allowed" | "off" } = {},
): OrgSettingsService => {
  const cfg = {
    sandbox: { limits: { ...LIMITS, ...opts } },
    devices: { autoMode: opts.autoMode },
  };
  return orgSettingsFor(db, () => cfg);
};

/** The platform's stored auto-mode switch (as the admin console writes it). */
const storePlatformMode = (mode: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key: DEVICES_AUTO_MODE_SETTING, value: JSON.stringify(mode) })
    .execute();

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ApiError).code;
  }
  return undefined;
};

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await raw.destroy();
  await pg.stop();
});

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.memberships, capybara.deployment_settings, capybara.audit_events",
  );
  const alice = await accountsFor(db).createLocal({
    login: "alice",
    password: "correct horse battery",
    displayName: "Alice",
  });
  accountId = alice.id;
  const org = await orgsFor(db).create({ name: "Acme" }, alice);
  orgId = org.id;
});

describe("org autoMode", () => {
  it("absent follows the platform; a person may set it; null clears it", async () => {
    const s = settingsWith();
    expect((await s.get(orgId)).autoMode).toBeUndefined();
    expect(await s.update(orgId, { autoMode: "allowed" }, accountId)).toMatchObject({
      autoMode: "allowed",
    });
    expect((await s.get(orgId)).autoMode).toBe("allowed");
    expect(await s.update(orgId, { autoMode: null }, accountId)).not.toHaveProperty("autoMode");
    expect(await s.update(orgId, { autoMode: "off" }, accountId)).toMatchObject({
      autoMode: "off",
    });
  });

  it("allowed while the platform is off is refused for a person too", async () => {
    await storePlatformMode({ mode: "off" });
    const s = settingsWith();
    expect(await codeOf(s.update(orgId, { autoMode: "allowed" }, accountId))).toBe(
      "org.auto_mode_not_allowed",
    );
    // off is the only value left, and clearing it is fine (it follows the platform's off)
    expect(await s.update(orgId, { autoMode: "off" }, accountId)).toMatchObject({
      autoMode: "off",
    });
    expect(await s.update(orgId, { autoMode: null }, accountId)).not.toHaveProperty("autoMode");
  });

  it("an invalid stored platform mode reads as off (fail closed)", async () => {
    await storePlatformMode({ mode: "maybe" });
    const s = settingsWith();
    expect((await s.deployment()).autoMode).toEqual({ mode: "off", source: "db" });
    expect(await codeOf(s.update(orgId, { autoMode: "allowed" }, accountId))).toBe(
      "org.auto_mode_not_allowed",
    );
  });

  it("a stored org value this version cannot read reads as off, never allowed", () => {
    expect(parseOrgSettings({ autoMode: "maybe" }).autoMode).toBe("off");
    expect(parseOrgSettings({ autoMode: null }).autoMode).toBe("off");
    expect(parseOrgSettings({}).autoMode).toBeUndefined();
  });

  it("the Platform tool / an API token may turn auto mode off, never on", async () => {
    const s = settingsWith();
    expect(
      await codeOf(
        s.update(orgId, { autoMode: "off" }, accountId, "tok", undefined, { onlyNarrows: true }),
      ),
    ).toBeUndefined();
    expect(
      await codeOf(
        s.update(orgId, { autoMode: "allowed" }, accountId, "tok", undefined, {
          onlyNarrows: true,
        }),
      ),
    ).toBe("org.auto_mode_not_allowed");
    expect((await s.get(orgId)).autoMode).toBe("off");
  });
});

describe("org cloudNetwork", () => {
  it("accepts valid hosts; open or allowlist with the deployment's hosts when omitted", async () => {
    const s = settingsWith();
    // absent = follow the deployment (open, with the platform allowlist as the default list)
    expect((await s.deployment()).cloudNetwork).toEqual({
      mode: "open",
      allowHosts: LIMITS.allowHosts,
    });
    expect(
      (await s.update(orgId, { cloudNetwork: { mode: "allowlist" } }, accountId)).cloudNetwork,
    ).toEqual({ mode: "allowlist" });
    expect(await s.update(orgId, { cloudNetwork: { mode: "open" } }, accountId)).toMatchObject({
      cloudNetwork: { mode: "open" },
    });
    expect(
      await s.update(
        orgId,
        { cloudNetwork: { mode: "allowlist", allowHosts: ["*.corp.example.org"] } },
        accountId,
      ),
    ).toMatchObject({ cloudNetwork: { mode: "allowlist", allowHosts: ["*.corp.example.org"] } });
    expect(await s.update(orgId, { cloudNetwork: null }, accountId)).not.toHaveProperty(
      "cloudNetwork",
    );
  });

  it("validates the shape and the hosts; an invalid stored value reads as an empty allowlist", () => {
    for (const bad of [
      { mode: "none" },
      { mode: "open", extra: 1 },
      { mode: "allowlist", allowHosts: ["10.0.0.1"] },
      { mode: "allowlist", allowHosts: ["localhost"] },
      { mode: "allowlist", allowHosts: ["Example.com"] },
      { mode: "allowlist", allowHosts: ["a.example.com", "a.example.com"] },
      { mode: "allowlist", allowHosts: Array.from({ length: 201 }, (_, i) => `h${i}.example.org`) },
    ]) {
      expect(
        OrgSettingsPatchSchema.safeParse({ cloudNetwork: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
    expect(parseOrgSettings({ cloudNetwork: { mode: "open", extra: 1 } }).cloudNetwork).toEqual({
      mode: "allowlist",
      allowHosts: [],
    });
  });

  it("narrow only: open -> allowlist and removing hosts narrow; allowlist -> open and adding hosts widen", async () => {
    const s = settingsWith();
    const tokenUpdate = (patch: { cloudNetwork: CloudNetworkSetting | null }) =>
      s.update(orgId, patch, accountId, "tok", undefined, { onlyNarrows: true });
    // absent = open: setting open explicitly is a no-op, not an error
    expect(await codeOf(tokenUpdate({ cloudNetwork: { mode: "open" } }))).toBeUndefined();
    await tokenUpdate({ cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } });
    expect(await codeOf(tokenUpdate({ cloudNetwork: { mode: "open" } }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    expect(
      await codeOf(
        tokenUpdate({
          cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com", "b.example.com"] },
        }),
      ),
    ).toBe("org.sandbox_egress_not_allowed");
    expect(
      await tokenUpdate({ cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } }),
    ).toMatchObject({ cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } });
    // allowlist -> the deployment's open network is a widening, so clearing is refused
    expect(await codeOf(tokenUpdate({ cloudNetwork: null }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    // the same value is a no-op, not an error
    expect(
      await tokenUpdate({ cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } }),
    ).toMatchObject({ cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } });
  });

  it("a deployment kill switch (sandbox.limits.egress none) makes the default an empty allowlist", async () => {
    const s = settingsWith({ egress: "none" });
    expect((await s.deployment()).cloudNetwork).toEqual({ mode: "allowlist", allowHosts: [] });
    // narrowing from that default needs nothing; a host the org gives itself is still wider than []
    expect(
      await codeOf(
        s.update(
          orgId,
          { cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] } },
          accountId,
          "tok",
          undefined,
          { onlyNarrows: true },
        ),
      ),
    ).toBe("org.sandbox_egress_not_allowed");
  });

  it("deployment() carries the platform's auto mode and the default cloud network", async () => {
    await storePlatformMode({ mode: "off" });
    const s = settingsWith();
    expect(await s.deployment()).toEqual({
      autoMode: { mode: "off", source: "db" },
      cloudNetwork: { mode: "open", allowHosts: LIMITS.allowHosts },
    });
  });
});

describe("org settings audit", () => {
  it("an unchanged value writes no audit row", async () => {
    const s = settingsWith();
    const updates = () =>
      db
        .selectFrom("audit_events")
        .select("id")
        .where("action", "=", "org.settings_updated")
        .execute();
    await s.update(orgId, { cloudNetwork: { mode: "open" } }, accountId);
    expect(await updates()).toHaveLength(1);
    await s.update(orgId, { cloudNetwork: { mode: "open" } }, accountId);
    expect(await updates()).toHaveLength(1);
  });

  it("keeps keys this version does not know", async () => {
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ futureKey: { enabled: true } }) })
      .where("id", "=", orgId)
      .execute();
    const s = settingsWith();
    const saved: OrgSettings = await s.update(orgId, { autoMode: "off" }, accountId);
    expect(saved).toMatchObject({ autoMode: "off" });
    const row = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(row.settings).toMatchObject({ autoMode: "off", futureKey: { enabled: true } });
  });
});
