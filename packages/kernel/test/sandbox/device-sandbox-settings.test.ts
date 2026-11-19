import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  applyDevicesNetworkPatch,
  applyDevicesOutsideSandboxPatch,
  DEVICES_NETWORK_SETTING,
  DEVICES_OUTSIDE_SANDBOX_SETTING,
  LEGACY_DEVICES_AUTO_MODE_SETTING,
  LEGACY_DEVICES_FULL_ACCESS_SETTING,
  orgDeviceSandboxOf,
  parseLegacyStoredDevicesAutoMode,
  parseLegacyStoredDevicesFullAccess,
  parseStoredDevicesNetwork,
  parseStoredDevicesOutsideSandbox,
  readDeviceSandboxSettings,
  readDeviceSandboxSettingsView,
  resolveDeviceSandboxSettings,
} from "../../src/sandbox/device-sandbox-settings.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;

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
  await db.deleteFrom("deployment_settings").execute();
});

type Src = "env" | "file" | "nacos";
/** A config holder: the startup config's device sandbox fields and where each comes from. */
const configOf = (
  fields: {
    outsideSandbox?: "allowed" | "off";
    network?: { default?: "open" | "allowlist"; ceiling?: "open" | "allowlist" };
  } = {},
  source: Src = "file",
) => ({
  get: () =>
    ({
      devices: { outsideSandbox: fields.outsideSandbox, network: { ...fields.network } },
    }) as never,
  fieldSource: (path: string) => {
    const v =
      path === "devices.outsideSandbox"
        ? fields.outsideSandbox
        : path === "devices.network.default"
          ? fields.network?.default
          : path === "devices.network.ceiling"
            ? fields.network?.ceiling
            : undefined;
    return v === undefined ? undefined : source;
  },
});

const store = (key: string, value: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key, value: JSON.stringify(value) })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value) }))
    .execute();

describe("readDeviceSandboxSettings (config > db > default)", () => {
  it("no row and no startup config: allowed, open, open", async () => {
    expect(await readDeviceSandboxSettings(db, configOf())).toEqual({
      outsideSandbox: "allowed",
      network: { default: "open", ceiling: "open" },
    });
    expect(await readDeviceSandboxSettingsView(db, configOf())).toEqual({
      outsideSandbox: { permission: "allowed", source: "default" },
      network: {
        default: "open",
        ceiling: "open",
        sources: { default: "default", ceiling: "default" },
      },
    });
  });

  it("the stored choices apply when the startup config is silent", async () => {
    await store(DEVICES_OUTSIDE_SANDBOX_SETTING, { permission: "off" });
    await store(DEVICES_NETWORK_SETTING, { ceiling: "allowlist" });
    expect(await readDeviceSandboxSettingsView(db, configOf())).toEqual({
      outsideSandbox: { permission: "off", source: "db" },
      network: {
        // the default never exceeds the ceiling
        default: "allowlist",
        ceiling: "allowlist",
        sources: { default: "default", ceiling: "db" },
      },
    });
  });

  it("the startup config wins field by field, whatever its source", async () => {
    await store(DEVICES_OUTSIDE_SANDBOX_SETTING, { permission: "allowed" });
    await store(DEVICES_NETWORK_SETTING, { default: "allowlist", ceiling: "allowlist" });
    for (const source of ["env", "file", "nacos"] as const) {
      const view = await readDeviceSandboxSettingsView(
        db,
        configOf({ outsideSandbox: "off", network: { ceiling: "open" } }, source),
      );
      expect(view).toEqual({
        outsideSandbox: { permission: "off", source },
        network: {
          default: "allowlist",
          ceiling: "open",
          sources: { default: "db", ceiling: source },
        },
      });
    }
  });

  it("an invalid stored value reads narrower (fail closed) with a warning naming the key", async () => {
    const warns: Record<string, unknown>[] = [];
    const log = { warn: (_m: string, f?: Record<string, unknown>) => warns.push(f ?? {}) };
    await store(DEVICES_OUTSIDE_SANDBOX_SETTING, { permission: "maybe" });
    await store(DEVICES_NETWORK_SETTING, { ceiling: "public" });
    expect(await readDeviceSandboxSettings(db, configOf(), log)).toEqual({
      outsideSandbox: "off",
      network: { default: "allowlist", ceiling: "allowlist" },
    });
    expect(warns).toEqual([
      { key: DEVICES_OUTSIDE_SANDBOX_SETTING },
      { key: DEVICES_NETWORK_SETTING },
    ]);
  });
});

