import {
  defineExtension,
  type ExtensionManifest,
  type ExtensionPointRef,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  ExtensionResolveError,
  PROVIDER_CONFLICT,
  parseProviderConflict,
  resolveExtensions,
} from "../../src/extensions/resolve.js";

const mk = (
  name: string,
  o: {
    provides?: ExtensionPointRef[];
    requires?: ExtensionPointRef[];
    optional?: ExtensionPointRef[];
    sdk?: string;
  } = {},
): ExtensionManifest =>
  defineExtension({
    name,
    version: "1.0.0",
    sdk: o.sdk ?? "^0.1.0",
    provides: o.provides ?? [],
    ...(o.requires ? { requires: o.requires } : {}),
    ...(o.optional ? { optional: o.optional } : {}),
    setup() {},
  });

describe("resolveExtensions", () => {
  it("按 requires 拓扑排序", () => {
    const a = mk("aa", { requires: ["counter@1"] });
    const b = mk("bb", { provides: ["counter@1"] });
    expect(resolveExtensions([a, b], "0.1.0").map((m) => m.name)).toEqual(["bb", "aa"]);
  });

  it("optional 缺提供方不报错", () => {
    const a = mk("aa", { optional: ["directory@1"] });
    expect(resolveExtensions([a], "0.1.0").map((m) => m.name)).toEqual(["aa"]);
  });

  it("optional 存在提供方时参与拓扑排序", () => {
    const a = mk("aa", { optional: ["directory@1"] });
    const b = mk("bb", { provides: ["directory@1"] });
    expect(resolveExtensions([a, b], "0.1.0").map((m) => m.name)).toEqual(["bb", "aa"]);
  });

  it("optional 同样参与环检测", () => {
    const a = mk("aa", { provides: ["channel@1"], optional: ["directory@1"] });
    const b = mk("bb", { provides: ["directory@1"], requires: ["channel@1"] });
    expect(() => resolveExtensions([a, b], "0.1.0")).toThrow(/cycle/);
  });

  it("缺提供方：信息含能力名与插件名", () => {
    const a = mk("aa", { requires: ["counter@1"] });
    expect(() => resolveExtensions([a], "0.1.0")).toThrow(/counter@1/);
    expect(() => resolveExtensions([a], "0.1.0")).toThrow(/aa/);
  });

  it("单选能力多个提供者：列出全部插件名", () => {
    const a = mk("aa", { provides: ["sandbox@2"] });
    const b = mk("bb", { provides: ["sandbox@2"] });
    expect(() => resolveExtensions([a, b], "0.1.0")).toThrow(/aa.*bb/);
  });

  it("a single-provider conflict carries extension.provider_conflict and its message parses back", () => {
    const a = mk("aa", { provides: ["sandbox@2"] });
    const b = mk("bb", { provides: ["sandbox@2"] });
    let err: unknown;
    try {
      resolveExtensions([a, b], "0.1.0");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExtensionResolveError);
    expect((err as ExtensionResolveError).code).toBe(PROVIDER_CONFLICT);
    expect(parseProviderConflict((err as Error).message)).toEqual({
      extensionPoint: "sandbox@2",
      providers: ["aa", "bb"],
    });
    expect(parseProviderConflict("plugin aa: required extension point x@1 has no provider")).toBe(
      null,
    );
    expect(parseProviderConflict(null)).toBe(null);
  });

  it("多选能力允许多个提供者", () => {
    const a = mk("aa", { provides: ["counter@1"] });
    const b = mk("bb", { provides: ["counter@1"] });
    expect(resolveExtensions([a, b], "0.1.0")).toHaveLength(2);
  });

  it("sdk 范围不满足", () => {
    expect(() => resolveExtensions([mk("aa", { sdk: "^9.0.0" })], "0.1.0")).toThrow(/sdk/);
  });

  it("an rc SDK satisfies an rc sdk range, not a plain one", () => {
    expect(resolveExtensions([mk("aa", { sdk: "^0.1.0-rc.0" })], "0.1.0-rc.0")).toHaveLength(1);
    expect(resolveExtensions([mk("aa", { sdk: "^0.1.0-rc.0" })], "0.1.0")).toHaveLength(1);
    expect(() => resolveExtensions([mk("aa")], "0.1.0-rc.0")).toThrow(/sdk range "\^0\.1\.0"/);
  });

  it("循环依赖", () => {
    const a = mk("aa", { provides: ["counter@1"], requires: ["channel@1"] });
    const b = mk("bb", { provides: ["channel@1"], requires: ["counter@1"] });
    expect(() => resolveExtensions([a, b], "0.1.0")).toThrow(/cycle/i);
  });

  it("重复插件名", () => {
    expect(() => resolveExtensions([mk("aa"), mk("aa")], "0.1.0")).toThrow(/aa/);
  });

  it("an extension providing sandbox@1 is refused at resolve", () => {
    const a = mk("old-sandbox", { provides: ["sandbox@1"] });
    expect(() => resolveExtensions([a], "0.1.0")).toThrow(
      expect.objectContaining({
        code: "extension.unsupported_extension_point",
        message:
          "Plugin old-sandbox provides sandbox@1, which this kernel no longer supports; upgrade it to a version that provides sandbox@2.",
      }),
    );
    expect(
      resolveExtensions([mk("new-sandbox", { provides: ["sandbox@2"] })], "0.1.0"),
    ).toHaveLength(1);
  });
});
