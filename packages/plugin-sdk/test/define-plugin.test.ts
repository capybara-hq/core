import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  definePlugin,
  isSecret,
  type PluginContext,
  type PluginManifest,
  PluginManifestError,
  parseCapability,
  secret,
} from "../src/index.js";

const valid = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  name: "demo-plugin",
  version: "1.0.0",
  sdk: "^0.1.0",
  provides: ["channel@1"],
  setup() {},
  ...over,
});

describe("definePlugin", () => {
  it("returns a valid manifest as-is", () => {
    const m = valid();
    expect(definePlugin(m)).toBe(m);
  });
  it("rejects missing setup", () => {
    // biome-ignore lint/suspicious/noExplicitAny: 构造缺 setup 的畸形清单
    const bad = { ...valid(), setup: undefined } as any;
    expect(() => definePlugin(bad)).toThrow(/setup/);
  });
  it("accepts an optional dispose function and rejects a non-function dispose", () => {
    const m = valid({ dispose() {} });
    expect(definePlugin(m)).toBe(m);
    // biome-ignore lint/suspicious/noExplicitAny: 构造 dispose 不是函数的畸形清单
    const bad = { ...valid(), dispose: "nope" } as any;
    expect(() => definePlugin(bad)).toThrow(/dispose/);
  });
  it("PluginContext carries an AbortSignal and dispose receives the context", () => {
    expectTypeOf<PluginContext["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<NonNullable<PluginManifest["dispose"]>>()
      .parameter(0)
      .toEqualTypeOf<PluginContext>();
  });
  it("rejects bad name", () => {
    expect(() => definePlugin(valid({ name: "Bad_Name" }))).toThrow(/name/);
    expect(() => definePlugin(valid({ name: "Bad_Name" }))).toThrow(PluginManifestError);
  });
  it("rejects the reserved name kernel", () => {
    expect(() => definePlugin(valid({ name: "kernel" }))).toThrow(/reserved/);
    expect(() => definePlugin(valid({ name: "kernel" }))).toThrow(PluginManifestError);
  });
  it("rejects unregistered capability", () => {
    expect(() => definePlugin(valid({ provides: ["nope@1"] }))).toThrow(/nope/);
  });
  it("rejects bad sdk range and bad version", () => {
    expect(() => definePlugin(valid({ sdk: "not-semver" }))).toThrow(/sdk/);
    expect(() => definePlugin(valid({ version: "x" }))).toThrow(/version/);
  });
  it("rejects duplicate provides", () => {
    expect(() => definePlugin(valid({ provides: ["channel@1", "channel@1"] }))).toThrow(
      /duplicate/,
    );
  });
  it("rejects requiring what it provides", () => {
    expect(() => definePlugin(valid({ requires: ["channel@1"] }))).toThrow(/channel@1/);
  });
  it("rejects Object.prototype names as capabilities", () => {
    expect(() => definePlugin(valid({ provides: ["constructor@1"] }))).toThrow(/constructor/);
    expect(() => definePlugin(valid({ requires: ["constructor@1"] }))).toThrow(/constructor/);
  });
  it("rejects unregistered requires", () => {
    expect(() => definePlugin(valid({ requires: ["zzz@1"] }))).toThrow(/zzz/);
  });
  it("accepts valid optional", () => {
    expect(() => definePlugin(valid({ optional: ["counter@1"] }))).not.toThrow();
  });
  it("rejects optional overlapping requires / provides, or unregistered", () => {
    expect(() => definePlugin(valid({ optional: ["channel@1"] }))).toThrow(/optional/);
    expect(() => definePlugin(valid({ requires: ["counter@1"], optional: ["counter@1"] }))).toThrow(
      /optional/,
    );
    expect(() => definePlugin(valid({ optional: ["zzz@1"] }))).toThrow(/zzz/);
  });
  it("rejects brokered capabilities in requires / optional", () => {
    expect(() => definePlugin(valid({ requires: ["model-provider@2"] }))).toThrow(/brokered/);
    expect(() => definePlugin(valid({ optional: ["sandbox@1"] }))).toThrow(/brokered/);
  });
  it("validates permissions", () => {
    expect(() => definePlugin(valid({ permissions: { secrets: true } }))).not.toThrow();
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: 构造未知键
      definePlugin(valid({ permissions: { bogus: 1 } as any })),
    ).toThrow(/bogus/);
    expect(() => definePlugin(valid({ permissions: { network: ["nodot"] } }))).toThrow(
      PluginManifestError,
    );
  });
  it("names the plugin in errors", () => {
    expect(() => definePlugin(valid({ name: "Bad_Name" }))).toThrow(/Bad_Name/);
    expect(() => definePlugin(valid({ name: undefined as never }))).toThrow(/<unnamed>/);
  });
});

describe("secret", () => {
  it("marks schemas", () => {
    expect(isSecret(secret(z.string()))).toBe(true);
    expect(isSecret(z.string())).toBe(false);
  });
  it("detects kernel-style meta", () => {
    expect(isSecret(z.string().meta({ secret: true, description: "x" }))).toBe(true);
  });
});

describe("parseCapability", () => {
  it("parses", () => {
    expect(parseCapability("channel@1")).toEqual({ name: "channel", major: 1 });
  });
  it("throws without major", () => {
    expect(() => parseCapability("channel" as never)).toThrow();
  });
});

describe("types", () => {
  it("kv writes require ttl", () => {
    expectTypeOf<PluginContext["kv"]["set"]>().parameter(2).toEqualTypeOf<{ ttlSeconds: number }>();
    expectTypeOf<PluginContext["kv"]["incr"]>()
      .parameter(1)
      .toEqualTypeOf<{ ttlSeconds: number }>();
  });
});
