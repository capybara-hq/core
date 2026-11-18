import { describe, expect, it } from "vitest";
import {
  MAC_SYSTEM_READ_EXACT,
  MAC_SYSTEM_READ_ROOTS,
  macReadAllows,
} from "../src/exec/mac-read-policy.js";

describe("macReadAllows", () => {
  const project = "/Users/me/src/app";
  const base = {
    roots: [project, "/Users/me/.asdf"],
    exact: ["/Users/me/.tool-versions", "/Users/me/.capybara-device/helper.py"],
    deniedReadRoots: ["/Users/me/.ssh", "/Users/me/.capybara-device"],
    isSymlink: () => false,
  };

  it("reads the roots and system roots whole and never a granted root's ancestor", () => {
    const { allowRead, allowReadExact } = macReadAllows(base);
    expect(allowRead).toEqual([...MAC_SYSTEM_READ_ROOTS, project, "/Users/me/.asdf"]);
    for (const ancestor of ["/", "/Users", "/Users/me", "/Users/me/src"]) {
      expect(allowRead).not.toContain(ancestor);
      expect(allowReadExact).not.toContain(ancestor);
    }
  });

  it("reads the given paths and the system paths exactly", () => {
    const { allowReadExact } = macReadAllows(base);
    expect(allowReadExact).toEqual([
      ...MAC_SYSTEM_READ_EXACT,
      "/Users/me/.tool-versions",
      "/Users/me/.capybara-device/helper.py",
    ]);
  });

  it("adds a symbolic link among the ancestors exactly, unless it is under a denied root", () => {
    const links = new Set(["/Users/me/src", "/Users/me/.ssh/link"]);
    const { allowRead, allowReadExact } = macReadAllows({
      ...base,
      roots: [project, "/Users/me/.ssh/link/x"],
      isSymlink: (p) => links.has(p),
    });
    expect(allowReadExact).toContain("/Users/me/src");
    expect(allowRead).not.toContain("/Users/me/src");
    expect(allowReadExact).not.toContain("/Users/me/.ssh/link");
  });

  it("reads only the xcrun cache of the user's temporary directory", () => {
    const { allowRead, allowReadExact } = macReadAllows({
      ...base,
      userTempDir: "/private/var/folders/ab/cd/T/",
    });
    expect(allowReadExact).toContain("/private/var/folders/ab/cd/T/xcrun_db");
    expect(allowReadExact).not.toContain("/private/var/folders/ab/cd/T");
    expect(allowRead.some((p) => p.startsWith("/private/var/folders"))).toBe(false);
  });

  it("keeps the system read set free of user data and of the root", () => {
    for (const p of [...MAC_SYSTEM_READ_ROOTS, ...MAC_SYSTEM_READ_EXACT]) {
      expect(p).not.toBe("/");
      expect(p.startsWith("/Users")).toBe(false);
      expect(p.startsWith("/private/var/folders")).toBe(false);
      expect(["/Library", "/private", "/private/var", "/Applications", "/opt"]).not.toContain(p);
    }
  });
});
