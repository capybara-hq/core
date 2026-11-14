import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { createLogger } from "../../src/log.js";

const BASE = {
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE, ...over };
}

function make(over: Record<string, unknown> = {}) {
  const lines: ({ level: string; msg: string } & Record<string, unknown>)[] = [];
  const log = createLogger("info", { write: (line) => lines.push(JSON.parse(line)) });
  const config: KernelConfig = resolveConfig(raw(over), {});
  const svc = new KernelConfigService({ config, env: {} }, log);
  return { svc, log, lines, config };
}

describe("KernelConfigService", () => {
  it("get() returns the resolved config", () => {
    const { svc, config } = make();
    expect(svc.get()).toBe(config);
    expect(KernelConfigSchema.safeParse(svc.get()).success).toBe(true);
  });

  it("apply runs the log.level applier, updates get() and notifies listeners", () => {
    const { svc, log } = make();
    const seen: string[][] = [];
    const off = svc.onChange((_next, changed) => seen.push(changed));
    svc.apply(raw({ log: { level: "debug" } }));
    expect(svc.get().log.level).toBe("debug");
    expect(log.level).toBe("debug");
    expect(seen).toEqual([["log.level"]]);
    off();
    svc.apply(raw({ log: { level: "warn" } }));
    expect(seen).toHaveLength(1);
  });

  it("reports restart-only paths and keeps the old value", () => {
    const { svc, lines } = make();
    svc.apply(raw({ http: { port: 4999 } }));
    expect(svc.get().http.port).not.toBe(4999);
    const warn = lines.find((l) => l.msg.includes("requires restart"));
    expect(warn?.keys).toContain("http.port");
  });

  it("constructs with the full default schema: every hot field has an applier", () => {
    const log = createLogger("info", { write: () => {} });
    const config = KernelConfigSchema.parse(raw());
    expect(() => new KernelConfigService({ config, env: {} }, log)).not.toThrow();
  });

  it("warns once at start when the retired env var of subagents.maxConcurrentPerRun is set", () => {
    const lines: ({ level: string; msg: string } & Record<string, unknown>)[] = [];
    const log = createLogger("info", { write: (line) => lines.push(JSON.parse(line)) });
    const config = resolveConfig(raw(), {});
    new KernelConfigService({ config, env: {} }, log);
    expect(lines.filter((l) => l.msg.includes("MAX_CONCURRENT_PER_RUN"))).toEqual([]);
    new KernelConfigService(
      { config, env: { CAPYBARA_SUBAGENTS__MAX_CONCURRENT_PER_RUN: "2" } },
      log,
    );
    const warns = lines.filter((l) => l.msg.includes("CAPYBARA_SUBAGENTS__MAX_CONCURRENT_PER_RUN"));
    expect(warns).toHaveLength(1);
    expect(warns[0]?.level).toBe("warn");
    expect(warns[0]?.msg).toContain("CAPYBARA_SUBAGENTS__MAX_CONCURRENT_PER_CONVERSATION");
  });

  it("an invalid reload keeps the current config", () => {
    const { svc, lines } = make();
    const before = svc.get();
    svc.apply({ nonsense: true });
    expect(svc.get()).toBe(before);
    expect(lines.some((l) => l.msg.includes("rejected"))).toBe(true);
  });
});
