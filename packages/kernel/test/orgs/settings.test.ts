import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { COMPACTION_SETTINGS, readPromptSuggestions } from "../../src/identity/settings.js";
import {
  type DeviceNetworkSetting,
  effectivePromptSuggestions,
  type OrgSettings,
  OrgSettingsPatchSchema,
  type OrgSettingsService,
  parseOrgSettings,
} from "../../src/orgs/settings.service.js";
import {
  DEVICES_NETWORK_SETTING,
  DEVICES_OUTSIDE_SANDBOX_SETTING,
} from "../../src/sandbox/device-sandbox-settings.js";
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

/**
 * A config holder: the startup config's `devices.outsideSandbox` / `devices.network` (unset here
 * unless the test says so).
 */
const settingsWith = (
  opts: {
    egress?: "none" | "allowlist";
    allowHosts?: string[];
    orgHosts?: "extend" | "within";
    outsideSandbox?: "allowed" | "off";
    networkCeiling?: "open" | "allowlist";
  } = {},
): OrgSettingsService => {
  const { outsideSandbox: _a, networkCeiling: _c, ...limits } = opts;
  const cfg = {
    sandbox: { limits: { ...LIMITS, ...limits } },
    devices: { outsideSandbox: opts.outsideSandbox, network: { ceiling: opts.networkCeiling } },
    attribution: {},
    http: { publicUrl: undefined },
  };
  return orgSettingsFor(db, () => cfg);
};

/** The platform's stored outside-sandbox choice (as the admin console writes it). */
const storePlatformMode = (mode: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key: DEVICES_OUTSIDE_SANDBOX_SETTING, value: JSON.stringify(mode) })
    .execute();

/** The platform's stored network choice. */
const storePlatformNetwork = (value: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key: DEVICES_NETWORK_SETTING, value: JSON.stringify(value) })
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

