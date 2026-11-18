import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { COMPACTION_SETTINGS } from "../../src/identity/settings.js";
import {
  type CloudNetworkSetting,
  type OrgSettings,
  OrgSettingsPatchSchema,
  type OrgSettingsService,
  orgSettingsView,
  parseOrgSettings,
} from "../../src/orgs/settings.service.js";
import { orgAllowedDomains } from "../../src/sandbox/modes.js";
import { DEVICES_FULL_ACCESS_SETTING } from "../../src/sandbox/platform-full-access.js";
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
  orgHosts: "extend" as "extend" | "within",
  cpu: 1,
  memoryMb: 2048,
};

/** The deployment side of {@link orgAllowedDomains}: the org's list, else this one. */
const DEPLOYMENT = {
  fullAccess: "allowed" as const,
  limits: { egress: LIMITS.egress, allowHosts: LIMITS.allowHosts, orgHosts: LIMITS.orgHosts },
};

/** A config holder: the startup config's `devices.fullAccess` (unset here unless the test says so). */
const settingsWith = (
  opts: {
    egress?: "none" | "allowlist";
    allowHosts?: string[];
    orgHosts?: "extend" | "within";
    fullAccess?: "allowed" | "off";
  } = {},
): OrgSettingsService => {
  const { fullAccess: _a, ...limits } = opts;
  const cfg = {
    sandbox: { limits: { ...LIMITS, ...limits } },
    devices: { fullAccess: opts.fullAccess },
    attribution: {},
    http: { publicUrl: undefined },
  };
  return orgSettingsFor(db, () => cfg);
};

/** The platform's stored Full switch (as the admin console writes it). */
const storePlatformMode = (mode: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key: DEVICES_FULL_ACCESS_SETTING, value: JSON.stringify(mode) })
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
});

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

