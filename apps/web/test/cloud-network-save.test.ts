import { describe, expect, it } from "vitest";
import { cloudNetworkToSave } from "../src/lib/org-settings";

const P = ["registry.npmjs.org", "github.com"];

describe("cloudNetworkToSave (egress ceiling spec §D4)", () => {
  it("derives the delta against the platform list, keeping a stale exclusion", () => {
    expect(
      cloudNetworkToSave({ excludedHosts: ["gone.example.org"] }, P, ["github.com", "pypi.org"]),
    ).toEqual({
      extraHosts: ["pypi.org"],
      excludedHosts: ["registry.npmjs.org", "gone.example.org"],
    });
  });

  it("keeps a stored extra the platform now lists too, while the list holds it", () => {
    expect(cloudNetworkToSave({ extraHosts: ["github.com"] }, P, P)).toEqual({
      extraHosts: ["github.com"],
    });
    expect(cloudNetworkToSave({ extraHosts: ["github.com"] }, P, ["registry.npmjs.org"])).toEqual({
      excludedHosts: ["github.com"],
    });
  });

  it("keeps the stored mode and base; base none lists the hosts as they are", () => {
    expect(cloudNetworkToSave({ mode: "allowlist", base: "none" }, P, ["github.com"])).toEqual({
      mode: "allowlist",
      base: "none",
      extraHosts: ["github.com"],
    });
    expect(cloudNetworkToSave(undefined, P, P, "allowlist")).toEqual({ mode: "allowlist" });
  });
});
