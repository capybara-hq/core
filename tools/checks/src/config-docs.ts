import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KernelConfigSchema, renderConfigDocs } from "@capybara-hq/kernel";
import type { core } from "zod";
import type { Finding } from "./source.js";

export type { Finding };

/** 仓库根下的 docs/config.md。 */
export const DEFAULT_DOC_PATH = fileURLToPath(new URL("../../../docs/config.md", import.meta.url));

/** 重新渲染配置文档并与 docs/config.md 比对；不一致（含文件缺失）-> config-docs-stale。 */
export function checkConfigDocs(
  schema: core.$ZodType = KernelConfigSchema,
  docPath: string = DEFAULT_DOC_PATH,
): Finding[] {
  const expected = renderConfigDocs(schema);
  const actual = existsSync(docPath) ? readFileSync(docPath, "utf8") : undefined;
  if (actual === expected) return [];
  return [
    {
      file: docPath,
      line: 1,
      rule: "config-docs-stale",
      message:
        actual === undefined
          ? "配置文档不存在；运行 pnpm gen:config-docs 生成"
          : "配置文档与配置 schema 不一致；运行 pnpm gen:config-docs 重新生成并提交（不要手工编辑）",
    },
  ];
}
