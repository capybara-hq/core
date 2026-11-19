import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { protectedChain } from "../src/exec/protected-targets.js";

// The shared protected-target resolver of the device workers: every link of a chain and the final
// target, walked one component at a time.
describe("protectedChain", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const fixture = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-chain-")));
    dirs.push(root);
    return root;
  };

  it("returns every link met, a middle hop included, and the final target", async () => {
    const root = await fixture();
    await mkdir(join(root, "code", "v1"), { recursive: true });
    await writeFile(join(root, "code", "v1", "rc"), "");
    await mkdir(join(root, "home"));
    await symlink(join(root, "code", "v1"), join(root, "code", "current"));
    await symlink(join(root, "code", "current", "rc"), join(root, "home", ".rc"));
    expect(protectedChain(join(root, "home", ".rc"))).toEqual({
      links: [join(root, "home", ".rc"), join(root, "code", "current")],
      target: join(root, "code", "v1", "rc"),
    });
  });

  it("follows relative and dangling links to the location they name", async () => {
    const root = await fixture();
    await mkdir(join(root, "home"));
    await mkdir(join(root, "code"));
    await symlink("../code/missing/rc", join(root, "home", ".rc"));
    expect(protectedChain(join(root, "home", ".rc", "x"))).toEqual({
      links: [join(root, "home", ".rc")],
      target: join(root, "code", "missing", "rc", "x"),
    });
  });

  it("has no links for an ordinary path, and stops at a loop", async () => {
    const root = await fixture();
    expect(protectedChain(join(root, "a", "b"))).toEqual({
      links: [],
      target: join(root, "a", "b"),
    });
    await symlink(join(root, "loop"), join(root, "loop"));
    const looped = protectedChain(join(root, "loop"));
    expect(looped.links[0]).toBe(join(root, "loop"));
    expect(looped.target).toBe(join(root, "loop"));
  });
});
