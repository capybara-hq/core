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
import { SDK_VERSION, themeIdOf } from "@capybara-hq/plugin-sdk";
import { clientStyleNames, PackRuleError } from "../pack/client.js";
import { packPlugin } from "../pack/pack.js";
import {
  appearanceFindings,
  clientApiVersionFindings,
  clientFindings,
  ruleErrorFinding,
} from "./client.js";
import type { Finding } from "./source.js";
import { themePathsOf } from "./themes.js";
import { uiSlotFindings } from "./ui-slots.js";

/**
 * The default of `packages.maxBytes` (from the kernel config schema): an official plugin's package
 * must install under the default limit.
 */
export const PLUGIN_PACK_MAX_BYTES = PACKAGES_MAX_BYTES_DEFAULT;

/**
 * Every plugin packs into a self-contained plugin package (C12): packed with {@link packPlugin}
 * (esbuild single-file ESM + `.capybara-plugin/plugin.json`), then validated with the kernel's
 * install-time readers: `readPluginPackage` (unpack rules, size, plugin.json, package.json, listed
 * paths, skills, connector templates) and, for a plugin with an extension, `readExtensionPackage`
 * (import allowlist of the entry's module graph, migrations). One finding per plugin that fails to
 * pack or validate (rule `plugin-pack`, located at the plugin's package.json).
 * package.json `files` lists something the package can't carry (a directory, a glob, a missing path):
 * rule `plugin-pack-dropped`, one per entry.
 * A setup guide validator warning (e.g. a text variable outside quotes in a yaml block): rule
 * `plugin-pack-guide`, severity `warning` (printed, never fails the check); guide errors fail the
 * pack and so are `plugin-pack` findings.
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
        for (const w of r.warnings) {
          findings.push({
            file,
            line: 1,
            rule: "plugin-pack-guide",
            message: w,
            severity: "warning",
          });
        }
        const bytes = new Uint8Array(await readFile(r.file));
        const plugin = await readPluginPackage(bytes, opts);
        findings.push(...uiSlotFindings(file, plugin.manifest.extension?.manifest.ui));
        if (plugin.manifest.extension !== undefined) await readExtensionPackage(bytes, opts);
        findings.push(
          ...clientApiVersionFindings(file, plugin.manifest.extension?.client),
          ...appearanceFindings(
            file,
            plugin.manifest,
            themePathsOf(dir).paths.map((p) => themeIdOf(p)),
          ),
          ...clientFindings(dir, await clientStyleNames(dir), plugin.manifest.name),
        );
      } catch (e) {
        if (e instanceof PackRuleError) {
          findings.push(ruleErrorFinding(file, e));
          continue;
        }
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
