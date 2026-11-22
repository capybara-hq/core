import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { CONNECTIONS_DIR } from "../src/connections.js";
import {
  grantStillHolds,
  intersectOperation,
  OUTSIDE_SANDBOX_REFUSAL,
  PROJECT_REFUSAL_MESSAGES,
  readStrictOwnerCeiling,
  readStrictOwnerCeilingSync,
} from "../src/exec/operation-types.js";
import { privateTempParentName } from "../src/exec/read-model.js";
import { macUserTempDir, osRoots } from "../src/exec/shared.js";
import {
  type Credential,
  DEFAULT_POLICY,
  type OwnerCeilingPolicy,
  type Policy,
  writeCredential,
  writePolicy,
} from "../src/state.js";

const FULL_OWNER_CEILING: OwnerCeilingPolicy = {
  outsideSandbox: true,
  network: "open",
  projectReach: "machine",
};

/** The policy these tests were written against: outside the sandbox on, the open network. */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
type Connections = {
  readable: { deviceId: string; workDir: string }[];
  unreadable: { deviceId: string; reason: string }[];
};
/**
 * A machine state root `<dir>/machine` holding this connection `a` (its state in
 * `connections/a`, its device directory `<dir>/device`) and whatever other connections a test
 * puts in `connections` (read on every ceiling read).
 */
async function fixture(policy: Partial<Policy> = {}) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "cap-ceiling-")));
  dirs.push(dir);
  const stateRoot = join(dir, "machine");
  const stateDir = join(stateRoot, CONNECTIONS_DIR, "a");
  const own = { deviceId: "a", workDir: join(dir, "device") };
  const connections: Connections = { readable: [own], unreadable: [] };
  const setPolicy = (p: Partial<Policy>) =>
    writePolicy(stateDir, { ...FULL_POLICY, allowedDomains: ["*.example.com"], ...p });
  setPolicy(policy);
  const roots = osRoots(join(dir, "device"));
  const input = {
    stateDir,
    deviceId: "a",
    dir: join(dir, "device"),
    home: join(dir, "home"),
    stateRoot,
    connections: () => connections,
    macTempBase: join(dir, "usertemp"),
  };
  const read = () => readStrictOwnerCeiling(input);
  const addOther = (deviceId: string) => {
    const workDir = join(dir, deviceId);
    mkdirSync(workDir, { recursive: true });
    connections.readable.push({ deviceId, workDir });
    return workDir;
  };
  return { dir, stateRoot, stateDir, roots, read, input, connections, addOther, setPolicy };
}
const scope = (roots: ReturnType<typeof osRoots>) => ({
  operationId: "op",
  admitBeforeMs: Date.now() + 60000,
  deviceId: "d",
  rootConversationId: "root",
  profileRevision: 0,
  ceilingRevision: "opaque",
  profile: "approve-for-me" as const,
  actor: { accountId: "a", conversationId: "root" },
  tag: "op",
  filesystem: {
    kind: "scoped" as const,
    projectRoot: roots.workspace as string | null,
    writeRoots: [roots.tmp],
  },
  network: {
    kind: "allowlist" as const,
    hosts: ["a.example.com", "approved.test", "unknown.test"],
  },
});
const open = { operationId: "op", orgNetwork: { kind: "open-public" as const, hosts: [] } };
const scoped = (
  roots: ReturnType<typeof osRoots>,
  projectRoot: string | null,
  writeRoots: string[] = projectRoot === null ? [] : [projectRoot],
) => {
  const s = scope(roots);
  s.filesystem.projectRoot = projectRoot;
  s.filesystem.writeRoots = writeRoots;
  return s;
};
/** Calls `fn` and returns the SandboxScopeDeniedError it throws (fails the test otherwise). */
function refusal(fn: () => unknown): SandboxScopeDeniedError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxScopeDeniedError);
    return error as SandboxScopeDeniedError;
  }
  throw new Error("expected a SandboxScopeDeniedError");
}

