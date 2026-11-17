import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enumerateInstalled,
  installedLayout,
  MANIFEST_FILE,
  verifyInstalledRuntime,
} from "../src/exec/runtime-manifest.js";

const deviceRoot = resolve(fileURLToPath(import.meta.url), "../..");

/**
 * Seals the workspace's real sandbox runtime in this process the way a binding does, so tests can
 * launch restricted workers from source (no build, so no shipped manifest: one is written for an
 * owned package root that resolves the workspace install). Only macOS launches restricted
 * workers, so elsewhere it seals nothing. Returns the cleanup.
 */
export async function sealWorkspaceRuntime(under?: string): Promise<() => Promise<void>> {
  if (process.platform !== "darwin") return async () => {};
  const root = await realpath(await mkdtemp(join(under ?? tmpdir(), "cap-runtime-seal-")));
  const packageRoot = join(root, "package");
  const state = join(root, "state");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await mkdir(state, { mode: 0o700 });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@capybara-hq/device" }),
  );
  await symlink(join(deviceRoot, "node_modules"), join(packageRoot, "node_modules"));
  const layout = { ...installedLayout(), packageRoot, helperModules: [] };
  const { runtime, helpers } = await enumerateInstalled(layout);
  await writeFile(
    join(packageRoot, "dist", MANIFEST_FILE),
    JSON.stringify({ version: 1, runtime, helpers }),
  );
  await verifyInstalledRuntime(
    { pythonPath: "/usr/bin/python3", roots: { workspace: "/w", skills: "/s", tmp: "/t" } },
    layout,
    { stageIn: state },
  );
  return () => rm(root, { recursive: true, force: true });
}
