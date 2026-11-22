import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionDir } from "../src/connections.js";
import {
  PROJECT_ROOTS_MAX,
  projectRootsPath,
  readProjectRoots,
  recordProjectRoot,
  sharedProjectRoots,
} from "../src/project-roots.js";
import { writeCredential } from "../src/state.js";

/** The machine directory (a fresh XDG_CONFIG_HOME/capybara-device stand-in). */
let m: string;
beforeEach(() => {
  m = realpathSync(mkdtempSync(join(tmpdir(), "device-projects-")));
  chmodSync(m, 0o700);
});
afterEach(() => {
  rmSync(m, { recursive: true, force: true });
});

/** A logged-in connection directory of the machine. */
function connection(id: string): string {
  const d = connectionDir(m, id);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeCredential(d, {
    url: "http://x.test",
    connectUrl: "ws://x.test/device/connect",
    credential: "cap_dev_secret_value",
    orgId: "o",
    deviceId: id,
    dir: "/w",
    mode: "os",
    reconnectGraceSeconds: 120,
    maxFrameBytes: 16 * 1024 * 1024,
  });
  return d;
}

describe("project roots of one connection", () => {
  it("records project roots most recent first, deduplicated and bounded", () => {
    const d = connection("dev-a");
    expect(readProjectRoots(d)).toEqual([]);
    recordProjectRoot(d, "/p/one");
    recordProjectRoot(d, "/p/two");
    recordProjectRoot(d, "/p/one");
    expect(readProjectRoots(d)).toEqual(["/p/one", "/p/two"]);
    expect(statSync(projectRootsPath(d)).mode & 0o777).toBe(0o600);
    expect(projectRootsPath(d)).toBe(join(d, "projects.json"));
    for (let i = 0; i < PROJECT_ROOTS_MAX + 10; i++) recordProjectRoot(d, `/p/n${i}`);
    const roots = readProjectRoots(d);
    expect(roots).toHaveLength(PROJECT_ROOTS_MAX);
    expect(roots[0]).toBe(`/p/n${PROJECT_ROOTS_MAX + 9}`);
    expect(roots).not.toContain("/p/one");
  });

  it("an invalid file or entry reads as none, and a malformed root is never recorded", () => {
    const d = connection("dev-a");
    writeFileSync(projectRootsPath(d), "{not json");
    expect(readProjectRoots(d)).toEqual([]);
    writeFileSync(projectRootsPath(d), JSON.stringify({ version: 1, roots: ["/ok", "rel", 3] }));
    expect(readProjectRoots(d)).toEqual(["/ok"]);
    recordProjectRoot(d, "relative/dir");
    recordProjectRoot(d, "/a/../b");
    expect(readProjectRoots(d)).toEqual(["/ok"]);
    // never through a symlink, never a FIFO (no blocking read), never an oversized file
    const elsewhere = join(m, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, roots: ["/p/linked"] }));
    rmSync(projectRootsPath(d));
    symlinkSync(elsewhere, projectRootsPath(d));
    expect(readProjectRoots(d)).toEqual([]);
    rmSync(projectRootsPath(d));
    execFileSync("mkfifo", [projectRootsPath(d)]);
    expect(readProjectRoots(d)).toEqual([]);
    rmSync(projectRootsPath(d));
    writeFileSync(
      projectRootsPath(d),
      JSON.stringify({ version: 1, roots: ["/ok"], pad: "x".repeat(2 * 1024 * 1024) }),
    );
    expect(readProjectRoots(d)).toEqual([]);
    // a write replaces a broken file
    writeFileSync(projectRootsPath(d), "[]");
    recordProjectRoot(d, "/p/new");
    expect(JSON.parse(readFileSync(projectRootsPath(d), "utf8"))).toEqual({
      version: 1,
      roots: ["/p/new"],
    });
  });
});

describe("shared project roots of the machine", () => {
  it("a root both connections recorded is shared; the other connection's own roots are never returned", () => {
    const a = connection("dev-a");
    const b = connection("dev-b");
    for (const r of ["/p/a", "/p/shared"]) recordProjectRoot(a, r);
    for (const r of ["/p/b", "/p/shared"]) recordProjectRoot(b, r);
    expect(sharedProjectRoots(m, "dev-a")).toEqual(["/p/shared"]);
    expect(sharedProjectRoots(m, "dev-b")).toEqual(["/p/shared"]);
  });

  it("roots are compared by their real path", () => {
    const real = join(m, "work", "core");
    mkdirSync(real, { recursive: true });
    const link = join(m, "link");
    symlinkSync(join(m, "work"), link);
    const a = connection("dev-a");
    const b = connection("dev-b");
    recordProjectRoot(a, join(link, "core"));
    recordProjectRoot(b, real);
    // this connection's own spelling is returned
    expect(sharedProjectRoots(m, "dev-a")).toEqual([join(link, "core")]);
    expect(sharedProjectRoots(m, "dev-b")).toEqual([real]);
  });

  it("a logged-out connection directory and a lone connection share nothing", () => {
    const a = connection("dev-a");
    recordProjectRoot(a, "/p/shared");
    expect(sharedProjectRoots(m, "dev-a")).toEqual([]);
    const gone = connectionDir(m, "dev-gone");
    mkdirSync(gone, { recursive: true, mode: 0o700 });
    recordProjectRoot(gone, "/p/shared");
    expect(sharedProjectRoots(m, "dev-a")).toEqual([]);
    // a machine without a connections directory
    expect(sharedProjectRoots(join(m, "absent"), "dev-a")).toEqual([]);
  });
});
