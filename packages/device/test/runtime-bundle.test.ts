import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundleRuntime } from "../tools/runtime-manifest.js";

// The vendored runtime closure (B4 fix round 2, R4): modified Apache-2.0 packages carry a notice,
// and nothing platform-dependent is bundled from whatever the release runner resolved.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function workspace(dep: Record<string, unknown>, patched = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-bundle-")));
  dirs.push(root);
  const write = async (path: string, text: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  await write(
    join(root, "pnpm-workspace.yaml"),
    `packages:\n  - packages/*\n${patched ? "patchedDependencies:\n  'dep@1.0.0': patches/dep@1.0.0.patch\n" : ""}`,
  );
  await write(join(root, "patches/dep@1.0.0.patch"), "--- a/i.js\n+++ b/i.js\n");
  const pkg = join(root, "packages/device");
  await write(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@capybara-hq/device", version: "0.0.0", bundledRuntime: ["dep"] }),
  );
  await write(
    join(pkg, "node_modules/dep/package.json"),
    JSON.stringify({ name: "dep", version: "1.0.0", license: "Apache-2.0", ...dep }),
  );
  await write(join(pkg, "node_modules/dep/i.js"), "module.exports = 1;\n");
  return pkg;
}

it("a patched package ships a modification notice with the patch", async () => {
  const pkg = await workspace({}, true);
  expect(await bundleRuntime(pkg)).toBe(1);
  const notice = await readFile(
    join(pkg, "dist/node_modules/dep/CAPYBARA-MODIFICATIONS.md"),
    "utf8",
  );
  expect(notice).toContain("dep@1.0.0");
  expect(notice).toContain("modified");
  expect(
    await readFile(join(pkg, "dist/node_modules/dep/CAPYBARA-MODIFICATIONS.patch"), "utf8"),
  ).toBe("--- a/i.js\n+++ b/i.js\n");
  // an unpatched package gets none
  const plain = await workspace({});
  await bundleRuntime(plain);
  expect(existsSync(join(plain, "dist/node_modules/dep/CAPYBARA-MODIFICATIONS.md"))).toBe(false);
});

it("refuses optional dependencies and platform-specific packages", async () => {
  for (const dep of [
    { optionalDependencies: { "native-thing": "1.0.0" } },
    { os: ["darwin"] },
    { cpu: ["arm64"] },
    { libc: ["glibc"] },
  ]) {
    const pkg = await workspace(dep);
    await expect(bundleRuntime(pkg)).rejects.toThrow(/platform|optional/);
  }
});
