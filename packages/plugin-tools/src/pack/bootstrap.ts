import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapFileName, parseBootstrapManifest } from "@capybara-hq/plugin-sdk";
import { integrityOf } from "../integrity.js";
import { DEFAULT_NPM_REGISTRY, downloadPinnedNpmPackage } from "./npm.js";
import { packPlugin } from "./pack.js";

/** One package {@link packBootstrap} wrote. */
export interface BootstrapPack {
  name: string;
  version: string;
  file: string;
  integrity: string;
}

/**
 * Produces the bootstrap directory the image bakes (package ecosystem spec §7): every entry of the
 * bootstrap manifest (`packages/kernel/bootstrap.json`) as `<outDir>/<name>-<version>.tgz`. A
 * `source: "workspace"` entry is packed from `<repoRoot>/<path>` with {@link packPlugin}
 * (byte-reproducible) and must equal the entry: the plugin name, the version and the pinned sha512,
 * otherwise this throws naming the plugin and writes nothing for it (the image build fails rather
 * than baking a package `capybara bootstrap` would refuse). A `source: "npm"` entry is downloaded
 * from `opts.registry` (default the public npm registry, the kernel's `packages.npmRegistry`
 * default) and written only when its bytes match the pinned sha512; a tampered tarball or an
 * unpublished package or version throws naming the plugin. So npm entries need the network at
 * build time only: init installs from the baked directory and never downloads.
 */
export async function packBootstrap(
  manifestFile: string,
  repoRoot: string,
  outDir: string,
  opts: { registry?: string } = {},
): Promise<BootstrapPack[]> {
  const parsed = parseBootstrapManifest(JSON.parse(await readFile(manifestFile, "utf8")));
  if ("errors" in parsed) {
    throw new Error(`invalid bootstrap manifest ${manifestFile}: ${parsed.errors.join("; ")}`);
  }
  await mkdir(outDir, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), "pack-bootstrap-"));
  const out: BootstrapPack[] = [];
  try {
    for (const e of parsed.plugins) {
      if (e.source === "npm") {
        let bytes: Uint8Array;
        try {
          bytes = await downloadPinnedNpmPackage(e, opts.registry ?? DEFAULT_NPM_REGISTRY);
        } catch (err) {
          throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          });
        }
        const file = join(outDir, bootstrapFileName(e));
        await writeFile(file, bytes);
        out.push({ name: e.name, version: e.version, file, integrity: e.integrity });
        continue;
      }
      const r = await packPlugin(join(repoRoot, e.path), staging);
      const integrity = integrityOf(new Uint8Array(await readFile(r.file)));
      const problems = [
        r.manifest.name !== e.name && `${e.path} packs the plugin "${r.manifest.name}"`,
        r.manifest.version !== e.version &&
          `version is ${e.version} but ${e.path} packs ${r.manifest.version}`,
        integrity !== e.integrity && `integrity is ${e.integrity} but ${e.path} packs ${integrity}`,
      ].filter((p): p is string => typeof p === "string");
      if (problems.length > 0) {
        throw new Error(
          `${e.name}: ${problems.join("; ")}; the bootstrap manifest is stale (pnpm check:bootstrap --write)`,
        );
      }
      const file = join(outDir, bootstrapFileName(e));
      await copyFile(r.file, file);
      out.push({ name: e.name, version: e.version, file, integrity });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return out;
}