describe("old platform keys (read narrower until the publication converts them)", () => {
  it("an old off reads as outside off and the allowlist ceiling; allowed reads as allowed", async () => {
    for (const [key, value] of [
      [LEGACY_DEVICES_FULL_ACCESS_SETTING, { permission: "off" }],
      [LEGACY_DEVICES_AUTO_MODE_SETTING, { mode: "off" }],
    ] as const) {
      await db.deleteFrom("deployment_settings").execute();
      await store(key, value);
      expect(await readDeviceSandboxSettings(db, configOf())).toEqual({
        outsideSandbox: "off",
        network: { default: "allowlist", ceiling: "allowlist" },
      });
    }
    await db.deleteFrom("deployment_settings").execute();
    await store(LEGACY_DEVICES_FULL_ACCESS_SETTING, { permission: "allowed" });
    expect(await readDeviceSandboxSettings(db, configOf())).toEqual({
      outsideSandbox: "allowed",
      network: { default: "open", ceiling: "open" },
    });
  });

  it("never widens a new key: the narrower of the old and the new wins", async () => {
    await store(DEVICES_OUTSIDE_SANDBOX_SETTING, { permission: "allowed" });
    await store(LEGACY_DEVICES_FULL_ACCESS_SETTING, { permission: "off" });
    expect((await readDeviceSandboxSettings(db, configOf())).outsideSandbox).toBe("off");
    await store(LEGACY_DEVICES_FULL_ACCESS_SETTING, { permission: "maybe" });
    expect((await readDeviceSandboxSettings(db, configOf())).outsideSandbox).toBe("off");
  });

  it("a network stored in step with an old off is not narrowed again", async () => {
    await store(DEVICES_OUTSIDE_SANDBOX_SETTING, { permission: "off" });
    await store(LEGACY_DEVICES_FULL_ACCESS_SETTING, { permission: "off" });
    await store(DEVICES_NETWORK_SETTING, { ceiling: "open" });
    expect((await readDeviceSandboxSettings(db, configOf())).network.ceiling).toBe("open");
  });
});

describe("pure parsers and patches", () => {
  it("parse missing and valid values; narrow invalid ones", () => {
    expect(parseStoredDevicesOutsideSandbox(undefined)).toEqual({});
    expect(parseStoredDevicesOutsideSandbox({ permission: "allowed" })).toEqual({
      permission: "allowed",
    });
    expect(parseStoredDevicesOutsideSandbox("off")).toEqual({ permission: "off" });
    expect(parseStoredDevicesNetwork(undefined)).toEqual({});
    expect(parseStoredDevicesNetwork({ default: "open" })).toEqual({ default: "open" });
    expect(parseStoredDevicesNetwork({ mode: "open" })).toEqual({
      default: "allowlist",
      ceiling: "allowlist",
    });
  });

  it("convert the old keys exactly, an off with the allowlist ceiling, never wider", () => {
    expect(parseLegacyStoredDevicesFullAccess({ permission: "allowed" })).toEqual({
      outsideSandbox: { permission: "allowed" },
      network: {},
    });
    expect(parseLegacyStoredDevicesFullAccess({})).toEqual({ outsideSandbox: {}, network: {} });
    for (const off of [{ permission: "off" }, { permission: "maybe" }, "off", null])
      expect(parseLegacyStoredDevicesFullAccess(off)).toEqual({
        outsideSandbox: { permission: "off" },
        network: { ceiling: "allowlist" },
      });
    expect(parseLegacyStoredDevicesAutoMode({ mode: "allowed" })).toEqual({
      outsideSandbox: { permission: "allowed" },
      network: {},
    });
    expect(parseLegacyStoredDevicesAutoMode({ mode: "off" }).network).toEqual({
      ceiling: "allowlist",
    });
  });

  it("apply patches: a value replaces, null clears back to the default", () => {
    expect(
      applyDevicesOutsideSandboxPatch({ permission: "allowed" }, { permission: "off" }),
    ).toEqual({ permission: "off" });
    expect(applyDevicesOutsideSandboxPatch({ permission: "off" }, { permission: null })).toEqual(
      {},
    );
    expect(
      applyDevicesNetworkPatch({ default: "allowlist", ceiling: "allowlist" }, { ceiling: null }),
    ).toEqual({ default: "allowlist" });
    expect(applyDevicesNetworkPatch({}, { default: "open", ceiling: "open" })).toEqual({
      default: "open",
      ceiling: "open",
    });
  });

  it("resolve ignores a config value without a source", () => {
    expect(
      resolveDeviceSandboxSettings(
        { outsideSandbox: "off", sources: {} },
        { outsideSandbox: { permission: "allowed" }, network: {} },
      ).outsideSandbox,
    ).toEqual({ permission: "allowed", source: "db" });
  });
});

