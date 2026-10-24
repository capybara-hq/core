import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionPackageError,
  PACKAGES_MAX_BYTES_DEFAULT,
  readExtensionPackage,
} from "@capybara-hq/kernel";
import { packPlugin } from "@capybara-hq/pack-plugin";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/** 即 `packages.maxBytes` 的默认值（取自内核配置 schema）：官方插件打出来的包必须能按默认上限安装。 */
export const PLUGIN_PACK_MAX_BYTES = PACKAGES_MAX_BYTES_DEFAULT;

/**
 * Every plugin packs into a self-contained plugin package (C12): packed with `tools/pack-plugin`
 * (esbuild single-file ESM + static manifest), then validated with the kernel's install-time
 * `readExtensionPackage` (import allowlist, install scripts, dependency fields, SDK range, version
 * consistency, size). One finding per plugin that fails to pack or validate (rule `plugin-pack`,
 * located at the plugin's package.json).
 * package.json `files` lists something the package can't carry (a directory, a glob, a missing path):
 * rule `plugin-pack-dropped`, one per entry.
 */
export async function checkPluginPack(pluginDirs: string[]): Promise<Finding[]> {
  const out = await mkdtemp(join(tmpdir(), "check-plugin-pack-"));
  const findings: Finding[] = [];
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
            message: `"files" entry "${d}" is not in the plugin package (only plain root files, README.md, LICENSE, migrations/ and ui/ are shipped): remove it or make it a plain file`,
          });
        }
        await readExtensionPackage(new Uint8Array(await readFile(r.file)), {
          maxBytes: PLUGIN_PACK_MAX_BYTES,
          hostSdkVersion: SDK_VERSION,
        });
      } catch (e) {
        const message =
          e instanceof ExtensionPackageError
            ? `插件包校验不通过：${e.issues.join("; ")}`
            : `打包失败：${e instanceof Error ? e.message : String(e)}`;
        findings.push({ file, line: 1, rule: "plugin-pack", message });
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  return findings;
}
