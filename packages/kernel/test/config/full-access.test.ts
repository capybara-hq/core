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

describe("devices.fullAccess (the old devices.autoMode is refused)", () => {
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

  it("refuses the old file / Nacos key with the conversion message (W5-P3b)", () => {
    for (const value of ["off", "allowed", "maybe"]) {
      const thrown = (() => {
        try {
          fullAccess({ devices: { autoMode: value } });
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(thrown).toBeInstanceOf(ConfigError);
      const msg = (thrown as Error).message;
      expect(msg).toContain("devices.autoMode");
      expect(msg).toContain("devices.fullAccess");
      expect(msg).toContain("capybara config migrate-permissions");
      // never the value
      expect(msg).not.toContain("maybe");
    }
    // even together with an equal new key
    expect(() => fullAccess({ devices: { autoMode: "off", fullAccess: "off" } })).toThrow(
      /devices\.autoMode.*devices\.fullAccess/s,
    );
  });

  it("refuses the old environment variable with the conversion message (W5-P3b)", () => {
    expect(() => fullAccess({}, { CAPYBARA_DEVICES__AUTO_MODE: "off" })).toThrow(
      /CAPYBARA_DEVICES__AUTO_MODE.*CAPYBARA_DEVICES__FULL_ACCESS/s,
    );
    expect(() =>
      fullAccess(
        { devices: { fullAccess: "off" } },
        { CAPYBARA_DEVICES__AUTO_MODE: "off", CAPYBARA_DEVICES__FULL_ACCESS: "off" },
      ),
    ).toThrow(ConfigError);
  });

  it("labels the winning source of the key", () => {
    const of = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv) =>
      new KernelConfigService(
        { config: resolveConfig({ ...base, ...raw }, env), env },
        log,
      ).fieldSource("devices.fullAccess");
    expect(of({}, { CAPYBARA_DEVICES__FULL_ACCESS: "off" })).toBe("env");
    expect(of({ devices: { fullAccess: "off" } }, {})).toBe("file");
    expect(of({ devices: { fullAccess: "off" } }, { CAPYBARA_CONFIG_SOURCE: "nacos" })).toBe(
      "nacos",
    );
    expect(of({}, {})).toBeUndefined();
  });

  it("a hot change goes through durable publication first; a reload with the old key is rejected", async () => {
    const svc = new KernelConfigService({ config: resolveConfig(base, {}), env: {} }, log);
    const published: [unknown, unknown][] = [];
    await svc.apply({ ...base, devices: { fullAccess: "off" } }, async (before, next) => {
      published.push([before.devices.fullAccess, next.devices.fullAccess]);
    });
    expect(published).toEqual([[undefined, "off"]]);
    expect(svc.get().devices.fullAccess).toBe("off");
    await svc.apply({ ...base, devices: { fullAccess: "allowed" } }, async () => {
      throw new Error("lost");
    });
    expect(svc.get().devices.fullAccess).toBe("off");
    // a Nacos push still naming the old key is refused whole: nothing is published or applied
    await svc.apply({ ...base, devices: { autoMode: "allowed" } }, async () => {
      published.push(["unexpected", "publish"]);
    });
    expect(published).toHaveLength(1);
    expect(svc.get().devices.fullAccess).toBe("off");
  });
});
