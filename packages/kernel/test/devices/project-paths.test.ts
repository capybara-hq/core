import { describe, expect, it } from "vitest";
import {
  joinProjectPath,
  projectFilePath,
  projectRelativePath,
} from "../../src/devices/project-paths.js";
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

describe("projectFilePath", () => {
  it("normalizes like projectRelativePath", () => {
    expect(projectFilePath("./src/a.ts")).toBe("src/a.ts");
  });

  it.each([".", "./", "a/..", "a/b/../..", ""])(
    "refuses %j, which names the project root, with a message and details that are never empty",
    (rel) => {
      let err: unknown;
      try {
        projectFilePath(rel);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("device.path_outside_project");
      expect(e.message).toBe(
        "The project root is not a file; give the path of a file inside the project",
      );
      expect(e.details).toEqual(rel === "" ? undefined : [{ path: rel }]);
    },
  );

  it("refuses an escape as projectRelativePath does", () => {
    expect(() => projectFilePath("../x")).toThrow(ApiError);
  });
});

describe("joinProjectPath", () => {
  it.each([
    ["/home/me/app", "", "/home/me/app"],
    ["/home/me/app", "src", "/home/me/app/src"],
    ["/home/me/app", "src/a.ts", "/home/me/app/src/a.ts"],
    ["/", "etc", "/etc"],
    ["/", "", "/"],
  ])("joins %j and %j", (root, rel, want) => {
    expect(joinProjectPath(root, rel)).toBe(want);
  });

  it("normalizes the relative path itself and refuses an escape", () => {
    expect(joinProjectPath("/home/me/app", "./src/../lib/")).toBe("/home/me/app/lib");
    expect(() => joinProjectPath("/home/me/app", "../other")).toThrow(ApiError);
  });

  it.each(["app", "", "/home/me/app/", "/home/me/./app", "/home/me/x/../app", "/home//me"])(
    "refuses the project path %j as an internal error",
    (root) => {
      let err: unknown;
      try {
        joinProjectPath(root, "src");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ApiError);
    },
  );
});
