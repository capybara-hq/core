import { describe, expect, it } from "vitest";
import { deviceNetworkToSave } from "../src/lib/org-settings";

const P = ["registry.npmjs.org", "github.com"];

describe("deviceNetworkToSave (approval-only profiles, Settings model)", () => {
  it("derives the delta against the platform list, keeping a stale exclusion", () => {
    expect(
      deviceNetworkToSave({ excludedHosts: ["gone.example.org"] }, P, ["github.com", "pypi.org"]),
    ).toEqual({
      extraHosts: ["pypi.org"],
      excludedHosts: ["registry.npmjs.org", "gone.example.org"],
    });
  });

  it("keeps a stored extra the platform now lists too, while the list holds it", () => {
    expect(deviceNetworkToSave({ extraHosts: ["github.com"] }, P, P)).toEqual({
      extraHosts: ["github.com"],
    });
    expect(deviceNetworkToSave({ extraHosts: ["github.com"] }, P, ["registry.npmjs.org"])).toEqual({
      excludedHosts: ["github.com"],
    });
  });

  it("keeps the stored default, ceiling and base; base none lists the hosts as they are", () => {
    expect(
      deviceNetworkToSave({ default: "open", ceiling: "allowlist", base: "none" }, P, [
        "github.com",
      ]),
    ).toEqual({ default: "open", ceiling: "allowlist", base: "none", extraHosts: ["github.com"] });
  });

  it("a changed default or ceiling replaces the stored one; absent stays absent", () => {
    expect(deviceNetworkToSave(undefined, P, P, { ceiling: "allowlist" })).toEqual({
      ceiling: "allowlist",
    });
    expect(
      deviceNetworkToSave({ default: "open", ceiling: "open" }, P, P, {
        default: "allowlist",
        ceiling: "allowlist",
      }),
    ).toEqual({ default: "allowlist", ceiling: "allowlist" });
  });
});