describe("project reach and other connections' directories", () => {
  it("machine reach grants / and denies secrets, the state root and other connections", async () => {
    const f = await fixture();
    const b = f.addOther("b");
    const project = join(f.dir, "project");
    mkdirSync(project);
    const c = await f.read();
    expect(c.projectReach).toBe("machine");
    const g = intersectOperation(scoped(f.roots, project), c, open);
    expect(g.readRoots).toEqual(["/"]);
    expect(g.writeRoots).toEqual([project]);
    expect(g.deniedReadRoots).toContain(join(f.dir, "home", ".ssh"));
    expect(g.deniedReadRoots).toContain(f.stateRoot);
    expect(g.deniedReadRoots).toContain(f.stateDir);
    expect(g.deniedReadRoots).toContain(b);
    // the other connection's private temporary parent in the macOS user temp dir
    expect(g.deniedReadRoots).toContain(join(f.dir, "usertemp", privateTempParentName("b")));
    expect(g.deniedReadRoots).not.toContain(join(f.dir, "device"));
    expect(g.deniedReadRoots).not.toContain(join(f.dir, "usertemp", privateTempParentName("a")));
    // the split lists, and their union
    expect(c.otherConnectionDenies).toContain(b);
    expect(c.otherConnectionDenies).not.toContain(f.stateRoot);
    expect(c.secretAndStateDenies).toContain(f.stateRoot);
    expect(c.secretAndStateDenies).not.toContain(b);
    expect([...c.restrictedDeniedReadRoots].sort()).toEqual(
      [...new Set([...c.secretAndStateDenies, ...c.otherConnectionDenies])].sort(),
    );
  });
  it("the revision changes when a connection is added or removed", async () => {
    const f = await fixture();
    const s = scoped(f.roots, f.roots.workspace);
    const one = await f.read();
    const before = intersectOperation(s, one, open);
    f.addOther("b");
    const two = await f.read();
    expect(two.revision).not.toBe(one.revision);
    const after = intersectOperation(s, two, open);
    expect(grantStillHolds(before, after)).toBe(false);
    f.connections.readable.pop();
    const three = await f.read();
    expect(three.revision).not.toBe(two.revision);
    expect(three.revision).toBe(one.revision);
  });
  it("fails closed when another connection's credential cannot be read", async () => {
    const f = await fixture();
    const cred = (id: string, dir: string | null) =>
      ({
        url: `https://${id}.example.com/x`,
        connectUrl: "wss://example.com/ws",
        credential: "secret",
        orgId: `org-${id}`,
        deviceId: id,
        dir,
        mode: "os",
        reconnectGraceSeconds: 120,
        maxFrameBytes: 1024,
      }) as unknown as Credential;
    // the default connection reader: the state root's connections/<id>/credential.json
    writeCredential(f.stateDir, cred("a", join(f.dir, "device")));
    const { connections: _injected, ...input } = f.input;
    expect(() => readStrictOwnerCeilingSync(input)).not.toThrow();
    writeCredential(join(f.stateRoot, CONNECTIONS_DIR, "b"), cred("b", null));
    const e = refusal(() => readStrictOwnerCeilingSync(input));
    expect(e.message).toMatch(/connections\/b/);
    expect(e.message).toMatch(/capybara-device logout -c b/);
    // an injected reader reporting an unreadable connection fails the same way
    f.connections.unreadable.push({ deviceId: "c", reason: "mode 0644" });
    expect(refusal(() => readStrictOwnerCeilingSync(f.input)).message).toMatch(/connections\/c/);
    // the own connection being unreadable is not another connection's directory
    f.connections.unreadable.splice(0, 1, { deviceId: "a", reason: "x" });
    expect(() => readStrictOwnerCeilingSync(f.input)).not.toThrow();
  });
  it("paths reach reads only the listed paths, refusing a project root outside them", async () => {
    const f = await fixture();
    const listed = join(f.dir, "listed");
    const repo = join(listed, "repo");
    mkdirSync(repo, { recursive: true });
    const missing = join(f.dir, "missing");
    f.setPolicy({
      ownerCeiling: { ...FULL_OWNER_CEILING, projectReach: "paths" },
      projectPaths: [listed, missing],
    });
    const c = await f.read();
    expect(c.projectReach).toBe("paths");
    // only listed paths that exist, in canonical form
    expect(c.projectPaths).toEqual([listed]);
    const g = intersectOperation(scoped(f.roots, repo), c, open);
    expect(g.readRoots).toContain(listed);
    expect(g.readRoots).not.toContain("/");
    expect(g.readRoots).toEqual([listed, f.roots.skills, f.roots.tmp, f.roots.workspace].sort());
    for (const root of ["/elsewhere", join(missing, "x")]) {
      const e = refusal(() => intersectOperation(scoped(f.roots, root), c, open));
      expect(e.message).toBe(PROJECT_REFUSAL_MESSAGES["outside-reach"]);
      expect(e.message).toMatch(/outside this connection's project reach/);
      expect(e.message).toMatch(/capybara-device policy add projectPaths/);
    }
    // a write root outside the listed paths and the device roots is refused the same way
    const e = refusal(() =>
      intersectOperation(scoped(f.roots, repo, [repo, join(f.dir, "out")]), c, open),
    );
    expect(e.message).toBe(PROJECT_REFUSAL_MESSAGES["outside-reach"]);
    // a link inside the listed path that leads out of it is outside the reach
    symlinkSync(join(f.dir, "home"), join(listed, "out"));
    expect(
      refusal(() => intersectOperation(scoped(f.roots, join(listed, "out")), c, open)).message,
    ).toBe(PROJECT_REFUSAL_MESSAGES["outside-reach"]);
  });
  it("a listed project path reached through a link is granted in its canonical form", async () => {
    const f = await fixture();
    const real = join(f.dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(f.dir, "linked"));
    f.setPolicy({
      ownerCeiling: { ...FULL_OWNER_CEILING, projectReach: "paths" },
      projectPaths: [join(f.dir, "linked")],
    });
    const c = await f.read();
    expect(c.projectPaths).toEqual([real]);
    expect(intersectOperation(scoped(f.roots, real), c, open).readRoots).toContain(real);
  });
  it("refuses a project root or write root in another connection's directory", async () => {
    for (const reach of ["machine", "paths", "workspace"] as const) {
      const f = await fixture();
      const b = f.addOther("b");
      mkdirSync(join(b, "x"));
      symlinkSync(b, join(f.dir, "to-b"));
      f.setPolicy({
        ownerCeiling: { ...FULL_OWNER_CEILING, projectReach: reach },
        projectPaths: [f.dir],
      });
      const c = await f.read();
      const message = PROJECT_REFUSAL_MESSAGES["other-connection"];
      for (const root of [b, join(b, "x"), join(f.dir, "to-b"), join(f.dir, "to-b", "x")]) {
        expect(refusal(() => intersectOperation(scoped(f.roots, root), c, open)).message).toBe(
          message,
        );
        expect(
          refusal(() => intersectOperation(scoped(f.roots, f.roots.workspace, [root]), c, open))
            .message,
          `${reach} write root ${root}`,
        ).toBe(message);
      }
    }
  });
  it("refuses a project root that holds secrets or this program's state", async () => {
    const f = await fixture();
    const c = await f.read();
    for (const root of [join(f.dir, "home", ".ssh"), f.stateRoot, join(f.stateDir, "x")]) {
      expect(refusal(() => intersectOperation(scoped(f.roots, root), c, open)).message).toBe(
        PROJECT_REFUSAL_MESSAGES.denied,
      );
      expect(
        refusal(() => intersectOperation(scoped(f.roots, null, [root]), c, open)).message,
      ).toBe(PROJECT_REFUSAL_MESSAGES.denied);
    }
  });
  it("workspace reach keeps today's workspace refusal", async () => {
    const f = await fixture();
    const project = join(f.dir, "project");
    mkdirSync(project);
    const s = scoped(f.roots, project);
    expect(intersectOperation(s, await f.read(), open).readRoots).toEqual(["/"]);
    f.setPolicy({
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "workspace" },
    });
    const narrowed = await f.read();
    expect(refusal(() => intersectOperation(s, narrowed, open)).message).toBe(
      PROJECT_REFUSAL_MESSAGES["outside-reach"],
    );
    const inside = intersectOperation(scoped(f.roots, f.roots.workspace), narrowed, open);
    expect(inside.readRoots).toEqual([f.roots.skills, f.roots.tmp, f.roots.workspace].sort());
  });
  it("reconcile: narrowed reach or a removed project path revokes the grant", async () => {
    const f = await fixture();
    const l1 = join(f.dir, "l1");
    const l2 = join(f.dir, "l2");
    mkdirSync(l1);
    mkdirSync(l2);
    const s = scoped(f.roots, l1);
    const machine = intersectOperation(s, await f.read(), open);
    const usePaths = (projectPaths: string[]) =>
      f.setPolicy({ ownerCeiling: { ...FULL_OWNER_CEILING, projectReach: "paths" }, projectPaths });
    usePaths([l1, l2]);
    const both = intersectOperation(s, await f.read(), open);
    // machine -> paths: "/" is no longer covered
    expect(both.deniedReadRoots).toEqual(machine.deniedReadRoots);
    expect(grantStillHolds(machine, both)).toBe(false);
    expect(grantStillHolds(both, both)).toBe(true);
    usePaths([l1]);
    const one = intersectOperation(s, await f.read(), open);
    expect(grantStillHolds(both, one)).toBe(false);
    // widening keeps it
    expect(grantStillHolds(one, both)).toBe(true);
    // paths -> workspace: the listed path is gone
    const ws = scoped(f.roots, f.roots.workspace);
    const listedGrant = intersectOperation(ws, await f.read(), open);
    f.setPolicy({ ownerCeiling: { ...FULL_OWNER_CEILING, projectReach: "workspace" } });
    const narrowed = intersectOperation(ws, await f.read(), open);
    expect(narrowed.deniedReadRoots).toEqual(listedGrant.deniedReadRoots);
    expect(grantStillHolds(listedGrant, narrowed)).toBe(false);
  });
  it.runIf(process.platform === "darwin")(
    "on macOS the default temp base is the user temp dir the worker uses",
    async () => {
      const f = await fixture();
      f.addOther("b");
      const { macTempBase: _base, ...input } = f.input;
      const c = readStrictOwnerCeilingSync(input);
      const base = macUserTempDir() ?? realpathSync(tmpdir());
      expect(c.otherConnectionDenies).toContain(join(base, privateTempParentName("b")));
    },
  );
});

