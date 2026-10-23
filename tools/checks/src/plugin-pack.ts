import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PACKAGES_MAX_BYTES_DEFAULT,
  PluginPackageError,
  readPluginPackage,
} from "@capybara-hq/kernel";
import { packPlugin } from "@capybara-hq/pack-plugin";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/** 即 `packages.maxBytes` 的默认值（取自内核配置 schema）：官方插件打出来的包必须能按默认上限安装。 */
export const PLUGIN_PACK_MAX_BYTES = PACKAGES_MAX_BYTES_DEFAULT;

/**
 * 每个插件都能打成自包含的插件包（C12）：用 `tools/pack-plugin` 打包（esbuild 单文件 ESM + 静态清单），
 * 再用内核安装时的 `readPluginPackage` 校验（白名单 import、安装脚本、依赖字段、SDK 范围、版本一致、大小）。
 * 打包或校验失败的插件各报一条（rule `plugin-pack`，位置记在插件的 package.json）。
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
        await readPluginPackage(new Uint8Array(await readFile(r.file)), {
          maxBytes: PLUGIN_PACK_MAX_BYTES,
          hostSdkVersion: SDK_VERSION,
        });
      } catch (e) {
        const message =
          e instanceof PluginPackageError
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