describe("orgDeviceSandboxOf (org stored keys, the Migration table)", () => {
  it("absent stays absent: the org follows the platform", () => {
    expect(orgDeviceSandboxOf({})).toEqual({});
    expect(orgDeviceSandboxOf({ cloudNetwork: { mode: "open" } })).toEqual({});
    expect(orgDeviceSandboxOf({ fullAccess: "allowed" })).toEqual({ outsideSandbox: "allowed" });
  });

  it("cloudNetwork allowlist becomes the allowlist ceiling, keeping the host delta", () => {
    const hosts = { base: "none", extraHosts: ["pypi.org"], excludedHosts: ["github.com"] };
    expect(orgDeviceSandboxOf({ cloudNetwork: { mode: "allowlist", ...hosts } })).toEqual({
      deviceNetwork: { ceiling: "allowlist", ...hosts },
    });
    expect(orgDeviceSandboxOf({ cloudNetwork: { mode: "open", ...hosts } })).toEqual({
      deviceNetwork: hosts,
    });
    // an invalid old value reads as the empty allowlist, as before
    expect(orgDeviceSandboxOf({ cloudNetwork: { mode: "wide" } })).toEqual({
      deviceNetwork: { default: "allowlist", ceiling: "allowlist", base: "none" },
    });
  });

  it("fullAccess / autoMode off becomes outside off and the allowlist ceiling", () => {
    for (const key of ["fullAccess", "autoMode"])
      expect(
        orgDeviceSandboxOf({ [key]: "off", cloudNetwork: { extraHosts: ["a.example"] } }),
      ).toEqual({
        outsideSandbox: "off",
        deviceNetwork: { ceiling: "allowlist", extraHosts: ["a.example"] },
      });
    expect(orgDeviceSandboxOf({ fullAccess: "maybe" })).toEqual({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist" },
    });
  });

  it("the new keys win only when the old ones are in step; a divergent old key narrows", () => {
    // in step: what a write leaves next to the new keys
    expect(
      orgDeviceSandboxOf({
        outsideSandbox: "off",
        fullAccess: "off",
        deviceNetwork: { ceiling: "open", extraHosts: ["a.example"] },
        cloudNetwork: { extraHosts: ["a.example"] },
      }),
    ).toEqual({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "open", extraHosts: ["a.example"] },
    });
    // the follow marker a write leaves while old keys are stored
    expect(
      orgDeviceSandboxOf({ outsideSandbox: "off", fullAccess: "off", deviceNetwork: {} }),
    ).toEqual({ outsideSandbox: "off" });
    // an old replica wrote its keys after the new ones: the narrower wins
    expect(
      orgDeviceSandboxOf({
        outsideSandbox: "allowed",
        fullAccess: "off",
        deviceNetwork: { extraHosts: ["a.example", "b.example"] },
        cloudNetwork: { mode: "allowlist", extraHosts: ["a.example"] },
      }),
    ).toEqual({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts: ["a.example"] },
    });
  });
});