describe("independent owner ceiling", () => {
  it("fails closed for absent/malformed policy and freezes fresh snapshots", async () => {
    const f = await fixture();
    const c = await f.read();
    expect(Object.isFrozen(c.roots)).toBe(true);
    expect(c.outsideSandbox).toBe(true);
    expect(c.network).toBe("open");
    await unlink(join(f.stateDir, "policy.json"));
    await expect(f.read()).rejects.toThrow();
    await writeFile(join(f.stateDir, "policy.json"), "{} nope");
    await expect(f.read()).rejects.toThrow();
  });
  it("an owner allowlist is a ceiling: grants count only where the owner's list covers them", async () => {
    const f = await fixture();
    const allowlist = (allowedDomains: string[]) =>
      writePolicy(f.stateDir, {
        ...FULL_POLICY,
        allowedDomains,
        ownerCeiling: { ...FULL_OWNER_CEILING, network: "allowlist" },
      });
    const a = (hosts: string[]) => ({
      operationId: "op",
      orgNetwork: { kind: "open-public" as const, hosts: [] },
      grants: { hosts, source: { kind: "run" as const, id: "run", accountId: "a" } },
    });
    allowlist(["*.example.com"]);
    // a grant beyond the owner's list never widens it, and no scope-only host gets in
    expect(intersectOperation(scope(f.roots), await f.read(), a(["approved.test"])).hosts).toEqual([
      "a.example.com",
    ]);
    // owner ["a.com"] with a grant for evil.example.com: only a.com
    allowlist(["a.com"]);
    const probe = {
      ...scope(f.roots),
      network: { kind: "allowlist" as const, hosts: ["a.com", "evil.example.com"] },
    };
    expect(intersectOperation(probe, await f.read(), a(["evil.example.com"])).hosts).toEqual([
      "a.com",
    ]);
    const open = { ...scope(f.roots), network: { kind: "open-public" as const } };
    expect(intersectOperation(open, await f.read(), a(["evil.example.com"])).hosts).toEqual([
      "a.com",
    ]);
    // an empty owner allowlist with a grant: nothing
    allowlist([]);
    expect(intersectOperation(probe, await f.read(), a(["evil.example.com"])).hosts).toEqual([]);
    expect(intersectOperation(open, await f.read(), a(["a.com"])).hosts).toEqual([]);
  });
  it("under the open owner network, grants stay bounded by the kernel only", async () => {
    const f = await fixture();
    const a = {
      operationId: "op",
      orgNetwork: { kind: "allowlist" as const, hosts: ["a.example.com", "approved.test"] },
      grants: {
        hosts: ["approved.test", "evil.test"],
        source: { kind: "run" as const, id: "run", accountId: "a" },
      },
    };
    expect([...intersectOperation(scope(f.roots), await f.read(), a).hosts].sort()).toEqual([
      "a.example.com",
      "approved.test",
    ]);
  });
  it("requires matching provenance and intersects org host patterns", async () => {
    const f = await fixture();
    const c = await f.read();
    expect(() => intersectOperation(scope(f.roots), c)).toThrow(/authority/);
    expect(() =>
      intersectOperation(scope(f.roots), c, {
        operationId: "other",
        orgNetwork: { kind: "open-public", hosts: [] },
      }),
    ).toThrow(/operation/);
    expect(
      intersectOperation(scope(f.roots), c, {
        operationId: "op",
        orgNetwork: { kind: "allowlist", hosts: ["b.example.com"] },
      }).hosts,
    ).toEqual([]);
  });
  // R3 final review M1: another process's socket in a write root reaches outside the sandbox
  it("refuses a write root that is a system runtime or socket directory, as the kernel does", async () => {
    const f = await fixture();
    const a = { operationId: "op", orgNetwork: { kind: "open-public" as const, hosts: [] } };
    const c = await f.read();
    for (const root of [
      "/tmp",
      "/private/tmp",
      "/tmp/tmux-1000",
      "/tmp/.X11-unix",
      "/run/user/1000",
      "/var/run",
      "/private/var/run/x",
      "/dev/shm",
      "/proc/self",
      "/sys",
    ]) {
      const s = scope(f.roots);
      s.filesystem.writeRoots = [root];
      expect(() => intersectOperation(s, c, a), root).toThrow(
        /is a system runtime or socket directory .*grant a directory of its own/,
      );
    }
    const own = scope(f.roots);
    own.filesystem.writeRoots = ["/tmp/build"];
    expect(intersectOperation(own, c, a).writeRoots).toEqual(["/tmp/build"]);
    // reading one is no write
    const read = scope(f.roots);
    read.filesystem.projectRoot = "/run/user/1000";
    expect(intersectOperation(read, c, a).readRoots).toEqual(["/"]);
  });
  it("an escalated Full access call ignores the host baseline; the owner ceiling denies it", async () => {
    const f = await fixture();
    const s = {
      ...scope(f.roots),
      profile: "full-access" as const,
      filesystem: { kind: "device" as const },
      network: { kind: "environment" as const },
    };
    const full = intersectOperation(s, await f.read());
    expect(full.full).toBe(true);
    // an escalated call gets no deny list: it runs outside the sandbox
    expect(full.readRoots).toEqual(["/"]);
    expect(full.deniedReadRoots).toEqual([]);
    writePolicy(f.stateDir, {
      ...FULL_POLICY,
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "workspace" },
    });
    const narrowed = await f.read();
    expect(() => intersectOperation(s, narrowed)).toThrow();
  });
  it("an escalated call under a restricted profile is full once, the next scope restricted", async () => {
    const f = await fixture();
    const escalated = {
      ...scope(f.roots),
      filesystem: { kind: "device" as const },
      network: { kind: "environment" as const },
    };
    const a = { operationId: "op", orgNetwork: { kind: "open-public" as const, hosts: [] } };
    expect(intersectOperation(escalated, await f.read()).full).toBe(true);
    expect(intersectOperation(scope(f.roots), await f.read(), a).full).toBe(false);
    // the owner's outside-sandbox ceiling bounds it under every profile
    writePolicy(f.stateDir, {
      ...FULL_POLICY,
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "workspace" },
    });
    const narrowed = await f.read();
    expect(() => intersectOperation(escalated, narrowed)).toThrow();
  });
});

