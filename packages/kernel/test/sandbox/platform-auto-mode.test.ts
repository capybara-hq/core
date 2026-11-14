import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  applyDevicesAutoModePatch,
  DEVICES_AUTO_MODE_SETTING,
  type DevicesAutoMode,
  type DevicesAutoModeSource,
  parseStoredDevicesAutoMode,
  readDevicesAutoMode,
  resolveDevicesAutoMode,
} from "../../src/sandbox/platform-auto-mode.js";

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

/** A config holder: the startup config's `devices.autoMode` and where it comes from. */
const configOf = (
  mode?: DevicesAutoMode,
  source?: Exclude<DevicesAutoModeSource, "db" | "default">,
) => ({
  get: () => ({ devices: { autoMode: mode } }) as never,
  fieldSource: () => source,
});

const store = (value: unknown) =>
  db
    .insertInto("deployment_settings")
    .values({ key: DEVICES_AUTO_MODE_SETTING, value: JSON.stringify(value) })
    .execute();

describe("readDevicesAutoMode", () => {
  it("no row and no startup config: allowed, source default", async () => {
    expect(await readDevicesAutoMode(db, configOf())).toEqual({
      mode: "allowed",
      source: "default",
    });
    // an empty stored choice follows the default too
    await store({});
    expect(await readDevicesAutoMode(db, configOf())).toEqual({
      mode: "allowed",
      source: "default",
    });
  });

  it("the stored choice applies when the startup config is silent", async () => {
    await store({ mode: "off" });
    expect(await readDevicesAutoMode(db, configOf())).toEqual({ mode: "off", source: "db" });
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ mode: "allowed" }) })
      .where("key", "=", DEVICES_AUTO_MODE_SETTING)
      .execute();
    expect(await readDevicesAutoMode(db, configOf())).toEqual({ mode: "allowed", source: "db" });
  });

  it("the startup config wins over the stored choice, whatever its source", async () => {
    await store({ mode: "allowed" });
    expect(await readDevicesAutoMode(db, configOf("off", "env"))).toEqual({
      mode: "off",
      source: "env",
    });
    expect(await readDevicesAutoMode(db, configOf("off", "file"))).toEqual({
      mode: "off",
      source: "file",
    });
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ mode: "off" }) })
      .where("key", "=", DEVICES_AUTO_MODE_SETTING)
      .execute();
    expect(await readDevicesAutoMode(db, configOf("allowed", "nacos"))).toEqual({
      mode: "allowed",
      source: "nacos",
    });
  });

  it("an invalid stored value reads as off (fail closed) with a warning naming the key", async () => {
    const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      warn: (msg: string, fields?: Record<string, unknown>) =>
        warns.push({ msg, ...(fields && { fields }) }),
    };
    for (const invalid of [{ mode: "maybe" }, "off", { enabled: false }, 1]) {
      await db.deleteFrom("deployment_settings").execute();
      await store(invalid);
      expect(await readDevicesAutoMode(db, configOf(), log)).toEqual({
        mode: "off",
        source: "db",
      });
    }
    expect(warns).toHaveLength(4);
    expect(warns[0]?.fields).toEqual({ key: DEVICES_AUTO_MODE_SETTING });
  });
});

describe("parseStoredDevicesAutoMode / applyDevicesAutoModePatch", () => {
  it("parses missing and valid values, narrows an invalid one without a logger", () => {
    expect(parseStoredDevicesAutoMode(undefined)).toEqual({});
    expect(parseStoredDevicesAutoMode({ mode: "off" })).toEqual({ mode: "off" });
    expect(parseStoredDevicesAutoMode({ mode: "allowed" })).toEqual({ mode: "allowed" });
    expect(parseStoredDevicesAutoMode({ mode: "maybe" })).toEqual({ mode: "off" });
  });

  it("applies a patch: a mode replaces, null clears back to the default", () => {
    expect(applyDevicesAutoModePatch({ mode: "allowed" }, { mode: "off" })).toEqual({
      mode: "off",
    });
    expect(applyDevicesAutoModePatch({ mode: "off" }, { mode: null })).toEqual({});
  });
});

describe("resolveDevicesAutoMode", () => {
  it("config > db > default", () => {
    expect(resolveDevicesAutoMode("off", "env", { mode: "allowed" })).toEqual({
      mode: "off",
      source: "env",
    });
    expect(resolveDevicesAutoMode(undefined, undefined, { mode: "off" })).toEqual({
      mode: "off",
      source: "db",
    });
    expect(resolveDevicesAutoMode(undefined, undefined, {})).toEqual({
      mode: "allowed",
      source: "default",
    });
    // a config value without a source cannot happen with the optional schema field; it is ignored
    expect(resolveDevicesAutoMode("off", undefined, { mode: "allowed" })).toEqual({
      mode: "allowed",
      source: "db",
    });
  });
});
