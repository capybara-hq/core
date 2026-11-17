/**
 * Package-build step for the canonical installed-byte manifest (permission runtime cutover B4).
 * Runs as `prepack`, after `tsc -b`:
 *
 * 1. Bundles the program's whole runtime dependency closure (`bundledRuntime` in package.json:
 *    the SDK, the sandbox runtime with its workspace patch, ws, and everything they depend on) into
 *    `dist/node_modules`, copied byte for byte from the workspace install and laid out so Node
 *    resolution from `dist/` finds exactly these copies. The published package declares no
 *    dependencies: `npm i -g @capybara-hq/device` installs exactly these bytes, never a newer
 *    version in some range.
 * 2. Loads the EMITTED verifier module and enumerates the emitted JavaScript, the inline helper
 *    sources and the bundled runtime closure exactly as the device will verify them, then writes
 *    `dist/runtime-manifest.json`. It fails when a helper module has a dynamic import it cannot
 *    enumerate or imports an uncovered package. TypeScript sources are never hashed.
 *
 *   node --experimental-strip-types tools/runtime-manifest.ts [packageRoot]
 *   node --experimental-strip-types tools/runtime-manifest.ts --clean [packageRoot]   (postpack)
 */
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface PackageJson {
  name: string;
  version: string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  publishConfig?: { exports?: unknown };
  exports?: unknown;
  bundledRuntime?: string[];
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as PackageJson;

/** The installed directory of `name` as seen from `fromDir` (realpath), or undefined. */
async function resolvePackage(name: string, fromDir: string): Promise<string | undefined> {
  const req = createRequire(join(fromDir, "package.json"));
  try {
    return dirname(await realpath(req.resolve(`${name}/package.json`)));
  } catch {}
  let entry: string;
  try {
    entry = await realpath(req.resolve(name));
  } catch {
    return undefined;
  }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      if ((await readJson(join(dir, "package.json"))).name === name) return dir;
    } catch {}
  }
  return undefined;
}

/** Where Node looks for `name` from a package installed at `parent` (nearest first). */
function lookupChain(parent: string, name: string): string[] {
  const chain: string[] = [];
  for (let at = parent; ; ) {
    chain.push(`${at ? `${at}/` : ""}node_modules/${name}`);
    if (!at) break;
    const i = at.lastIndexOf("/node_modules/");
    at = i < 0 ? "" : at.slice(0, i);
  }
  return chain;
}

interface Placed {
  name: string;
  version: string;
  source: string;
  location: string;
}

/**
 * npm-style hoisting: each package goes as high as it can without shadowing another version a
 * nearer dependent already sees; a conflict nests it under its dependent.
 */
async function layout(roots: readonly string[], fromDir: string): Promise<Map<string, Placed>> {
  const tree = new Map<string, Placed>();
  const queue: { name: string; from: string; parent: string; optional: boolean }[] = roots.map(
    (name) => ({ name, from: fromDir, parent: "", optional: false }),
  );
  while (queue.length) {
    const { name, from, parent, optional } = queue.shift() as (typeof queue)[number];
    const source = await resolvePackage(name, from);
    if (!source) {
      if (optional) continue;
      throw new Error(`Cannot resolve ${name} from ${from}; run pnpm install`);
    }
    const pkg = await readJson(join(source, "package.json"));
    const chain = lookupChain(parent, name);
    let location = chain[chain.length - 1] as string;
    let satisfied = false;
    for (let i = 0; i < chain.length; i++) {
      const existing = tree.get(chain[i] as string);
      if (!existing) continue;
      if (existing.version === pkg.version) satisfied = true;
      else if (i === 0) throw new Error(`Conflicting ${name} under ${parent}`);
      else location = chain[i - 1] as string;
      break;
    }
    if (satisfied) continue;
    tree.set(location, { name, version: pkg.version, source, location });
    for (const [dep, optionalDep] of [
      ...Object.keys(pkg.dependencies ?? {}).map((d) => [d, false] as const),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((d) => [d, true] as const),
    ])
      queue.push({ name: dep, from: source, parent: location, optional: optionalDep });
  }
  // every dependent must resolve the exact version it was installed with
  for (const placed of tree.values()) {
    const pkg = await readJson(join(placed.source, "package.json"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const want = await resolvePackage(dep, placed.source);
      const wantVersion = want && (await readJson(join(want, "package.json"))).version;
      const found = lookupChain(placed.location, dep)
        .map((l) => tree.get(l))
        .find((p) => p !== undefined);
      if (found?.version !== wantVersion)
        throw new Error(
          `Bundled ${placed.name} would load ${dep}@${found?.version}, not ${wantVersion}`,
        );
    }
  }
  return tree;
}

/** Copies the regular files of one package (no nested node_modules; links refused). */
async function copyPackage(placed: Placed, target: string, workspace: boolean): Promise<void> {
  const pkg = await readJson(join(placed.source, "package.json"));
  const copyTree = async (from: string, to: string) => {
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`${from} is a link; refusing to bundle it`);
    if (info.isDirectory()) {
      if (from.endsWith("/node_modules")) return;
      await mkdir(to, { recursive: true });
      for (const e of await readdir(from)) await copyTree(join(from, e), join(to, e));
    } else if (info.isFile()) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, constants.COPYFILE_EXCL);
    }
  };
  if (!workspace) {
    await copyTree(placed.source, target);
    return;
  }
  // a workspace package: what it publishes (its files, with its publish exports)
  await mkdir(target, { recursive: true });
  for (const entry of new Set([...(pkg.files ?? []), "README.md", "NOTICE", "LICENSE"])) {
    try {
      await copyTree(join(placed.source, entry), join(target, entry));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const published = {
    ...pkg,
    ...(pkg.publishConfig?.exports ? { exports: pkg.publishConfig.exports } : {}),
  };
  await writeFile(join(target, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
}

export async function bundleRuntime(packageRoot: string): Promise<number> {
  const pkg = await readJson(join(packageRoot, "package.json"));
  const roots = pkg.bundledRuntime ?? [];
  const base = join(packageRoot, "dist");
  await rm(join(base, "node_modules"), { recursive: true, force: true });
  const tree = await layout(roots, packageRoot);
  for (const placed of tree.values())
    await copyPackage(
      placed,
      join(base, placed.location),
      !relative(dirname(packageRoot), placed.source).startsWith(".."),
    );
  return tree.size;
}

export async function generateRuntimeManifest(packageRoot: string): Promise<string> {
  await bundleRuntime(packageRoot);
  const emitted = (await import(
    pathToFileURL(join(packageRoot, "dist", "exec", "runtime-manifest.js")).href
  )) as typeof import("../src/exec/runtime-manifest.js");
  const layoutOf = { ...emitted.installedLayout(), packageRoot };
  const { runtime, helpers } = await emitted.enumerateInstalled(layoutOf);
  const out = join(packageRoot, "dist", emitted.MANIFEST_FILE);
  await writeFile(out, `${JSON.stringify({ version: 1, runtime, helpers })}\n`, { mode: 0o644 });
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const clean = args[0] === "--clean";
  const root = resolve(
    (clean ? args[1] : args[0]) ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  (clean
    ? rm(join(root, "dist", "node_modules"), { recursive: true, force: true }).then(
        () => "removed the bundled runtime",
      )
    : generateRuntimeManifest(root).then((out) => `wrote ${out}`)
  ).then(
    (msg) => console.log(msg),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
