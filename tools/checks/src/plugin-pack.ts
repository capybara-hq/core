import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionPackageError,
  PACKAGES_MAX_BYTES_DEFAULT,
  PluginPackageError,
  readExtensionPackage,
  readPluginPackage,
} from "@capybara-hq/kernel";
import { packPlugin } from "@capybara-hq/pack-plugin";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/**
 * The default of `packages.maxBytes` (from the kernel config schema): an official plugin's package
 * must install under the default limit.
 */
export const PLUGIN_PACK_MAX_BYTES = PACKAGES_MAX_BYTES_DEFAULT;

/**
 * Every plugin packs into a self-contained plugin package (C12): packed with `tools/pack-plugin`
 * (esbuild single-file ESM + `.capybara-plugin/plugin.json`), then validated with the kernel's
 * install-time readers: `readPluginPackage` (unpack rules, size, plugin.json, package.json, listed
 * paths, skills, connector templates) and, for a plugin with an extension, `readExtensionPackage`
 * (import allowlist of the entry's module graph, migrations). One finding per plugin that fails to
 * pack or validate (rule `plugin-pack`, located at the plugin's package.json).
 * package.json `files` lists something the package can't carry (a directory, a glob, a missing path):
 * rule `plugin-pack-dropped`, one per entry.
 */
export async function checkPluginPack(pluginDirs: string[]): Promise<Finding[]> {
  const out = await mkdtemp(join(tmpdir(), "check-plugin-pack-"));
  const findings: Finding[] = [];
  const opts = { maxBytes: PLUGIN_PACK_MAX_BYTES, hostSdkVersion: SDK_VERSION };
  try {
    for (const dir of pluginDirs) {
      const file = join(dir, "package.json");
      try {
        const r = await packPlugin(dir, out);
        for (const d of r.dropped) {
          findings.push({
            file,
            line: 1,
            rule: "plugin-pack-dropped",
            message: `"files" entry "${d}" is not in the plugin package (only plain root files, README.md, LICENSE, migrations/, ui/, skills/ and connectors/ are shipped): remove it or make it a plain file`,
          });
        }
        const bytes = new Uint8Array(await readFile(r.file));
        const plugin = await readPluginPackage(bytes, opts);
        if (plugin.manifest.extension !== undefined) await readExtensionPackage(bytes, opts);
      } catch (e) {
        const message =
          e instanceof ExtensionPackageError || e instanceof PluginPackageError
            ? `the plugin package is invalid: ${e.issues.join("; ")}`
            : `packing failed: ${e instanceof Error ? e.message : String(e)}`;
        findings.push({ file, line: 1, rule: "plugin-pack", message });
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  return findings;
}
