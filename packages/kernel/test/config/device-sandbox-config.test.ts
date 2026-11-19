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
const devices = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
  resolveConfig({ ...base, ...raw }, env).devices;
const thrown = (f: () => unknown): Error | undefined => {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  return undefined;
};

describe("devices.outsideSandbox and devices.network (approval-only profiles)", () => {
  it("have no schema default: an unset source leaves the deployment setting in charge", () => {
    const d = KernelConfigSchema.parse(base).devices;
    expect(d.outsideSandbox).toBeUndefined();
    expect(d.network).toEqual({});
    expect(devices({}).network.default).toBeUndefined();
    expect(devices({}).network.ceiling).toBeUndefined();
    expect(() => devices({ devices: { outsideSandbox: "on" } })).toThrow(ConfigError);
    expect(() => devices({ devices: { network: { ceiling: "public" } } })).toThrow(ConfigError);
  });

  it("reads the keys from the file and the environment", () => {
    expect(devices({ devices: { outsideSandbox: "off" } }).outsideSandbox).toBe("off");
    expect(devices({}, { CAPYBARA_DEVICES__OUTSIDE_SANDBOX: "allowed" }).outsideSandbox).toBe(
      "allowed",
    );
    expect(
      devices({ devices: { network: { default: "allowlist", ceiling: "open" } } }).network,
    ).toEqual({ default: "allowlist", ceiling: "open" });
    expect(devices({}, { CAPYBARA_DEVICES__NETWORK__CEILING: "allowlist" }).network.ceiling).toBe(
      "allowlist",
    );
  });

  it("refuses a default above the ceiling of the same source", () => {
    const e = thrown(() =>
      devices({ devices: { network: { default: "open", ceiling: "allowlist" } } }),
    );
    expect(e).toBeInstanceOf(ConfigError);
    expect(e?.message).toMatch(/devices\.network.*default.*ceiling/s);
    // across sources the reader clamps the default to the ceiling
    expect(
      devices(
        { devices: { network: { default: "open" } } },
        { CAPYBARA_DEVICES__NETWORK__CEILING: "allowlist" },
      ).network,
    ).toEqual({ default: "open", ceiling: "allowlist" });
    // the narrower default under a wider ceiling is fine
    expect(
      devices({ devices: { network: { default: "allowlist", ceiling: "open" } } }).network.default,
    ).toBe("allowlist");
  });

  it("a hot reload that only narrows is applied even when it leaves the default above the ceiling", async () => {
    const svc = new KernelConfigService(
      {
        config: resolveConfig(
          { ...base, devices: { network: { default: "open", ceiling: "open" } } },
          {},
        ),
        env: {},
      },
      log,
    );
    await svc.apply(
      { ...base, devices: { network: { default: "open", ceiling: "allowlist" } } },
      async () => {},
    );
    expect(svc.get().devices.network).toEqual({ default: "open", ceiling: "allowlist" });
    // an unrelated narrowing keeps the clamped pair as it is
    await svc.apply(
      {
        ...base,
        devices: { outsideSandbox: "off", network: { default: "open", ceiling: "allowlist" } },
      },
      async () => {},
    );
    expect(svc.get().devices.outsideSandbox).toBe("off");
    // opening the default above the same source's ceiling is a widening: refused, kept as it was
    const strict = new KernelConfigService(
      {
        config: resolveConfig(
          { ...base, devices: { network: { default: "allowlist", ceiling: "allowlist" } } },
          {},
        ),
        env: {},
      },
      log,
    );
    await strict.apply(
      { ...base, devices: { network: { default: "open", ceiling: "allowlist" } } },
      async () => {},
    );
    expect(strict.get().devices.network.default).toBe("allowlist");
  });

  it("refuses the old file / Nacos keys with the conversion message, never the value", () => {
    for (const key of ["autoMode", "fullAccess"])
      for (const value of ["off", "allowed", "maybe"]) {
        const e = thrown(() => devices({ devices: { [key]: value } }));
        expect(e).toBeInstanceOf(ConfigError);
        expect(e?.message).toContain(`devices.${key}`);
        expect(e?.message).toContain("devices.outsideSandbox");
        expect(e?.message).toContain("devices.network.ceiling: allowlist");
        expect(e?.message).toContain("capybara config migrate-permissions");
        expect(e?.message).not.toContain("maybe");
      }
    // even together with an equal new key
    expect(() => devices({ devices: { fullAccess: "off", outsideSandbox: "off" } })).toThrow(
      /devices\.fullAccess.*devices\.outsideSandbox/s,
    );
  });

  it("refuses the old environment variables with the conversion message", () => {
    for (const env of ["CAPYBARA_DEVICES__AUTO_MODE", "CAPYBARA_DEVICES__FULL_ACCESS"]) {
      const e = thrown(() => devices({}, { [env]: "off" }));
      expect(e).toBeInstanceOf(ConfigError);
      expect(e?.message).toContain(env);
      expect(e?.message).toContain("CAPYBARA_DEVICES__OUTSIDE_SANDBOX");
      expect(e?.message).toContain("CAPYBARA_DEVICES__NETWORK__CEILING=allowlist");
    }
    expect(() =>
      devices(
        { devices: { outsideSandbox: "off" } },
        { CAPYBARA_DEVICES__FULL_ACCESS: "off", CAPYBARA_DEVICES__OUTSIDE_SANDBOX: "off" },
      ),
    ).toThrow(ConfigError);
  });

  it("labels the winning source of each key", () => {
    const of = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv, path: string) =>
      new KernelConfigService(
        { config: resolveConfig({ ...base, ...raw }, env), env },
        log,
      ).fieldSource(path);
    expect(of({}, { CAPYBARA_DEVICES__OUTSIDE_SANDBOX: "off" }, "devices.outsideSandbox")).toBe(
      "env",
    );
    expect(of({ devices: { outsideSandbox: "off" } }, {}, "devices.outsideSandbox")).toBe("file");
    expect(
      of(
        { devices: { network: { ceiling: "allowlist" } } },
        { CAPYBARA_CONFIG_SOURCE: "nacos" },
        "devices.network.ceiling",
      ),
    ).toBe("nacos");
    expect(of({}, {}, "devices.network.default")).toBeUndefined();
  });

  it("a hot change of any key goes through durable publication first", async () => {
    const svc = new KernelConfigService({ config: resolveConfig(base, {}), env: {} }, log);
    const published: [unknown, unknown][] = [];
    const record = async (before: ReturnType<typeof svc.get>, next: ReturnType<typeof svc.get>) => {
      published.push([before.devices, next.devices]);
    };
    await svc.apply({ ...base, devices: { outsideSandbox: "off" } }, record);
    expect(svc.get().devices.outsideSandbox).toBe("off");
    await svc.apply(
      { ...base, devices: { outsideSandbox: "off", network: { ceiling: "allowlist" } } },
      record,
    );
    expect(svc.get().devices.network.ceiling).toBe("allowlist");
    await svc.apply(
      {
        ...base,
        devices: { outsideSandbox: "off", network: { default: "allowlist", ceiling: "allowlist" } },
      },
      record,
    );
    expect(svc.get().devices.network.default).toBe("allowlist");
    expect(published).toHaveLength(3);
    // a failed publication keeps the current config
    await svc.apply({ ...base, devices: { outsideSandbox: "allowed" } }, async () => {
      throw new Error("lost");
    });
    expect(svc.get().devices.outsideSandbox).toBe("off");
    // a Nacos push still naming an old key is refused whole: nothing is published or applied
    await svc.apply({ ...base, devices: { fullAccess: "allowed" } }, async () => {
      published.push(["unexpected", "publish"]);
    });
    expect(published).toHaveLength(3);
    expect(svc.get().devices.outsideSandbox).toBe("off");
  });
});
