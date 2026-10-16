import { type CapabilityRef, definePlugin, type PluginManifest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { resolvePlugins } from "../../src/plugins/resolve.js";

const mk = (
  name: string,
  o: { provides?: CapabilityRef[]; requires?: CapabilityRef[]; sdk?: string } = {},
): PluginManifest =>
  definePlugin({
    name,
    version: "1.0.0",
    sdk: o.sdk ?? "^0.1.0",
    provides: o.provides ?? [],
    ...(o.requires ? { requires: o.requires } : {}),
    setup() {},
  });

describe("resolvePlugins", () => {
  it("按 requires 拓扑排序", () => {
    const a = mk("aa", { requires: ["counter@1"] });
    const b = mk("bb", { provides: ["counter@1"] });
    expect(resolvePlugins([a, b], "0.1.0").map((m) => m.name)).toEqual(["bb", "aa"]);
  });

  it("缺提供方：信息含能力名与插件名", () => {
    const a = mk("aa", { requires: ["counter@1"] });
    expect(() => resolvePlugins([a], "0.1.0")).toThrow(/counter@1/);
    expect(() => resolvePlugins([a], "0.1.0")).toThrow(/aa/);
  });

  it("单选能力多个提供者：列出全部插件名", () => {
    const a = mk("aa", { provides: ["sandbox@1"] });
    const b = mk("bb", { provides: ["sandbox@1"] });
    expect(() => resolvePlugins([a, b], "0.1.0")).toThrow(/aa.*bb/);
  });

  it("多选能力允许多个提供者", () => {
    const a = mk("aa", { provides: ["counter@1"] });
    const b = mk("bb", { provides: ["counter@1"] });
    expect(resolvePlugins([a, b], "0.1.0")).toHaveLength(2);
  });

  it("sdk 范围不满足", () => {
    expect(() => resolvePlugins([mk("aa", { sdk: "^9.0.0" })], "0.1.0")).toThrow(/sdk/);
  });

  it("循环依赖", () => {
    const a = mk("aa", { provides: ["counter@1"], requires: ["channel@1"] });
    const b = mk("bb", { provides: ["channel@1"], requires: ["counter@1"] });
    expect(() => resolvePlugins([a, b], "0.1.0")).toThrow(/cycle/i);
  });

  it("重复插件名", () => {
    expect(() => resolvePlugins([mk("aa"), mk("aa")], "0.1.0")).toThrow(/aa/);
  });
});
