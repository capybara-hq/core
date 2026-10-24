import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  defineExtension,
  type ExtensionContext,
  type ExtensionManifest,
  ExtensionManifestError,
  isSecret,
  parseExtensionPoint,
  secret,
} from "../src/index.js";

const valid = (over: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  name: "demo-plugin",
  version: "1.0.0",
  sdk: "^0.1.0",
  provides: ["channel@1"],
  setup() {},
  ...over,
});

describe("defineExtension", () => {
  it("returns a valid manifest as-is", () => {
    const m = valid();
    expect(defineExtension(m)).toBe(m);
  });
  it("rejects missing setup", () => {
    // biome-ignore lint/suspicious/noExplicitAny: 构造缺 setup 的畸形清单
    const bad = { ...valid(), setup: undefined } as any;
    expect(() => defineExtension(bad)).toThrow(/setup/);
  });
  it("accepts an optional dispose function and rejects a non-function dispose", () => {
    const m = valid({ dispose() {} });
    expect(defineExtension(m)).toBe(m);
    // biome-ignore lint/suspicious/noExplicitAny: 构造 dispose 不是函数的畸形清单
    const bad = { ...valid(), dispose: "nope" } as any;
    expect(() => defineExtension(bad)).toThrow(/dispose/);
  });
  it("ExtensionContext carries an AbortSignal and dispose receives the context", () => {
    expectTypeOf<ExtensionContext["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<NonNullable<ExtensionManifest["dispose"]>>()
      .parameter(0)
      .toEqualTypeOf<ExtensionContext>();
  });
  it("rejects bad name", () => {
    expect(() => defineExtension(valid({ name: "Bad_Name" }))).toThrow(/name/);
    expect(() => defineExtension(valid({ name: "Bad_Name" }))).toThrow(ExtensionManifestError);
  });
  it("rejects the reserved name kernel", () => {
    expect(() => defineExtension(valid({ name: "kernel" }))).toThrow(/reserved/);
    expect(() => defineExtension(valid({ name: "kernel" }))).toThrow(ExtensionManifestError);
  });
  it("rejects unregistered extension point", () => {
    expect(() => defineExtension(valid({ provides: ["nope@1"] }))).toThrow(/nope/);
  });
  it("rejects bad sdk range and bad version", () => {
    expect(() => defineExtension(valid({ sdk: "not-semver" }))).toThrow(/sdk/);
    expect(() => defineExtension(valid({ version: "x" }))).toThrow(/version/);
  });
  it("rejects duplicate provides", () => {
    expect(() => defineExtension(valid({ provides: ["channel@1", "channel@1"] }))).toThrow(
      /duplicate/,
    );
  });
  it("rejects requiring what it provides", () => {
    expect(() => defineExtension(valid({ requires: ["channel@1"] }))).toThrow(/channel@1/);
  });
  it("rejects Object.prototype names as extension points", () => {
    expect(() => defineExtension(valid({ provides: ["constructor@1"] }))).toThrow(/constructor/);
    expect(() => defineExtension(valid({ requires: ["constructor@1"] }))).toThrow(/constructor/);
  });
  it("rejects unregistered requires", () => {
    expect(() => defineExtension(valid({ requires: ["zzz@1"] }))).toThrow(/zzz/);
  });
  it("accepts valid optional", () => {
    expect(() => defineExtension(valid({ optional: ["counter@1"] }))).not.toThrow();
  });
  it("rejects optional overlapping requires / provides, or unregistered", () => {
    expect(() => defineExtension(valid({ optional: ["channel@1"] }))).toThrow(/optional/);
    expect(() =>
      defineExtension(valid({ requires: ["counter@1"], optional: ["counter@1"] })),
    ).toThrow(/optional/);
    expect(() => defineExtension(valid({ optional: ["zzz@1"] }))).toThrow(/zzz/);
  });
  it("rejects brokered extension points in requires / optional", () => {
    expect(() => defineExtension(valid({ requires: ["model-provider@2"] }))).toThrow(/brokered/);
    expect(() => defineExtension(valid({ optional: ["sandbox@1"] }))).toThrow(/brokered/);
  });
  it("validates permissions", () => {
    expect(() => defineExtension(valid({ permissions: { secrets: true } }))).not.toThrow();
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: 构造未知键
      defineExtension(valid({ permissions: { bogus: 1 } as any })),
    ).toThrow(/bogus/);
    expect(() => defineExtension(valid({ permissions: { network: ["nodot"] } }))).toThrow(
      ExtensionManifestError,
    );
  });
  it("names the plugin in errors", () => {
    expect(() => defineExtension(valid({ name: "Bad_Name" }))).toThrow(/Bad_Name/);
    expect(() => defineExtension(valid({ name: undefined as never }))).toThrow(/<unnamed>/);
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

describe("parseExtensionPoint", () => {
  it("parses", () => {
    expect(parseExtensionPoint("channel@1")).toEqual({ name: "channel", major: 1 });
  });
  it("throws without major", () => {
    expect(() => parseExtensionPoint("channel" as never)).toThrow();
  });
});

describe("types", () => {
  it("kv writes require ttl", () => {
    expectTypeOf<ExtensionContext["kv"]["set"]>()
      .parameter(2)
      .toEqualTypeOf<{ ttlSeconds: number }>();
    expectTypeOf<ExtensionContext["kv"]["incr"]>()
      .parameter(1)
      .toEqualTypeOf<{ ttlSeconds: number }>();
  });
});
