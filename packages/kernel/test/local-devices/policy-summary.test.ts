import { MAX_DEVICE_PROJECTS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { deviceFeaturesOf, localPolicyOf } from "../../src/local-devices/policy-summary.js";

/**
 * The local policy summary the kernel keeps from a device's hello or `policy` op (auto mode spec
 * §4.1): the device is the authority, so the kernel keeps what it reads and never throws over it.
 */
describe("localPolicyOf", () => {
  it("keeps the projects a device reports", () => {
    expect(
      localPolicyOf({
        mode: "auto",
        allowedDomains: [],
        projects: [{ name: "core", path: "/w/core" }],
      }),
    ).toEqual({
      mode: "auto",
      allowedDomains: [],
      projects: [{ name: "core", path: "/w/core" }],
    });
  });

  it("defaults projects to [] when the device reports none (an older program)", () => {
    expect(localPolicyOf({ mode: "sandbox", allowedDomains: ["a.com"] })).toEqual({
      mode: "sandbox",
      allowedDomains: ["a.com"],
      projects: [],
    });
  });

  it("fails an unreadable projects value closed to [] rather than throwing", () => {
    expect(localPolicyOf({ mode: "auto", allowedDomains: [], projects: "core" })).toEqual({
      mode: "auto",
      allowedDomains: [],
      projects: [],
    });
    // an entry that is not a name and an absolute path is dropped, the readable ones kept
    expect(
      localPolicyOf({
        mode: "auto",
        allowedDomains: [],
        projects: [{ name: "core", path: "/w/core" }, { name: "" }, null],
      }),
    ).toEqual({
      mode: "auto",
      allowedDomains: [],
      projects: [{ name: "core", path: "/w/core" }],
    });
  });

  it("applies the protocol's bounds: relative or control-character paths, bad names, the cap", () => {
    const core = { name: "core", path: "/w/core" };
    expect(
      localPolicyOf({
        mode: "auto",
        allowedDomains: [],
        projects: [
          core,
          { name: "rel", path: "w/rel" },
          { name: "ctl", path: "/w/c\ntl" },
          { name: "a/b", path: "/w/ab" },
          { name: "x".repeat(65), path: "/w/long" },
        ],
      })?.projects,
    ).toEqual([core]);
    const many = Array.from({ length: MAX_DEVICE_PROJECTS + 5 }, (_, i) => ({
      name: `p${i}`,
      path: `/w/p${i}`,
    }));
    const kept = localPolicyOf({ mode: "auto", allowedDomains: [], projects: many })?.projects;
    expect(kept).toEqual(many.slice(0, MAX_DEVICE_PROJECTS));
  });
});

describe("deviceFeaturesOf", () => {
  it("knows the projects feature", () => {
    expect(deviceFeaturesOf(["projects", "mode", "teleport"])).toEqual(["mode", "projects"]);
  });
});
