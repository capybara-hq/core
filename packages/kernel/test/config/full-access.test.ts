import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { createLogger } from "../../src/log.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};
const log = createLogger("error", { write: () => {} });
const fullAccess = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
  resolveConfig({ ...base, ...raw }, env).devices.fullAccess;

describe("devices.fullAccess (B1 replacement of devices.autoMode)", () => {
  it("has no schema default: an unset source leaves the deployment setting in charge", () => {
    expect(KernelConfigSchema.parse(base).devices.fullAccess).toBeUndefined();
    expect(fullAccess({})).toBeUndefined();
    expect(
      KernelConfigSchema.safeParse({ ...base, devices: { fullAccess: "maybe" } }).success,
    ).toBe(false);
    expect(() => fullAccess({ devices: { fullAccess: "on" } })).toThrow(ConfigError);
  });

  it("reads the new key from the file and the environment", () => {
    expect(fullAccess({ devices: { fullAccess: "off" } })).toBe("off");
    expect(fullAccess({}, { CAPYBARA_DEVICES__FULL_ACCESS: "allowed" })).toBe("allowed");
  });

  it("translates the old key of the same source exactly, keeping its presence", () => {
    expect(fullAccess({ devices: { autoMode: "off" } })).toBe("off");
    expect(fullAccess({ devices: { autoMode: "allowed" } })).toBe("allowed");
    expect(fullAccess({}, { CAPYBARA_DEVICES__AUTO_MODE: "off" })).toBe("off");
    expect(() => fullAccess({ devices: { autoMode: "maybe" } })).toThrow(ConfigError);
    // the old key never survives into the validated config
    expect(
      Object.hasOwn(
        resolveConfig({ ...base, devices: { autoMode: "off" } }, {}).devices as object,
        "autoMode",
      ),
    ).toBe(false);
  });

  it("keeps strict source precedence across old and new keys: env > file", () => {
    expect(
      fullAccess({ devices: { autoMode: "allowed" } }, { CAPYBARA_DEVICES__AUTO_MODE: "off" }),
    ).toBe("off");
    expect(
      fullAccess({ devices: { autoMode: "off" } }, { CAPYBARA_DEVICES__FULL_ACCESS: "allowed" }),
    ).toBe("allowed");
  });

  it("refuses conflicting old and new keys in one source, accepts equal ones", () => {
    expect(() => fullAccess({ devices: { autoMode: "allowed", fullAccess: "off" } })).toThrow(
      /devices\.autoMode.*devices\.fullAccess/s,
    );
    expect(() =>
      fullAccess(
        {},
        { CAPYBARA_DEVICES__AUTO_MODE: "allowed", CAPYBARA_DEVICES__FULL_ACCESS: "off" },
      ),
    ).toThrow(/CAPYBARA_DEVICES__AUTO_MODE/);
    expect(fullAccess({ devices: { autoMode: "off", fullAccess: "off" } })).toBe("off");
  });

  it("labels the winning source of either key", () => {
    const of = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv) =>
      new KernelConfigService(
        { config: resolveConfig({ ...base, ...raw }, env), env },
        log,
      ).fieldSource("devices.fullAccess");
    expect(of({}, { CAPYBARA_DEVICES__AUTO_MODE: "off" })).toBe("env");
    expect(of({}, { CAPYBARA_DEVICES__FULL_ACCESS: "off" })).toBe("env");
    expect(of({ devices: { autoMode: "off" } }, {})).toBe("file");
    expect(of({ devices: { autoMode: "off" } }, { CAPYBARA_CONFIG_SOURCE: "nacos" })).toBe("nacos");
    expect(of({}, {})).toBeUndefined();
  });

  it("a hot change of either key goes through durable publication first", async () => {
    const svc = new KernelConfigService({ config: resolveConfig(base, {}), env: {} }, log);
    const published: [unknown, unknown][] = [];
    await svc.apply({ ...base, devices: { autoMode: "off" } }, async (before, next) => {
      published.push([before.devices.fullAccess, next.devices.fullAccess]);
    });
    expect(published).toEqual([[undefined, "off"]]);
    expect(svc.get().devices.fullAccess).toBe("off");
    await svc.apply({ ...base, devices: { fullAccess: "allowed" } }, async () => {
      throw new Error("lost");
    });
    expect(svc.get().devices.fullAccess).toBe("off");
  });
});