describe("org outsideSandbox", () => {
  it("absent follows the platform; a person may set it; null clears it", async () => {
    const s = settingsWith();
    expect((await s.get(orgId)).outsideSandbox).toBeUndefined();
    expect(await s.update(orgId, { outsideSandbox: "allowed" }, accountId)).toMatchObject({
      outsideSandbox: "allowed",
    });
    expect((await s.get(orgId)).outsideSandbox).toBe("allowed");
    expect(await s.update(orgId, { outsideSandbox: null }, accountId)).not.toHaveProperty(
      "outsideSandbox",
    );
    expect(await s.update(orgId, { outsideSandbox: "off" }, accountId)).toMatchObject({
      outsideSandbox: "off",
    });
  });

  it("the old names fullAccess, autoMode and cloudNetwork are refused and never answered", async () => {
    const s = settingsWith();
    for (const patch of [
      { autoMode: "off" },
      { fullAccess: "off" },
      { fullAccess: null },
      { cloudNetwork: { mode: "allowlist" } },
      { fullAccess: "off", outsideSandbox: "off" },
    ])
      expect(OrgSettingsPatchSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
    await s.update(orgId, { outsideSandbox: "off" }, accountId);
    for (const key of ["autoMode", "fullAccess", "cloudNetwork"]) {
      expect(await s.get(orgId)).not.toHaveProperty(key);
      expect(await s.deployment()).not.toHaveProperty(key);
    }
  });

  it("allowed while the platform is off is refused for a person too", async () => {
    await storePlatformMode({ permission: "off" });
    const s = settingsWith();
    expect(await codeOf(s.update(orgId, { outsideSandbox: "allowed" }, accountId))).toBe(
      "org.outside_sandbox_not_allowed",
    );
    // off is the only value left, and clearing it is fine (it follows the platform's off)
    expect(await s.update(orgId, { outsideSandbox: "off" }, accountId)).toMatchObject({
      outsideSandbox: "off",
    });
    expect(await s.update(orgId, { outsideSandbox: null }, accountId)).not.toHaveProperty(
      "outsideSandbox",
    );
  });

  it("a configured platform value wins over the stored one", async () => {
    await storePlatformMode({ permission: "allowed" });
    const s = settingsWith({ outsideSandbox: "off" });
    expect((await s.deployment()).outsideSandbox).toEqual({ permission: "off", source: "file" });
    expect(await codeOf(s.update(orgId, { outsideSandbox: "allowed" }, accountId))).toBe(
      "org.outside_sandbox_not_allowed",
    );
  });

  it("an invalid stored platform value reads as off (fail closed)", async () => {
    await storePlatformMode({ permission: "maybe" });
    const s = settingsWith();
    expect((await s.deployment()).outsideSandbox).toEqual({ permission: "off", source: "db" });
    expect(await codeOf(s.update(orgId, { outsideSandbox: "allowed" }, accountId))).toBe(
      "org.outside_sandbox_not_allowed",
    );
  });

  it("a stored org value this version cannot read reads as off, never allowed", () => {
    expect(parseOrgSettings({ outsideSandbox: "maybe" }).outsideSandbox).toBe("off");
    expect(parseOrgSettings({ outsideSandbox: null }).outsideSandbox).toBe("off");
    expect(parseOrgSettings({}).outsideSandbox).toBeUndefined();
    // old stored keys the publication conversion has not reached yet are read too and the
    // narrower wins (fail closed)
    expect(parseOrgSettings({ fullAccess: "allowed" }).outsideSandbox).toBe("allowed");
    expect(parseOrgSettings({ autoMode: "off", outsideSandbox: "allowed" }).outsideSandbox).toBe(
      "off",
    );
    expect(parseOrgSettings({ fullAccess: "maybe" }).outsideSandbox).toBe("off");
  });

  it("the Platform tool / an API token may turn it off, never allow it", async () => {
    const s = settingsWith();
    expect(
      await codeOf(
        s.update(orgId, { outsideSandbox: "off" }, accountId, "tok", undefined, {
          onlyNarrows: true,
        }),
      ),
    ).toBeUndefined();
    for (const outsideSandbox of ["allowed", null] as const)
      expect(
        await codeOf(
          s.update(orgId, { outsideSandbox }, accountId, "tok", undefined, { onlyNarrows: true }),
        ),
      ).toBe("org.outside_sandbox_not_allowed");
    expect((await s.get(orgId)).outsideSandbox).toBe("off");
  });
});

describe("org deviceNetwork", () => {
  const tokenUpdateOf =
    (s: OrgSettingsService) => (patch: { deviceNetwork: DeviceNetworkSetting | null }) =>
      s.update(orgId, patch, accountId, "tok", undefined, { onlyNarrows: true });

  it("stores the delta as given; null follows the platform again", async () => {
    const s = settingsWith();
    expect((await s.deployment()).deviceNetwork).toEqual({
      default: "open",
      ceiling: "open",
      sources: { default: "default", ceiling: "default" },
      allowHosts: LIMITS.allowHosts,
      orgHosts: "extend",
      off: false,
    });
    expect(
      (await s.update(orgId, { deviceNetwork: { ceiling: "allowlist" } }, accountId)).deviceNetwork,
    ).toEqual({ ceiling: "allowlist" });
    const delta = {
      default: "allowlist" as const,
      extraHosts: ["*.corp.example.org"],
      excludedHosts: ["github.com"],
    };
    expect((await s.update(orgId, { deviceNetwork: delta }, accountId)).deviceNetwork).toEqual(
      delta,
    );
    expect(s.effectiveNetwork(await s.get(orgId))).toEqual({
      mode: "allowlist",
      hosts: ["registry.npmjs.org", "*.corp.example.org"],
    });
    expect(await s.update(orgId, { deviceNetwork: null }, accountId)).not.toHaveProperty(
      "deviceNetwork",
    );
  });

  it("a default or ceiling above the platform's ceiling is refused for a person too", async () => {
    await storePlatformNetwork({ ceiling: "allowlist" });
    const s = settingsWith();
    for (const deviceNetwork of [{ ceiling: "open" }, { default: "open" }] as const) {
      const e = await s.update(orgId, { deviceNetwork }, accountId).catch((err: ApiError) => err);
      expect((e as ApiError).code).toBe("org.network_not_allowed");
      expect((e as ApiError).status).toBe(400);
    }
    // the configured ceiling counts the same
    expect(
      await codeOf(
        settingsWith({ networkCeiling: "allowlist" }).update(
          orgId,
          { deviceNetwork: { ceiling: "open" } },
          accountId,
        ),
      ),
    ).toBe("org.network_not_allowed");
    // narrower values, hosts and clearing stay fine
    expect(
      (
        await s.update(
          orgId,
          { deviceNetwork: { ceiling: "allowlist", extraHosts: ["pypi.org"] } },
          accountId,
        )
      ).deviceNetwork,
    ).toEqual({ ceiling: "allowlist", extraHosts: ["pypi.org"] });
    expect(await codeOf(s.update(orgId, { deviceNetwork: null }, accountId))).toBeUndefined();
  });

  it("a default above the org's own ceiling is a validation error", () => {
    expect(
      OrgSettingsPatchSchema.safeParse({ deviceNetwork: { default: "open", ceiling: "allowlist" } })
        .success,
    ).toBe(false);
    expect(
      OrgSettingsPatchSchema.safeParse({ deviceNetwork: { default: "allowlist", ceiling: "open" } })
        .success,
    ).toBe(true);
  });

  it("a platform change reaches an org that stores a delta", async () => {
    await settingsWith().update(
      orgId,
      { deviceNetwork: { ceiling: "allowlist", extraHosts: ["pypi.org"] } },
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
      { ceiling: "none" },
      { mode: "open" },
      { default: "open", extra: 1 },
      { ceiling: "allowlist", allowHosts: ["github.com"] },
      { base: "all" },
      { extraHosts: ["10.0.0.1"] },
      { extraHosts: ["localhost"] },
      { excludedHosts: ["Example.com"] },
      { extraHosts: ["a.example.com", "a.example.com"] },
      { extraHosts: Array.from({ length: 201 }, (_, i) => `h${i}.example.org`) },
    ]) {
      expect(
        OrgSettingsPatchSchema.safeParse({ deviceNetwork: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
    for (const stored of [{ mode: "open" }, { ceiling: "allowlist", allowHosts: ["github.com"] }]) {
      expect(parseOrgSettings({ deviceNetwork: stored }).deviceNetwork).toEqual({
        default: "allowlist",
        ceiling: "allowlist",
        base: "none",
      });
    }
    // an exclusion of a host the platform does not list stays valid
    expect(
      OrgSettingsPatchSchema.safeParse({ deviceNetwork: { excludedHosts: ["gone.example.org"] } })
        .success,
    ).toBe(true);
  });

  it("narrow only (tokens): stored deltas are compared, each widening refused", async () => {
    const s = settingsWith();
    const tokenUpdate = tokenUpdateOf(s);
    // absent = open: setting open explicitly is a no-op
    expect(await codeOf(tokenUpdate({ deviceNetwork: { ceiling: "open" } }))).toBeUndefined();
    // an extra host widens, even one the platform lists today (it would stay when the platform
    // drops it)
    expect(await codeOf(tokenUpdate({ deviceNetwork: { extraHosts: ["a.example.com"] } }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    expect(await codeOf(tokenUpdate({ deviceNetwork: { extraHosts: ["github.com"] } }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    // excluding platform hosts and narrowing to the allowlist narrow
    expect(
      (
        await tokenUpdate({
          deviceNetwork: { ceiling: "allowlist", excludedHosts: ["github.com"] },
        })
      ).deviceNetwork,
    ).toEqual({ ceiling: "allowlist", excludedHosts: ["github.com"] });
    // opening the ceiling or the default where it is the allowlist widens; clearing too
    const opens: (DeviceNetworkSetting | null)[] = [
      { ceiling: "open", excludedHosts: ["github.com"] },
      { excludedHosts: ["github.com"] },
      null,
    ];
    for (const deviceNetwork of opens)
      expect(await codeOf(tokenUpdate({ deviceNetwork }))).toBe("org.network_not_allowed");
    // dropping an exclusion widens the hosts
    expect(await codeOf(tokenUpdate({ deviceNetwork: { ceiling: "allowlist" } }))).toBe(
      "org.sandbox_egress_not_allowed",
    );
    // base none narrows; back to the platform widens
    expect(
      (await tokenUpdate({ deviceNetwork: { ceiling: "allowlist", base: "none" } })).deviceNetwork,
    ).toEqual({ ceiling: "allowlist", base: "none" });
    expect(
      await codeOf(
        tokenUpdate({ deviceNetwork: { ceiling: "allowlist", excludedHosts: ["github.com"] } }),
      ),
    ).toBe("org.sandbox_egress_not_allowed");
    // the default narrows on its own and cannot reopen
    expect(
      (
        await tokenUpdate({
          deviceNetwork: { default: "allowlist", ceiling: "allowlist", base: "none" },
        })
      ).deviceNetwork,
    ).toEqual({ default: "allowlist", ceiling: "allowlist", base: "none" });
    expect(
      await codeOf(tokenUpdate({ deviceNetwork: { ceiling: "allowlist", base: "none" } })),
    ).toBe("org.network_not_allowed");
  });

  it("narrow only (tokens): an extra covered by a stored extra narrows; base none with a platform host is refused (over-strict on purpose)", async () => {
    const s = settingsWith();
    const tokenUpdate = tokenUpdateOf(s);
    await s.update(
      orgId,
      { deviceNetwork: { extraHosts: ["*.example.org", "pypi.org"] } },
      accountId,
    );
    expect(
      (await tokenUpdate({ deviceNetwork: { extraHosts: ["a.example.org"] } })).deviceNetwork,
    ).toEqual({ extraHosts: ["a.example.org"] });
    expect(
      await codeOf(
        tokenUpdate({ deviceNetwork: { base: "none", extraHosts: ["registry.npmjs.org"] } }),
      ),
    ).toBe("org.sandbox_egress_not_allowed");
  });

  it("a token's widening is refused under the kill switch too (it would take effect later)", async () => {
    const s = settingsWith({ egress: "none" });
    expect((await s.deployment()).deviceNetwork.off).toBe(true);
    expect(s.effectiveNetwork(await s.get(orgId))).toEqual({ mode: "allowlist", hosts: [] });
    expect(
      await codeOf(tokenUpdateOf(s)({ deviceNetwork: { extraHosts: ["a.example.com"] } })),
    ).toBe("org.sandbox_egress_not_allowed");
  });

  describe("under the platform hosts ceiling (orgHosts within)", () => {
    it("drops extras outside the platform list on read", async () => {
      await settingsWith().update(
        orgId,
        { deviceNetwork: { extraHosts: ["pypi.org", "github.com"] } },
        accountId,
      );
      const s = settingsWith({ orgHosts: "within" });
      expect(s.effectiveNetwork(await s.get(orgId)).hosts).toEqual([
        "registry.npmjs.org",
        "github.com",
      ]);
      expect((await s.deployment()).deviceNetwork.orgHosts).toBe("within");
    });

    it("refuses a new extra outside the list, for people and tokens", async () => {
      const s = settingsWith({ orgHosts: "within" });
      for (const actor of [undefined, "tok"]) {
        const e = await s
          .update(orgId, { deviceNetwork: { extraHosts: ["pypi.org"] } }, accountId, actor)
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
            { deviceNetwork: { ceiling: "allowlist", base: "none", extraHosts: ["github.com"] } },
            accountId,
          )
        ).deviceNetwork,
      ).toEqual({ ceiling: "allowlist", base: "none", extraHosts: ["github.com"] });
    });

    it("accepts stored values sent back as they are", async () => {
      await settingsWith().update(
        orgId,
        { deviceNetwork: { default: "open", extraHosts: ["pypi.org"] } },
        accountId,
      );
      const s = settingsWith({ orgHosts: "within" });
      expect(
        (
          await s.update(
            orgId,
            {
              deviceNetwork: {
                default: "open",
                extraHosts: ["pypi.org"],
                excludedHosts: ["github.com"],
              },
            },
            accountId,
          )
        ).deviceNetwork,
      ).toEqual({ default: "open", extraHosts: ["pypi.org"], excludedHosts: ["github.com"] });
    });
  });

  it("deployment() carries the platform's device sandbox settings", async () => {
    await storePlatformMode({ permission: "off" });
    await storePlatformNetwork({ default: "allowlist" });
    const s = settingsWith();
    expect(await s.deployment()).toEqual({
      outsideSandbox: { permission: "off", source: "db" },
      deviceNetwork: {
        default: "allowlist",
        ceiling: "open",
        sources: { default: "db", ceiling: "default" },
        allowHosts: LIMITS.allowHosts,
        orgHosts: "extend",
        off: false,
      },
      attribution: {
        commit: "Co-Authored-By: Capybara <noreply@capybarahq.com>",
        pr: "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)",
        sessionUrl: false,
      },
      publicUrl: false,
      // the platform's compaction defaults the org page follows (context compaction spec §4.8)
      compaction: COMPACTION_SETTINGS.parse({}),
      externalSharing: { value: "deny", source: "default" },
      shareMaxExpiryDays: 30,
      promptSuggestions: "on",
    });
  });
});

describe("prompt suggestions (effective)", () => {
  const storePlatform = (value: unknown) =>
    db
      .insertInto("deployment_settings")
      .values({ key: "promptSuggestions", value: JSON.stringify(value) })
      .execute();

  it("effectivePromptSuggestions: the platform on and the org not off", () => {
    expect(effectivePromptSuggestions("on", undefined)).toBe(true);
    expect(effectivePromptSuggestions("on", "on")).toBe(true);
    expect(effectivePromptSuggestions("on", "off")).toBe(false);
    expect(effectivePromptSuggestions("off", undefined)).toBe(false);
    expect(effectivePromptSuggestions("off", "on")).toBe(false);
  });

  it("readPromptSuggestions: absent on, stored off, invalid off with a warning", async () => {
    expect(await readPromptSuggestions(db)).toBe("on");
    await storePlatform("off");
    expect(await readPromptSuggestions(db)).toBe("off");
    await db.deleteFrom("deployment_settings").execute();
    await storePlatform("maybe");
    const warns: string[] = [];
    expect(await readPromptSuggestions(db, { warn: (m: string) => warns.push(m) })).toBe("off");
    expect(warns).toHaveLength(1);
  });

  it("promptSuggestionsEnabled follows the platform and the org", async () => {
    const s = settingsWith();
    expect(await s.promptSuggestionsEnabled(orgId)).toBe(true);
    await s.update(orgId, { promptSuggestions: "off" }, accountId);
    expect(await s.promptSuggestionsEnabled(orgId)).toBe(false);
    await s.update(orgId, { promptSuggestions: null }, accountId);
    expect(await s.promptSuggestionsEnabled(orgId)).toBe(true);
    await s.update(orgId, { promptSuggestions: "on" }, accountId);
    await storePlatform("off");
    expect(await s.promptSuggestionsEnabled(orgId)).toBe(false);
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
    await s.update(orgId, { deviceNetwork: { default: "open" } }, accountId);
    expect(await updates()).toHaveLength(1);
    await s.update(orgId, { deviceNetwork: { default: "open" } }, accountId);
    expect(await updates()).toHaveLength(1);
  });

  it("keeps keys this version does not know", async () => {
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ futureKey: { enabled: true } }) })
      .where("id", "=", orgId)
      .execute();
    const s = settingsWith();
    const saved: OrgSettings = await s.update(orgId, { outsideSandbox: "off" }, accountId);
    expect(saved).toMatchObject({ outsideSandbox: "off" });
    const row = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(row.settings).toMatchObject({ outsideSandbox: "off", futureKey: { enabled: true } });
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
