import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProject,
  candidates,
  listProjects,
  MAX_CANDIDATES,
  projectPath,
  projectScope,
  removeProject,
} from "../src/projects.js";
import type { Policy } from "../src/state.js";

/** A policy that serves `projects` (the only field the project store reads). */
const policy = (projects: Policy["projects"] = []): Pick<Policy, "projects"> => ({ projects });

const sandbox = (workspace: string) => ({ mode: "sandbox" as const, base: workspace });
const auto = (home: string) => ({ mode: "auto" as const, base: home });

describe("projectScope", () => {
  it("offers the workspace in sandbox mode and resolves from the owner's home in auto mode", () => {
    expect(projectScope("sandbox", { workspace: "/w" }, false, "/home/me")).toEqual({
      mode: "sandbox",
      base: "/w",
    });
    expect(projectScope("auto", { workspace: "/w" }, false, "/home/me")).toEqual({
      mode: "auto",
      base: "/home/me",
    });
  });

  it("offers only its workspace on a container device, in either mode", () => {
    expect(projectScope("auto", { workspace: "/workspace" }, true, "/home/me")).toEqual({
      mode: "sandbox",
      base: "/workspace",
    });
  });
});

describe("projectPath", () => {
  it("takes a relative path from the base and keeps an absolute one", () => {
    expect(projectPath(sandbox("/w"), "core")).toBe("/w/core");
    expect(projectPath(auto("/home/me"), "code/core")).toBe("/home/me/code/core");
    expect(projectPath(auto("/home/me"), "/opt/core")).toBe("/opt/core");
  });
});

describe("addProject", () => {
  it("refuses a path outside the workspace in sandbox mode, naming the reason", () => {
    expect(addProject(policy(), { path: "/home/me/other" }, sandbox("/w"))).toEqual({
      refused: expect.stringContaining("outside the device's workspace"),
    });
  });

  it("accepts the workspace itself and any directory under it", () => {
    expect(addProject(policy(), { path: "/w/core" }, sandbox("/w"))).toEqual({
      project: { name: "core", path: "/w/core" },
    });
    expect(addProject(policy(), { path: "." }, sandbox("/w"))).toEqual({
      project: { name: "w", path: "/w" },
    });
  });

  it("offers any absolute path its owner can read in auto mode", () => {
    expect(addProject(policy(), { path: "/opt/core" }, auto("/home/me"))).toEqual({
      project: { name: "core", path: "/opt/core" },
    });
  });

  it("resolves a relative path against the mode's base", () => {
    expect(addProject(policy(), { path: "core" }, sandbox("/w"))).toEqual({
      project: { name: "core", path: "/w/core" },
    });
    expect(addProject(policy(), { path: "code/core" }, auto("/home/me"))).toEqual({
      project: { name: "core", path: "/home/me/code/core" },
    });
  });

  it("keeps an explicit name", () => {
    expect(addProject(policy(), { path: "/w/core", name: "platform" }, sandbox("/w"))).toEqual({
      project: { name: "platform", path: "/w/core" },
    });
  });

  it("refuses a name already served", () => {
    const served = policy([{ name: "core", path: "/w/other" }]);
    expect(addProject(served, { path: "/w/core" }, sandbox("/w"))).toEqual({
      refused: expect.stringContaining("core"),
    });
  });

  it("treats a workspace child whose name starts with .. as inside, and a sibling as outside", () => {
    expect(addProject(policy(), { path: "/w/..foo" }, sandbox("/w"))).toEqual({
      project: { name: "..foo", path: "/w/..foo" },
    });
    expect(addProject(policy(), { path: "/wx/core" }, sandbox("/w"))).toEqual({
      refused: expect.stringContaining("outside the device's workspace"),
    });
    expect(addProject(policy(), { path: "/w/../etc" }, sandbox("/w"))).toEqual({
      refused: expect.stringContaining("outside the device's workspace"),
    });
  });

  it("refuses a name containing / and a path with no basename", () => {
    expect(addProject(policy(), { path: "/w/core", name: "a/b" }, sandbox("/w"))).toEqual({
      refused: expect.stringContaining("no usable directory name"),
    });
    expect(addProject(policy(), { path: "/" }, auto("/home/me"))).toEqual({
      refused: expect.stringContaining("no usable directory name"),
    });
  });

  it("does not change the policy it is given", () => {
    const served = policy();
    addProject(served, { path: "/w/core" }, sandbox("/w"));
    expect(served.projects).toEqual([]);
  });
});

describe("removeProject", () => {
  it("reports whether the name is served, leaving the policy alone", () => {
    const served = policy([{ name: "core", path: "/w/core" }]);
    expect(removeProject(served, "core")).toBe(true);
    expect(removeProject(served, "nope")).toBe(false);
    expect(served.projects).toEqual([{ name: "core", path: "/w/core" }]);
  });
});

describe("listProjects", () => {
  it("returns the served projects as a copy", () => {
    const served = policy([{ name: "core", path: "/w/core" }]);
    const list = listProjects(served, sandbox("/w"));
    expect(list).toEqual([{ name: "core", path: "/w/core" }]);
    expect(list).not.toBe(served.projects);
  });

  it("offers only what the current mode can read, keeping the rest in the policy", () => {
    const served = policy([
      { name: "core", path: "/w/core" },
      { name: "home", path: "/home/me/code/home" },
    ]);
    expect(listProjects(served, sandbox("/w"))).toEqual([{ name: "core", path: "/w/core" }]);
    expect(listProjects(served, auto("/home/me"))).toEqual(served.projects);
    expect(served.projects).toHaveLength(2);
  });
});

describe("candidates", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "device-project-candidates-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Creates a directory under the root and returns its path. */
  const dir = (...parts: string[]): string => {
    const p = join(root, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };
  /** Creates a file under the root (its parent included) and returns its path. */
  const file = (...parts: string[]): string => {
    const p = join(root, ...parts);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
    return p;
  };

  it("finds a directory with .git or AGENTS.md two levels down and ignores a plain one", () => {
    dir("a", ".git");
    file("b", "AGENTS.md");
    dir("plain");
    dir("x", "y", ".git");
    expect(candidates(root, MAX_CANDIDATES)).toEqual([
      { name: "a", path: join(root, "a") },
      { name: "b", path: join(root, "b") },
      { name: "y", path: join(root, "x", "y") },
    ]);
  });

  it("does not look deeper than two levels", () => {
    dir("x", "y", "z", ".git");
    expect(candidates(root, MAX_CANDIDATES)).toEqual([]);
  });

  it("skips hidden directories and does not suggest the root itself", () => {
    dir(".git");
    dir(".hidden", ".git");
    dir(".config", "app", ".git");
    expect(candidates(root, MAX_CANDIDATES)).toEqual([]);
  });

  it("skips symbolic links, to directories that look like projects too", () => {
    const target = mkdtempSync(join(tmpdir(), "device-project-link-target-"));
    try {
      mkdirSync(join(target, "proj", ".git"), { recursive: true });
      symlinkSync(join(target, "proj"), join(root, "linked"));
      symlinkSync(target, join(root, "linkdir"));
      expect(candidates(root, MAX_CANDIDATES)).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("is capped at the limit", () => {
    for (let i = 0; i < MAX_CANDIDATES + 10; i += 1) {
      dir(`p${String(i).padStart(2, "0")}`, ".git");
    }
    expect(candidates(root, MAX_CANDIDATES)).toHaveLength(MAX_CANDIDATES);
  });

  it("returns nothing for a missing or unreadable root", () => {
    expect(candidates(join(root, "missing"), MAX_CANDIDATES)).toEqual([]);
  });
});