describe("approval-only profiles: the sandbox under every profile", () => {
  const authority = (orgNetwork: { kind: "open-public" | "allowlist"; hosts: string[] }) => ({
    operationId: "op",
    orgNetwork,
  });
  it("a non-escalated Full access scope gets scoped roots and the denied read roots", async () => {
    const f = await fixture({ ownerCeiling: { ...FULL_OWNER_CEILING, projectReach: "workspace" } });
    const s = {
      ...scope(f.roots),
      profile: "full-access" as const,
      network: { kind: "open-public" as const },
    };
    const g = intersectOperation(s, await f.read(), authority({ kind: "open-public", hosts: [] }));
    expect(g.full).toBe(false);
    expect(g.readRoots).toEqual([f.roots.skills, f.roots.tmp, f.roots.workspace].sort());
    expect(g.writeRoots).toEqual([f.roots.tmp]);
    expect(g.readRoots).not.toContain("/");
    expect(g.deniedReadRoots).toContain(join(f.dir, "home", ".ssh"));
    expect(g.deniedReadRoots).toContain(f.stateDir);
    expect(g.openNetwork).toBe(true);
    expect(g.hosts).toEqual([]);
  });
  it("open-public against an allowlist owner ceiling narrows to the allowlist", async () => {
    const f = await fixture();
    writePolicy(f.stateDir, {
      ...FULL_POLICY,
      allowedDomains: ["*.example.com", "b.test"],
      ownerCeiling: { ...FULL_OWNER_CEILING, network: "allowlist" },
    });
    const s = { ...scope(f.roots), network: { kind: "open-public" as const } };
    const g = intersectOperation(s, await f.read(), authority({ kind: "open-public", hosts: [] }));
    expect(g.openNetwork).toBeUndefined();
    expect([...g.hosts].sort()).toEqual(["*.example.com", "b.test"]);
    // and against a kernel allowlist under the open owner ceiling: the kernel's hosts
    writePolicy(f.stateDir, FULL_POLICY);
    const k = intersectOperation(
      s,
      await f.read(),
      authority({ kind: "allowlist", hosts: ["k.test"] }),
    );
    expect(k.openNetwork).toBeUndefined();
    expect(k.hosts).toEqual(["k.test"]);
  });
  it("an allowlist scope under the open owner ceiling keeps the scope's hosts", async () => {
    const f = await fixture();
    const g = intersectOperation(
      scope(f.roots),
      await f.read(),
      authority({ kind: "open-public", hosts: [] }),
    );
    expect(g.openNetwork).toBeUndefined();
    expect([...g.hosts].sort()).toEqual(["a.example.com", "approved.test", "unknown.test"]);
  });
  it("device + environment without outsideSandbox is refused under every profile", async () => {
    const f = await fixture();
    writePolicy(f.stateDir, {
      ...FULL_POLICY,
      ownerCeiling: { ...FULL_OWNER_CEILING, outsideSandbox: false },
    });
    const c = await f.read();
    for (const profile of ["full-access", "approve-for-me", "request-approval"] as const) {
      const s = {
        ...scope(f.roots),
        profile,
        filesystem: { kind: "device" as const },
        network: { kind: "environment" as const },
      };
      expect(() => intersectOperation(s, c), profile).toThrow(OUTSIDE_SANDBOX_REFUSAL);
    }
    // half an escalation is never one
    const half = { ...scope(f.roots), network: { kind: "environment" as const } };
    expect(() =>
      intersectOperation(half, c, authority({ kind: "open-public", hosts: [] })),
    ).toThrow(/only together/);
  });

  it("reconcile: an open-network grant does not survive the owner narrowing to an allowlist", async () => {
    const f = await fixture();
    const open = { ...scope(f.roots), network: { kind: "open-public" as const } };
    const a = authority({ kind: "open-public", hosts: [] });
    const before = intersectOperation(open, await f.read(), a);
    expect(before.openNetwork).toBe(true);
    expect(grantStillHolds(before, intersectOperation(open, await f.read(), a))).toBe(true);
    writePolicy(f.stateDir, {
      ...FULL_POLICY,
      allowedDomains: ["a.example.com"],
      ownerCeiling: { ...FULL_OWNER_CEILING, network: "allowlist" },
    });
    const narrowed = intersectOperation(open, await f.read(), a);
    expect(grantStillHolds(before, narrowed)).toBe(false);
    // an allowlist grant whose hosts stay is kept; one that loses a host is not
    const listed = intersectOperation(scope(f.roots), await f.read(), a);
    expect(grantStillHolds(listed, listed)).toBe(true);
    expect(grantStillHolds({ ...listed, hosts: ["a.example.com", "b.test"] }, listed)).toBe(false);
    // a full grant holds only while the next one is full
    const full = { ...listed, full: true };
    expect(grantStillHolds(full, listed)).toBe(false);
    expect(grantStillHolds(full, full)).toBe(true);
  });
});