describe("org fullAccess (B1)", () => {
  it("absent follows the platform; a person may set it; null clears it", async () => {
    const s = settingsWith();
    expect((await s.get(orgId)).fullAccess).toBeUndefined();
    expect(await s.update(orgId, { fullAccess: "allowed" }, accountId)).toMatchObject({
      fullAccess: "allowed",
    });
    expect((await s.get(orgId)).fullAccess).toBe("allowed");
    expect(await s.update(orgId, { fullAccess: null }, accountId)).not.toHaveProperty("fullAccess");
    expect(await s.update(orgId, { fullAccess: "off" }, accountId)).toMatchObject({
      fullAccess: "off",
    });
  });

  it("the old name autoMode is still accepted and stored as fullAccess, never with it", async () => {
    const s = settingsWith();
    expect(await s.update(orgId, { autoMode: "off" }, accountId)).toMatchObject({
      fullAccess: "off",
    });
    const stored = async () =>
      (
        await db
          .selectFrom("orgs")
          .select("settings")
          .where("id", "=", orgId)
          .executeTakeFirstOrThrow()
      ).settings as Record<string, unknown>;
    expect(await stored()).toMatchObject({ fullAccess: "off" });
    expect(await stored()).not.toHaveProperty("autoMode");
    expect(await s.update(orgId, { autoMode: null }, accountId)).not.toHaveProperty("fullAccess");
    expect(OrgSettingsPatchSchema.safeParse({ autoMode: "off", fullAccess: "off" }).success).toBe(
      false,
    );
    // the answer mirrors fullAccess under the old name until the old readers go
    expect(orgSettingsView(parseOrgSettings({ fullAccess: "off" }))).toMatchObject({
      fullAccess: "off",
      autoMode: "off",
    });
    expect(orgSettingsView(parseOrgSettings({}))).not.toHaveProperty("autoMode");
  });

  it("allowed while the platform is off is refused for a person too", async () => {
    await storePlatformMode({ permission: "off" });
    const s = settingsWith();
    expect(await codeOf(s.update(orgId, { fullAccess: "allowed" }, accountId))).toBe(
      "org.full_access_not_allowed",
    );
    expect(await codeOf(s.update(orgId, { autoMode: "allowed" }, accountId))).toBe(
      "org.full_access_not_allowed",
    );
    // off is the only value left, and clearing it is fine (it follows the platform's off)
    expect(await s.update(orgId, { fullAccess: "off" }, accountId)).toMatchObject({
      fullAccess: "off",
    });
    expect(await s.update(orgId, { fullAccess: null }, accountId)).not.toHaveProperty("fullAccess");
  });

  it("a configured platform value wins over the stored one", async () => {
    await storePlatformMode({ permission: "allowed" });
    const s = settingsWith({ fullAccess: "off" });
    expect((await s.deployment()).fullAccess).toEqual({ permission: "off", source: "file" });
    expect(await codeOf(s.update(orgId, { fullAccess: "allowed" }, accountId))).toBe(
      "org.full_access_not_allowed",
    );
  });

  it("an invalid stored platform value reads as off (fail closed)", async () => {
    await storePlatformMode({ permission: "maybe" });
    const s = settingsWith();
    expect((await s.deployment()).fullAccess).toEqual({ permission: "off", source: "db" });
    expect((await s.deployment()).autoMode).toEqual({ mode: "off", source: "db" });
    expect(await codeOf(s.update(orgId, { fullAccess: "allowed" }, accountId))).toBe(
      "org.full_access_not_allowed",
    );
  });

  it("a stored org value this version cannot read reads as off, never allowed", () => {
    expect(parseOrgSettings({ fullAccess: "maybe" }).fullAccess).toBe("off");
    expect(parseOrgSettings({ fullAccess: null }).fullAccess).toBe("off");
    expect(parseOrgSettings({}).fullAccess).toBeUndefined();
    // until 8.6 the old stored key is read too and the narrower wins (fail closed)
    expect(parseOrgSettings({ autoMode: "allowed" }).fullAccess).toBeUndefined();
    expect(parseOrgSettings({ autoMode: "off", fullAccess: "allowed" }).fullAccess).toBe("off");
    expect(parseOrgSettings({ autoMode: "maybe" }).fullAccess).toBe("off");
  });

  it("the Platform tool / an API token may turn Full off, never allow it", async () => {
    const s = settingsWith();
    expect(
      await codeOf(
        s.update(orgId, { fullAccess: "off" }, accountId, "tok", undefined, { onlyNarrows: true }),
      ),
    ).toBeUndefined();
    for (const patch of [{ fullAccess: "allowed" as const }, { autoMode: "allowed" as const }])
      expect(
        await codeOf(s.update(orgId, patch, accountId, "tok", undefined, { onlyNarrows: true })),
      ).toBe("org.full_access_not_allowed");
    expect((await s.get(orgId)).fullAccess).toBe("off");
  });
});

