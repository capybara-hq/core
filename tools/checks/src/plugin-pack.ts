import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGES_MAX_BYTES_DEFAULT } from "@capybara-hq/kernel";
import { packPlugin } from "@capybara-hq/pack-plugin";
import {
  PLUGIN_MANIFEST_FILE,
  parsePluginManifest,
  SDK_VERSION,
  validatePluginPackageJsonFor,
} from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/** 即 `packages.maxBytes` 的默认值（取自内核配置 schema）：官方插件打出来的包必须能按默认上限安装。 */
export const PLUGIN_PACK_MAX_BYTES = PACKAGES_MAX_BYTES_DEFAULT;

/** One entry of a tgz as text, via the system tar. */
const readEntry = (tgz: string, path: string) =>
  execFileSync("tar", ["-xzOf", tgz, `package/${path}`], { encoding: "utf8" });

/**
 * The problems of a packed plugin tgz, read back with the SDK parsers: size within
 * {@link PLUGIN_PACK_MAX_BYTES}, `.capybara-plugin/plugin.json` valid (`parsePluginManifest`),
 * `package.json` valid for it (`validatePluginPackageJsonFor`).
 * Until the kernel reads the new format (phase 0b Task 3) this replaces the kernel's install-time
 * `readExtensionPackage`.
 */
async function packedIssues(tgz: string): Promise<string[]> {
  const size = (await stat(tgz)).size;
  if (size > PLUGIN_PACK_MAX_BYTES) {
    return [`the package is ${size} bytes, over packages.maxBytes ${PLUGIN_PACK_MAX_BYTES}`];
  }
  const manifest = parsePluginManifest(readEntry(tgz, PLUGIN_MANIFEST_FILE));
  if ("errors" in manifest) return manifest.errors.map((e) => `${PLUGIN_MANIFEST_FILE}: ${e}`);
  const pkg = JSON.parse(readEntry(tgz, "package.json")) as unknown;
  return validatePluginPackageJsonFor(pkg, manifest, SDK_VERSION);
}

/**
 * Every plugin packs into a self-contained plugin package (C12): packed with `tools/pack-plugin`
 * (esbuild single-file ESM + `.capybara-plugin/plugin.json`; the packer checks the import
 * allowlist and the manifests), then read back and validated ({@link packedIssues}). One finding
 * per plugin that fails to pack or validate (rule `plugin-pack`, located at the plugin's
 * package.json).
 * package.json `files` lists something the package can't carry (a directory, a glob, a missing path):
 * rule `plugin-pack-dropped`, one per entry.
 */
export async function checkPluginPack(pluginDirs: string[]): Promise<Finding[]> {
  const out = await mkdtemp(join(tmpdir(), "check-plugin-pack-"));
  const findings: Finding[] = [];
  try {
    for (const dir of pluginDirs) {
      const file = join(dir, "package.json");
      let r: Awaited<ReturnType<typeof packPlugin>>;
      try {
        r = await packPlugin(dir, out);
      } catch (e) {
        const message = `打包失败：${e instanceof Error ? e.message : String(e)}`;
        findings.push({ file, line: 1, rule: "plugin-pack", message });
        continue;
      }
      for (const d of r.dropped) {
        findings.push({
          file,
          line: 1,
          rule: "plugin-pack-dropped",
          message: `"files" entry "${d}" is not in the plugin package (only plain root files, README.md, LICENSE, migrations/, ui/, skills/ and connectors/ are shipped): remove it or make it a plain file`,
        });
      }
      const issues = await packedIssues(r.file);
      if (issues.length > 0) {
        findings.push({
          file,
          line: 1,
          rule: "plugin-pack",
          message: `插件包校验不通过：${issues.join("; ")}`,
        });
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  return findings;
}
