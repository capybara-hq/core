import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginPackageError, readPluginPackage } from "@capybara-hq/kernel";
import { packPlugin } from "@capybara-hq/pack-plugin";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/** 与 `packages.maxBytes` 的默认值一致：官方插件打出来的包必须能按默认上限安装。 */
export const PLUGIN_PACK_MAX_BYTES = 52_428_800;

/**
 * 每个插件都能打成自包含的插件包（C12）：用 `tools/pack-plugin` 打包（esbuild 单文件 ESM + 静态清单），
 * 再用内核安装时的 `readPluginPackage` 校验（白名单 import、安装脚本、依赖字段、SDK 范围、版本一致、大小）。
 * 打包或校验失败的插件各报一条（rule `plugin-pack`，位置记在插件的 package.json）。
 */
export async function checkPluginPack(pluginDirs: string[]): Promise<Finding[]> {
  const out = await mkdtemp(join(tmpdir(), "check-plugin-pack-"));
  const findings: Finding[] = [];
  try {
    for (const dir of pluginDirs) {
      const file = join(dir, "package.json");
      try {
        const r = await packPlugin(dir, out);
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