describe("org cloudNetwork", () => {
  const tokenUpdateOf =
    (s: OrgSettingsService) => (patch: { cloudNetwork: CloudNetworkSetting | null }) =>
      s.update(orgId, patch, accountId, "tok", undefined, { onlyNarrows: true });

  it("stores the delta as given; null follows the platform again", async () => {
    const s = settingsWith();
    expect((await s.deployment()).cloudNetwork).toEqual({
      allowHosts: LIMITS.allowHosts,
      orgHosts: "extend",
      off: false,
    });
    expect(
      (await s.update(orgId, { cloudNetwork: { mode: "allowlist" } }, accountId)).cloudNetwork,
    ).toEqual({ mode: "allowlist" });
    const delta = {
      mode: "allowlist" as const,
      extraHosts: ["*.corp.example.org"],
      excludedHosts: ["github.com"],
    };
    expect((await s.update(orgId, { cloudNetwork: delta }, accountId)).cloudNetwork).toEqual(delta);
    expect(s.effectiveNetwork(await s.get(orgId))).toEqual({
      mode: "allowlist",
      hosts: ["registry.npmjs.org", "*.corp.example.org"],
    });
    expect(await s.update(orgId, { cloudNetwork: null }, accountId)).not.toHaveProperty(
      "cloudNetwork",
    );
  });

  it("a platform change reaches an org that stores a delta", async () => {
    await settingsWith().update(
      orgId,
      { cloudNetwork: { mode: "allowlist", extraHosts: ["pypi.org"] } },
      accountId,
    );
    const stored = await settingsWith().get(orgId);
    expect(settingsWith({ allowHosts: ["a.example.org"] }).effectiveNetwork(stored).hosts).toEqual([
      "a.example.org",
      "pypi.org",
    ]);
    expect(settingsWith({ allowHosts: [] }).effectiveNetwork(stored).hosts).toEqual(["pypi.org"]);
  });

  it("validates the shape and the hosts; an invalid stored value reads as an empty allowlist", () => {
    for (const bad of [
      { mode: "none" },
      { mode: "open", extra: 1 },
      { mode: "allowlist", allowHosts: ["github.com"] },
      { base: "all" },
      { extraHosts: ["10.0.0.1"] },
      { extraHosts: ["localhost"] },
      { excludedHosts: ["Example.com"] },
      { extraHosts: ["a.example.com", "a.example.com"] },
      { extraHosts: Array.from({ length: 201 }, (_, i) => `h${i}.example.org`) },
    ]) {
      expect(
        OrgSettingsPatchSchema.safeParse({ cloudNetwork: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
    // an old copy (`allowHosts`) and anything else invalid read as the empty allowlist
    for (const stored of [
      { mode: "open", extra: 1 },
      { mode: "allowlist", allowHosts: ["github.com"] },
    ]) {
      expect(parseOrgSettings({ cloudNetwork: stored }).cloudNetwork).toEqual({
        mode: "allowlist",
        base: "none",
      });
    }
    // an exclusion of a host the platform does not list stays valid
    expect(
      OrgSettingsPatchSchema.safeParse({ cloudNetwork: { excludedHosts: ["gone.example.org"] } })
        .success,
    ).toBe(true);
  });

  it("narrow only (tokens): stored deltas are compared, each widening refused", async () => {
    const s = settingsWith();
    const tokenUpdate = tokenUpdateOf(s);
    // absent = open: setting open explicitly is a no-op
    expect(await codeOf(tokenUpdate({ cloudNetwork: { mode: "open" } }))).toBeUndefined();
    // an extra host widens, even one the platform lists today (it would stay when the platform
    // drops it)
    expect(await codeOf(tokenUpdate({ cloudNetwork: { extraHosts: ["a.example.com"] } }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    expect(await codeOf(tokenUpdate({ cloudNetwork: { extraHosts: ["github.com"] } }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    // excluding platform hosts and switching to the allowlist narrow
    expect(
      (
        await tokenUpdate({
          cloudNetwork: { mode: "allowlist", excludedHosts: ["github.com"] },
        })
      ).cloudNetwork,
    ).toEqual({ mode: "allowlist", excludedHosts: ["github.com"] });
    // open where it is the allowlist widens; so does dropping an exclusion, and clearing
    expect(
      await codeOf(tokenUpdate({ cloudNetwork: { mode: "open", excludedHosts: ["github.com"] } })),
    ).toBe("org.sandbox_egress_not_allowed");
    expect(await codeOf(tokenUpdate({ cloudNetwork: { mode: "allowlist" } }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    expect(await codeOf(tokenUpdate({ cloudNetwork: null }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    // base none narrows; back to the platform widens
    expect(
      (await tokenUpdate({ cloudNetwork: { mode: "allowlist", base: "none" } })).cloudNetwork,
    ).toEqual({ mode: "allowlist", base: "none" });
    expect(
      await codeOf(
        tokenUpdate({ cloudNetwork: { mode: "allowlist", excludedHosts: ["github.com"] } }),
      ),
    ).toBe("org.sandbox_egress_not_allowed");
  });

  it("narrow only (tokens): an extra covered by a stored extra narrows; base none with a platform host is refused (over-strict on purpose)", async () => {
    const s = settingsWith();
    const tokenUpdate = tokenUpdateOf(s);
    await s.update(
      orgId,
      { cloudNetwork: { extraHosts: ["*.example.org", "pypi.org"] } },
      accountId,
    );
    expect(
      (await tokenUpdate({ cloudNetwork: { extraHosts: ["a.example.org"] } })).cloudNetwork,
    ).toEqual({ extraHosts: ["a.example.org"] });
    // a narrowing these rules refuse: a platform host pinned as an extra under base none
    expect(
      await codeOf(
        tokenUpdate({ cloudNetwork: { base: "none", extraHosts: ["registry.npmjs.org"] } }),
      ),
    ).toBe("org.sandbox_egress_not_allowed");
  });

  it("a token's widening is refused under the kill switch too (it would take effect later)", async () => {
    const s = settingsWith({ egress: "none" });
    expect((await s.deployment()).cloudNetwork).toEqual({
      allowHosts: LIMITS.allowHosts,
      orgHosts: "extend",
      off: true,
    });
    expect(s.effectiveNetwork(await s.get(orgId))).toEqual({ mode: "allowlist", hosts: [] });
    expect(
      await codeOf(tokenUpdateOf(s)({ cloudNetwork: { extraHosts: ["a.example.com"] } })),
    ).toBe("org.sandbox_egress_not_allowed");
  });

  describe("under the platform ceiling (orgHosts within)", () => {
    it("forces the allowlist and drops extras outside the platform list on read", async () => {
      await settingsWith().update(
        orgId,
        { cloudNetwork: { mode: "open", extraHosts: ["pypi.org", "github.com"] } },
        accountId,
      );
      const s = settingsWith({ orgHosts: "within" });
      expect(s.effectiveNetwork(await s.get(orgId))).toEqual({
        mode: "allowlist",
        hosts: ["registry.npmjs.org", "github.com"],
      });
      expect((await s.deployment()).cloudNetwork.orgHosts).toBe("within");
    });

    it("refuses a new open mode or a new extra outside the list, for people and tokens", async () => {
      const s = settingsWith({ orgHosts: "within" });
      for (const actor of [undefined, "tok"]) {
        const opts = actor === undefined ? undefined : { onlyNarrows: true };
        expect(
          await codeOf(
            s.update(orgId, { cloudNetwork: { mode: "open" } }, accountId, actor, undefined, opts),
          ),
        ).toBe("org.sandbox_egress_not_allowed");
        const e = await s
          .update(orgId, { cloudNetwork: { extraHosts: ["pypi.org"] } }, accountId, actor)
          .catch((err: ApiError) => err);
        expect((e as ApiError).code).toBe("org.sandbox_egress_not_allowed");
        expect((e as ApiError).message).toContain("pypi.org");
        expect((e as ApiError).message).toContain("super admin");
        expect((e as ApiError).details).toEqual([
          { reason: "outside_ceiling", hosts: ["pypi.org"] },
        ]);
      }
      // a person may still add a host the platform list covers
      expect(
        (
          await s.update(
            orgId,
            { cloudNetwork: { mode: "allowlist", base: "none", extraHosts: ["github.com"] } },
            accountId,
          )
        ).cloudNetwork,
      ).toEqual({ mode: "allowlist", base: "none", extraHosts: ["github.com"] });
    });

    it("accepts stored values sent back as they are", async () => {
      await settingsWith().update(
        orgId,
        { cloudNetwork: { mode: "open", extraHosts: ["pypi.org"] } },
        accountId,
      );
      const s = settingsWith({ orgHosts: "within" });
      expect(
        (
          await s.update(
            orgId,
            {
              cloudNetwork: {
                mode: "open",
                extraHosts: ["pypi.org"],
                excludedHosts: ["github.com"],
              },
            },
            accountId,
          )
        ).cloudNetwork,
      ).toEqual({ mode: "open", extraHosts: ["pypi.org"], excludedHosts: ["github.com"] });
    });
  });

  it("deployment() carries the platform's Full switch and the default cloud network", async () => {
    await storePlatformMode({ permission: "off" });
    const s = settingsWith();
    expect(await s.deployment()).toEqual({
      fullAccess: { permission: "off", source: "db" },
      autoMode: { mode: "off", source: "db" },
      cloudNetwork: { allowHosts: LIMITS.allowHosts, orgHosts: "extend", off: false },
      attribution: {
        commit: "Co-Authored-By: Capybara <noreply@capybarahq.com>",
        pr: "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)",
        sessionUrl: false,
      },
      publicUrl: false,
      // the platform's compaction defaults the org page follows (context compaction spec §4.8)
      compaction: COMPACTION_SETTINGS.parse({}),
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
    const saved: OrgSettings = await s.update(orgId, { fullAccess: "off" }, accountId);
    expect(saved).toMatchObject({ fullAccess: "off" });
    const row = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(row.settings).toMatchObject({ fullAccess: "off", futureKey: { enabled: true } });
  });
});

describe("org security settings read narrow", () => {
  const storedSettings = async () =>
    (
      await db
        .selectFrom("orgs")
        .select("settings")
        .where("id", "=", orgId)
        .executeTakeFirstOrThrow()
    ).settings as Record<string, unknown>;
  const store = (settings: unknown) =>
    db
      .updateTable("orgs")
      .set({ settings: JSON.stringify(settings) })
      .where("id", "=", orgId)
      .execute();

  it("an unreadable sandboxToolPolicy reads as ask", async () => {
    await store({ sandboxToolPolicy: "deny" });
    expect((await settingsWith().get(orgId)).sandboxToolPolicy).toBe("ask");
  });

  it("a write that does not save forbiddenTools keeps an unreadable list unreadable", async () => {
    await store({ scheduledTasks: { forbiddenTools: "Bash", maxRunsPerHour: 7 } });
    const s = settingsWith();
    await s.update(orgId, { locale: "zh" }, accountId);
    await s.update(orgId, { scheduledTasks: { enabled: false } }, accountId);
    expect((await storedSettings()).scheduledTasks).toMatchObject({
      enabled: false,
      maxRunsPerHour: 7,
      forbiddenTools: "Bash",
    });
    // a group that is not an object: written with a null list, still unreadable
    await store({ scheduledTasks: "junk" });
    await s.update(orgId, { locale: "zh" }, accountId);
    expect((await storedSettings()).scheduledTasks).toMatchObject({ forbiddenTools: null });
    // saving the list fixes it, even when it saves what the list read as ([])
    await s.update(orgId, { scheduledTasks: { forbiddenTools: [] } }, accountId);
    expect((await storedSettings()).scheduledTasks).toMatchObject({ forbiddenTools: [] });
  });

  it("saving sandboxToolPolicy as what it read as repairs the stored value", async () => {
    await store({ sandboxToolPolicy: "deny" });
    await settingsWith().update(orgId, { sandboxToolPolicy: "ask" }, accountId);
    expect((await storedSettings()).sandboxToolPolicy).toBe("ask");
  });

  it("the responses flag an unreadable list; the flag is never stored; a repair is audited", async () => {
    await store({ scheduledTasks: { forbiddenTools: 7 } });
    const s = settingsWith();
    expect((await s.get(orgId)).scheduledTasks).toMatchObject({
      forbiddenTools: [],
      forbiddenToolsUnreadable: true,
    });
    // a write that keeps it unreadable says so too, and stores no flag
    const kept = await s.update(orgId, { locale: "zh" }, accountId);
    expect(kept.scheduledTasks.forbiddenToolsUnreadable).toBe(true);
    expect((await storedSettings()).scheduledTasks).not.toHaveProperty("forbiddenToolsUnreadable");
    const fixed = await s.update(orgId, { scheduledTasks: { forbiddenTools: [] } }, accountId);
    expect(fixed.scheduledTasks).not.toHaveProperty("forbiddenToolsUnreadable");
    expect((await s.get(orgId)).scheduledTasks).not.toHaveProperty("forbiddenToolsUnreadable");
    const details = (
      await db
        .selectFrom("audit_events")
        .select("detail")
        .where("action", "=", "org.settings_updated")
        .execute()
    ).map((r) => (r.detail as { repaired?: boolean }).repaired);
    // the locale write repaired nothing; the list save did
    expect(details).toHaveLength(2);
    expect(details.filter((r) => r !== undefined)).toEqual([true]);
  });

  it("a write still validates forbiddenTools", () => {
    expect(
      OrgSettingsPatchSchema.safeParse({ scheduledTasks: { forbiddenTools: "Bash" } }).success,
    ).toBe(false);
  });
});
