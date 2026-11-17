import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

// The published tarball must install exactly the bytes its manifest names (B4 fix round 1, I3):
// pack it as the release does (pnpm pack: prepack bundles the runtime closure and writes the
// manifest), install it with npm into a clean prefix with no registry reachable, and verify there.
const run = promisify(execFile);
const deviceRoot = resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = resolve(deviceRoot, "../..");
let dir: string, installed: string, env: NodeJS.ProcessEnv;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "cap-device-pack-")));
  // npm sees no user config, an empty cache and an unreachable registry: nothing leaves the box
  await writeFile(join(dir, "npmrc"), "");
  env = {
    ...process.env,
    npm_config_userconfig: join(dir, "npmrc"),
    npm_config_cache: join(dir, "cache"),
    npm_config_registry: "http://127.0.0.1:9/",
    npm_config_update_notifier: "false",
  };
  await run("pnpm", ["exec", "tsc", "-b", "packages/device"], { cwd: repoRoot, env });
  await run("pnpm", ["pack", "--pack-destination", dir], { cwd: deviceRoot, env });
  const tgz = (await readdir(dir)).find((n) => n.endsWith(".tgz"));
  if (!tgz) throw new Error("pnpm pack wrote no tarball");
  await mkdir(join(dir, "install"));
  await run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      join(dir, "install"),
      join(dir, tgz),
    ],
    { cwd: dir, env },
  );
  installed = join(dir, "install/node_modules/@capybara-hq/device");
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const verifyInstalled = async () => {
  const script = `
    const m = await import(${JSON.stringify(join(installed, "dist/exec/runtime-manifest.js"))});
    const v = await m.verifyInstalledRuntime({ pythonPath: "/usr/bin/python3",
      roots: { workspace: "/w", skills: "/s", tmp: "/t" } });
    console.log(JSON.stringify(v));`;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    env,
  });
  return JSON.parse(stdout) as { runtimeHash: string; helperHash: string };
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const canonical = (kind: string, entries: unknown[]) => JSON.stringify([1, kind, entries]);

it("installs self-contained: no dependency is resolved from a registry", async () => {
  const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  expect(pkg.dependencies ?? {}).toEqual({});
  expect(existsSync(join(installed, "dist/runtime-manifest.json"))).toBe(true);
  // the workspace patch of the sandbox runtime ships with it
  const patched = await readFile(
    join(
      installed,
      "dist/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js",
    ),
    "utf8",
  );
  expect(patched).toContain('(sysctl-name "kern.hv_vmm_present")');
  // packing never leaves the bundle in the workspace
  expect(existsSync(join(deviceRoot, "dist/node_modules"))).toBe(false);
});

it("the npm-installed bytes verify against the shipped manifest", async () => {
  const manifest = JSON.parse(
    await readFile(join(installed, "dist/runtime-manifest.json"), "utf8"),
  );
  const verified = await verifyInstalled();
  expect(verified.runtimeHash).toBe(sha(canonical("runtime", manifest.runtime)));
  expect(verified.helperHash).toBe(sha(canonical("helpers", manifest.helpers)));
});

it("a changed installed byte fails verification", async () => {
  await appendFile(
    join(installed, "dist/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js"),
    "\n// changed\n",
  );
  await expect(verifyInstalled()).rejects.toThrow(
    /changed node_modules\/@anthropic-ai\/sandbox-runtime/,
  );
});
