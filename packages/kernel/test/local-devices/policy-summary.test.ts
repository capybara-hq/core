import { describe, expect, it } from "vitest";
import { deviceFeaturesOf, localPolicyOf } from "../../src/local-devices/policy-summary.js";

/**
 * The local policy summary the kernel keeps from a device's hello or `policy` op (auto mode spec
 * §4.1): the device is the authority, so the kernel keeps what it reads and never throws over it.
 */
describe("localPolicyOf", () => {
  it("keeps the mode and the allowlist, and nothing else a device reports", () => {
    expect(
      localPolicyOf({
        mode: "auto",
        allowedDomains: ["a.com"],
        projects: [{ name: "core", path: "/w/core" }],
      }),
    ).toEqual({ mode: "auto", allowedDomains: ["a.com"] });
  });

  it("refuses a summary without a valid mode or allowlist", () => {
    expect(localPolicyOf({ mode: "open", allowedDomains: [] })).toBeNull();
    expect(localPolicyOf({ mode: "sandbox", allowedDomains: [1] })).toBeNull();
    expect(localPolicyOf(null)).toBeNull();
  });
});

describe("deviceFeaturesOf", () => {
  it("knows the projects feature", () => {
    expect(deviceFeaturesOf(["projects", "mode", "teleport"])).toEqual(["mode", "projects"]);
  });
});
