import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapFileName, parseBootstrapManifest } from "@capybara-hq/plugin-sdk";
import { packPlugin } from "./pack.js";

/** One package {@link packBootstrap} wrote. */
export interface BootstrapPack {
  name: string;
  version: string;
  file: string;
  integrity: string;
}

const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * Produces the bootstrap directory the image bakes (package ecosystem spec §7): every entry of the
 * bootstrap manifest (`packages/kernel/bootstrap.json`) as `<outDir>/<name>-<version>.tgz`. A
 * `source: "workspace"` entry is packed from `<repoRoot>/<path>` with {@link packPlugin}
 * (byte-reproducible) and must equal the entry: the plugin name, the version and the pinned sha512,
 * otherwise this throws naming the plugin and writes nothing for it (the image build fails rather
 * than baking a package `capybara bootstrap` would refuse). `source: "npm"` entries (phase A3) are
 * not supported yet and throw.
 */
export async function packBootstrap(
  manifestFile: string,
  repoRoot: string,
  outDir: string,
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
      if (e.source !== "workspace") {
        throw new Error(
          `${e.name}: source "${e.source}" entries are downloaded from npm, which is not supported yet`,
        );
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
