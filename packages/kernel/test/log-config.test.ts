import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/load.js";
import { createLogger } from "../src/log.js";
import { loggerOptionsFromConfig } from "../src/log-config.js";

const raw = {
  db: { url: "postgres://h/db" },
  redis: { url: "redis://h" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("loggerOptionsFromConfig", () => {
  it("defaults: auto console format, role = every role", () => {
    const opts = loggerOptionsFromConfig(resolveConfig(raw, {}));
    expect(opts).toMatchObject({ format: "auto", base: { role: "api,worker,gateway" } });
  });

  it("CAPYBARA_LOG__FORMAT and roles flow into the records", () => {
    const config = resolveConfig(raw, { CAPYBARA_LOG__FORMAT: "json", CAPYBARA_ROLES: "api" });
    const lines: string[] = [];
    const log = createLogger(
      "info",
      loggerOptionsFromConfig(config, { write: (l) => lines.push(l) }),
    );
    log.info("hi");
    expect(loggerOptionsFromConfig(config).format).toBe("json");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ role: "api", msg: "hi" });
  });

  it("an unknown log.format is a config error", () => {
    expect(() => resolveConfig(raw, { CAPYBARA_LOG__FORMAT: "loud" })).toThrow(/log\.format/);
  });
});
