import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  applyDevicesFullAccessPatch,
  DEVICES_FULL_ACCESS_SETTING,
  type DevicesFullAccessSource,
  type FullAccessPermission,
  parseLegacyStoredDevicesAutoMode,
  parseStoredDevicesFullAccess,
  readDevicesFullAccess,
  resolveDevicesFullAccess,
} from "../../src/sandbox/platform-full-access.js";

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

/** A config holder: the startup config's `devices.fullAccess` and where it comes from. */
const configOf = (
  mode?: FullAccessPermission,
  source?: Exclude<DevicesFullAccessSource, "db" | "default">,
) => ({
  get: () => ({ devices: { fullAccess: mode } }) as never,
  fieldSource: () => source,
});

const store = (value: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key: DEVICES_FULL_ACCESS_SETTING, value: JSON.stringify(value) })
    .execute();

describe("readDevicesFullAccess (allowed / off / default / configured over DB)", () => {
  it("no row and no startup config: allowed, source default", async () => {
    expect(await readDevicesFullAccess(db, configOf())).toEqual({
      permission: "allowed",
      source: "default",
    });
    // an empty stored choice follows the default too
    await store({});
    expect(await readDevicesFullAccess(db, configOf())).toEqual({
      permission: "allowed",
      source: "default",
    });
  });

  it("the stored choice applies when the startup config is silent", async () => {
    await store({ permission: "off" });
    expect(await readDevicesFullAccess(db, configOf())).toEqual({
      permission: "off",
      source: "db",
    });
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ permission: "allowed" }) })
      .where("key", "=", DEVICES_FULL_ACCESS_SETTING)
      .execute();
    expect(await readDevicesFullAccess(db, configOf())).toEqual({
      permission: "allowed",
      source: "db",
    });
  });

  it("the startup config wins over the stored choice, whatever its source", async () => {
    await store({ permission: "allowed" });
    expect(await readDevicesFullAccess(db, configOf("off", "env"))).toEqual({
      permission: "off",
      source: "env",
    });
    expect(await readDevicesFullAccess(db, configOf("off", "file"))).toEqual({
      permission: "off",
      source: "file",
    });
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ permission: "off" }) })
      .where("key", "=", DEVICES_FULL_ACCESS_SETTING)
      .execute();
    expect(await readDevicesFullAccess(db, configOf("allowed", "nacos"))).toEqual({
      permission: "allowed",
      source: "nacos",
    });
  });

  it("an invalid stored value reads as off (fail closed) with a warning naming the key", async () => {
    const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      warn: (msg: string, fields?: Record<string, unknown>) =>
        warns.push({ msg, ...(fields && { fields }) }),
    };
    for (const invalid of [{ permission: "maybe" }, "off", { enabled: false }, 1]) {
      await db.deleteFrom("deployment_settings").execute();
      await store(invalid);
      expect(await readDevicesFullAccess(db, configOf(), log)).toEqual({
        permission: "off",
        source: "db",
      });
    }
    expect(warns).toHaveLength(4);
    expect(warns[0]?.fields).toEqual({ key: DEVICES_FULL_ACCESS_SETTING });
  });
});

describe("parseStoredDevicesFullAccess / applyDevicesFullAccessPatch", () => {
  it("parses missing and valid values, narrows an invalid one without a logger", () => {
    expect(parseStoredDevicesFullAccess(undefined)).toEqual({});
    expect(parseStoredDevicesFullAccess({ permission: "off" })).toEqual({ permission: "off" });
    expect(parseStoredDevicesFullAccess({ permission: "allowed" })).toEqual({
      permission: "allowed",
    });
    expect(parseStoredDevicesFullAccess({ permission: "maybe" })).toEqual({ permission: "off" });
  });

  it("applies a patch: a permission replaces, null clears back to the default", () => {
    expect(applyDevicesFullAccessPatch({ permission: "allowed" }, { permission: "off" })).toEqual({
      permission: "off",
    });
    expect(applyDevicesFullAccessPatch({ permission: "off" }, { permission: null })).toEqual({});
  });
});

describe("resolveDevicesFullAccess", () => {
  it("config > db > default", () => {
    expect(resolveDevicesFullAccess("off", "env", { permission: "allowed" })).toEqual({
      permission: "off",
      source: "env",
    });
    expect(resolveDevicesFullAccess(undefined, undefined, { permission: "off" })).toEqual({
      permission: "off",
      source: "db",
    });
    expect(resolveDevicesFullAccess(undefined, undefined, {})).toEqual({
      permission: "allowed",
      source: "default",
    });
    // a config value without a source cannot happen with the optional schema field; it is ignored
    expect(resolveDevicesFullAccess("off", undefined, { permission: "allowed" })).toEqual({
      permission: "allowed",
      source: "db",
    });
  });
});

describe("parseLegacyStoredDevicesAutoMode (the one-time conversion)", () => {
  it("maps exactly, keeps an empty choice empty, makes an invalid one explicit off", () => {
    const warns: string[] = [];
    const log = { warn: (msg: string) => warns.push(msg) };
    expect(parseLegacyStoredDevicesAutoMode({ mode: "allowed" }, log)).toEqual({
      permission: "allowed",
    });
    expect(parseLegacyStoredDevicesAutoMode({ mode: "off" }, log)).toEqual({ permission: "off" });
    expect(parseLegacyStoredDevicesAutoMode({}, log)).toEqual({});
    expect(warns).toEqual([]);
    for (const invalid of [{ mode: "maybe" }, "off", { permission: "allowed" }, null])
      expect(parseLegacyStoredDevicesAutoMode(invalid, log)).toEqual({ permission: "off" });
    expect(warns).toHaveLength(4);
  });
});
