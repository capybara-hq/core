import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withCanonicalForms } from "../src/exec/operation-types.js";
import {
  otherConnectionDenies,
  PROJECT_REACH_RANK,
  privateTempParentName,
  projectPathRefusal,
  reachWidens,
  readRootsFor,
  unreadableConnectionMessage,
} from "../src/exec/read-model.js";
import { deniedSecretPaths } from "../src/policy.js";

/** Whether the temporary volume ignores case (APFS default on macOS). */
function tempVolumeIgnoresCase(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "case-probe-"));
  try {
    writeFileSync(join(dir, "probe"), "");
    return existsSync(join(dir, "PROBE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ignoresCase = tempVolumeIgnoresCase();

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
    expect(otherConnectionDenies({ ownDeviceId: "a", connections })).toEqual([
      "/home/u/capybara-device/b",
    ]);
    expect(
      sorted(otherConnectionDenies({ ownDeviceId: "a", connections, macTempBases: ["/T", "/U"] })),
    ).toEqual(sorted(["/home/u/capybara-device/b", "/T/capybara-op-b", "/U/capybara-op-b"]));
    expect(privateTempParentName("b")).toBe("capybara-op-b");
  });

  it("denies a logged-out connection's default working directory and temp parents, never its own", () => {
    expect(
      sorted(
        otherConnectionDenies({
          ownDeviceId: "a",
          connections,
          credentialless: ["a", "out"],
          home: "/home/u",
          macTempBases: ["/T"],
        }),
      ),
    ).toEqual(
      sorted([
        "/home/u/capybara-device/b",
        "/T/capybara-op-b",
        "/home/u/capybara-device/out",
        "/T/capybara-op-out",
      ]),
    );
    // without an absolute home the default directory cannot be denied: fail closed
    for (const home of [undefined, "rel/home"])
      expect(() =>
        otherConnectionDenies({
          ownDeviceId: "a",
          connections,
          credentialless: ["out"],
          ...(home === undefined ? {} : { home }),
        }),
      ).toThrow(/home/);
    expect(() =>
      otherConnectionDenies({
        ownDeviceId: "a",
        connections: [],
        credentialless: [".."],
        home: "/h",
      }),
    ).toThrow(/device id/i);
  });

  it("names an unreadable connection, its reason and how to remove it", () => {
    const message = unreadableConnectionMessage({
      deviceId: "b",
      reason: "credential.json is not valid JSON",
    });
    expect(message).toContain("connections/b");
    expect(message).toContain("credential.json is not valid JSON");
    expect(message).toContain("capybara-device logout -c b");
  });

  it("refuses a device id that would leave its parent directory", () => {
    for (const id of ["../x", "a/b", ".", "..", ""])
      expect(() =>
        otherConnectionDenies({
          ownDeviceId: "a",
          connections: [{ deviceId: id, workDir: "/w" }],
          macTempBases: ["/T"],
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

  it("refuses mise's env files and Maven and Gradle credentials from the shared deny list", () => {
    const withShared = { ...input("machine"), secretAndStateDenies: deniedSecretPaths(home) };
    for (const rel of [
      ".config/mise",
      ".config/mise/config.toml",
      ".config/mise/config.local.toml",
      ".config/mise/config.production.toml",
      ".config/mise/conf.d/tokens.toml",
      ".config/mise/age.txt",
      ".config/mise.toml",
      ".mise.toml",
      ".mise.local.toml",
      ".mise/config.toml",
      "mise.toml",
      "mise.local.toml",
      "mise/config.toml",
      "mise/config.local.toml",
      ".config/mise.local.toml",
      ".rtx.toml",
      ".rtx.local.toml",
      "mise/conf.d/tokens.toml",
      ".m2/settings.xml",
      ".m2/settings-security.xml",
      ".m2/settings-security4.xml",
      ".gradle/gradle.properties",
      ".gradle/develocity/keys.properties",
      ".gradle/enterprise/keys.properties",
    ])
      expect(projectPathRefusal(join(home, rel), withShared), rel).toBe("denied");
    // their neighbours stay readable: mise's data and a ~/mise checkout, the local repository,
    // Gradle's caches
    for (const rel of [
      ".local/share/mise",
      ".local/share/mise/installs/node",
      ".config/mise-other",
      "mise",
      "mise/src",
      ".m2/repository",
      ".gradle/caches",
      ".gradle/develocity",
    ])
      expect(projectPathRefusal(join(home, rel), withShared), rel).toBeNull();
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

  it("follows a dangling link into another connection's directory", () => {
    const dang = join(project, "dang");
    symlinkSync(join(bDir, "new"), dang);
    for (const reach of ["machine", "paths", "workspace"] as const)
      expect(projectPathRefusal(dang, input(reach, [project]))).toBe("other-connection");
    expect(projectPathRefusal(join(dang, "x"), input("machine"))).toBe("other-connection");
    // a relative dangling link, two hops deep
    const hop = join(tmp, "outside", "hop");
    symlinkSync("../home/.ssh/missing", hop);
    const first = join(project, "first");
    symlinkSync(hop, first);
    expect(projectPathRefusal(first, input("machine"))).toBe("denied");
  });

  it("treats a dangling link as outside a narrower reach", () => {
    const dang = join(project, "later");
    symlinkSync(join(project, "not-yet"), dang);
    expect(projectPathRefusal(dang, input("machine"))).toBeNull();
    expect(projectPathRefusal(dang, input("paths", [project]))).toBe("outside-reach");
    const ws = join(roots.workspace, "later");
    symlinkSync(join(roots.workspace, "not-yet"), ws);
    expect(projectPathRefusal(ws, input("workspace"))).toBe("outside-reach");
  });

  it("ends a dangling link loop", () => {
    const a = join(project, "loop-a");
    const b = join(project, "loop-b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(projectPathRefusal(a, input("machine"))).toBeNull();
    expect(projectPathRefusal(a, input("paths", [project]))).toBe("outside-reach");
  });

  it.skipIf(!ignoresCase)("refuses case variants of denied directories", () => {
    const variant = join(tmp, "HOME", "Capybara-Device", "B", "x");
    expect(projectPathRefusal(variant, input("machine"))).toBe("other-connection");
    expect(projectPathRefusal(join(home, ".SSH"), input("machine"))).toBe("denied");
    expect(projectPathRefusal(join(home, ".Ssh", "id"), input("machine"))).toBe("denied");
  });

  it.skipIf(process.platform !== "darwin")(
    "refuses a denied directory spelled through the macOS data volume firmlink",
    () => {
      // a firmlink is not a symlink: realpath keeps /System/Volumes/Data, the sandbox does not
      const real = realpathSync(bDir);
      const viaData = `/System/Volumes/Data${real}`;
      expect(existsSync(viaData)).toBe(true);
      for (const reach of ["machine", "paths", "workspace"] as const) {
        expect(projectPathRefusal(join(viaData, "repo"), input(reach, [viaData]))).toBe(
          "other-connection",
        );
      }
      expect(projectPathRefusal(`/system/volumes/data${real}`, input("machine"))).toBe(
        "other-connection",
      );
      const ssh = `/System/Volumes/Data${realpathSync(join(home, ".ssh"))}/id`;
      expect(projectPathRefusal(ssh, input("machine"))).toBe("denied");
      // a deny list spelled through the firmlink still matches the plain spelling
      const viaDeny = { ...input("machine"), otherConnectionDenies: [viaData] };
      expect(projectPathRefusal(join(real, "x"), viaDeny)).toBe("other-connection");
      // the extra forms never widen a reach: the firmlink spelling of a listed path stays outside
      const listed = realpathSync(project);
      expect(projectPathRefusal(`/System/Volumes/Data${listed}`, input("paths", [listed]))).toBe(
        "outside-reach",
      );
    },
  );

  it.skipIf(!ignoresCase)("allows a case variant of a listed path under paths reach", () => {
    const variant = join(tmp, "Projects", "P", "src");
    expect(projectPathRefusal(variant, input("paths", [project]))).toBeNull();
  });
});

describe("withCanonicalForms", () => {
  it.skipIf(!ignoresCase)("adds the on-disk case of an existing ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "canon-case-"));
    try {
      mkdirSync(join(tmp, "Real"));
      const forms = withCanonicalForms([join(tmp, "REAL", "missing")]);
      expect(forms).toContain(join(realpathSync(tmp), "Real", "missing"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
