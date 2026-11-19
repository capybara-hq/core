import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  it("retains independently approved additions, never scope-only hosts", async () => {
    const f = await fixture();
    writePolicy(join(f.dir, "state"), {
      ...FULL_POLICY,
      allowedDomains: ["*.example.com"],
      ownerCeiling: { ...FULL_OWNER_CEILING, network: "allowlist" },
    });
    const c = await f.read();
    const a = {
      operationId: "op",
      orgNetwork: { kind: "open-public" as const, hosts: [] },
      grants: {
        hosts: ["approved.test"],
        source: { kind: "run" as const, id: "run", accountId: "a" },
      },
    };
    expect(intersectOperation(scope(f.roots), c, a).hosts).toEqual([
      "a.example.com",
      "approved.test",
    ]);
    writePolicy(join(f.dir, "state"), {
      ...FULL_POLICY,
      allowedDomains: [],
      ownerCeiling: { ...FULL_OWNER_CEILING, network: "allowlist" },
    });
    expect(intersectOperation(scope(f.roots), await f.read(), a).hosts).toEqual(["approved.test"]);
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
});
