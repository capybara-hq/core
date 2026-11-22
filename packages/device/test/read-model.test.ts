import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSandboxScopeDeniedError, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  otherConnectionDenies,
  PROJECT_REACH_RANK,
  privateTempParentName,
  projectPathRefusal,
  reachWidens,
  readRootsFor,
} from "../src/exec/read-model.js";

const sorted = (xs: readonly string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("project reach", () => {
  it("ranks workspace < paths < machine", () => {
    expect(PROJECT_REACH_RANK).toEqual({ workspace: 0, paths: 1, machine: 2 });
    expect(reachWidens("workspace", "paths")).toBe(true);
    expect(reachWidens("paths", "machine")).toBe(true);
    expect(reachWidens("machine", "paths")).toBe(false);
    expect(reachWidens("paths", "paths")).toBe(false);
  });
});

describe("readRootsFor", () => {
  const roots: SandboxRoots = { workspace: "/w/dev", skills: "/w/skills", tmp: "/w/tmp" };

  it("machine reach reads the whole machine", () => {
    expect(
      readRootsFor({ reach: "machine", projectPaths: ["/p"], roots, writeRoots: ["/x"] }),
    ).toEqual(["/"]);
  });

  it("paths reach reads the listed paths, the device roots and the write roots only", () => {
    expect(
      readRootsFor({
        reach: "paths",
        projectPaths: ["/src/a", "/src/b/", "/src/a"],
        roots,
        writeRoots: ["/out", "/w/dev/sub"],
      }),
    ).toEqual(sorted(["/src/a", "/src/b", "/w/dev", "/w/skills", "/w/tmp", "/out"]));
    expect(readRootsFor({ reach: "paths", projectPaths: [], roots, writeRoots: ["/out"] })).toEqual(
      sorted(["/w/dev", "/w/skills", "/w/tmp", "/out"]),
    );
  });

  it("drops a listed path inside another entry", () => {
    expect(
      readRootsFor({ reach: "paths", projectPaths: ["/src", "/src/a/.."], roots, writeRoots: [] }),
    ).toEqual(sorted(["/src", "/w/dev", "/w/skills", "/w/tmp"]));
  });

  it("workspace reach reads the device roots and write roots", () => {
    expect(
      readRootsFor({ reach: "workspace", projectPaths: ["/src"], roots, writeRoots: ["/out"] }),
    ).toEqual(sorted(["/w/dev", "/w/skills", "/w/tmp", "/out"]));
  });
});

describe("otherConnectionDenies", () => {
  const connections = [
    { deviceId: "a", workDir: "/home/u/capybara-device/a" },
    { deviceId: "b", workDir: "/home/u/capybara-device/b/" },
  ];

  it("denies every other connection's working directory, never its own", () => {
    expect(otherConnectionDenies({ ownDeviceId: "a", connections, unreadable: [] })).toEqual([
      "/home/u/capybara-device/b",
    ]);
    expect(
      sorted(
        otherConnectionDenies({ ownDeviceId: "a", connections, unreadable: [], macTempBase: "/T" }),
      ),
    ).toEqual(sorted(["/home/u/capybara-device/b", "/T/capybara-op-b"]));
    expect(privateTempParentName("b")).toBe("capybara-op-b");
  });

  it("fails closed on a connection whose credential cannot be read", () => {
    let caught: unknown;
    try {
      otherConnectionDenies({
        ownDeviceId: "a",
        connections: connections.slice(0, 1),
        unreadable: [{ deviceId: "b", reason: "credential.json is not valid JSON" }],
      });
    } catch (error) {
      caught = error;
    }
    expect(isSandboxScopeDeniedError(caught)).toBe(true);
    const message = (caught as Error).message;
    expect(message).toContain("connections/b");
    expect(message).toContain("credential.json is not valid JSON");
    expect(message).toContain("capybara-device logout -c b");
  });

  it("ignores its own unreadable entry", () => {
    expect(
      otherConnectionDenies({
        ownDeviceId: "a",
        connections,
        unreadable: [{ deviceId: "a", reason: "x" }],
      }),
    ).toEqual(["/home/u/capybara-device/b"]);
  });

  it("refuses a device id that would leave its parent directory", () => {
    for (const id of ["../x", "a/b", ".", "..", ""])
      expect(() =>
        otherConnectionDenies({
          ownDeviceId: "a",
          connections: [{ deviceId: id, workDir: "/w" }],
          unreadable: [],
          macTempBase: "/T",
        }),
      ).toThrow(/device id/i);
  });
});

describe("projectPathRefusal", () => {
  let tmp: string;
  let home: string;
  let bDir: string;
  let roots: SandboxRoots;
  let project: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "read-model-"));
    home = join(tmp, "home");
    bDir = join(home, "capybara-device", "b");
    project = join(tmp, "projects", "p");
    for (const d of [bDir, join(home, ".ssh"), project, join(tmp, "outside")])
      mkdirSync(d, { recursive: true });
    roots = {
      workspace: join(home, "capybara-device", "a"),
      skills: join(tmp, "skills"),
      tmp: join(tmp, "dtmp"),
    };
    mkdirSync(roots.workspace, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const input = (reach: "machine" | "paths" | "workspace", projectPaths: string[] = []) => ({
    reach,
    projectPaths,
    roots,
    secretAndStateDenies: [join(home, ".ssh")],
    otherConnectionDenies: [bDir],
  });

  it("refuses another connection's directory, also through a symlink", () => {
    for (const reach of ["machine", "paths", "workspace"] as const) {
      expect(projectPathRefusal(join(bDir, "repo"), input(reach))).toBe("other-connection");
      expect(projectPathRefusal(bDir, input(reach))).toBe("other-connection");
    }
    const link = join(tmp, "link");
    symlinkSync(bDir, link);
    expect(projectPathRefusal(link, input("machine"))).toBe("other-connection");
    expect(projectPathRefusal(join(link, "repo"), input("machine"))).toBe("other-connection");
  });

  it("refuses through the canonical form of a denied directory", () => {
    // the deny list names B's directory through a link; the path names its real location
    const alias = join(tmp, "alias-b");
    symlinkSync(bDir, alias);
    const viaAlias = { ...input("machine"), otherConnectionDenies: [alias] };
    expect(projectPathRefusal(join(realpathSync(bDir), "x"), viaAlias)).toBe("other-connection");
  });

  it("refuses secret and state paths", () => {
    expect(projectPathRefusal(join(home, ".ssh"), input("machine"))).toBe("denied");
    expect(projectPathRefusal(join(home, ".ssh", "id_ed25519"), input("machine"))).toBe("denied");
    const link = join(tmp, "ssh-link");
    symlinkSync(join(home, ".ssh"), link);
    expect(projectPathRefusal(link, input("machine"))).toBe("denied");
  });

  it("checks other connections before secrets", () => {
    const both = { ...input("machine"), secretAndStateDenies: [bDir] };
    expect(projectPathRefusal(bDir, both)).toBe("other-connection");
  });

  it("machine reach allows anything not denied, including a directory containing a deny", () => {
    expect(projectPathRefusal("/opt/x", input("machine"))).toBeNull();
    expect(projectPathRefusal(home, input("machine"))).toBeNull();
    expect(projectPathRefusal("/", input("machine"))).toBeNull();
  });

  it("paths reach allows the listed paths and the device roots only", () => {
    expect(projectPathRefusal(join(project, "src"), input("paths", [project]))).toBeNull();
    expect(projectPathRefusal(project, input("paths", [project]))).toBeNull();
    expect(projectPathRefusal(join(roots.workspace, "r"), input("paths", [project]))).toBeNull();
    expect(projectPathRefusal(roots.skills, input("paths", [project]))).toBeNull();
    expect(projectPathRefusal(join(roots.tmp, "t"), input("paths", [project]))).toBeNull();
    expect(projectPathRefusal(join(tmp, "outside"), input("paths", [project]))).toBe(
      "outside-reach",
    );
    expect(projectPathRefusal(join(tmp, "projects"), input("paths", [project]))).toBe(
      "outside-reach",
    );
    expect(projectPathRefusal(join(tmp, "outside"), input("paths", []))).toBe("outside-reach");
  });

  it("paths reach allows a link whose canonical form is inside a listed path", () => {
    const link = join(tmp, "outside", "to-project");
    symlinkSync(project, link);
    expect(projectPathRefusal(link, input("paths", [project]))).toBeNull();
    expect(projectPathRefusal(join(link, "src"), input("paths", [project]))).toBeNull();
  });

  it("paths reach refuses a link inside a listed path whose canonical form is outside", () => {
    const exit = join(project, "escape");
    symlinkSync(join(tmp, "outside"), exit);
    expect(projectPathRefusal(exit, input("paths", [project]))).toBe("outside-reach");
    expect(projectPathRefusal(join(exit, "f"), input("paths", [project]))).toBe("outside-reach");
  });

  it("paths reach compares a symlinked listed path canonically", () => {
    const listed = join(tmp, "listed-link");
    symlinkSync(project, listed);
    expect(projectPathRefusal(join(realpathSync(project), "src"), input("paths", [listed]))).toBe(
      null,
    );
    expect(projectPathRefusal(join(listed, "src"), input("paths", [listed]))).toBeNull();
  });

  it("paths reach still refuses a listed path inside another connection's directory", () => {
    expect(projectPathRefusal(join(bDir, "repo"), input("paths", [bDir]))).toBe("other-connection");
  });

  it("workspace reach allows the device roots only", () => {
    expect(projectPathRefusal(join(roots.workspace, "r"), input("workspace"))).toBeNull();
    expect(projectPathRefusal(project, input("workspace", [project]))).toBe("outside-reach");
    expect(projectPathRefusal(join(tmp, "outside"), input("workspace"))).toBe("outside-reach");
  });

  it("refuses a relative path", () => {
    expect(projectPathRefusal("repo", input("machine"))).toBe("outside-reach");
  });

  it("normalizes dot segments before matching", () => {
    expect(projectPathRefusal(`${roots.workspace}/../b/x`, input("machine"))).toBe(
      "other-connection",
    );
  });
});
