import { describe, expect, it } from "vitest";
import { joinProjectPath, projectRelativePath } from "../../src/devices/project-paths.js";
import { ApiError } from "../../src/errors.js";

/** Paths relative to a device project (composer menus §5): normalized, never above the root. */
describe("projectRelativePath", () => {
  it.each([
    ["", ""],
    [".", ""],
    ["./", ""],
    ["src/", "src"],
    ["./a/./b", "a/b"],
    ["a/../b", "b"],
    ["a//b", "a/b"],
    ["a/b/..", "a"],
    ["a/..", ""],
    ["notes.txt", "notes.txt"],
    ["..foo/bar", "..foo/bar"],
  ])("normalizes %j to %j", (rel, want) => {
    expect(projectRelativePath(rel)).toBe(want);
  });

  it.each([
    "..",
    "../x",
    "a/../../x",
    "a/../..",
    "/etc",
    "//x",
    "a\\b",
    "..\\x",
    "a\u0000",
    "a\nb",
    "x".repeat(4097),
  ])("refuses %j with device.path_outside_project", (rel) => {
    let err: unknown;
    try {
      projectRelativePath(rel);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "device.path_outside_project" });
  });
});

describe("joinProjectPath", () => {
  it.each([
    ["/home/me/app", "", "/home/me/app"],
    ["/home/me/app", "src", "/home/me/app/src"],
    ["/home/me/app/", "src/a.ts", "/home/me/app/src/a.ts"],
    ["/", "etc", "/etc"],
    ["/", "", "/"],
  ])("joins %j and %j", (root, rel, want) => {
    expect(joinProjectPath(root, rel)).toBe(want);
  });

  it("normalizes the relative path itself and refuses an escape", () => {
    expect(joinProjectPath("/home/me/app", "./src/../lib/")).toBe("/home/me/app/lib");
    expect(() => joinProjectPath("/home/me/app", "../other")).toThrow(ApiError);
  });
});
