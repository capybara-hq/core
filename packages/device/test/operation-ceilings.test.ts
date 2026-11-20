import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  grantStillHolds,
  intersectOperation,
  OUTSIDE_SANDBOX_REFUSAL,
  readStrictOwnerCeiling,
} from "../src/exec/operation-types.js";
import { osRoots } from "../src/exec/shared.js";
import {
  DEFAULT_POLICY,
  FULL_OWNER_CEILING,
  ownerCeilingOfMode,
  writePolicy,
} from "../src/state.js";

/** The policy these tests were written against: outside the sandbox on, the open network. */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cap-ceiling-"));
  dirs.push(dir);
  writePolicy(join(dir, "state"), { ...FULL_POLICY, allowedDomains: ["*.example.com"] });
  const roots = osRoots(join(dir, "device"));
  const read = () =>
    readStrictOwnerCeiling({
      stateDir: join(dir, "state"),
      deviceId: "d",
      dir: join(dir, "device"),
      home: join(dir, "home"),
    });
  return { dir, roots, read };
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
  filesystem: { kind: "scoped" as const, readRoots: [roots.workspace], writeRoots: [roots.tmp] },
  network: {
    kind: "allowlist" as const,
    hosts: ["a.example.com", "approved.test", "unknown.test"],
  },
});
describe("independent owner ceiling", () => {
  it("fails closed for absent/malformed policy and freezes fresh snapshots", async () => {
    const f = await fixture();
    const c = await f.read();
    expect(Object.isFrozen(c.roots)).toBe(true);
    expect(c.outsideSandbox).toBe(true);
    expect(c.network).toBe("open");
    await unlink(join(f.dir, "state", "policy.json"));
    await expect(f.read()).rejects.toThrow();
    await writeFile(join(f.dir, "state", "policy.json"), "{} nope");
    await expect(f.read()).rejects.toThrow();
  });
  it("an owner allowlist is a ceiling: grants count only where the owner's list covers them", async () => {
    const f = await fixture();
    const allowlist = (allowedDomains: string[]) =>
      writePolicy(join(f.dir, "state"), {
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
  it("allows outside projects only under independent OS-user reach", async () => {
    const f = await fixture();
    const s = scope(f.roots);
    s.filesystem.readRoots = [join(f.dir, "project")];
    const a = { operationId: "op", orgNetwork: { kind: "open-public" as const, hosts: [] } };
    expect(intersectOperation(s, await f.read(), a).readRoots).toContain(join(f.dir, "project"));
    writePolicy(join(f.dir, "state"), {
      ...FULL_POLICY,
      ownerCeiling: ownerCeilingOfMode("sandbox"),
    });
    const narrowed = await f.read();
    expect(() => intersectOperation(s, narrowed, a)).toThrow();
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
    read.filesystem.readRoots = ["/run/user/1000"];
    expect(intersectOperation(read, c, a).readRoots).toEqual(["/run/user/1000"]);
  });
  it("an escalated Full access call ignores the host baseline; the owner ceiling denies it", async () => {
    const f = await fixture();
    const s = {
      ...scope(f.roots),
      profile: "full-access" as const,
      filesystem: { kind: "device" as const },
      network: { kind: "environment" as const },
    };
    expect(intersectOperation(s, await f.read()).full).toBe(true);
    writePolicy(join(f.dir, "state"), {
      ...FULL_POLICY,
      ownerCeiling: ownerCeilingOfMode("sandbox"),
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
    writePolicy(join(f.dir, "state"), {
      ...FULL_POLICY,
      ownerCeiling: ownerCeilingOfMode("sandbox"),
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
    const f = await fixture();
    const s = {
      ...scope(f.roots),
      profile: "full-access" as const,
      network: { kind: "open-public" as const },
    };
    const g = intersectOperation(s, await f.read(), authority({ kind: "open-public", hosts: [] }));
    expect(g.full).toBe(false);
    expect(g.readRoots).toEqual([f.roots.workspace]);
    expect(g.writeRoots).toEqual([f.roots.tmp]);
    expect(g.readRoots).not.toContain("/");
    expect(g.deniedReadRoots).toContain(join(f.dir, "home", ".ssh"));
    expect(g.deniedReadRoots).toContain(join(f.dir, "state"));
    expect(g.openNetwork).toBe(true);
    expect(g.hosts).toEqual([]);
  });
  it("open-public against an allowlist owner ceiling narrows to the allowlist", async () => {
    const f = await fixture();
    writePolicy(join(f.dir, "state"), {
      ...FULL_POLICY,
      allowedDomains: ["*.example.com", "b.test"],
      ownerCeiling: { ...FULL_OWNER_CEILING, network: "allowlist" },
    });
    const s = { ...scope(f.roots), network: { kind: "open-public" as const } };
    const g = intersectOperation(s, await f.read(), authority({ kind: "open-public", hosts: [] }));
    expect(g.openNetwork).toBeUndefined();
    expect([...g.hosts].sort()).toEqual(["*.example.com", "b.test"]);
    // and against a kernel allowlist under the open owner ceiling: the kernel's hosts
    writePolicy(join(f.dir, "state"), FULL_POLICY);
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
    writePolicy(join(f.dir, "state"), {
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
    writePolicy(join(f.dir, "state"), {
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
